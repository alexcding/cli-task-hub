// Real API with an isolated database; never starts pollers, hooks, or CLI processes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
process.env.TASKHUB_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-native-fixture-'));
if (process.env.TASKHUB_BUILD_FIXTURE === '1') {
  // Replace registration before bootstrap so these UI checks never call Xcode
  // or start a build. Real CLI/build acceptance is a separate integration gate.
  require('../../src/server/routes/xcode').register = app => {
    const { ROUTES } = require('../../src/shared/routes.mjs');
    const requests = { schemes: 0, simulators: 0, settings: 0 };
    app.get(ROUTES.XCODE_SCHEMES, (_req, res) => {
      requests.schemes += 1;
      res.json({ target: path.join(process.env.TASKHUB_DATA_DIR, 'Fixture.xcodeproj'), schemes: ['Fixture Alpha', 'Fixture Beta'] });
    });
    app.get(ROUTES.XCODE_SIMULATORS, (_req, res) => {
      requests.simulators += 1;
      res.json(['A', 'B'].map((suffix, index) => ({ udid: `12345678-1234-1234-1234-123456789ab${index}`,
        name: `Fixture ${suffix}`, runtime: 'Fixture OS' })));
    });
    app.get(ROUTES.XCODE_BUILD_SETTINGS, (_req, res) => {
      requests.settings += 1;
      res.status(500).json({ error: 'Fixture build preparation rejected' });
    });
    app.get('/fixture/build-requests', (_req, res) => res.json(requests));
  };
}
const { app } = require('../../src/server/app');
if (process.env.TASKHUB_PROJECT_ACTION_FIXTURE === '1') {
  // Persist through the real route, but hold its first response until the UI
  // explicitly releases it. This exercises cancellation after a tab was saved.
  const { ROUTES } = require('../../src/shared/routes.mjs');
  const sendJSON = app.response.json;
  let held = null, opens = 0, armed = false;
  app.response.json = function (body) {
    if (armed && this.req.method === 'POST' && this.req.path === ROUTES.TABS && this.req.body?.url?.endsWith('?pr=2')) {
      opens += 1;
      if (opens === 1) { held = { response: this, body }; return this; }
    }
    return sendJSON.call(this, body);
  };
  app.get('/fixture/project-opens', (_req, res) => res.json({ held: held !== null, opens }));
  app.post('/fixture/arm-project-open', (_req, res) => { armed = true; opens = 0; res.json({ ok: true }); });
  app.post('/fixture/release-project-open', (_req, res) => {
    const pending = held; held = null;
    if (pending && !pending.response.destroyed) sendJSON.call(pending.response, pending.body);
    res.json({ ok: true });
  });
}
const db = require('../../src/server/database/db');
const sse = require('../../src/server/routes/sse');
// Project writes exercise real validation/storage without starting external syncs.
const fixturePoller = require('../../src/server/services/poller');
fixturePoller.syncProject = fixturePoller.syncProjectJira = fixturePoller.syncProjectBoard = async () => {};
require('../../src/server/services/webhook-forwarder').sync = () => {};
require('../../src/server/repositories/jira').listVersions = async () => [{ name: 'ios-1.2.3' }];
if (process.env.TASKHUB_WORKFLOW_PAGE_FIXTURE === '1') {
  require('../../src/server/repositories/jira').searchLean = async () => [{ key: 'REC-42', summary: 'Workflow handoff' }];
  require('../../src/server/repositories/github').lookupPr = async () => ({ repo: 'fixture/repo', title: 'Review handoff', headRefName: 'review/pr-42' });
}
if (process.env.TASKHUB_CLI_FIXTURE === '1') {
  require('../../src/server/services/cli-tools').detect = async () => ({
    claude: { present: true }, codex: { present: false }, gh: { present: true, authed: false }, acli: { present: true, authed: null },
  });
  // Exercise HTTP and native UI without reading or editing real agent config files.
  const hooks = require('../../src/server/services/agent-hooks');
  const status = { claude: 'absent', codex: 'absent' };
  hooks.status = () => ({ ...status });
  hooks.install = cli => {
    if (cli === 'codex') throw new Error('Fixture hook configuration rejected');
    status[cli] = 'installed';
  };
  hooks.uninstall = cli => { status[cli] = 'absent'; };
}
if (process.env.TASKHUB_LOGS_FIXTURE === '1') {
  db.addLog({ category: 'event', level: 'info', type: 'native_activity', payload: 'Synthetic successful operation' });
  db.addLog({ category: 'event', level: 'error', type: 'native_failure', payload: 'Synthetic failed operation' });
  db.addLog({ category: 'poller', level: 'info', type: 'keep_diagnostics', payload: 'This category survives clearing Activity' });
}
app.get('/fixture/page', (_req, res) => {
  res.setHeader('Set-Cookie', 'taskhub_native_fixture=retained; Path=/; Max-Age=3600; SameSite=Lax');
  res.type('html').send('<!doctype html><title>Native Browser Fixture</title><h1>Native browser fixture</h1><p>Find the quokka.</p><a href="/fixture/next">Next page</a><a href="/fixture/next" target="_blank">Popup page</a>');
});
app.get('/fixture/next', (_req, res) => res.type('html').send('<!doctype html><title>Next Fixture Page</title><h1>Next page</h1><a href="/fixture/page">Back to fixture</a>'));
app.get('/browse/:key', (_req, res) => res.type('html').send('<!doctype html><title>Native ticket fixture</title><h1>Native ticket fixture</h1>'));
if (!db.getProjects().length) {
  db.addProject({ name: 'Native integration fixture', repo: '', color: '#64748b', workspace: process.env.TASKHUB_FIXTURE_WORKSPACE || '/tmp' });
}
if (process.env.TASKHUB_BUILD_FIXTURE === '1') db.updateProject(db.getProjects()[0].id, { ide: 'xcode' });
if (process.env.TASKHUB_PROJECT_ACTION_FIXTURE === '1') db.updateProject(db.getProjects()[0].id, { repo: 'fixture/taskhub' });
if (process.env.TASKHUB_BOARD_FIXTURE === '1') {
  const project = db.getProjects()[0];
  db.updateProject(project.id, { jiraProjectKey: 'REC' });
  const items = [
    { key: 'REC-1', summary: 'Native board integration', status: 'To Do', statusId: '1', assignee: '', assigneeId: '' },
    { key: 'REC-2', summary: 'Completed fixture task', status: 'Done', statusId: '2', assignee: 'Alice', assigneeId: 'alice' },
    { key: 'REC-3', summary: 'Blocked fixture task', status: 'Blocked', statusId: '3', assignee: 'Bob', assigneeId: 'bob' },
  ].map(item => ({ ...item, statusCategory: item.status === 'Done' ? 'done' : 'new', type: 'Task', priority: 'Medium' }));
  const save = () => {
    const snapshot = { items, jql: 'project = REC', lastSynced: new Date().toISOString(), error: null,
      meta: { query: '', sprint: { name: 'Fixture sprint' }, columns: [
        { name: 'To Do', statusIds: ['1'], statuses: [{ id: '1', name: 'To Do' }] },
        { name: 'Done', statusIds: ['2'], statuses: [{ id: '2', name: 'Done' }] },
        { name: 'Blocked', statusIds: ['3'], statuses: [{ id: '3', name: 'Blocked' }] },
      ] } };
    db.setJiraSnapshot(`board:${project.id}`, snapshot); db.setJiraSnapshot(project.id, snapshot);
  };
  save();
  const jira = require('../../src/server/repositories/jira');
  jira.searchLean = async jql => {
    const key = /^key = ([A-Z0-9_-]+)$/i.exec(jql)?.[1];
    if (jql.includes('failure')) throw new Error('Fixture search rejected');
    return items.filter(item => !key || item.key === key);
  };
  jira.getAuth = async () => ({ email: 'fixture@example.test', site: 'example.test' });
  require('../../src/server/repositories/jira-rest').myself = async () => ({ accountId: 'fixture-me' });
  jira.transitionWorkItem = async (key, status) => {
    if (status === 'Blocked') throw new Error('Fixture transition rejected');
    const item = items.find(item => item.key === key);
    if (!item) throw new Error('Fixture ticket missing');
    item.status = status; item.statusId = status === 'Done' ? '2' : '1'; save();
  };
  jira.assignWorkItem = async (key, assignee) => {
    const item = items.find(item => item.key === key);
    item.assigneeId = assignee; item.assignee = assignee === 'alice' ? 'Alice' : assignee; save();
  };
  const poller = require('../../src/server/services/poller');
  poller.syncProjectBoard = poller.syncProjectJira = poller.pollJira = async () => { save(); };
  poller.poll = async () => {};
}
// Opt-in sample hierarchy for native sidebar/UI checks. Uses only this fixture's
// isolated data directory and never reads the daily app's sessions.
if (process.env.TASKHUB_SIDEBAR_FIXTURE === '1') {
  const configdb = require('../../src/server/database/configdb');
  const project = db.getProjects()[0];
  for (const [id, title, pinned] of [['sidebar-1', 'Review authentication', true], ['sidebar-2', 'Fix dashboard refresh', false]]) {
    const worktree = path.join(process.env.TASKHUB_DATA_DIR, id);
    fs.mkdirSync(worktree, { recursive: true });
    configdb.upsertTask({ id, projectId: project.id, workspace: project.workspace, worktree,
      title, branch: id, url: id === 'sidebar-1' ? 'https://example.com/review' : '', pinned,
      createdAt: id === 'sidebar-1' ? '2026-01-01T00:00:00Z' : '2026-02-01T00:00:00Z' });
  }
  configdb.setTabs([{ kind: 'web', title: 'Review context', url: 'https://example.com/review' },
                   { kind: 'web', title: 'Documentation', url: 'https://example.com/docs' }]);
}
if (process.env.TASKHUB_EDITOR_FIXTURE === '1') {
  fs.writeFileSync(path.join(process.env.TASKHUB_DATA_DIR, 'Editable.swift'), 'let original = true\n');
}
if (process.env.TASKHUB_DIFF_FIXTURE === '1') {
  const worktree = path.join(process.env.TASKHUB_DATA_DIR, 'sidebar-2');
  fs.mkdirSync(path.join(worktree, 'Sources'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'Sources/Fixture.swift'), 'let message = "Native diff ready"\n');
  fs.writeFileSync(path.join(worktree, 'Untracked.txt'), 'Untracked editor fixture\n');

  const github = require('../../src/server/repositories/github');
  let reads = 0, committed = false, pushed = false, discarded = false, commitCalls = 0, pushCalls = 0, discardCalls = 0;
  github.gitCommit = async (_dir, message, includeUntracked) => {
    if (++commitCalls > 1) return { error: 'Duplicate commit request' };
    if (message !== 'Native commit fixture' || includeUntracked !== false) return { error: 'Unexpected commit draft' };
    committed = true;
    return { ok: true, hash: 'abc1234' };
  };
  github.gitPush = async () => {
    if (++pushCalls === 1) return { error: 'Fixture push rejected' };
    pushed = true;
    return { ok: true };
  };
  github.gitDiscard = async (dir, patch) => {
    if (++discardCalls === 1) return { error: 'Fixture discard rejected' };
    if (!patch.includes('-let message = "Before"') || !patch.includes('+let message = "Native diff ready"')) return { error: 'Unexpected discard patch' };
    fs.writeFileSync(path.join(dir, 'Sources/Fixture.swift'), 'let message = "Before"\n');
    discarded = true;
    return { ok: true };
  };
  github.gitDiff = async () => {
    if (discarded) return { branch: 'fixture-changes', diff: '', untracked: ['Untracked.txt'], ahead: 0, behind: 0 };
    if (committed) return { branch: 'fixture-changes', diff: '', untracked: [], ahead: pushed ? 0 : 1, behind: 0 };
    if (++reads === 2) return { error: 'Fixture diff unavailable' };
    return { branch: 'fixture-changes', untracked: ['Untracked.txt'],
      diff: 'diff --git a/Sources/Fixture.swift b/Sources/Fixture.swift\n--- a/Sources/Fixture.swift\n+++ b/Sources/Fixture.swift\n@@ -1 +1 @@\n-let message = "Before"\n+let message = "Native diff ready"\n' };
  };
}
if (process.env.TASKHUB_HISTORY_FIXTURE === '1') {
  const github = require('../../src/server/repositories/github');
  const commits = Array.from({ length: 205 }, (_, i) => ({
    sha: (205 - i).toString(16).padStart(40, '0'), short: (205 - i).toString(16).padStart(7, '0'),
    parents: [], author: 'History Author', email: 'history@example.invalid', date: '2026-01-01T00:00:00Z',
    subject: i === 204 ? 'Oldest fixture commit' : 'History commit ' + (205 - i),
    refs: i === 0 ? [{ type: 'head', name: 'fixture-history' }] : [],
  }));
  let reads = 0, details = 0;
  github.gitLog = async (_dir, { limit = 200, skip = 0, aheadOnly = false } = {}) => {
    if (++reads === 1) return { error: 'Fixture history unavailable' };
    return { commits: commits.slice(skip, skip + limit), branch: 'fixture-history', viewing: 'fixture-history',
      base: aheadOnly ? 'release/next' : null, historyRevision: 'fixture-history-revision' };
  };
  github.gitShow = async (_dir, sha) => {
    if (++details === 1) return { error: 'Fixture commit unavailable' };
    const commit = commits.find(value => value.sha === sha);
    if (!commit) return { error: 'Fixture commit missing' };
    return { meta: { sha, short: commit.short, parents: [], author: commit.author, authorEmail: commit.email,
      authorDate: commit.date, committer: commit.author, committerEmail: commit.email, commitDate: commit.date,
      message: commit.subject + '\n\nHistory detail body' },
      diff: 'diff --git a/History.swift b/History.swift\n--- a/History.swift\n+++ b/History.swift\n@@ -1 +1 @@\n-let history = false\n+let history = true\n' };
  };
}
if (process.env.TASKHUB_TRAY_FIXTURE === '1') {
  const configdb = require('../../src/server/database/configdb');
  const project = db.getProjects()[0];
  const prs = [
    { number: 1, title: 'Review native navigation', category: 'review', awaitingMyReview: true },
    { number: 2, title: 'Previously reviewed terminal change', category: 'other', awaitingMyReview: true },
    { number: 3, title: 'Add native usage panel', category: 'mine', awaitingMyReview: false },
  ].map(pr => ({ ...pr, state: 'OPEN', repo: 'fixture/taskhub', url: `https://example.com/pr/${pr.number}`,
    requestedAt: '2026-01-01T00:00:00Z', ci: { status: 'completed', conclusion: 'success' } }));
  db.setSnapshot(project.id, { prs, lastSynced: new Date().toISOString(), error: null });
  configdb.setTabs([...configdb.getTabs().tabs.filter(tab => !prs.some(pr => pr.url === tab.url)),
    ...prs.map(pr => ({ kind: 'github', title: pr.title, url: pr.url, category: pr.category }))]);
  // Never touch credentials, rollout files, or ccusage during UI/integration tests.
  require('../../src/server/repositories/usage').getUsage = async () => {
    if (process.env.TASKHUB_HOLD_USAGE === '1') {
      while (!fs.existsSync(path.join(process.env.TASKHUB_DATA_DIR, 'release-usage'))) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    await new Promise(resolve => setTimeout(resolve, Number(process.env.TASKHUB_USAGE_DELAY_MS || 0)));
    if (fs.existsSync(path.join(process.env.TASKHUB_DATA_DIR, 'fail-usage'))) throw new Error('Fixture usage unavailable');
    const window = usedPct => ({ usedPct, resetsAt: new Date(Date.now() + 3_600_000).toISOString() });
    return { claude: { tokens: 120000, cost: 2.34 }, codex: { tokens: 45000, cost: 0.87 },
      limits: { session: window(24), weekly: window(42), scoped: [{ label: 'Model', ...window(10) }] },
      codexLimits: { session: window(8), weekly: window(18) }, asOf: new Date().toISOString() };
  };
}
const server = app.listen(Number(process.env.PORT || 0), '127.0.0.1', error => {
  if (error) { console.error(error.message); process.exit(1); }
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  if (process.env.TASKHUB_BOARD_FIXTURE === '1') db.set('jira_base_url', baseURL);
  if (process.env.TASKHUB_BROWSER_FIXTURE === '1') {
    const configdb = require('../../src/server/database/configdb');
    const url = `${baseURL}/fixture/page`;
    configdb.patchTask('sidebar-1', { url });
    configdb.setTabs([{ kind: 'web', title: 'Browser fixture', url }, { kind: 'web', title: 'Next page', url: `${baseURL}/fixture/next` }]);
    const project = db.getProjects()[0];
    const snapshot = db.getSnapshot(project.id);
    if (snapshot) db.setSnapshot(project.id, { ...snapshot,
      prs: snapshot.prs.map(pr => ({ ...pr, url: `${url}?pr=${pr.number}` })) });
  }
  if (process.env.TASKHUB_EDITOR_FIXTURE === '1') {
    const configdb = require('../../src/server/database/configdb');
    configdb.setTabs([...configdb.getTabs().tabs, { kind: 'web', title: 'Editor fixture',
      url: `${baseURL}/fixture/editor-context`, pageClosed: true,
      links: [{ kind: 'file', path: path.join(process.env.TASKHUB_DATA_DIR, 'Editable.swift'), active: true }] }]);
  }
  if (process.env.TASKHUB_READY_FILE) fs.writeFileSync(process.env.TASKHUB_READY_FILE, baseURL);
  console.log(baseURL);
});
server.on('error', error => { console.error(error.message); process.exit(1); });
const timer = setInterval(() => {
  // Opt-in, local-file controls for exercising the actual notification UI.
  // No test routes are added to the production HTTP API.
  const commandFile = path.join(process.env.TASKHUB_DATA_DIR, 'notification-command.json');
  if (process.env.TASKHUB_NOTIFICATION_FIXTURE === '1' && fs.existsSync(commandFile)) {
    try {
      const command = JSON.parse(fs.readFileSync(commandFile, 'utf8'));
      fs.unlinkSync(commandFile);
      if (command.type === 'activity') {
        sse.publishActivity({ type: 'sync_failed', payload: { repo: 'fixture/taskhub', error: 'Sample notification acceptance check' },
          created_at: new Date().toISOString() });
      } else if (command.type === 'review') {
        const project = db.getProjects()[0];
        const snapshot = db.getSnapshot(project.id);
        const prs = snapshot.prs.map(pr => pr.number === 1 ? { ...pr, requestedAt: new Date().toISOString() } : pr);
        db.setSnapshot(project.id, { ...snapshot, prs, lastSynced: new Date().toISOString() });
      }
    } catch (error) { console.error('Notification fixture:', error.message); }
  }
  sse.publishSync('fixture');
}, 100);
process.on('SIGTERM', () => { clearInterval(timer); server.closeAllConnections(); server.close(); process.exit(0); });
