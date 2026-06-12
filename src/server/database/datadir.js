// Shared resolver for the writable data directory, in its own module so db.js,
// configdb.js and datadb.js can all import it without circular requires.
//  1. TASKHUB_DATA_DIR — set by the Electron tray (points at app.getPath('userData')).
//     The forked server runs as plain Node, so it can't read Electron's app paths itself.
//  2. Electron app.getPath (when this happens to run inside the main process).
//  3. Repo root — for `node server.js` / dev.
const fs = require('fs');
const path = require('path');

const dataDir = (() => {
  if (process.env.TASKHUB_DATA_DIR) return process.env.TASKHUB_DATA_DIR;
  try {
    const { app } = require('electron');
    if (app && app.getPath) return app.getPath('userData');
  } catch {}
  return path.join(__dirname, '..', '..', '..');
})();

// Ensure it exists — node:sqlite (DatabaseSync) won't create missing parent dirs, so
// a fresh machine or a custom TASKHUB_DATA_DIR would otherwise fail to open the stores.
try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}

module.exports = { dataDir };
