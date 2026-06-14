// Project CRUD + workspace→repo auto-detection. Mutations re-sync the webhook
// forwarder so new/changed repos start (or stop) forwarding immediately.
const db = require('../database/db');
const github = require('../repositories/github');
const forwarder = require('../services/webhook-forwarder');
const poller = require('../services/poller');
const { ROUTES } = require('../../shared/routes.mjs');

// A new/changed project has no fresh snapshot yet, so fetch its PRs + Jira now — the snapshot
// writes broadcast sync/jira-sync, which every subscribed UI (dashboard, tray) reacts to. This
// is why the renderer no longer pokes /api/poll after a save. Deferred off the response:
// syncProject awaits gh and syncProjectJira shells out to acli synchronously.
function kickSync(project) {
  setImmediate(() => {
    poller.syncProject(project).catch(err => console.error('[sync] project resync failed:', err.message));
    try { poller.syncProjectJira(project); }
    catch (err) { console.error('[jira-sync] project resync failed:', err.message); }
  });
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

  // Resolve the GitHub "owner/repo" for a local checkout, so the UI can auto-fill a
  // project's repo from its workspace folder. Returns { repo: '' } when none is found.
  app.get(ROUTES.DETECT_REPO, async (req, res) => {
    const dir = req.query.path;
    if (!dir) return res.status(400).json({ error: 'path required' });
    res.json({ repo: (await github.gitRemoteRepo(String(dir))) || '' });
  });
}

module.exports = { register };
