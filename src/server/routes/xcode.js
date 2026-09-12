// Xcode run destinations for the terminal toolbar's Run chip — what Xcode's own scheme/device
// picker knows, read from the toolchain itself (`xcodebuild`, `xcrun simctl`), so the project
// needs no hand-written run script and no third-party build tool.
//
// Three read-only GETs, each a fixed binary for a fixed purpose (the same discipline as the gh /
// acli / git routes — there is no "run this command" endpoint):
//   schemes         — `xcodebuild -list -json` on the checkout's document (the same .xcworkspace /
//                     .xcodeproj the IDE button opens — resolved by routes/file.js).
//   simulators      — `xcrun simctl list devices available -j`, flattened and grouped by runtime.
//   build-settings  — `xcodebuild -showBuildSettings -json` for one scheme + simulator: where the
//                     built .app lands and its bundle id, which is what `simctl install/launch` need.
// The run itself is NOT here: the renderer composes the xcodebuild/simctl lines from these answers
// and types them into the context's build terminal (components/build.js), where output belongs.
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { ROUTES } = require('../../shared/routes.mjs');
const { resolvePath, foreignOrigin, resolveLaunchTarget } = require('./file');

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;
// `xcodebuild -list` on a package resolves dependencies first, which can take a while; the
// settings dump loads the project graph. Both well under a minute on anything sane.
const XCODEBUILD_TIMEOUT = 90_000;

async function run(bin, args, opts = {}) {
  try {
    const { stdout } = await execFileAsync(bin, args, { maxBuffer: MAX_BUFFER, timeout: XCODEBUILD_TIMEOUT, ...opts });
    return stdout;
  } catch (err) {
    // xcodebuild puts the useful line on stderr ("xcodebuild: error: The project named X does not
    // contain a scheme named Y"); prefer it to Node's generic "Command failed".
    const lines = String(err.stderr || '').trim().split('\n');
    const msg = lines.find(l => /^xcodebuild: error:/.test(l))?.replace(/^xcodebuild: error:\s*/, '')
      || lines.find(l => /error/i.test(l) && !/result bundle/i.test(l))
      || String(err.stderr || err.message || `${bin} failed`).trim().split('\n')[0];
    throw new Error(msg);
  }
}

// The flag that introduces a resolved launch target to xcodebuild. A Package.swift (or a bare
// folder) has neither — xcodebuild reads the package from the cwd instead, so `[]` + cwd=dir.
function targetArgs(target) {
  if (/\.xcworkspace\/?$/.test(target)) return ['-workspace', target];
  if (/\.xcodeproj\/?$/.test(target)) return ['-project', target];
  return [];
}
const cwdFor = (dir, target) => (targetArgs(target).length ? dir : (/Package\.swift$/.test(target) ? path.dirname(target) : target || dir));

// Resolve the checkout's document the way the IDE button does. 400 on a missing ?path, and the
// caller gets the plain folder when nothing better exists (xcodebuild then reads a package there).
async function targetFor(req, res) {
  const dir = resolvePath(req.query.path);
  if (!dir) { res.status(400).json({ error: 'path required' }); return null; }
  try { return { dir, target: (await resolveLaunchTarget(dir, req.query.rel, 'xcode')).path }; }
  catch (e) { res.status(e.code === 'ENOENT' ? 404 : 500).json({ error: e.code === 'ENOENT' ? 'not found' : e.message }); return null; }
}

// ── Simulators ──────────────────────────────────────────────────────────────────────────────
// "com.apple.CoreSimulator.SimRuntime.iOS-27-0" → { platform: 'iOS', runtime: 'iOS 27.0' }.
function parseRuntime(key) {
  const m = /SimRuntime\.([A-Za-z]+)-(\d+)(?:-(\d+))?(?:-(\d+))?$/.exec(key || '');
  if (!m) return { platform: '', runtime: key || '' };
  const ver = [m[2], m[3], m[4]].filter(Boolean).join('.');
  return { platform: m[1], runtime: `${m[1]} ${ver}` };
}

