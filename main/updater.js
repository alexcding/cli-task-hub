// Auto-update from GitHub Releases. The publish config baked into the build
// tells electron-updater where to look; it fetches latest-mac.yml, downloads a
// newer signed build in the background, and installs it on the next quit.
// Only meaningful in a packaged, Developer-ID-signed build — Squirrel.Mac
// rejects ad-hoc/unsigned updates, and dev runs have no update manifest.
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

const SIX_HOURS = 6 * 60 * 60 * 1000;

function setupAutoUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (err) => console.error('[updater]', err?.message || err));
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] ${info.version} downloaded — installs on quit`);
  });
  const check = () => autoUpdater.checkForUpdatesAndNotify().catch(
    (err) => console.error('[updater] check failed:', err?.message || err),
  );
  check();
  setInterval(check, SIX_HOURS); // tray app rarely quits, so poll periodically
}

module.exports = { setupAutoUpdates };
