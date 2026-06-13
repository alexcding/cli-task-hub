// Live updates (SSE). Pages subscribe at /api/stream; when the sync loop refreshes a
// project's snapshot we push an event so the open UI re-reads the snapshot (no
// client-side polling needed). broadcast/publish* are exported for the poller wiring
// (app.js start()) and the dev live-reload watcher.
const { ROUTES } = require('../../shared/routes.mjs');

const sseClients = new Set();

function register(app) {
  app.get(ROUTES.STREAM, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });
}

function broadcast(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch {} }
}
const publishSync = projectId => broadcast({ type: 'sync', projectId });
const publishJiraSync = id => broadcast({ type: 'jira-sync', id });
// The open-tab set changed (renderer PUT /api/tabs). Subscribers that mirror the tabs — the
// renderer sidebar and the tray menu — re-read /api/tabs in response. No payload needed.
const publishTabs = () => broadcast({ type: 'tabs' });

module.exports = { register, broadcast, publishSync, publishJiraSync, publishTabs };
