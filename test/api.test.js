// API tests over the Express app. Runs against a temp data dir and never starts the
// pollers/forwarder (we listen on the exported `app` directly, on an ephemeral port),
// so no `gh`/`acli` calls happen. Snapshots are seeded through src/server/database/db where a route
// would otherwise kick a live sync.
process.env.TASKHUB_DATA_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'taskhub-test-'));

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { app } = require('../src/server/app');
const db = require('../src/server/database/db');

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
  const created = await send('POST', '/api/projects', { name: '  Demo  ' });
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

test('projects: workflows are sanitized and round-trip', async () => {
  const p = (await send('POST', '/api/projects', { name: 'WF' })).body;
  assert.deepEqual(p.workflows ?? [], []); // new project has no workflows

  const saved = await send('PUT', `/api/projects/${p.id}`, {
    workflows: [
      { name: 'Feature dev', cli: 'nonsense', steps: [
        { title: 'feature done', command: '/feature_dev {url}' },
        { title: 'blank', command: '   ' },          // dropped: no command
        { command: 'npm test' },                      // title optional
      ] },
      { name: 'Legacy', cli: 'codex', commands: ['echo hi'] }, // old shape tolerated
    ],
  });
  assert.equal(saved.status, 200);
  const [a, b] = saved.body.workflows;
  assert.equal(a.cli, 'claude');                                  // bad cli → claude
  assert.deepEqual(a.steps, [
    { title: 'feature done', command: '/feature_dev {url}' },
    { title: '', command: 'npm test' },
  ]);                                                             // blank-command step dropped, title defaults to ''
  assert.ok(a.id);                                                // id assigned by the server
  assert.equal(b.cli, 'codex');
  assert.deepEqual(b.steps, [{ title: '', command: 'echo hi' }]); // commands:[str] → steps

  // Persisted: a fresh GET returns the same list.
  const got = await get(`/api/projects/${p.id}`);
  assert.equal(got.body.workflows.length, 2);
  assert.equal(got.body.workflows[0].name, 'Feature dev');

  await send('DELETE', `/api/projects/${p.id}`);
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
    { kind: 'github', title: 'PR #1 Fix', url: 'https://github.com/o/r/pull/1', repo: 'o/r', branch: 'fix', jiraKey: '', prSplit: false, category: 'mine', login: 'octocat', avatar: 'data:image/png;base64,AAAA' },
    { kind: 'jira', title: 'REC-1 Thing', url: 'https://example.atlassian.net/browse/REC-1', jiraKey: 'REC-1' },
  ];
  const put = await send('PUT', '/api/tabs', { tabs, active: tabs[0].url });
  assert.equal(put.status, 200);
  const { body } = await get('/api/tabs');
  assert.equal(body.tabs.length, 2);
  assert.equal(body.tabs[0].url, tabs[0].url);
  assert.equal(body.tabs[0].category, 'mine');
  assert.equal(body.tabs[0].login, 'octocat');
  assert.equal(body.tabs[0].avatar, 'data:image/png;base64,AAAA');
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

test('tray review requests track viewed vs (re-)requested state', async () => {
  const proj = (await send('POST', '/api/projects', { name: 'Rev' })).body;
  const t0 = '2026-06-01T00:00:00Z';
  const pr = { number: 9, title: 'Review me', url: 'https://github.com/o/r/pull/9', state: 'OPEN', repo: 'o/r', category: 'review', requestedAt: t0 };
  db.setSnapshot(proj.id, { prs: [pr], lastSynced: new Date().toISOString(), error: null });

  const findItem = async () => (await get('/api/prs/tray')).body.find(p => p.number === 9 && p.repo === 'o/r');

  // Never viewed → pending.
  assert.equal((await findItem()).reviewPending, true);

  // Open it (records viewed_at = now, which is after t0) → no longer pending.
  const viewed = await send('POST', '/api/prs/viewed', { repo: 'o/r', number: 9 });
  assert.equal(viewed.status, 200);
  assert.equal((await findItem()).reviewPending, false);

  // A newer request (later requestedAt) re-surfaces it.
  db.setSnapshot(proj.id, { prs: [{ ...pr, requestedAt: new Date().toISOString() }], lastSynced: new Date().toISOString(), error: null });
  assert.equal((await findItem()).reviewPending, true);

  // Missing requestedAt → pending (never silently drop a request).
  db.setSnapshot(proj.id, { prs: [{ ...pr, requestedAt: undefined }], lastSynced: new Date().toISOString(), error: null });
  // Stored requested_at (t0, from setReviewRequestedAt? none here) — none was set via the
  // poller, so the fallback is the live state's requested_at (null) → pending.
  assert.equal((await findItem()).reviewPending, true);

  await send('DELETE', `/api/projects/${proj.id}`);
});

test('POST /api/prs/viewed validates its body', async () => {
  const bad = await send('POST', '/api/prs/viewed', { repo: 'o/r' });
  assert.equal(bad.status, 400);
});

test('jira feeds serve a seeded fresh snapshot without acli', async () => {
  const poller = require('../src/server/services/poller');
  const item = { key: 'REC-9', summary: 'S', status: 'To Do', type: 'Task', priority: 'High' };
  db.setJiraSnapshot(poller.MY_SPRINT_ID, { items: [item], jql: 'x', lastSynced: new Date().toISOString(), error: null });
  const { body } = await get('/api/jira/sprint');
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].key, 'REC-9');
});

