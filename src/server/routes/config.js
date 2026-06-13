// Config-flavored surface: the JSON config store, notification sounds, the
// taskhub.db key/value settings, and the persisted viewer tabs.
const path = require('path');
const db = require('../database/db');
const configdb = require('../database/configdb');
const poller = require('../services/poller');
const sse = require('./sse');
const { wrap } = require('./helpers');
const { ROUTES } = require('../../shared/routes.mjs');

function register(app) {
  // ── Config ────────────────────────────────────────────────────────────────────
  app.get(ROUTES.CONFIG, (req, res) => res.json(db.getConfig()));
  app.post(ROUTES.CONFIG, (req, res) => {
    for (const [k, v] of Object.entries(req.body)) db.set(k, v);
    res.json({ ok: true });
    // Only the JQL settings feed the global Jira lists — resync them now (so a JQL edit takes
    // effect immediately; the snapshot write broadcasts jira-sync, which the UIs react to) and
    // ONLY when a JQL actually changed. Other keys (e.g. poll_interval) must not trigger acli.
    // Deferred off the response: writeJiraSnapshot shells out to acli synchronously.
    if ('my_jql' in req.body || 'sprint_jql' in req.body) {
      setImmediate(() => {
        try { poller.syncJiraMine(); poller.syncJiraSprint(); }
        catch (err) { console.error('[config] jira resync failed:', err.message); }
      });
    }
  });

  // macOS notification sounds the user can pick for review alerts — the same folders
  // System Settings draws from. Each entry is { name, path }; the chosen path is stored
  // as the `reviewSound` setting and played by afplay (see src/main/native/notifications.js).
  app.get(ROUTES.SOUNDS, wrap((req, res) => {
    const fs = require('fs'), os = require('os');
    const dirs = ['/System/Library/Sounds', path.join(os.homedir(), 'Library', 'Sounds')];
    const sounds = [];
    for (const dir of dirs) {
      let files;
      try { files = fs.readdirSync(dir); } catch { continue; } // dir absent → skip
      for (const f of files.sort()) {
        if (!/\.(aiff?|wav|caf|m4a|mp3)$/i.test(f)) continue;
        sounds.push({ name: f.replace(/\.[^.]+$/, ''), path: path.join(dir, f) });
      }
    }
    res.json(sounds);
  }));

  // ── Settings (taskhub.db key/value — theme + ticket filter prefs) ───────────────
  app.get(ROUTES.SETTINGS, wrap((req, res) => res.json(configdb.getAllSettings())));
  app.put(ROUTES.SETTINGS_KEY, wrap((req, res) => {
    configdb.setSetting(req.params.key, req.body.value);
    res.json({ ok: true });
  }));

  // ── Tabs (taskhub.db — open viewer tabs, persisted across restarts) ─────────────
  // Rows, not a blob: see src/server/database/configdb.js. The renderer PUTs its full
  // ordered set on every change; reads it back on launch to rehydrate the sidebar.
  app.get(ROUTES.TABS, wrap((req, res) => res.json(configdb.getTabs())));
  app.put(ROUTES.TABS, wrap((req, res) => {
    configdb.setTabs(Array.isArray(req.body.tabs) ? req.body.tabs : [], req.body.active ?? null);
    sse.publishTabs(); // notify subscribers (renderer sidebar + tray menu) the tab set changed
    res.json({ ok: true });
  }));
}

module.exports = { register };
