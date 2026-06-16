const db = require('../database/db');
const github = require('../repositories/github');
const jira = require('../repositories/jira');
const jiraRest = require('../repositories/jira-rest');
const versionScript = require('./version-script');
const { PR_CATEGORY } = require('../../shared/constants.mjs');
const { prJiraKeys } = require('../../shared/jira-keys.mjs');

// Snapshot id for the global dashboard feed (project boards/tabs use the project UUID).
const MY_SPRINT_ID = '@sprint'; // assigned to me, in an active sprint — the dashboard's "Current Sprint"

// Defaults for the Jira sync loop — overridable via the config store (Settings UI).
// `currentUser()` resolves server-side from `acli jira auth`, so no username/token
// is ever stored — same reason merge-transitions already work.
const JIRA_DEFAULTS = {
  // `sprint is not EMPTY` (any sprint, not just openSprints()): on some Jira sites
  // openSprints() only resolves a subset of boards, leaving active work off the
  // dashboard. Filtering to statusCategory != Done keeps it to in-flight tickets.
  sprint_jql:         'assignee = currentUser() AND sprint is not EMPTY AND statusCategory != Done ORDER BY updated DESC',
  jira_poll_interval: '120',  // seconds — tickets change less often than PR CI
  jira_limit:         '100',  // high enough to hold the full assigned list so the
                              // client-side project filter + counts stay accurate
  board_limit:        '200',  // a project board holds the WHOLE sprint (every assignee),
                              // so it needs more headroom than the mine feed
};
const sprintJql    = () => db.get('sprint_jql') || JIRA_DEFAULTS.sprint_jql;

// A project's effective JQL: its explicit query if set, else — when only a Jira
// project key is configured — a sensible default scoped to that key (in-flight
// tickets, newest first). This is why a project's Jira tab populates from just a
// key, with no JQL to hand-write.
const projectJql = (p) => {
  if (p && p.jql) return p.jql;
  if (!p || !p.jiraProjectKey) return '';
  return `project = ${p.jiraProjectKey} AND statusCategory != Done ORDER BY updated DESC`;
};
const jiraLimit    = () => Math.max(1, parseInt(db.get('jira_limit') || JIRA_DEFAULTS.jira_limit, 10));
const boardLimit   = () => Math.max(1, parseInt(db.get('board_limit') || JIRA_DEFAULTS.board_limit, 10));
const jiraInterval = () => Math.max(30, parseInt(db.get('jira_poll_interval') || JIRA_DEFAULTS.jira_poll_interval, 10));

// prKey ("repo#number") -> last seen state, so we only act on real changes.
const prState = new Map();
// Repos whose PRs we've already seen once — lets us seed silently on first sync
// instead of logging every existing PR as "opened".
const seededRepos = new Set();

// Called with a projectId whenever its snapshot changes (server uses it to push SSE).
let onSync = null;
const setPublisher = fn => { onSync = fn; };

// Called with a Jira snapshot id ('@me' or a project UUID) when it changes.
let onJiraSync = null;
const setJiraPublisher = fn => { onJiraSync = fn; };

const now = () => new Date().toISOString();

// Strip a PR down to what the UI needs (no huge body / rollup) before storing.
function lean(pr, repo) {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    repo,
    headRefName: pr.headRefName,
    author: pr.author ? { login: pr.author.login, name: pr.author.name } : null,
    createdAt: pr.createdAt,
    isDraft: pr.isDraft,
    labels: pr.labels,
    jiraKeys: pr.jiraKeys,
    ci: pr.ci,
    category: pr.category,
    awaitingMyReview: pr.awaitingMyReview,
    reviewDecision: pr.reviewDecision, // drives the card's approved green check
  };
}

