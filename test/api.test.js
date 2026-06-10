// API tests over the Express app. Runs against a temp data dir and never starts the
// pollers/forwarder (we listen on the exported `app` directly, on an ephemeral port),
// so no `gh`/`acli` calls happen. Snapshots are seeded through lib/db where a route
// would otherwise kick a live sync.
process.env.TASKHUB_DATA_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'taskhub-test-'));

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { app } = require('../server');
const db = require('../lib/db');

let base = '';
let server = null;

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
};
const send = async (method, p, body) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1');
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  // jira_base_url override so /api/jira/site never shells out to acli.
  await send('POST', '/api/config', { jira_base_url: 'https://example.atlassian.net' });
});

after(() => server && server.close());

test('config round-trips through /api/config', async () => {
  const set = await send('POST', '/api/config', { poll_interval: '90' });
  assert.equal(set.status, 200);
  const { body } = await get('/api/config');
  assert.equal(body.poll_interval, '90');
});

test('settings round-trip through /api/settings', async () => {
  await send('PUT', '/api/settings/theme', { value: 'dark' });
  const { body } = await get('/api/settings');
  assert.equal(body.theme, 'dark');
});

test('jira site uses the config override (no acli)', async () => {
  const { body } = await get('/api/jira/site');
  assert.equal(body.baseUrl, 'https://example.atlassian.net');
});

test('projects: create, read, update, delete', async () => {
  const created = await send('POST', '/api/projects', { name: '  Demo  ', color: '#0ea5e9' });
  assert.equal(created.status, 200);
  assert.equal(created.body.name, 'Demo'); // trimmed
  const id = created.body.id;
  assert.ok(id);

  const one = await get(`/api/projects/${id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.name, 'Demo');

  const updated = await send('PUT', `/api/projects/${id}`, { name: 'Demo 2', jiraProjectKey: 'rec' });
  assert.equal(updated.body.name, 'Demo 2');
  assert.equal(updated.body.jiraProjectKey, 'REC'); // uppercased

  const del = await send('DELETE', `/api/projects/${id}`);
  assert.equal(del.status, 200);
  assert.equal((await get(`/api/projects/${id}`)).status, 404);
});

test('projects: validation errors', async () => {
  assert.equal((await send('POST', '/api/projects', {})).status, 400);
  assert.equal((await send('POST', '/api/projects', { name: '   ' })).status, 400);
  const badRepo = await send('POST', '/api/projects', { name: 'X', repo: 'not a repo!!' });
  assert.equal(badRepo.status, 400);
  assert.match(badRepo.body.error, /repo/i);
  assert.equal((await send('PUT', '/api/projects/nope', { name: 'Y' })).status, 404);
});

test('repo accepts owner/repo and GitHub URLs', async () => {
  const a = await send('POST', '/api/projects', { name: 'RepoA', repo: 'octo/repo' });
  assert.equal(a.body.repo, 'octo/repo');
  const b = await send('PUT', `/api/projects/${a.body.id}`, { repo: 'https://github.com/octo/other' });
  assert.equal(b.body.repo, 'octo/other');
  // Clearing with '' is allowed.
  const c = await send('PUT', `/api/projects/${a.body.id}`, { repo: '' });
  assert.equal(c.body.repo, '');
  await send('DELETE', `/api/projects/${a.body.id}`);
});

test('tabs round-trip through /api/tabs', async () => {
  const tabs = [
    { kind: 'github', title: 'PR #1 Fix', url: 'https://github.com/o/r/pull/1', repo: 'o/r', branch: 'fix', jiraKey: '', prSplit: false, category: 'mine' },
    { kind: 'jira', title: 'REC-1 Thing', url: 'https://example.atlassian.net/browse/REC-1', jiraKey: 'REC-1' },
  ];
  const put = await send('PUT', '/api/tabs', { tabs, active: tabs[0].url });
  assert.equal(put.status, 200);
  const { body } = await get('/api/tabs');
  assert.equal(body.tabs.length, 2);
  assert.equal(body.tabs[0].url, tabs[0].url);
  assert.equal(body.tabs[0].category, 'mine');
  assert.equal(body.active, tabs[0].url);
});

test('links: validation and round-trip', async () => {
  assert.equal((await send('POST', '/api/links', { prNumber: 1 })).status, 400);
  const ok = await send('POST', '/api/links', { prNumber: 7, prRepo: 'o/r', jiraKey: 'REC-7' });
  assert.equal(ok.status, 200);
  const { body } = await get('/api/links');
  const link = body.find(l => l.jira_key === 'REC-7');
  assert.ok(link);
  assert.equal((await send('DELETE', `/api/links/${link.id}`)).status, 200);
});

test('PR endpoints serve a seeded fresh snapshot without syncing', async () => {
  const proj = (await send('POST', '/api/projects', { name: 'Snap' })).body;
  const pr = { number: 5, title: 'T', url: 'https://github.com/o/r/pull/5', state: 'OPEN', repo: 'o/r', category: 'mine' };
  db.setSnapshot(proj.id, { prs: [pr], lastSynced: new Date().toISOString(), error: null });

  // No repo on the project → no background sync is kicked; data comes from the snapshot.
  const tray = await get('/api/prs/tray');
  const found = tray.body.find(p => p.number === 5);
  assert.ok(found);
  assert.equal(found.projectId, proj.id);
  assert.equal(found.projectName, 'Snap');

  const dash = await get('/api/dashboard');
  const g = dash.body.find(x => x.id === proj.id);
  assert.equal(g.prs.length, 1);
  assert.ok(g.lastSynced);

  // Project-scoped list: no repo → [] regardless of snapshot.
  const prs = await get(`/api/projects/${proj.id}/prs`);
  assert.deepEqual(prs.body, []);
  await send('DELETE', `/api/projects/${proj.id}`);
});

test('jira feeds serve a seeded fresh snapshot without acli', async () => {
  const poller = require('../lib/poller');
  const item = { key: 'REC-9', summary: 'S', status: 'To Do', type: 'Task', priority: 'High' };
  db.setJiraSnapshot(poller.MY_TICKETS_ID, { items: [item], jql: 'x', lastSynced: new Date().toISOString(), error: null });
  const { body } = await get('/api/jira/mine');
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].key, 'REC-9');
});

test('events and logs endpoints', async () => {
  db.addEvent('jira_transitioned', { key: 'REC-1', transition: 'Done', trigger: 'manual' });
  const events = await get('/api/events');
  assert.ok(events.body.some(e => e.type === 'jira_transitioned'));

  const logs = await get('/api/logs?category=event&limit=10');
  assert.equal(logs.status, 200);
  assert.ok(Array.isArray(logs.body));

  const cats = await get('/api/logs/categories');
  assert.ok(cats.body.includes('event'));

  const cleared = await send('POST', '/api/logs/clear', { category: 'event' });
  assert.equal(cleared.status, 200);
  const after = await get('/api/events');
  assert.equal(after.body.length, 0);
});

test('GET /api/db reports counts and snapshots', async () => {
  const { status, body } = await get('/api/db');
  assert.equal(status, 200);
  assert.ok(body.counts);
  assert.ok('projects' in body.counts);
  assert.ok(body.snapshots);
});

test('webhook ignores non-merge events', async () => {
  const res = await fetch(base + '/webhook/github', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-github-event': 'pull_request' },
    body: JSON.stringify({ action: 'opened', pull_request: { number: 1, merged: false }, repository: { full_name: 'o/r' } }),
  });
  assert.equal(res.status, 200); // always 200s, then ignores
});
