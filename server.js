// Cache compiled V8 bytecode to disk for faster cold starts (no-op pre-Node 22.8).
try { require('node:module').enableCompileCache?.(); } catch {}

const express = require('express');
const path = require('path');
const db = require('./lib/db');
const configdb = require('./lib/configdb');
const github = require('./lib/github');
const jira = require('./lib/jira');
const poller = require('./lib/poller');
const forwarder = require('./lib/webhook-forwarder');

const PORT = parseInt(process.env.PORT || '3000', 10);

const app = express();
app.use(express.json());
// Never cache static assets — this is a localhost tool; a refresh should always
// show the latest UI (avoids "I edited the file but don't see changes").
app.use(express.static(path.join(__dirname, 'public'), {
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

const wrap = fn => (req, res) => {
  try { fn(req, res); }
  catch (err) { res.status(500).json({ error: err.message }); }
};

// Build the validated patch for a project from a request body.
// Returns { patch } or { error }.
function projectPatch(body) {
  const patch = {};
  if (body.name  !== undefined) {
    if (!String(body.name).trim()) return { error: 'name required' };
    patch.name = String(body.name).trim();
  }
  if (body.color !== undefined) patch.color = body.color;
  if (body.jql   !== undefined) patch.jql   = String(body.jql).trim();
  if (body.workspace !== undefined) patch.workspace = String(body.workspace).trim();
  if (body.jiraProjectKey !== undefined) patch.jiraProjectKey = String(body.jiraProjectKey).trim().toUpperCase();
  if (body.mergeTransition !== undefined) patch.mergeTransition = String(body.mergeTransition).trim();
  if (body.repo  !== undefined) {
    const raw = String(body.repo).trim();
    if (raw === '') { patch.repo = ''; }
    else {
      const parsed = github.parseRepo(raw);
      if (!parsed) return { error: 'Invalid repo — use owner/repo or a GitHub URL' };
      patch.repo = parsed;
    }
  }
  return { patch };
}

// ── Config ────────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => res.json(db.getConfig()));
app.post('/api/config', (req, res) => {
  for (const [k, v] of Object.entries(req.body)) db.set(k, v);
  res.json({ ok: true });
});

// ── Settings (config.db key/value — theme today, room for more) ─────────────────
// One-time migration: the theme used to live in the JSON config store as `app_theme`.
// Seed it into the settings table on first boot so existing users keep their choice.
if (configdb.getSetting('theme') == null) {
  const legacy = db.get('app_theme');
  if (legacy) configdb.setSetting('theme', legacy);
}
app.get('/api/settings', wrap((req, res) => res.json(configdb.getAllSettings())));
app.put('/api/settings/:key', wrap((req, res) => {
  configdb.setSetting(req.params.key, req.body.value);
  res.json({ ok: true });
}));

// ── Tabs (config.db — open viewer tabs, persisted across restarts) ──────────────
// Rows, not a blob: see lib/configdb.js. The renderer PUTs its full ordered set on
// every change; reads it back on launch to rehydrate the sidebar.
app.get('/api/tabs', wrap((req, res) => res.json(configdb.getTabs())));
app.put('/api/tabs', wrap((req, res) => {
  configdb.setTabs(Array.isArray(req.body.tabs) ? req.body.tabs : [], req.body.active ?? null);
  res.json({ ok: true });
}));

// ── Projects ──────────────────────────────────────────────────────────────────
app.get('/api/projects', (req, res) => res.json(db.getProjects()));

app.get('/api/projects/:id', (req, res) => {
  const project = db.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  res.json(project);
});

app.post('/api/projects', (req, res) => {
  const { patch, error } = projectPatch(req.body);
  if (error) return res.status(400).json({ error });
  if (!patch.name) return res.status(400).json({ error: 'name required' });
  const project = db.addProject(patch);
  forwarder.sync(PORT);
  res.json(project);
});

app.put('/api/projects/:id', (req, res) => {
  const { patch, error } = projectPatch(req.body);
  if (error) return res.status(400).json({ error });
  const project = db.updateProject(req.params.id, patch);
  if (!project) return res.status(404).json({ error: 'Not found' });
  forwarder.sync(PORT);
  res.json(project);
});

app.delete('/api/projects/:id', (req, res) => {
  db.deleteProject(req.params.id);
  forwarder.sync(PORT);
  res.json({ ok: true });
});

// Resolve the GitHub "owner/repo" for a local checkout, so the UI can auto-fill a
// project's repo from its workspace folder. Returns { repo: '' } when none is found.
app.get('/api/detect-repo', async (req, res) => {
  const dir = req.query.path;
  if (!dir) return res.status(400).json({ error: 'path required' });
  res.json({ repo: (await github.gitRemoteRepo(String(dir))) || '' });
});

// Local worktree path checked out at `branch` within `path` (so a PR's terminal can
// open in the matching worktree instead of the main checkout). { path: '' } if none.
app.get('/api/worktree', async (req, res) => {
  const { path: dir, branch } = req.query;
  if (!dir || !branch) return res.json({ path: '' });
  res.json({ path: (await github.worktreeForBranch(String(dir), String(branch))) || '' });
});

// ── Pull requests (stale-while-revalidate) ──────────────────────────────────────
// The UI always reads the snapshot the sync loop writes — never `gh` directly.
// On read we kick a background sync if the snapshot is stale; when it lands the
// new data is pushed to open pages over SSE.
const STALE_MS = 30_000;

function isStale(snap) {
  return !snap || !snap.lastSynced || (Date.now() - Date.parse(snap.lastSynced) > STALE_MS);
}

// Return the cached snapshot for a project, revalidating in the background if stale.
function snapshotFor(project) {
  const snap = db.getSnapshot(project.id);
  if (project.repo && isStale(snap)) poller.syncProject(project).catch(() => {});
  return snap;
}

// Project-scoped PR list. `open` is served from the snapshot; merged/all is a live
// fetch (rare, on-demand from the state filter).
app.get('/api/projects/:id/prs', async (req, res) => {
  const project = db.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (!project.repo) return res.json([]);

  const state = req.query.state || 'open';
  if (state === 'open') return res.json(snapshotFor(project)?.prs || []);

  try {
    const prs = await github.getPRs(project.repo, state, 30, { ci: true });
    res.json(prs.map(p => ({ ...p, repo: project.repo })));
  } catch (err) {
    res.json([{ repo: project.repo, error: err.message }]);
  }
});

// Compact list with CI for the tray — read straight from snapshots.
app.get('/api/prs/tray', (req, res) => {
  const items = [];
  for (const project of db.getProjects()) {
    const snap = snapshotFor(project);
    for (const pr of snap?.prs || []) {
      items.push({ ...pr, projectId: project.id, projectName: project.name });
    }
  }
  res.json(items);
});

// Dashboard: every project with its snapshotted open PRs + freshness info.
app.get('/api/dashboard', (req, res) => {
  res.json(db.getProjects().map(project => {
    const snap = snapshotFor(project);
    return { ...project, prs: snap?.prs || [], lastSynced: snap?.lastSynced || null, syncError: snap?.error || null };
  }));
});

// ── Jira ──────────────────────────────────────────────────────────────────────
// Snapshots (assigned-to-me + per-project) follow the same stale-while-revalidate
// model as PRs: read the cached snapshot the Jira sync loop writes; if it's stale,
// kick a background refresh whose result lands over SSE. Jira changes less often
// than PR CI, so the staleness window is longer.
const JIRA_STALE_MS = 90_000;
const jiraStale = snap => !snap || !snap.lastSynced || (Date.now() - Date.parse(snap.lastSynced) > JIRA_STALE_MS);

// Base URL for ticket links. Prefer an explicit `jira_base_url` config override;
// otherwise auto-detect the site from `acli jira auth status` (cached — it doesn't
// change within a session). The UI reads this instead of hardcoding a host.
let _jiraBaseCache = null;
function jiraBaseUrl() {
  const override = db.get('jira_base_url');
  if (override) return override.replace(/\/+$/, '');
  if (_jiraBaseCache) return _jiraBaseCache;
  try {
    const site = jira.getSite();
    if (site) _jiraBaseCache = /^https?:\/\//.test(site) ? site.replace(/\/+$/, '') : `https://${site}`;
  } catch { /* not authed yet — UI falls back to no link */ }
  return _jiraBaseCache || '';
}
app.get('/api/jira/site', wrap((req, res) => res.json({ baseUrl: jiraBaseUrl() })));

// Global "assigned to me" feed. Declared before '/api/jira/:key' so this literal
// path wins over the :key param.
app.get('/api/jira/mine', wrap((req, res) => {
  const snap = db.getJiraSnapshot(poller.MY_TICKETS_ID);
  if (jiraStale(snap)) poller.syncJiraMine();
  res.json(snap || { items: [], jql: '', lastSynced: null, error: null });
}));

// Global "my work in the active sprint(s)" feed (dashboard).
app.get('/api/jira/sprint', wrap((req, res) => {
  const snap = db.getJiraSnapshot(poller.MY_SPRINT_ID);
  if (jiraStale(snap)) poller.syncJiraSprint();
  res.json(snap || { items: [], jql: '', lastSynced: null, error: null });
}));

// Per-project Jira feed (the project's saved JQL).
app.get('/api/projects/:id/jira', wrap((req, res) => {
  const project = db.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const snap = db.getJiraSnapshot(project.id);
  if (project.jql && jiraStale(snap)) poller.syncProjectJira(project);
  res.json(snap || { items: [], jql: project.jql || '', lastSynced: null, error: null });
}));

// Ad-hoc live search (e.g. previewing a JQL before saving it).
app.get('/api/jira/search', wrap((req, res) => {
  const jql = req.query.jql || 'assignee = currentUser() ORDER BY updated DESC';
  res.json(jira.searchWorkItems(jql, 30));
}));

app.get('/api/jira/:key', wrap((req, res) => res.json(jira.getWorkItem(req.params.key))));

app.post('/api/jira/:key/transition', wrap((req, res) => {
  jira.transitionWorkItem(req.params.key, req.body.transition);
  db.addEvent('jira_transitioned', { key: req.params.key, transition: req.body.transition, trigger: 'manual' });
  res.json({ ok: true });
}));

// ── Links ───────────────────────────────────────────────────────────────────────
app.get('/api/links', (req, res) => res.json(db.getLinks(req.query.project)));
app.post('/api/links', (req, res) => {
  const { prNumber, prRepo, jiraKey, projectId } = req.body;
  if (!prNumber || !prRepo || !jiraKey) return res.status(400).json({ error: 'prNumber, prRepo, jiraKey required' });
  db.addLink(prNumber, prRepo, jiraKey, projectId);
  res.json({ ok: true });
});
app.delete('/api/links/:id', (req, res) => { db.removeLink(req.params.id); res.json({ ok: true }); });

// ── Events ────────────────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => res.json(db.getEvents(100)));

// ── DB inspector (Settings) ─────────────────────────────────────────────────────
app.get('/api/db', (req, res) => {
  const snaps = db.getAllSnapshots();
  const jsnaps = db.getAllJiraSnapshots();
  res.json({
    config: db.getConfig(),
    projects: db.getProjects(),
    counts: { projects: db.getProjects().length, links: db.getLinks().length, events: db.getEvents(1000).length },
    snapshots: Object.fromEntries(Object.entries(snaps).map(([id, s]) =>
      [id, { open: s.prs?.length || 0, lastSynced: s.lastSynced, error: s.error || null }])),
    jiraSnapshots: Object.fromEntries(Object.entries(jsnaps).map(([id, s]) =>
      [id, { tickets: s.items?.length || 0, lastSynced: s.lastSynced, error: s.error || null }])),
  });
});

// ── Live updates (SSE) ──────────────────────────────────────────────────────────
// Pages subscribe here; when the sync loop refreshes a project's snapshot we push
// an event so the open UI re-reads the snapshot (no client-side polling needed).
const sseClients = new Set();

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('retry: 1000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch {} }
}
const publishSync = projectId => broadcast({ type: 'sync', projectId });
const publishJiraSync = id => broadcast({ type: 'jira-sync', id });

// ── Dev live reload ─────────────────────────────────────────────────────────────
// Watch public/ and tell open pages to reload on change. Disabled in the packaged
// app (files live inside app.asar, which isn't watchable/editable).
const isPackaged = __dirname.includes('app.asar');
if (!isPackaged) {
  try {
    let t = null;
    require('fs').watch(path.join(__dirname, 'public'), { recursive: true }, () => {
      clearTimeout(t);
      t = setTimeout(() => broadcast({ type: 'reload' }), 100);
    });
    console.log('[dev] live reload watching public/');
  } catch (err) { console.warn('[dev] live reload unavailable:', err.message); }
}

// ── GitHub webhook ──────────────────────────────────────────────────────────────
app.post('/webhook/github', (req, res) => {
  res.sendStatus(200);
  if (req.headers['x-github-event'] !== 'pull_request') return;
  const { action, pull_request: pr, repository } = req.body;
  if (action !== 'closed' || !pr?.merged) return;
  const repo = repository?.full_name;
  if (!repo) return;
  console.log(`[webhook] PR #${pr.number} merged in ${repo}`);
  poller.handleMerge(repo, { number: pr.number, title: pr.title, url: pr.html_url, body: pr.body });
});

// ── Forwarders ────────────────────────────────────────────────────────────────
app.get('/api/forwarders', (req, res) => res.json(forwarder.list()));
app.post('/api/forwarders/sync', (req, res) => { forwarder.sync(PORT); res.json(forwarder.list()); });

// ── Poll trigger ────────────────────────────────────────────────────────────────
app.post('/api/poll', async (req, res) => {
  try { await poller.poll(); poller.pollJira(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
// Bind to loopback only: TaskHub is an Electron-only app, not meant to be reached
// over the LAN by IP (the embedded GitHub/Jira <webview>s and header-stripping are
// Electron-only and don't work in a plain browser anyway).
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`TaskHub running at http://localhost:${PORT}`);
  poller.start(publishSync);         // PR sync loop publishes snapshot updates over SSE
  poller.startJira(publishJiraSync); // Jira sync loop (assigned-to-me + per-project)
  forwarder.sync(PORT);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] Port ${PORT} is already in use — another TaskHub is running.`);
    process.exit(1);
  }
  throw err;
});

process.on('SIGTERM', () => { forwarder.stopAll(); process.exit(0); });
process.on('SIGINT',  () => { forwarder.stopAll(); process.exit(0); });

module.exports = app;
