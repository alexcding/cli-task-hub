const db = require('./db');
const github = require('./github');
const jira = require('./jira');

const DEFAULT_TRANSITION = 'In Review';

// Snapshot ids for the global feeds (vs. project UUIDs).
const MY_TICKETS_ID = '@me';     // everything assigned to me
const MY_SPRINT_ID  = '@sprint'; // assigned to me, in an active sprint

// Defaults for the Jira sync loop — overridable via the config store (Settings UI).
// `currentUser()` resolves server-side from `acli jira auth`, so no username/token
// is ever stored — same reason merge-transitions already work.
const JIRA_DEFAULTS = {
  my_jql:             'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
  // `sprint is not EMPTY` (any sprint, not just openSprints()): on some Jira sites
  // openSprints() only resolves a subset of boards, leaving active work off the
  // dashboard. Filtering to statusCategory != Done keeps it to in-flight tickets.
  sprint_jql:         'assignee = currentUser() AND sprint is not EMPTY AND statusCategory != Done ORDER BY updated DESC',
  jira_poll_interval: '120',  // seconds — tickets change less often than PR CI
  jira_limit:         '100',  // high enough to hold the full assigned list so the
                              // client-side project filter + counts stay accurate
};
const myJql        = () => db.get('my_jql') || JIRA_DEFAULTS.my_jql;
const sprintJql    = () => db.get('sprint_jql') || JIRA_DEFAULTS.sprint_jql;
const jiraLimit    = () => Math.max(1, parseInt(db.get('jira_limit') || JIRA_DEFAULTS.jira_limit, 10));
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
  };
}

// Transition every Jira ticket linked to a merged PR. Returns the keys handled.
function applyMergeAutomation(project, pr) {
  const repo = project.repo;
  const transition = project.mergeTransition || DEFAULT_TRANSITION;
  const links    = db.getLinksByPR(pr.number, repo).map(l => l.jira_key);
  const autoKeys = github.extractJiraKeys(`${pr.title} ${pr.body || ''}`);
  const keys     = [...new Set([...links, ...autoKeys])];

  for (const key of keys) {
    try {
      jira.transitionWorkItem(key, transition);
      db.addEvent('jira_transitioned', { key, transition, trigger: `PR #${pr.number} merged` });
      console.log(`[automation] ${key} → ${transition} (PR #${pr.number} ${repo})`);
    } catch (err) {
      db.addEvent('jira_transition_failed', { key, transition, error: err.message });
      console.error(`[automation] failed ${key} → ${transition}:`, err.message);
    }
  }
  return keys;
}

// Webhook entry point — record + automate a single merge.
function handleMerge(repo, pr) {
  const project = db.projectForRepo(repo);
  db.addEvent('pr_merged', { repo, pr: { number: pr.number, title: pr.title, url: pr.url } });
  if (project) applyMergeAutomation(project, pr);
}

// Sync ONE project: a single `gh` call serves both the UI snapshot (open PRs)
// and merge detection (newly-merged PRs). This is the only place we hit `gh`.
async function syncProject(project) {
  if (!project.repo) {
    db.setSnapshot(project.id, { prs: [], lastSynced: now(), error: null });
    if (onSync) onSync(project.id);
    return;
  }

  let prs;
  try {
    prs = await github.getPRs(project.repo, 'all', 60, { ci: true, fresh: true });
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
        applyMergeAutomation(project, pr);
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
  const reviewPRs = leanPRs.filter(p => p.category === 'review');
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
function writeJiraSnapshot(id, jql) {
  if (!jql) {
    db.setJiraSnapshot(id, { items: [], jql: '', lastSynced: now(), error: null });
    if (onJiraSync) onJiraSync(id);
    return;
  }
  try {
    const items = jira.searchLean(jql, jiraLimit());
    db.setJiraSnapshot(id, { items, jql, lastSynced: now(), error: null });
  } catch (err) {
    const prev = db.getJiraSnapshot(id);
    if (prev?.error !== err.message) db.addEvent('jira_sync_failed', { id, jql, error: err.message });
    db.setJiraSnapshot(id, { items: prev?.items || [], jql, lastSynced: now(), error: err.message });
  }
  if (onJiraSync) onJiraSync(id);
}

// Global "assigned to me" feed.
const syncJiraMine = () => { writeJiraSnapshot(MY_TICKETS_ID, myJql()); };
// Global "my work in the active sprint(s)" feed (dashboard).
const syncJiraSprint = () => { writeJiraSnapshot(MY_SPRINT_ID, sprintJql()); };
// A single project's saved JQL.
const syncProjectJira = (project) => { writeJiraSnapshot(project.id, project.jql); };

// Refresh the global feeds + every project's Jira snapshot.
function pollJira() {
  syncJiraMine();
  syncJiraSprint();
  for (const p of db.getProjects()) {
    try { syncProjectJira(p); }
    catch (err) { console.error(`[jira-sync] ${p.name}:`, err.message); }
  }
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
  try { pollJira(); } catch (err) { console.error('[jira-sync] first run failed:', err.message); }
  jiraTimer = setInterval(() => { try { pollJira(); } catch (err) { console.error('[jira-sync]', err.message); } }, interval);
}

function stop() {
  if (timer) clearInterval(timer);
  if (jiraTimer) clearInterval(jiraTimer);
  timer = null;
  jiraTimer = null;
}

module.exports = {
  start, startJira, stop, poll, pollJira,
  syncProject, syncProjectJira, syncJiraMine, syncJiraSprint,
  handleMerge, applyMergeAutomation,
  setPublisher, setJiraPublisher,
  DEFAULT_TRANSITION, MY_TICKETS_ID, MY_SPRINT_ID, JIRA_DEFAULTS,
};