// simctl is ~0.5s and the toolbar may ask for the list on every menu open; a short cache keeps
// repeated opens instant while still noticing a booted/new device within seconds.
let _sims = { at: 0, list: null };
const SIM_TTL = 5_000;
async function listSimulators() {
  if (_sims.list && Date.now() - _sims.at < SIM_TTL) return _sims.list;
  const out = JSON.parse(await run('xcrun', ['simctl', 'list', 'devices', 'available', '-j']));
  const list = [];
  for (const [rt, devices] of Object.entries(out.devices || {})) {
    const { platform, runtime } = parseRuntime(rt);
    for (const d of devices || []) {
      if (d.isAvailable === false) continue;
      list.push({ udid: d.udid, name: d.name, platform, runtime, state: d.state || 'Shutdown', lastUsedAt: d.lastUsedAt || '' });
    }
  }
  // Booted devices first (they're what you're already looking at), then most recently used —
  // the order Xcode's own destination menu leans towards.
  list.sort((a, b) => (b.state === 'Booted') - (a.state === 'Booted') || (b.lastUsedAt || '').localeCompare(a.lastUsedAt || '') || a.name.localeCompare(b.name));
  _sims = { at: Date.now(), list };
  return list;
}

function register(app) {
  app.get(ROUTES.XCODE_SIMULATORS, async (req, res) => {
    if (foreignOrigin(req)) return res.status(403).json({ error: 'forbidden' });
    try { res.json(await listSimulators()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get(ROUTES.XCODE_SCHEMES, async (req, res) => {
    if (foreignOrigin(req)) return res.status(403).json({ error: 'forbidden' });
    const t = await targetFor(req, res);
    if (!t) return;
    try {
      const out = JSON.parse(await run('xcodebuild', ['-list', '-json', ...targetArgs(t.target)], { cwd: cwdFor(t.dir, t.target) }));
      // A workspace answers under `workspace`, a project under `project`; a workspace lists no
      // targets or configurations (those belong to its projects).
      const info = out.workspace || out.project || {};
      res.json({
        target: t.target, name: info.name || path.basename(t.target),
        schemes: info.schemes || [], targets: info.targets || [], configurations: info.configurations || [],
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Where `xcodebuild build` will put the app for this scheme on this simulator, and its bundle
  // id. Read BEFORE the build (settings don't depend on it), so the renderer can type the whole
  // build → install → launch chain as one line.
  app.get(ROUTES.XCODE_BUILD_SETTINGS, async (req, res) => {
    if (foreignOrigin(req)) return res.status(403).json({ error: 'forbidden' });
    const scheme = String(req.query.scheme || '').trim();
    const sim = String(req.query.sim || '').trim();
    const configuration = String(req.query.configuration || 'Debug').trim() || 'Debug';
    if (!scheme) return res.status(400).json({ error: 'scheme required' });
    if (!/^[0-9A-Fa-f-]{16,}$/.test(sim)) return res.status(400).json({ error: 'sim (a simulator UDID) required' });
    const t = await targetFor(req, res);
    if (!t) return;
    try {
      const args = ['-showBuildSettings', '-json', ...targetArgs(t.target), '-scheme', scheme, '-configuration', configuration, '-destination', `id=${sim}`];
      const out = JSON.parse(await run('xcodebuild', args, { cwd: cwdFor(t.dir, t.target) }));
      // One entry per target the scheme builds; the app is the one whose product is a .app.
      const entry = (Array.isArray(out) ? out : []).find(e => /\.app$/.test(e.buildSettings?.FULL_PRODUCT_NAME || '')) || (Array.isArray(out) ? out[0] : null);
      const bs = entry?.buildSettings || {};
      if (!bs.FULL_PRODUCT_NAME || !bs.BUILT_PRODUCTS_DIR) return res.status(500).json({ error: `Scheme ${scheme} builds no app` });
      res.json({
        appPath: path.join(bs.BUILT_PRODUCTS_DIR, bs.FULL_PRODUCT_NAME),
        bundleId: bs.PRODUCT_BUNDLE_IDENTIFIER || '',
        productName: bs.FULL_PRODUCT_NAME,
        target: t.target, configuration,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { register, parseRuntime, targetArgs };