test('project board returns the aggregated snapshot (items + sprint + filter + columns) without acli', async () => {
  const poller = require('../src/server/services/poller');
  const project = db.addProject({ name: 'iOS', jiraProjectKey: 'REC' });
  const meta = {
    sprint: { id: 1, name: 'Sprint 9', endDate: null, boardId: 5 },
    query: 'component = iOS',
    columns: [{ name: 'To Do', statusIds: ['1'] }],
  };
  db.setJiraSnapshot(poller.boardSnapId(project), {
    items: [{ key: 'REC-1', summary: 'S', status: 'To Do', statusId: '1', type: 'Task', priority: 'High', assignee: 'Me', assigneeId: 'acc1' }],
    jql: 'sprint = 1 AND (component = iOS)', lastSynced: new Date().toISOString(), error: null, meta,
  });
  try {
    const { status, body } = await get(`/api/projects/${project.id}/board`);
    assert.equal(status, 200);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].key, 'REC-1');
    assert.equal(body.sprint.name, 'Sprint 9'); // sprint meta flattened in
    assert.equal(body.query, 'component = iOS'); // filter clause echoed back
    assert.equal(body.columns[0].name, 'To Do'); // board column order
  } finally {
    db.deleteJiraSnapshot(poller.boardSnapId(project));
    db.deleteProject(project.id);
  }
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

test('GET /api/diff: validation, real repo, non-repo', async () => {
  assert.equal((await get('/api/diff')).status, 400);

  // Real temp repo: one committed file (then modified) + one untracked file.
  const { execFileSync } = require('child_process');
  const fs = require('fs'), path = require('path'), os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-diff-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false'); // the host's signing setup (e.g. 1Password) would block for seconds
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  git('add', '.'); git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'hi\n');

  const { status, body } = await get('/api/diff?path=' + encodeURIComponent(dir));
  assert.equal(status, 200);
  assert.match(body.diff, /^diff --git a\/a\.txt b\/a\.txt/m);
  assert.match(body.diff, /\+TWO/);
  assert.deepEqual(body.untracked, ['new.txt']);

  // A non-repo path reports an error instead of throwing.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-plain-'));
  const bad = await get('/api/diff?path=' + encodeURIComponent(plain));
  assert.equal(bad.status, 200);
  assert.ok(bad.body.error);
});

