// Server entry: Express bootstrap + route wiring + lifecycle. Handlers live in
// routes/* (thin glue: parse → service/repository → JSON); snapshot orchestration in
// services/sync.js; the long-running loops in services/poller + webhook-forwarder.

// Cache compiled V8 bytecode to disk for faster cold starts (no-op pre-Node 22.8).
try { require('node:module').enableCompileCache?.(); } catch {}

// Load first so console.* is routed to the log file before any other module logs.
require('./logger');

const express = require('express');
const path = require('path');
const poller = require('./services/poller');
const forwarder = require('./services/webhook-forwarder');
const db = require('./database/db');
const { ROUTES } = require('../shared/routes.mjs');

const PORT = parseInt(process.env.PORT || '3000', 10);

const app = express();
// Only /api/git/discard carries a big body (a patch); everything else keeps the
// default 100kb cap so one route's needs don't widen the whole API's buffer ceiling.
const jsonBig = express.json({ limit: '15mb' });
const jsonStd = express.json();
// /api/git/discard carries a patch and /api/file carries file content; both can exceed
// the default 100kb cap, so route them through the bigger parser. Everything else keeps
// the tight ceiling so one route's needs don't widen the whole API's buffer.
app.use((req, res, next) => (req.path === ROUTES.GIT_DISCARD || req.path === ROUTES.FILE ? jsonBig : jsonStd)(req, res, next));
// Shared cross-process contracts (src/shared/*.mjs) exposed to the renderer at /shared.
// The page imports e.g. /shared/constants.mjs; Node consumers require() the same files
// from disk. This surface stays stable regardless of where the renderer's files live.
// Mounted BEFORE the web-root static so a future src/renderer/shared/ can't shadow it.
app.use('/shared', express.static(path.join(__dirname, '..', 'shared'), {
  etag: false,
  lastModified: false,
  setHeaders: res => res.setHeader('Cache-Control', 'no-store'),
}));

// Never cache static assets — this is a localhost tool; a refresh should always
// show the latest UI (avoids "I edited the file but don't see changes").
app.use(express.static(path.join(__dirname, '..', 'renderer'), {
  etag: false,
  lastModified: false,
  setHeaders: res => res.setHeader('Cache-Control', 'no-store'),
}));

// Serve SF Mono (bundled with macOS Terminal.app) at /sf-mono when present, so the
// terminal can use it. Absent on machines without it → the route 404s and the UI
// falls back to Menlo. No-op on non-mac / if the folder isn't there.
const SF_MONO_DIRS = [
  '/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts', // Catalina+
  '/Applications/Utilities/Terminal.app/Contents/Resources/Fonts',        // older macOS
];
try { const dir = SF_MONO_DIRS.find(d => require('fs').existsSync(d)); if (dir) app.use('/sf-mono', express.static(dir)); } catch { /* ignore */ }

// ── Routes ──────────────────────────────────────────────────────────────────────
// One module per domain; registration order mirrors the pre-split file.
require('./routes/config').register(app);
require('./routes/projects').register(app, PORT);
require('./routes/git').register(app);
require('./routes/file').register(app);
require('./routes/prs').register(app);
require('./routes/jira').register(app);
require('./routes/system').register(app);
require('./routes/logs').register(app);
const sse = require('./routes/sse');
sse.register(app);

// ── Dev live reload ─────────────────────────────────────────────────────────────
// Watch the renderer AND the shared contracts (served to the page at /shared) and tell
// open pages to reload on change. src/shared is a sibling of src/renderer, so it needs
// its own watch — editing routes.mjs/constants.mjs must reload the page too. Disabled in
// the packaged app (files live inside app.asar, which isn't watchable/editable), and only
// armed when app.js is the entry point (standalone / dev / forked server) — NOT when this
// module is merely require()d (e.g. by tests), so it never leaks unclosed FSWatcher handles.
const isPackaged = __dirname.includes('app.asar');
if (!isPackaged && require.main === module) {
  try {
    let t = null;
    const reload = () => { clearTimeout(t); t = setTimeout(() => sse.broadcast({ type: 'reload' }), 100); };
    for (const dir of ['renderer', 'shared']) {
      require('fs').watch(path.join(__dirname, '..', dir), { recursive: true }, reload);
    }
    console.log('[dev] live reload watching src/renderer + src/shared');
  } catch (err) { console.warn('[dev] live reload unavailable:', err.message); }
}

// ── Start ─────────────────────────────────────────────────────────────────────
// The HTTP server + poller + webhook forwarder run either standalone (`node src/server/app.js`,
// dev / tray child process) or through start()/stop() in tests. Nothing listens or
// schedules at require time.
let server = null;

// Bind to loopback only: TaskHub is an Electron-only app, not meant to be reached
// over the LAN by IP (the embedded GitHub/Jira <webview>s and header-stripping are
// Electron-only and don't work in a plain browser anyway). Resolves on a successful
// bind, rejects on a hard failure — `server` is only set once we're actually listening,
// so a failed bind leaves it null and a retry can re-listen.
function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, '127.0.0.1');
    srv.once('listening', () => resolve(srv));
    srv.once('error', reject);
  });
}

// Start listening, then launch the poller + forwarder. A just-freed port (freePort's
// `kill -9` races the OS releasing the socket) is retried a few times; if it's still
// unavailable we reject so the caller surfaces it instead of running against a dead backend.
async function start(port = PORT) {
  if (server) return server;
  const ATTEMPTS = 6;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const srv = await listenOnce(port);
      server = srv;
      server.on('error', (err) => console.error('[server] runtime error:', err)); // post-listen errors
      console.log(`TaskHub running at http://localhost:${port}`);
      require('./services/agent-hooks').writePort(port); // so installed CLI hooks can reach us across port drift
      poller.start(sse.publishSync);         // PR sync loop publishes snapshot updates over SSE
      poller.startJira(sse.publishJiraSync); // Jira sync loop (assigned-to-me + per-project)
      db.setActivityListener(sse.publishActivity); // fan new activity entries out to live UIs
      // Dev builds are hard-killed often (no clean tray-quit), which leaks `gh webhook forward`
      // relay hooks and 422s the next run — so wipe stale relay hooks before (re)starting. Off in
      // the packaged app, where the hook could belong to another machine's active forwarder.
      forwarder.setCleanStaleHooks(!isPackaged);
      forwarder.sync(port);
      return server;
    } catch (err) {
      if (err.code === 'EADDRINUSE' && attempt < ATTEMPTS) {
        console.warn(`[server] Port ${port} busy — retry ${attempt}/${ATTEMPTS - 1}`);
        await new Promise(r => setTimeout(r, 300));
        continue;
      }
      throw err; // give up — caller decides what to do (standalone exits; tray shows an error)
    }
  }
}

// Tear down background work and release the port (the Electron main process calls this on quit).
function stop() {
  poller.stop();
  forwarder.stopAll();
  if (server) { try { server.close(); } catch {} server = null; }
}

// Standalone (`node src/server/app.js`, dev:server) self-starts; when required in-process by
// src/main/app/main.js it stays dormant until tray calls start() itself.
if (require.main === module) {
  start().catch((err) => {
    console.error(`[server] failed to start: ${err.message}`);
    process.exit(1);
  });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
  process.on('SIGINT',  () => { stop(); process.exit(0); });
}

module.exports = { app, start, stop };