// Run the on-merge Jira automation for a merged PR's linked tickets: first the optional Fix
// Version step, then the optional transition. Returns the keys handled. Never rejects — every
// external call is wrapped so one failure can't break the sync loop.
async function applyMergeAutomation(project, pr) {
  const repo = project.repo;
  const links    = db.getLinksByPR(pr.number, repo).map(l => l.jira_key);
  const autoKeys = prJiraKeys(pr, project.jiraProjectKey); // description links (or title fallback), scoped to our key
  const keys     = [...new Set([...links, ...autoKeys])];
  if (!keys.length) return keys;

  const transition = project.mergeTransition;

  // 1. Fix Version (opt-in): build the version name, create it in Jira if absent, and stamp it on
  //    each linked ticket (REST writes acli can't do → needs a Jira API token). When a transition
  //    will also run, the version rides on THAT activity entry ("moved to X · Fix Version Y" — one
  //    line per ticket); with no transition it gets its own entry. `version` = the applied name,
  //    null if the step is off or fails.
  let version = null;
  if (project.fixVersionEnabled && project.jiraProjectKey) {
    try {
      version = await applyFixVersion(project, pr, keys, !transition);
    } catch (err) {
      // Setup failure (no token, script error, version create) — the per-ticket writes never ran.
      version = null;
      db.addEvent('jira_fixversion_failed', { error: err.message, trigger: `PR #${pr.number} merged` });
      console.error(`[automation] fix version failed (PR #${pr.number} ${repo}):`, err.message);
    }
  }

  // 2. Transition (opt-in): move each linked ticket. Blank = no transition, as the Automation UI
  //    promises ("Leave blank to take no transition"). The applied Fix Version rides along.
  if (transition) {
    for (const key of keys) {
      try {
        jira.transitionWorkItem(key, transition);
        db.addEvent('jira_transitioned', { key, transition, version: version || undefined, trigger: `PR #${pr.number} merged` });
        console.log(`[automation] ${key} → ${transition}${version ? ` (fixVersion ${version})` : ''} (PR #${pr.number} ${repo})`);
      } catch (err) {
        db.addEvent('jira_transition_failed', { key, transition, error: err.message });
        console.error(`[automation] failed ${key} → ${transition}:`, err.message);
      }
    }
  }
  return keys;
}

// Build the Fix Version name (same sandbox the Automation preview uses) and apply it to each linked
// ticket; returns the built name. Throws on setup failures (script error, version create) so the
// caller logs once; per-ticket writes are caught individually so one bad key doesn't block the
// others. `recordSet` emits a per-ticket "Fix Version set" activity entry on success — suppressed
// when a transition will also run (the version rides on the transition entry instead).
async function applyFixVersion(project, pr, keys, recordSet) {
  const versions = jira.listVersions(project.jiraProjectKey).map(v => v.name);
  const { version } = versionScript.buildVersion(
    project.fixVersionPrefix, project.fixVersionScript,
    { now: new Date(), pr: { number: pr.number, title: pr.title, body: pr.body || '' }, versions });
  if (await jiraRest.ensureVersion(project.jiraProjectKey, version, versions))
    db.addEvent('jira_version_created', { version, project: project.jiraProjectKey, trigger: `PR #${pr.number} merged` });
  for (const key of keys) {
    try {
      await jiraRest.setFixVersion(key, version);
      if (recordSet) db.addEvent('jira_fixversion_set', { key, version, trigger: `PR #${pr.number} merged` });
      console.log(`[automation] ${key} fixVersion=${version} (PR #${pr.number} ${project.repo})`);
    } catch (err) {
      db.addEvent('jira_fixversion_failed', { key, version, error: err.message });
      console.error(`[automation] fixVersion ${key}=${version} failed:`, err.message);
    }
  }
  return version;
}

// Webhook entry point — record + automate a single merge. Fire-and-forget: the automation never
// rejects, so a dangling .catch is just belt-and-braces for an unexpected sync throw.
function handleMerge(repo, pr) {
  const project = db.projectForRepo(repo);
  db.addEvent('pr_merged', { repo, pr: { number: pr.number, title: pr.title, url: pr.url } });
  // Record the merged state now so the next poll's diff (state === 'MERGED' && prev !== 'MERGED')
  // doesn't re-detect this same merge and fire a duplicate pr_merged event/notification.
  prState.set(`${repo}#${pr.number}`, 'MERGED');
  if (project) applyMergeAutomation(project, pr).catch(err => console.error('[automation]', err.message));
}

