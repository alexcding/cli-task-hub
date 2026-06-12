// Forks and supervises the backend server child process (server.js). The tray process
// outlives window closes and owns this child until Quit, while synchronous Jira/GitHub
// work stays off the UI/menu event loop.
const { app } = require('electron');
const { fork, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const { PORT, BASE_URL } = require('../app/const');

let serverProcess = null; // forked backend server; null when using an external one
let serverStartedAt = 0;  // when the current server child was forked (for the healthy reset)
let serverFailures = 0;   // consecutive crash count, drives respawn backoff
let serverRestartTimer = null;
let shuttingDown = false; // set on quit so a deliberate kill isn't treated as a crash

// Respawn the backend if it crashes. A child that ran a while is treated as healthy (streak
// reset); too many crashes in quick succession stops the loop so a persistently broken build
// doesn't hot-spawn forever. Mirrors the webhook forwarder's backoff.
const SERVER_HEALTHY_MS = 30_000;
const SERVER_MAX_RESTARTS = 5;

function startServer() {
  // Clear the port in case a previous server (e.g. a stale dev run, or a half-dead child) lingers.
  freePort();
  serverStartedAt = Date.now();
  serverProcess = fork(path.join(__dirname, '..', '..', 'server', 'app.js'), [], {
    // The forked server is plain Node and can't read Electron's app paths, so hand it a
    // writable data dir explicitly (never inside the asar). ELECTRON_RUN_AS_NODE makes the
    // child run as plain Node — without it, fork() reuses the Electron binary (execPath)
    // and in a packaged build would boot a whole second Electron runtime, not Node.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT), TASKHUB_DATA_DIR: app.getPath('userData') },
    silent: false,
  });
  serverProcess.on('error', (err) => console.error('[tray] server error:', err));
  serverProcess.on('exit', (code, signal) => {
    serverProcess = null;
    if (shuttingDown) return; // deliberate teardown, not a crash
    console.warn(`[tray] server exited (${code ?? signal ?? 'unknown'})`);
    if (Date.now() - serverStartedAt > SERVER_HEALTHY_MS) serverFailures = 0;
    if (++serverFailures > SERVER_MAX_RESTARTS) {
      console.error(`[tray] server crashed ${serverFailures} times in quick succession — not restarting. Quit and relaunch TaskHub.`);
      return;
    }
    const delay = Math.min(1000 * 2 ** (serverFailures - 1), 30_000);
    console.warn(`[tray] restarting server in ${delay}ms (attempt ${serverFailures})`);
    serverRestartTimer = setTimeout(startServer, delay);
  });
}

// Kill whatever is holding our port (e.g. a stale server from a previous run).
function freePort() {
  try { execSync(`lsof -ti:${PORT} | xargs kill -9`, { stdio: 'ignore' }); }
  catch { /* nothing to kill */ }
}

// Wait for the HTTP server to be ready.
function waitForServer(retries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(BASE_URL, () => resolve()).on('error', () => {
        if (n <= 0) return reject(new Error('Server did not start'));
        setTimeout(() => attempt(n - 1), 500);
      });
    };
    attempt(retries);
  });
}

// GET a local API path; resolves [] on any failure so menu builds never throw.
async function fetchJSON(path) {
  return new Promise((resolve) => {
    http.get(BASE_URL + path, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve([]); } });
    }).on('error', () => resolve([]));
  });
}

// POST JSON to a local API path; resolves null on any failure (callers are best-effort,
// like the tray recording a viewed review). Mirrors fetchJSON's never-throw contract.
function postJSON(path, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request(BASE_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(data);
    req.end();
  });
}

const getServerPid = () => serverProcess?.pid || null;

// Deliberate teardown on quit: stop the respawn loop and kill the child.
function shutdown() {
  shuttingDown = true;
  if (serverRestartTimer) { clearTimeout(serverRestartTimer); serverRestartTimer = null; }
  if (serverProcess) {
    const child = serverProcess;
    serverProcess = null;
    try { child.kill(); } catch {}
  }
}

module.exports = { startServer, freePort, waitForServer, fetchJSON, postJSON, getServerPid, shutdown };
