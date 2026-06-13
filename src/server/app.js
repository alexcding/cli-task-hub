// Cache compiled V8 bytecode to disk for faster cold starts (no-op pre-Node 22.8).
try { require('node:module').enableCompileCache?.(); } catch {}

// Load first so console.* is routed to the log file before any other module logs.
require('./logger');

const express = require('express');
const path = require('path');
const db = require('./database/db');
const configdb = require('./database/configdb');
const github = require('./repositories/github');
const jira = require('./repositories/jira');
const poller = require('./services/poller');
const usage = require('./repositories/usage');
const forwarder = require('./services/webhook-forwarder');
const { PR_CATEGORY } = require('../shared/constants.mjs');
const { ROUTES } = require('../shared/routes.mjs');

const PORT = parseInt(process.env.PORT || '3000', 10);

const app = express();
// Only /api/git/discard carries a big body (a patch); everything else keeps the
// default 100kb cap so one route's needs don't widen the whole API's buffer ceiling.
const jsonBig = express.json({ limit: '15mb' });
const jsonStd = express.json();
app.use((req, res, next) => (req.path === ROUTES.GIT_DISCARD ? jsonBig : jsonStd)(req, res, next));
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
  if (body.forwardWebhooks !== undefined) patch.forwardWebhooks = !!body.forwardWebhooks;
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
app.get(ROUTES.CONFIG, (req, res) => res.json(db.getConfig()));
app.post(ROUTES.CONFIG, (req, res) => {
  for (const [k, v] of Object.entries(req.body)) db.set(k, v);
  res.json({ ok: true });
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
// Rows, not a blob: see src/server/database/configdb.js. The renderer PUTs its full ordered set on
// every change; reads it back on launch to rehydrate the sidebar.
app.get(ROUTES.TABS, wrap((req, res) => res.json(configdb.getTabs())));
app.put(ROUTES.TABS, wrap((req, res) => {
  configdb.setTabs(Array.isArray(req.body.tabs) ? req.body.tabs : [], req.body.active ?? null);
  res.json({ ok: true });
}));

// ── Projects ──────────────────────────────────────────────────────────────────
app.get(ROUTES.PROJECTS, (req, res) => res.json(db.getProjects()));

app.get(ROUTES.PROJECT, (req, res) => {
  const project = db.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  res.json(project);
});

app.post(ROUTES.PROJECTS, (req, res) => {
  const { patch, error } = projectPatch(req.body);
  if (error) return res.status(400).json({ error });
  if (!patch.name) return res.status(400).json({ error: 'name required' });
  const project = db.addProject(patch);
  forwarder.sync(PORT);
  res.json(project);
});

app.put(ROUTES.PROJECT, (req, res) => {
  const { patch, error } = projectPatch(req.body);
  if (error) return res.status(400).json({ error });
  const project = db.updateProject(req.params.id, patch);
  if (!project) return res.status(404).json({ error: 'Not found' });
  forwarder.sync(PORT);
  res.json(project);
});

app.delete(ROUTES.PROJECT, (req, res) => {
  db.deleteProject(req.params.id);
  forwarder.sync(PORT);
  res.json({ ok: true });
});

// Resolve the GitHub "owner/repo" for a local checkout, so the UI can auto-fill a
// project's repo from its workspace folder. Returns { repo: '' } when none is found.
app.get(ROUTES.DETECT_REPO, async (req, res) => {
  const dir = req.query.path;
  if (!dir) return res.status(400).json({ error: 'path required' });
  res.json({ repo: (await github.gitRemoteRepo(String(dir))) || '' });
});

// Where a tab's branch/key is checked out, so the terminal can open there and the titlebar
// chip can label it. Resolve by exact `branch` (GitHub PR) or by Jira `key` embedded in a
// branch name (RECORD-1234 → feature/RECORD-1234-foo). Returns:
//   { path, matched, isWorktree } — matched: a tree has it checked out; isWorktree: that
//   tree is a dedicated (linked) worktree, not the shared main checkout.
// { path: '', matched: false } when nothing matches (or, for a key, the match is ambiguous).
app.get(ROUTES.WORKTREE, async (req, res) => {
  const { path: dir, branch, key } = req.query;
  if (!dir || (!branch && !key)) return res.json({ path: '', matched: false, isWorktree: false });
  const found = key
    ? await github.worktreeForJiraKey(String(dir), String(key))
    : await github.worktreeForBranch(String(dir), String(branch));
  res.json({ path: found?.path || '', matched: !!found, isWorktree: !!(found && !found.isMain) });
});

// Create a git worktree for a PR branch as a sibling of the project workspace, so the
// tab can get its own checkout. Local git only. Returns { path } on success or { error }.
app.post(ROUTES.WORKTREE, async (req, res) => {
  const { path: dir, branch } = req.body || {};
  if (!dir || !branch) return res.status(400).json({ error: 'path and branch required' });
  res.json(await github.createWorktree(String(dir), String(branch)));
});

// Remove a worktree (folder + admin entry), run from the project workspace. Local git only.
app.post(ROUTES.WORKTREE_REMOVE, async (req, res) => {
  const { path: dir, worktree } = req.body || {};
  if (!dir || !worktree) return res.status(400).json({ error: 'path and worktree required' });
  res.json(await github.removeWorktree(String(dir), String(worktree)));
});

// Uncommitted changes in a checkout (the diff pane). Local git only — same class of
// on-demand local exec as /api/detect-repo and /api/worktree, not a `gh` call.
app.get(ROUTES.DIFF, async (req, res) => {
  const dir = req.query.path;
  if (!dir) return res.status(400).json({ error: 'path required' });
  res.json(await github.gitDiff(String(dir)));
});

// Commit/push the worktree's changes (the diff pane's commit popover). The renderer
// always sends a message — blank input is auto-filled client-side before the request.
app.post(ROUTES.GIT_COMMIT, async (req, res) => {
  const { path: dir, message, includeUntracked } = req.body || {};
  if (!dir) return res.status(400).json({ error: 'path required' });
  if (!String(message || '').trim()) return res.status(400).json({ error: 'message required' });
  res.json(await github.gitCommit(String(dir), String(message), includeUntracked !== false));
});

app.post(ROUTES.GIT_PUSH, async (req, res) => {
  const dir = req.body && req.body.path;
  if (!dir) return res.status(400).json({ error: 'path required' });
  res.json(await github.gitPush(String(dir)));
});

// Commit history for the project History view (graph + list). Read-only local git.
app.get(ROUTES.GIT_LOG, async (req, res) => {
  const dir = req.query.path;
  if (!dir) return res.status(400).json({ error: 'path required' });
  res.json(await github.gitLog(String(dir), { limit: Number(req.query.limit) || 100, skip: Number(req.query.skip) || 0, ref: req.query.ref ? String(req.query.ref) : '' }));
});

// Local branches + worktree folders + default branch for the Git tab's left rail. Read-only
// local git. defaultBranch ships here (not just in /log) so the rail can pin it on first paint.
app.get(ROUTES.GIT_REFS, async (req, res) => {
  const dir = req.query.path;
  if (!dir) return res.status(400).json({ error: 'path required' });
  const [branches, worktrees, defaultBranch] = await Promise.all([
    github.gitBranches(String(dir)), github.listWorktrees(String(dir)), github.gitDefaultBranch(String(dir)),
  ]);
  res.json({ branches, worktrees, defaultBranch });
});

// Real GitHub avatars for commit authors (keyed by SHA) — the Git tab overlays these on its
// generated initials avatars. `gh`-backed, cached; returns {} when the repo isn't on GitHub.
app.get(ROUTES.GIT_COMMIT_AVATARS, async (req, res) => {
  const { repo, ref, limit } = req.query;
  res.json(await github.commitAvatars(repo ? String(repo) : '', ref ? String(ref) : '', Number(limit) || 100));
});

// One commit's detail (meta + patch) for the History detail pane.
app.get(ROUTES.GIT_SHOW, async (req, res) => {
  const { path: dir, sha } = req.query;
  if (!dir || !sha) return res.status(400).json({ error: 'path and sha required' });
  res.json(await github.gitShow(String(dir), String(sha)));
});

// Discard one hunk from the worktree (reverse-apply a single-hunk patch the renderer
// rebuilt from its parsed diff — see hunkPatch in src/renderer/lib/diff-parse.mjs).
app.post(ROUTES.GIT_DISCARD, async (req, res) => {
  const { path: dir, patch } = req.body || {};
  if (!dir || !patch) return res.status(400).json({ error: 'path and patch required' });
  res.json(await github.gitDiscard(String(dir), String(patch)));
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
app.get(ROUTES.PROJECT_PRS, async (req, res) => {
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

// Compact list with CI for the tray — read straight from snapshots. For PRs awaiting my
// review we attach reviewPending: the tray's "Review requested" list shows a PR while its
// latest request (requestedAt, set by the poller) is newer than when I last opened it
// (viewedAt). Missing requestedAt → pending (never silently drop a request).
app.get(ROUTES.PRS_TRAY, (req, res) => {
  const items = [];
  for (const project of db.getProjects()) {
    const snap = snapshotFor(project);
    for (const pr of snap?.prs || []) {
      const item = { ...pr, projectId: project.id, projectName: project.name };
      if (pr.category === PR_CATEGORY.REVIEW) {
        const st = db.getReviewState(`${pr.repo}#${pr.number}`);
        item.viewedAt = st?.viewed_at || null;
        item.requestedAt = pr.requestedAt || st?.requested_at || null;
        item.reviewPending = !item.requestedAt || !item.viewedAt || item.requestedAt > item.viewedAt;
      }
      items.push(item);
    }
  }
  res.json(items);
});

// Mark a review request as opened (acknowledged) — clicked from the tray's "Review
// requested" list. Hides it until a newer request arrives (see /api/prs/tray).
app.post(ROUTES.PRS_VIEWED, (req, res) => {
  const { repo, number } = req.body || {};
  if (!repo || number == null) return res.status(400).json({ error: 'repo and number required' });
  db.setReviewViewed(`${repo}#${number}`, new Date().toISOString());
  res.json({ ok: true });
});

// Dashboard: every project with its snapshotted open PRs + freshness info.
app.get(ROUTES.DASHBOARD, (req, res) => {
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
app.get(ROUTES.JIRA_SITE, wrap((req, res) => res.json({ baseUrl: jiraBaseUrl() })));

// Global "assigned to me" feed. Declared before ROUTES.JIRA_KEY so this literal
// path wins over the :key param.
app.get(ROUTES.JIRA_MINE, wrap((req, res) => {
  const snap = db.getJiraSnapshot(poller.MY_TICKETS_ID);
  if (jiraStale(snap)) poller.syncJiraMine();
  res.json(snap || { items: [], jql: '', lastSynced: null, error: null });
}));

// Global "my work in the active sprint(s)" feed (dashboard). The active sprint's
// name/end date lives in poller memory (not the snapshot table), merged in here.
app.get(ROUTES.JIRA_SPRINT, wrap((req, res) => {
  const snap = db.getJiraSnapshot(poller.MY_SPRINT_ID);
  if (jiraStale(snap)) poller.syncJiraSprint();
  res.json({ ...(snap || { items: [], jql: '', lastSynced: null, error: null }), sprint: poller.currentSprint() });
}));

// Per-project Jira feed (the project's saved JQL).
app.get(ROUTES.PROJECT_JIRA, wrap((req, res) => {
  const project = db.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const snap = db.getJiraSnapshot(project.id);
  // Effective JQL falls back to the project's Jira key, so a key-only project still
  // has a feed (see poller.projectJql). Gate the sync and report it so the tab knows
  // there's a query even before the first snapshot lands.
  const eff = poller.projectJql(project);
  if (eff && jiraStale(snap)) poller.syncProjectJira(project);
  res.json(snap ? { ...snap, jql: snap.jql || eff } : { items: [], jql: eff, lastSynced: null, error: null });
}));

// Ad-hoc live search (e.g. previewing a JQL before saving it).
app.get(ROUTES.JIRA_SEARCH, wrap((req, res) => {
  const jql = req.query.jql || 'assignee = currentUser() ORDER BY updated DESC';
  res.json(jira.searchWorkItems(jql, 30));
}));

app.get(ROUTES.JIRA_KEY, wrap((req, res) => res.json(jira.getWorkItem(req.params.key))));

app.post(ROUTES.JIRA_KEY_TRANSITION, wrap((req, res) => {
  jira.transitionWorkItem(req.params.key, req.body.transition);
  db.addEvent('jira_transitioned', { key: req.params.key, transition: req.body.transition, trigger: 'manual' });
  res.json({ ok: true });
}));

// ── Links ───────────────────────────────────────────────────────────────────────
app.get(ROUTES.LINKS, (req, res) => res.json(db.getLinks(req.query.project)));
app.post(ROUTES.LINKS, (req, res) => {
  const { prNumber, prRepo, jiraKey, projectId } = req.body;
  if (!prNumber || !prRepo || !jiraKey) return res.status(400).json({ error: 'prNumber, prRepo, jiraKey required' });
  db.addLink(prNumber, prRepo, jiraKey, projectId);
  res.json({ ok: true });
});
app.delete(ROUTES.LINK, (req, res) => { db.removeLink(req.params.id); res.json({ ok: true }); });

// ── Who am I (dashboard greeting) ───────────────────────────────────────────────
app.get(ROUTES.WHOAMI, (req, res) => {
  github.getUserName()
    .then(name => res.json({ name }))
    .catch(() => res.json({ name: '' }));
});

// ── AI token usage (dashboard hero) ─────────────────────────────────────────────
// Today's Claude Code / Codex usage via ccusage; src/server/repositories/usage.js caches SWR-style.
app.get(ROUTES.USAGE, (req, res) => {
  usage.getUsage()
    .then(u => res.json(u))
    .catch(err => res.status(500).json({ error: err.message }));
});

// ── Events / Logs ────────────────────────────────────────────────────────────────
// /api/events is the activity feed (category='event'); /api/logs is the full,
// filterable log viewer across all categories.
app.get(ROUTES.EVENTS, (req, res) => res.json(db.getEvents(100)));
app.get(ROUTES.LOGS, (req, res) => res.json(db.getLogs({
  category: req.query.category,
  level: req.query.level,
  limit: parseInt(req.query.limit, 10) || 200,
})));
app.get(ROUTES.LOGS_CATEGORIES, (req, res) => res.json(db.logCategories()));
app.post(ROUTES.LOGS_CLEAR, (req, res) => { db.clearLogs(req.body && req.body.category); res.json({ ok: true }); });

// ── DB inspector (Settings) ─────────────────────────────────────────────────────
app.get(ROUTES.DB, (req, res) => {
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

function broadcast(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch {} }
}
const publishSync = projectId => broadcast({ type: 'sync', projectId });
const publishJiraSync = id => broadcast({ type: 'jira-sync', id });

// ── Dev live reload ─────────────────────────────────────────────────────────────
// Watch the renderer AND the shared contracts (served to the page at /shared) and tell
// open pages to reload on change. src/shared is a sibling of src/renderer, so it needs
// its own watch — editing routes.mjs/constants.mjs must reload the page too. Disabled in
// the packaged app (files live inside app.asar, which isn't watchable/editable).
const isPackaged = __dirname.includes('app.asar');
if (!isPackaged) {
  try {
    let t = null;
    const reload = () => { clearTimeout(t); t = setTimeout(() => broadcast({ type: 'reload' }), 100); };
    for (const dir of ['renderer', 'shared']) {
      require('fs').watch(path.join(__dirname, '..', dir), { recursive: true }, reload);
    }
    console.log('[dev] live reload watching src/renderer + src/shared');
  } catch (err) { console.warn('[dev] live reload unavailable:', err.message); }
}

// ── GitHub webhook ──────────────────────────────────────────────────────────────
app.post(ROUTES.WEBHOOK_GITHUB, (req, res) => {
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
app.get(ROUTES.FORWARDERS, (req, res) => res.json(forwarder.list()));

// ── Poll trigger ────────────────────────────────────────────────────────────────
app.post(ROUTES.POLL, async (req, res) => {
  try { await poller.poll(); poller.pollJira(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

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
      poller.start(publishSync);         // PR sync loop publishes snapshot updates over SSE
      poller.startJira(publishJiraSync); // Jira sync loop (assigned-to-me + per-project)
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