// Coalesce concurrent syncs of the SAME project: a stale dashboard read fires a
// fire-and-forget syncProject per stale project, which can race the interval poll()
// (or rapid reloads / multiple tabs) and otherwise spawn duplicate identical `gh pr
// list` processes for one repo. Return the in-flight promise instead, so each repo
// has at most one sync running at a time. (Different projects still run concurrently.)
const _inFlight = new Map(); // project.id -> { repo, promise }
function syncProject(project) {
  const existing = _inFlight.get(project.id);
  // Coalesce only when the in-flight sync is for the SAME repo. A repo change (project
  // edit) must NOT be satisfied by a fetch already running against the old repo — that
  // would write the old repo's PRs under this id; let the new repo start its own sync.
  if (existing && existing.repo === (project.repo || '')) { github.noteCoalesced(); return existing.promise; }
  github.noteInflight(1);
  const promise = syncProjectImpl(project).finally(() => {
    // Clear only if still ours — a mismatching newer sync may have replaced the entry.
    if (_inFlight.get(project.id)?.promise === promise) _inFlight.delete(project.id);
    github.noteInflight(-1);
  });
  _inFlight.set(project.id, { repo: project.repo || '', promise });
  return promise;
}

// Sync ONE project: a single `gh` call serves both the UI snapshot (open PRs)
// and merge detection (newly-merged PRs). This is the only place we hit `gh`.
async function syncProjectImpl(project) {
  if (!project.repo) {
    db.setSnapshot(project.id, { prs: [], lastSynced: now(), error: null });
    if (onSync) onSync(project.id);
    return;
  }

  let prs;
  try {
    prs = await github.getPRs(project.repo, 'all', 60, { ci: true, fresh: true, jiraProjectKey: project.jiraProjectKey });
  } catch (err) {
    const prev = db.getSnapshot(project.id);
    // Only log a sync failure when the error is new (don't spam every cycle).
    if (prev?.error !== err.message) db.addEvent('sync_failed', { repo: project.repo, error: err.message });
    db.setSnapshot(project.id, { prs: prev?.prs || [], lastSynced: now(), error: err.message });
    if (onSync) onSync(project.id);
    return;
  }

  // Detect PR lifecycle changes → activity log + merge automation.
  // First sync of a repo seeds state silently (no flood of "opened" events).
  const firstTime = !seededRepos.has(project.repo);
  for (const pr of prs) {
    const key = `${project.repo}#${pr.number}`;
    const prev = prState.get(key);
    const meta = { repo: project.repo, pr: { number: pr.number, title: pr.title, url: pr.url } };
    if (!firstTime) {
      if (pr.state === 'OPEN' && prev === undefined) {
        db.addEvent('pr_opened', meta);
      } else if (pr.state === 'MERGED' && prev !== 'MERGED') {
        console.log(`[sync] PR #${pr.number} in ${project.repo} merged`);
        db.addEvent('pr_merged', meta);
        await applyMergeAutomation(project, pr);
      } else if (pr.state === 'CLOSED' && prev !== 'CLOSED') {
        db.addEvent('pr_closed', meta);
      }
    }
    prState.set(key, pr.state);
  }
  seededRepos.add(project.repo);

  // Snapshot = open PRs only (what the dashboard/project page show).
  const open = prs.filter(p => p.state === 'OPEN');
  const leanPRs = open.map(p => lean(p, project.repo));

  // For PRs awaiting MY review, fetch the latest review-request timestamp (one GraphQL
  // call, only when there's at least one such PR) and persist it. The tray uses
  // requestedAt vs. the stored viewed_at to decide what's still pending — so a clicked
  // request stays hidden across restarts, and a re-request re-surfaces it. A failed/
  // missing timestamp falls back to the last stored one, so a transient error can't drop
  // a pending request off the list.
  const reviewPRs = leanPRs.filter(p => p.category === PR_CATEGORY.REVIEW);
  if (reviewPRs.length) {
    let reqMap = {};
    try { reqMap = await github.reviewRequestedAt(project.repo, await github.getCurrentUser()); }
    catch (err) { console.error(`[sync] review timeline ${project.repo}:`, err.message); }
    for (const p of reviewPRs) {
      const key = `${project.repo}#${p.number}`;
      const ts = reqMap[p.number] || db.getReviewState(key)?.requested_at || null;
      if (ts) {
        p.requestedAt = ts;
        if (reqMap[p.number]) db.setReviewRequestedAt(key, ts);
      }
    }
  }
  db.pruneReviewStateForRepo(project.repo, open.map(p => p.number));

  db.setSnapshot(project.id, { prs: leanPRs, lastSynced: now(), error: null });
  if (onSync) onSync(project.id);
}

