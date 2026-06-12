// Centralized logging for both processes, built on electron-log.
//
// The app is two processes (see tray.js): the Electron *main* process (tray.js) and
// a *forked* plain-Node child (server.js). electron-log ships a variant for each —
// `electron-log/main` (wires up renderer IPC) and `electron-log/node` (no Electron) —
// so we pick by `process.type` ('browser' only inside the Electron main process).
//
// To avoid two processes racing on one file, each writes its own log under
// <userData>/logs/: main.log (tray + renderer) and server.log (forked server).
// electron-log rotates each at maxSize, archiving to <name>.old.log.
//
// `Object.assign(console, log.functions)` routes every existing console.log/warn/error
// call site (the [webhook], [jira-sync], [tray]… lines) into the file transport while
// still printing to stdout — so no call sites need to change.
const path = require('path');
const { dataDir } = require('./database/datadir');

const isElectronMain = process.type === 'browser';
const log = require(isElectronMain ? 'electron-log/main' : 'electron-log/node');

const logsDir = path.join(dataDir, 'logs');
const fileName = isElectronMain ? 'main.log' : 'server.log';

log.transports.file.resolvePathFn = () => path.join(logsDir, fileName);
log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB, then rotate to <name>.old.log
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
// Console transport keeps dev-terminal output readable (no timestamp clutter).
log.transports.console.format = '{h}:{i}:{s}.{ms} [{level}] {text}';

// In the main process, inject the preload bridge so renderer-side errors/logs are
// captured too, and spy on the SPA's console. Must run before any BrowserWindow.
if (isElectronMain && typeof log.initialize === 'function') {
  log.initialize({ spyRendererConsole: true });
}

// Adopt electron-log as the global console so existing call sites are captured.
Object.assign(console, log.functions);

module.exports = { log, logsDir, logFile: path.join(logsDir, fileName) };
