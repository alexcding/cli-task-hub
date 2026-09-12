// Local file surface for the embedded editor (a CodeMirror tab). On-demand local
// filesystem access — same class as /api/diff — keyed by an absolute path the
// renderer derives from a `file://` tab url (or a path printed in the terminal).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { ROUTES } = require('../../shared/routes.mjs');

// Refuse to open anything bigger than this in the editor — a multi-MB string plus a
// CodeMirror document would stall the renderer, and these tabs are for reading/editing
// source, not blobs. PUT shares the cap (and app.js routes it through the 15mb body parser).
const MAX_BYTES = 5 * 1024 * 1024;

// Normalize a renderer-supplied path to an absolute filesystem path: strip a `file://`
// scheme, expand a leading `~`, then resolve. Relative paths resolve against cwd, but the
// renderer always sends absolute paths (it joins terminal-relative links to the term's cwd).
function resolvePath(p) {
  if (!p) return '';
  let s = String(p);
  if (s.startsWith('file://')) s = decodeURIComponent(s.slice('file://'.length));
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(s);
}

// Reject anything that isn't clean UTF-8 text. A NUL byte means binary; a buffer that doesn't
// round-trip through utf8 decode/encode is some other encoding (latin-1, etc.) — opening it
// would show replacement chars, and SAVING would re-encode those, corrupting the file. So we
// refuse to open it rather than risk silent data loss on the first save.
function decodeUtf8(buf) {
  if (buf.includes(0)) return null;                 // NUL → binary (fast raw-byte scan)
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf) ? text : null; // not clean UTF-8 → refuse
}

// Block the browser-CSRF vector: a page in a web-link webview (or any browser tab) could POST
// to this loopback endpoint. Same-origin renderer requests carry no Origin or a loopback one;
// reject any Origin whose host isn't loopback. (Other routes do local work too, but /api/file
// is an arbitrary-path write, so it gets the guard.)
function foreignOrigin(req) {
  const o = req.headers.origin;
  if (!o) return false;
  try { const h = new URL(o).hostname; return !(h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'); }
  catch { return true; }
}

// ── IDE launch targets ────────────────────────────────────────────────────────────────
// What a project's IDE should actually open for a given folder. Two inputs, in order:
//   `rel`  — the project's configured target, relative to the checkout ('ios/App.xcworkspace').
//            Relative, not absolute, because it resolves against a different folder on every
//            branch (each worktree). Used whenever it exists in that folder.
//   `kind` — for an IDE that can't open a plain folder at all (Xcode), a probe fallback for when
//            nothing is configured.
// Anything unresolved → the folder itself.
//
// The probe (kind='xcode') looks for the thing a developer would double-click, in priority order:
//   1. *.xcworkspace  (CocoaPods/multi-project checkouts — the workspace is the right entry)
//   2. *.xcodeproj
//   3. Package.swift  (a SwiftPM package — Xcode opens the manifest's folder as a package)
// Shallowest match wins, so a repo with `ios/App.xcworkspace` resolves even when the root has
// nothing. Nothing found → the folder itself (harmless: Xcode just opens what it can).
const XCODE_SKIP = new Set(['.git', 'node_modules', 'Pods', 'Carthage', 'DerivedData', 'build', '.build', 'vendor', 'fastlane', '.gradle', 'dist']);
const XCODE_MAX_DEPTH = 2;

// Best target inside ONE directory, or '' — the priority order above.
function xcodePick(dir, entries) {
  const named = ext => entries.filter(e => e.name.endsWith(ext)).map(e => e.name).sort()[0];
  const ws = named('.xcworkspace');   // a bundle dir; never the project.xcworkspace inside a
  if (ws) return path.join(dir, ws);  // .xcodeproj, since we don't descend into those (below)
  const proj = named('.xcodeproj');
  if (proj) return path.join(dir, proj);
  if (entries.some(e => e.isFile() && e.name === 'Package.swift')) return path.join(dir, 'Package.swift');
  return '';
}

// Breadth-first so the shallowest target wins. Bundle dirs (.xcodeproj/.xcworkspace) and the
// heavy/generated folders above are never descended into.
async function xcodeTarget(root) {
  let level = [root];
  for (let depth = 0; depth <= XCODE_MAX_DEPTH && level.length; depth++) {
    const next = [];
    for (const dir of level) {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      const hit = xcodePick(dir, entries);
      if (hit) return hit;
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || XCODE_SKIP.has(e.name)) continue;
        if (e.name.endsWith('.xcodeproj') || e.name.endsWith('.xcworkspace')) continue; // bundles, not folders
        next.push(path.join(dir, e.name));
      }
    }
    level = next;
  }
  return '';
}