// Sync every project (repos fetched concurrently).
async function poll() {
  await Promise.all(db.getProjects().map(p => syncProject(p).catch(err =>
    console.error(`[sync] ${p.name}:`, err.message))));
}

// ── Jira sync ───────────────────────────────────────────────────────────────────
// Mirrors the PR sync: run a JQL through `acli`, write a lean snapshot, publish.
// On failure keep the last good items so the UI doesn't blank out (like PR sync).
function writeJiraSnapshot(id, jql, limit = jiraLimit(), meta = null) {
  if (!jql) {
    db.setJiraSnapshot(id, { items: [], jql: '', lastSynced: now(), error: null, meta });
    if (onJiraSync) onJiraSync(id);
    return;
  }
  try {
    const items = jira.searchLean(jql, limit);
    db.setJiraSnapshot(id, { items, jql, lastSynced: now(), error: null, meta });
  } catch (err) {
    const prev = db.getJiraSnapshot(id);
    if (prev?.error !== err.message) db.addEvent('jira_sync_failed', { id, jql, error: err.message });
    db.setJiraSnapshot(id, { items: prev?.items || [], jql, lastSynced: now(), error: err.message, meta });
  }
  if (onJiraSync) onJiraSync(id);
}

// Active sprint ({id,name,endDate}) for a project key, cached 15 min per key — the
// lookup is two extra acli calls (board search + list-sprints) and the answer changes
// once per sprint, not per poll. Held in memory (snapshots persist only fixed columns);
// it re-resolves within one poll after a restart.
const _sprintCache = new Map(); // KEY -> { value, at }
function activeSprintFor(key) {
  key = (key || '').toUpperCase();
  if (!key) return null;
  const c = _sprintCache.get(key);
  if (c && Date.now() - c.at < 15 * 60_000) return c.value;
  let value = null;
  try { value = jira.activeSprint(key); }
  catch (err) { console.error('[jira-sync] active sprint lookup failed:', err.message); }
  _sprintCache.set(key, { value, at: Date.now() });
  return value;
}

// The dashboard "Current Sprint" section titles itself with the active sprint of the
// dominant project key among my sprint items (noted by syncJiraSprint).
let _dashSprintKey = null;
const dominantKey = (items) => {
  const counts = {};
  for (const it of items) { const k = (it.key || '').split('-')[0]; if (k) counts[k] = (counts[k] || 0) + 1; }
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
};
const currentSprint = () => activeSprintFor(_dashSprintKey);

// The board's ordered columns ({name, statusIds}) for a board, so the Scrumboard mirrors
// the web board's column order. Comes from the Agile board-configuration REST endpoint
// (needs the Jira API token), cached 15 min per board — config changes rarely, so we
// don't refetch it every poll. Returns null (uncached) when there's no token / it's not
// permitted, so the next poll retries and the view simply category-sorts meanwhile.
const _colsCache = new Map(); // boardId -> { value, at }
async function boardColumnsFor(boardId) {
  if (!boardId) return null;
  const c = _colsCache.get(boardId);
  if (c && Date.now() - c.at < 15 * 60_000) return c.value;
  try {
    const value = await jiraRest.boardConfig(boardId);
    _colsCache.set(boardId, { value, at: Date.now() });
    return value;
  } catch { return null; }
}

