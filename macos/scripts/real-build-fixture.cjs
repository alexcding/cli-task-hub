// Opt-in native acceptance fixture. All Xcode routes remain real.
const fs = require('node:fs');
const path = require('node:path');

module.exports = function install(app, db) {
  const directory = process.env.TASKHUB_DATA_DIR;
  const simulator = process.env.TASKHUB_REAL_BUILD_SIMULATOR;
  if (!simulator) return;
  if (!path.basename(directory).startsWith('taskhub-browser-ui.')) throw new Error('Real build requires isolated fixture data');
  const project = db.getProjects()[0];
  db.updateProject(project.id, { ide: 'xcode', ideTarget: 'TaskHubBuildProbe.xcworkspace',
    runScheme: 'TaskHubBuildProbe', runSim: simulator });
  let pid = null, reports = 0;
  const launches = [];
  app.post('/fixture/real-build-report', (req, res) => {
    const config = JSON.parse(fs.readFileSync(path.join(directory, 'build-probe.json')));
    if (req.body.bundleID !== config.bundleID || !Number.isInteger(req.body.pid) || req.body.pid <= 1) {
      return res.status(400).json({ error: 'Invalid isolated probe identity' });
    }
    pid = req.body.pid; reports += 1;
    if (!launches.includes(pid)) launches.push(pid);
    fs.writeFileSync(path.join(directory, 'build-probe-reports.json'), JSON.stringify({ pid, reports, launches }));
    res.json({ ok: true });
  });
  app.get('/fixture/real-build-state', (_req, res) => {
    const alive = value => {
      if (!Number.isInteger(value) || value <= 1) return false;
      try { process.kill(value, 0); return true; } catch { return false; }
    };
    const termsDir = path.join(directory, 'ptyd-native-spike', 'terms');
    const terms = fs.existsSync(termsDir) ? fs.readdirSync(termsDir).filter(name => name.endsWith('.json')).flatMap(name => {
      try { const term = JSON.parse(fs.readFileSync(path.join(termsDir, name))); return [{ ...term, alive: alive(term.pid) }]; }
      catch { return []; }
    }) : [];
    res.json({ pid, reports, launches, alive: pid !== null && alive(pid), terms });
  });
};
