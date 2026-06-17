// Jira reads + transitions. Snapshots (assigned-to-me + per-project) follow the same
// stale-while-revalidate model as PRs (services/sync.js jiraStale): read the cached
// snapshot the Jira sync loop writes; if it's stale, kick a background refresh whose
// result lands over SSE.
const db = require('../database/db');
const jira = require('../repositories/jira');
const poller = require('../services/poller');
const { jiraStale } = require('../services/sync');
const { wrap } = require('./helpers');
const { ROUTES } = require('../../shared/routes.mjs');

// Base URL for ticket links. Prefer an explicit `jira_base_url` config override;
// otherwise auto-detect the site from `acli jira auth status` (cached — it doesn't
// change within a session). The UI reads this instead of hardcoding a host.
let _jiraBaseCache = null;
async function jiraBaseUrl() {
  const override = db.get('jira_base_url');
  if (override) return override.replace(/\/+$/, '');
  if (_jiraBaseCache) return _jiraBaseCache;
  try {
    const site = await jira.getSite();
    if (site) _jiraBaseCache = /^https?:\/\//.test(site) ? site.replace(/\/+$/, '') : `https://${site}`;
  } catch { /* not authed yet — UI falls back to no link */ }
  return _jiraBaseCache || '';
}

function register(app) {
  app.get(ROUTES.JIRA_SITE, wrap(async (req, res) => res.json({ baseUrl: await jiraBaseUrl() })));

  // Global "my work in the active sprint(s)" feed (dashboard). The active sprint's
  // name/end date lives in poller memory (not the snapshot table), merged in here.
  app.get(ROUTES.JIRA_SPRINT, wrap(async (req, res) => {
    const snap = db.getJiraSnapshot(poller.MY_SPRINT_ID);
    if (jiraStale(snap)) poller.syncJiraSprint().catch(() => {}); // background (acli is async now)
    res.json({ ...(snap || { items: [], jql: '', lastSynced: null, error: null }), sprint: await poller.currentSprint() });
  }));

  // A project's Scrumboard: the whole active sprint (every assignee), scoped to the
  // project's filter clause. The snapshot the poller writes already aggregates the
  // tickets + sprint + filter + column order, so this is a pure read — the view gets one
  // self-contained object and never cares which CLI/API each field came from.
  app.get(ROUTES.PROJECT_BOARD, wrap(async (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    if (project.jiraProjectKey) {
      // ?refresh=1 (a filter change) re-queries first so the response reflects the new
      // clause. Otherwise stale-while-revalidate: return the cached snapshot now and
      // refresh in the background (acli is async, so this never blocks the response).
      if (req.query.refresh) await poller.syncProjectBoard(project, true); // force fresh: reflects the new filter clause
      else if (jiraStale(db.getJiraSnapshot(poller.boardSnapId(project)))) poller.syncProjectBoard(project).catch(() => {});
    }
    const snap = db.getJiraSnapshot(poller.boardSnapId(project));
    res.json(snap || { items: [], jql: '', lastSynced: null, error: null, sprint: null, query: '', columns: null });
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
    if (eff && jiraStale(snap)) poller.syncProjectJira(project).catch(() => {}); // background (acli is async now)
    res.json(snap ? { ...snap, jql: snap.jql || eff } : { items: [], jql: eff, lastSynced: null, error: null });
  }));

  app.post(ROUTES.JIRA_KEY_TRANSITION, wrap(async (req, res) => {
    await jira.transitionWorkItem(req.params.key, req.body.transition);
    db.addEvent('jira_transitioned', { key: req.params.key, transition: req.body.transition, trigger: 'manual' });
    res.json({ ok: true });
  }));

  // Assign (or unassign, when assignee is blank) a ticket — from the Scrumboard.
  app.post(ROUTES.JIRA_KEY_ASSIGN, wrap(async (req, res) => {
    const assignee = (req.body.assignee || '').trim();
    await jira.assignWorkItem(req.params.key, assignee);
    db.addEvent('jira_assigned', { key: req.params.key, assignee: assignee || '(unassigned)', trigger: 'manual' });
    res.json({ ok: true });
  }));
}

module.exports = { register };