// The launch-target resolution behind GET /api/launch-target, shared with routes/xcode.js (the
// scheme list and build settings need the same document the IDE button would open, so both
// resolve it here rather than re-deriving it). Throws ENOENT for a missing folder.
async function resolveLaunchTarget(dir, relQ, kindQ) {
  const rel = String(relQ || '').trim().replace(/^\/+/, '');
  const kind = String(kindQ || '');
  const st = await fsp.stat(dir);
  if (!st.isDirectory()) return { path: dir, source: 'path' };
  // A configured target wins — but only if it's actually there. A worktree that predates the
  // file (or a typo) falls through to the probe/folder rather than handing the IDE a bad path.
  if (rel && !rel.split('/').includes('..')) {
    const target = path.join(dir, rel);
    try { await fsp.stat(target); return { path: target, source: 'configured' }; }
    catch { /* not in this checkout — fall through */ }
  }
  if (kind === 'xcode') {
    const found = await xcodeTarget(dir);
    if (found) return { path: found, source: 'probe' };
  }
  return { path: dir, source: 'folder' };
}

function register(app) {
  // What a project's IDE should open for a folder. Only 'xcode' needs a probe today; every other
  // kind opens the folder, and the renderer doesn't call this for those.
  app.get(ROUTES.LAUNCH_TARGET, async (req, res) => {
    if (foreignOrigin(req)) return res.status(403).json({ error: 'forbidden' });
    const dir = resolvePath(req.query.path);
    if (!dir) return res.status(400).json({ error: 'path required' });
    try {
      res.json(await resolveLaunchTarget(dir, req.query.rel, req.query.kind));
    } catch (e) {
      const notFound = e.code === 'ENOENT';
      res.status(notFound ? 404 : 500).json({ error: notFound ? 'not found' : e.message });
    }
  });

  // Read a local file for the editor. Returns { path, content, readOnly } or { error }.
  // readOnly drives a non-editable CodeMirror state (no write permission on disk).
  app.get(ROUTES.FILE, async (req, res) => {
    if (foreignOrigin(req)) return res.status(403).json({ error: 'forbidden' });
    const file = resolvePath(req.query.path);
    if (!file) return res.status(400).json({ error: 'path required' });
    try {
      const st = await fsp.stat(file);
      if (st.isDirectory()) return res.status(400).json({ error: 'is a directory' });
      if (st.size > MAX_BYTES) return res.status(413).json({ error: `file too large (${(st.size / 1048576).toFixed(1)} MB)` });
      const content = decodeUtf8(await fsp.readFile(file));
      if (content === null) return res.status(415).json({ error: 'not a UTF-8 text file' });
      let readOnly = false;
      try { await fsp.access(file, fs.constants.W_OK); } catch { readOnly = true; }
      res.json({ path: file, content, readOnly });
    } catch (e) {
      const notFound = e.code === 'ENOENT';
      res.status(notFound ? 404 : 500).json({ error: notFound ? 'not found' : e.message });
    }
  });

  // Save editor content back to disk (⌘S / the tab's save button). Body: { path, content }.
  app.put(ROUTES.FILE, async (req, res) => {
    if (foreignOrigin(req)) return res.status(403).json({ error: 'forbidden' });
    const file = resolvePath(req.body && req.body.path);
    const content = req.body && req.body.content;
    if (!file) return res.status(400).json({ error: 'path required' });
    if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) return res.status(413).json({ error: 'content too large' });
    try {
      await fsp.writeFile(file, content, 'utf8');
      res.json({ ok: true, path: file });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { register, resolvePath, foreignOrigin, resolveLaunchTarget };
