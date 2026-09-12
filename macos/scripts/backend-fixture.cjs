// Real API with an isolated database; never starts pollers, hooks, or CLI processes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
process.env.TASKHUB_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-native-fixture-'));
const { app } = require('../../src/server/app');
const db = require('../../src/server/database/db');
const sse = require('../../src/server/routes/sse');
if (!db.getProjects().length) {
  db.addProject({ name: 'Native integration fixture', repo: '', color: '#64748b', workspace: '/tmp' });
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
const server = app.listen(Number(process.env.PORT || 0), '127.0.0.1', () => {
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  if (process.env.TASKHUB_READY_FILE) fs.writeFileSync(process.env.TASKHUB_READY_FILE, baseURL);
  console.log(baseURL);
});
server.on('error', error => { console.error(error.message); process.exit(1); });
const timer = setInterval(() => sse.publishSync('fixture'), 100);
process.on('SIGTERM', () => { clearInterval(timer); server.closeAllConnections(); server.close(); process.exit(0); });
