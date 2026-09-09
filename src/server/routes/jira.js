// Jira reads + transitions. Snapshots (per-project Jira tab + sprint board) follow the same
// stale-while-revalidate model as PRs (services/sync.js jiraStale): read the cached
// snapshot the Jira sync loop writes; if it's stale, kick a background refresh whose
// result lands over SSE.
const db = require('../database/db');
const jira = require('../repositories/jira');
const jiraRest = require('../repositories/jira-rest');
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

// The authenticated account, cached for the session (it can't change without re-running
// `acli jira auth login`, which needs an app restart anyway). Never throws.
let _jiraMeCache = null;
async function jiraMe() {
  if (_jiraMeCache) return _jiraMeCache;
  let email = null, accountId = null;
  try { email = (await jira.getAuth()).email; } catch { /* not authed yet */ }
  try { accountId = (await jiraRest.myself())?.accountId || null; } catch { /* no token — email match only */ }
  const me = { email, accountId };
  // Cache only a complete answer: the REST token is editable at runtime (Settings → Jira), so a
  // null accountId must be retried on the next read (the config route also drops the cache).
  if (email && accountId) _jiraMeCache = me;
  return me;
}
const invalidateJiraMe = () => { _jiraMeCache = null; };

function register(app) {
  // Site + identity: the base URL for ticket links and who the acli login is (`me`), so the
  // board can tint the cards assigned to you. `me.email` comes from `acli jira auth status`;
  // `me.accountId` needs the REST token (Settings → Jira) and is null without it — the UI
  // matches on whichever it has (board items carry both the assignee's id and email).
  app.get(ROUTES.JIRA_SITE, wrap(async (req, res) => res.json({ baseUrl: await jiraBaseUrl(), me: await jiraMe() })));

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
  app.get(ROUTES.PROJECT_JIRA, wrap(async (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const snap = db.getJiraSnapshot(project.id);
    // Effective JQL falls back to the project's Jira key, so a key-only project still
    // has a feed (see poller.projectJql). Gate the sync and report it so the tab knows
    // there's a query even before the first snapshot lands.
    const eff = poller.projectJql(project);
    // ?refresh=1 (the filter clause changed) re-queries first so the response reflects it;
    // otherwise stale-while-revalidate in the background (acli is async now).
    if (eff && req.query.refresh) await poller.syncProjectJira(project, true);
    else if (eff && jiraStale(snap)) poller.syncProjectJira(project).catch(() => {});
    const fresh = req.query.refresh ? db.getJiraSnapshot(project.id) : snap;
    res.json(fresh ? { ...fresh, jql: fresh.jql || eff } : { items: [], jql: eff, lastSynced: null, error: null });
  }));

  // Inline JQL search (project page → Jira → Tickets). Live, not snapshot-backed: the user typed
  // the query and is waiting, so it runs acli now and returns the lean items directly.
  app.post(ROUTES.JIRA_SEARCH, wrap(async (req, res) => {
    const jql = String(req.body?.jql || '').trim();
    if (!jql) return res.status(400).json({ error: 'jql is required' });
    const limit = Math.min(200, Math.max(1, parseInt(req.body?.limit, 10) || 50));
    const items = await jira.searchLean(jql, limit);
    res.json({ items, jql, lastSynced: new Date().toISOString(), error: null });
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

module.exports = { register, invalidateJiraMe };