test('POST /api/git/commit and /api/git/push', async () => {
  assert.equal((await send('POST', '/api/git/commit', {})).status, 400);
  assert.equal((await send('POST', '/api/git/commit', { path: '/tmp', message: ' ' })).status, 400);
  assert.equal((await send('POST', '/api/git/push', {})).status, 400);

  const { execFileSync } = require('child_process');
  const fs = require('fs'), path = require('path'), os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-commit-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', '.'); git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'ONE\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'hi\n');

  // includeUntracked:false commits the modification but leaves new.txt untracked.
  const c1 = await send('POST', '/api/git/commit', { path: dir, message: 'tracked only', includeUntracked: false });
  assert.equal(c1.status, 200);
  assert.ok(c1.body.ok, JSON.stringify(c1.body));
  assert.match(c1.body.hash, /^[0-9a-f]{4,}$/);
  let d = (await get('/api/diff?path=' + encodeURIComponent(dir))).body;
  assert.equal(d.diff, '');
  assert.deepEqual(d.untracked, ['new.txt']);
  assert.ok(d.branch); // gitMeta rides along on the diff response

  // Nothing tracked left to commit → git's own error comes through.
  const c2 = await send('POST', '/api/git/commit', { path: dir, message: 'x', includeUntracked: false });
  assert.ok(c2.body.error);

  // includeUntracked:true sweeps new.txt in.
  const c3 = await send('POST', '/api/git/commit', { path: dir, message: 'untracked too' });
  assert.ok(c3.body.ok, JSON.stringify(c3.body));
  d = (await get('/api/diff?path=' + encodeURIComponent(dir))).body;
  assert.deepEqual(d.untracked, []);
  assert.equal(git('log', '--format=%s', '-1').trim(), 'untracked too');

  // No remote configured → push reports an error instead of throwing.
  const p = await send('POST', '/api/git/push', { path: dir });
  assert.equal(p.status, 200);
  assert.ok(p.body.error);

  // Discard: end-to-end through the renderer's own patch reconstruction — modify the
  // file, parse the served diff, reverse-apply one block, and the change is gone.
  const { parseDiff, blockPatch } = await import('../src/renderer/lib/diff-parse.mjs');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'WRONG\n');
  const before = (await get('/api/diff?path=' + encodeURIComponent(dir))).body;
  const [f] = parseDiff(before.diff);
  const d1 = await send('POST', '/api/git/discard', { path: dir, patch: blockPatch(f, f.hunks[0], 0) });
  assert.ok(d1.body.ok, JSON.stringify(d1.body));
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'ONE\n'); // back to committed content
  // Re-sending the same (now stale) patch fails cleanly instead of corrupting the file.
  const d2 = await send('POST', '/api/git/discard', { path: dir, patch: blockPatch(f, f.hunks[0], 0) });
  assert.ok(d2.body.error);
  assert.equal((await send('POST', '/api/git/discard', { path: dir })).status, 400);

  // Two blocks sharing one hunk (edits 5 context lines apart — beyond the merge gap,
  // within git's hunk-merge distance): discarding block 0 must leave block 1 untouched.
  fs.writeFileSync(path.join(dir, 'b.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n');
  git('add', '.'); git('commit', '-qm', 'base for blocks');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\neight\n');
  const multi = (await get('/api/diff?path=' + encodeURIComponent(dir))).body;
  const bf = parseDiff(multi.diff).find(x => x.newPath === 'b.txt');
  assert.equal(bf.hunks.length, 1); // sanity: both edits really share one hunk
  const d3 = await send('POST', '/api/git/discard', { path: dir, patch: blockPatch(bf, bf.hunks[0], 0) });
  assert.ok(d3.body.ok, JSON.stringify(d3.body));
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'one\ntwo\nthree\nfour\nfive\nsix\nSEVEN\neight\n');
});

test('webhook ignores non-merge events', async () => {
  const res = await fetch(base + '/webhook/github', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-github-event': 'pull_request' },
    body: JSON.stringify({ action: 'opened', pull_request: { number: 1, merged: false }, repository: { full_name: 'o/r' } }),
  });
  assert.equal(res.status, 200); // always 200s, then ignores
});
