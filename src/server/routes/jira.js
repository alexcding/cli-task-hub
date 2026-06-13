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

function register(app) {
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
}

module.exports = { register };
