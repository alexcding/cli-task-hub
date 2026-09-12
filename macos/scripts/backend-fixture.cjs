// Real API with an isolated database; never starts pollers, hooks, or CLI processes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
process.env.TASKHUB_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-native-fixture-'));
const { app } = require('../../src/server/app');
const db = require('../../src/server/database/db');
const sse = require('../../src/server/routes/sse');
app.get('/fixture/page', (_req, res) => {
  res.setHeader('Set-Cookie', 'taskhub_native_fixture=retained; Path=/; Max-Age=3600; SameSite=Lax');
  res.type('html').send('<!doctype html><title>Native Browser Fixture</title><h1>Native browser fixture</h1><p>Find the quokka.</p><a href="/fixture/next">Next page</a><a href="/fixture/next" target="_blank">Popup page</a>');
});
app.get('/fixture/next', (_req, res) => res.type('html').send('<!doctype html><title>Next Fixture Page</title><h1>Next page</h1><a href="/fixture/page">Back to fixture</a>'));
if (!db.getProjects().length) {
  db.addProject({ name: 'Native integration fixture', repo: '', color: '#64748b', workspace: process.env.TASKHUB_FIXTURE_WORKSPACE || '/tmp' });
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
