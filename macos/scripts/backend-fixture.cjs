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
const server = app.listen(Number(process.env.PORT || 0), '127.0.0.1', () => {
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  if (process.env.TASKHUB_READY_FILE) fs.writeFileSync(process.env.TASKHUB_READY_FILE, baseURL);
  console.log(baseURL);
});
server.on('error', error => { console.error(error.message); process.exit(1); });
const timer = setInterval(() => sse.publishSync('fixture'), 100);
process.on('SIGTERM', () => { clearInterval(timer); server.closeAllConnections(); server.close(); process.exit(0); });