// Global "my work in the active sprint(s)" feed (dashboard). Notes the dominant project
// key so currentSprint() can title the section.
const syncJiraSprint = () => {
  writeJiraSnapshot(MY_SPRINT_ID, sprintJql());
  _dashSprintKey = dominantKey(db.getJiraSnapshot(MY_SPRINT_ID)?.items || []);
};
// A single project's saved JQL (its Jira tab).
const syncProjectJira = (project) => { writeJiraSnapshot(project.id, projectJql(project)); };

// A single project's Scrumboard: the WHOLE active sprint for the project's Jira board
// (every assignee, including Done so the Done column fills), optionally scoped to the
// project's component (e.g. iOS). Querying by the resolved sprint id is exact. acli can
// only filter components in JQL (not as a returned field), hence the AND clause.
const boardSnapId = (project) => 'board:' + project.id;
// Aggregate the board into ONE snapshot: tickets (acli) + the sprint (acli) + the
// component + the column order (REST). The route just returns this row, so the view
// never knows the data came from two sources. `columns` is null when there's no API
// token — the tickets still render, the view just category-sorts the columns.
async function syncProjectBoard(project) {
  const id = boardSnapId(project);
  // A free-form JQL clause the user types on the board (e.g. `component = iOS`), saved per
  // project and ANDed into the sprint query. Generic — works for any field. No default:
  // unset = the whole sprint.
  const clause = (db.get(`board_query_${project.id}`) || '').trim();
  const sprint = project.jiraProjectKey ? activeSprintFor(project.jiraProjectKey) : null;
  if (!sprint?.id) {
    db.setJiraSnapshot(id, { items: [], jql: '', lastSynced: now(), error: null, meta: { sprint: null, query: clause, columns: null } });
    if (onJiraSync) onJiraSync(id);
    return;
  }
  const columns = await boardColumnsFor(sprint.boardId);
  const jql = `sprint = ${sprint.id}` +
    (clause ? ` AND (${clause})` : '') +
    ` ORDER BY priority DESC, key ASC`;
  writeJiraSnapshot(id, jql, boardLimit(), { sprint, query: clause, columns });
}

// Refresh the global feeds + every project's Jira tab + Scrumboard. Async because the
// board aggregation fetches the column order over REST; project boards refresh in
// parallel.
async function pollJira() {
  syncJiraSprint();
  await Promise.all(db.getProjects().map(async (p) => {
    try { syncProjectJira(p); await syncProjectBoard(p); }
    catch (err) { console.error(`[jira-sync] ${p.name}:`, err.message); }
  }));
}

let timer = null;
let jiraTimer = null;

function start(publisher) {
  if (publisher) setPublisher(publisher);
  const interval = Math.max(15, parseInt(db.get('poll_interval') || '60', 10)) * 1000;
  console.log(`[sync] starting, every ${interval / 1000}s`);
  poll().catch(err => console.error('[sync] first run failed:', err.message));
  timer = setInterval(() => poll().catch(err => console.error('[sync]', err.message)), interval);
}

function startJira(publisher) {
  if (publisher) setJiraPublisher(publisher);
  const interval = jiraInterval() * 1000;
  console.log(`[jira-sync] starting, every ${interval / 1000}s`);
  pollJira().catch(err => console.error('[jira-sync] first run failed:', err.message));
  jiraTimer = setInterval(() => pollJira().catch(err => console.error('[jira-sync]', err.message)), interval);
}

function stop() {
  if (timer) clearInterval(timer);
  if (jiraTimer) clearInterval(jiraTimer);
  timer = null;
  jiraTimer = null;
}

module.exports = {
  start, startJira, stop, poll, pollJira,
  syncProject, syncProjectJira, syncProjectBoard, syncJiraSprint, projectJql, currentSprint,
  activeSprintFor, boardSnapId,
  handleMerge, applyMergeAutomation,
  setPublisher, setJiraPublisher,
  MY_SPRINT_ID, JIRA_DEFAULTS,
};
