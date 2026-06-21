// Project CRUD + workspace→repo auto-detection. Mutations re-sync the webhook
// forwarder so new/changed repos start (or stop) forwarding immediately.
const crypto = require('node:crypto');
const db = require('../database/db');
const github = require('../repositories/github');
const jira = require('../repositories/jira');
const forwarder = require('../services/webhook-forwarder');
const poller = require('../services/poller');
const versionScript = require('../services/version-script');
const { ROUTES } = require('../../shared/routes.mjs');

// Short-lived cache of a project's Jira version names, keyed by project id. The fix-version
// preview re-fetches these on every debounced keystroke; the list barely moves during an edit,
// so a few seconds of caching collapses a typing burst's worth of `acli` spawns into one.
const _previewVersions = new Map(); // id -> { at, names }
const PREVIEW_VERSIONS_TTL = 15000;
async function previewVersions(project) {
  const hit = _previewVersions.get(project.id);
  if (hit && Date.now() - hit.at < PREVIEW_VERSIONS_TTL) return hit.names;
  let names = [];
  try { names = (await jira.listVersions(project.jiraProjectKey)).map(v => v.name); } catch { /* ignore */ }
  _previewVersions.set(project.id, { at: Date.now(), names });
  return names;
}

// A new/changed project has no fresh snapshot yet, so fetch its PRs + Jira (tab + board)
// now — the snapshot writes broadcast sync/jira-sync, which every subscribed UI (dashboard,
// scrumboard, tray) reacts to. This is why the renderer no longer pokes /api/poll after a
// save. Fire-and-forget: all three are async (gh + acli over execFile).
function kickSync(project) {
  poller.syncProject(project).catch(err => console.error('[sync] project resync failed:', err.message));
  poller.syncProjectJira(project).catch(err => console.error('[jira-sync] tab resync failed:', err.message));
  poller.syncProjectBoard(project).catch(err => console.error('[jira-sync] board resync failed:', err.message));
}

// Per-project workflow recipes (Workflows tab). Never trust the client: whitelist the CLI,
// cap counts/lengths, drop steps with no command, and ensure every workflow has a stable id.
// A step is { title, command }: the command is typed into the terminal; the title is the
// step's goal, fed to the headless CLI so it can judge whether the step is done.
function sanitizeSteps(w) {
  const raw = Array.isArray(w?.steps) ? w.steps
    : Array.isArray(w?.commands) ? w.commands.map(c => ({ command: c })) // tolerate the old shape
      : [];
  return raw
    .map(s => ({ title: String(s?.title || '').slice(0, 120), command: String(s?.command || '').slice(0, 500) }))
    .filter(s => s.command.trim())
    .slice(0, 20);
}
function sanitizeWorkflows(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 20).map(w => ({
    id: (w && typeof w.id === 'string' && w.id) ? w.id.slice(0, 64) : crypto.randomUUID(),
    name: String(w?.name || '').slice(0, 80),
    cli: w?.cli === 'codex' ? 'codex' : 'claude',
    steps: sanitizeSteps(w),
  }));
}

// Build the validated patch for a project from a request body.
// Returns { patch } or { error }.
function projectPatch(body) {
  const patch = {};
  if (body.name  !== undefined) {
    if (!String(body.name).trim()) return { error: 'name required' };
    patch.name = String(body.name).trim();
  }
  if (body.jql   !== undefined) patch.jql   = String(body.jql).trim();
  if (body.workspace !== undefined) patch.workspace = String(body.workspace).trim();
  if (body.jiraProjectKey !== undefined) patch.jiraProjectKey = String(body.jiraProjectKey).trim().toUpperCase();
  if (body.mergeTransition !== undefined) patch.mergeTransition = String(body.mergeTransition).trim();
  if (body.forwardWebhooks !== undefined) patch.forwardWebhooks = !!body.forwardWebhooks;
  // On-merge "set Fix Version" automation: a toggle, a platform prefix, and a JS script that
  // returns the number part. The Jira API token to write it is a global setting (Settings → Jira).
  if (body.fixVersionEnabled !== undefined) patch.fixVersionEnabled = !!body.fixVersionEnabled;
  if (body.fixVersionPrefix !== undefined) patch.fixVersionPrefix = String(body.fixVersionPrefix).trim();
  if (body.fixVersionScript !== undefined) patch.fixVersionScript = String(body.fixVersionScript);
  if (body.workflows !== undefined) patch.workflows = sanitizeWorkflows(body.workflows);
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

function register(app, PORT) {
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
    kickSync(project);
  });

  app.put(ROUTES.PROJECT, (req, res) => {
    const { patch, error } = projectPatch(req.body);
    if (error) return res.status(400).json({ error });
    const project = db.updateProject(req.params.id, patch);
    if (!project) return res.status(404).json({ error: 'Not found' });
    forwarder.sync(PORT);
    res.json(project);
    kickSync(project);
  });

  app.delete(ROUTES.PROJECT, (req, res) => {
    db.deleteProject(req.params.id);
    forwarder.sync(PORT);
    res.json({ ok: true });
  });

  // Live preview for the Automation tab: evaluate the (unsaved) prefix + script and return the
  // assembled version name. The script's `versions` input is the project's real Jira versions.
  app.post(ROUTES.PROJECT_FIXVERSION_PREVIEW, async (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'project not found' });
    // Existing versions feed the script's `versions` input + the "exists?" badge. They rarely
    // change mid-edit, so cache them briefly per project — otherwise every debounced keystroke
    // spawns an `acli project view` subprocess. A Jira/acli hiccup shouldn't break the script
    // preview either — fall back to an empty list.
    const versions = await previewVersions(project);
    try {
      const pr = { number: 0, title: 'Sample PR', body: '' };
      const { version, number } = versionScript.buildVersion(
        String(req.body.prefix || ''), String(req.body.script || ''),
        { now: new Date(), pr, versions });
      res.json({ version, number, exists: versions.includes(version) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Resolve the GitHub "owner/repo" for a local checkout, so the UI can auto-fill a
  // project's repo from its workspace folder. Returns { repo: '' } when none is found.
  app.get(ROUTES.DETECT_REPO, async (req, res) => {
    const dir = req.query.path;
    if (!dir) return res.status(400).json({ error: 'path required' });
    res.json({ repo: (await github.gitRemoteRepo(String(dir))) || '' });
  });
}

module.exports = { register };
