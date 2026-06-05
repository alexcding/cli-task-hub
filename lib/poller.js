const db = require('./db');
const github = require('./github');
const jira = require('./jira');

const DEFAULT_TRANSITION = 'In Review';

// prKey ("repo#number") -> last seen state, so we only act on real changes.
const prState = new Map();
// Repos whose PRs we've already seen once — lets us seed silently on first sync
// instead of logging every existing PR as "opened".
const seededRepos = new Set();

// Called with a projectId whenever its snapshot changes (server uses it to push SSE).
let onSync = null;
const setPublisher = fn => { onSync = fn; };

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
  const open = prs.filter(p => p.state === 'OPEN').map(p => lean(p, project.repo));
  db.setSnapshot(project.id, { prs: open, lastSynced: now(), error: null });
  if (onSync) onSync(project.id);
}

// Sync every project (repos fetched concurrently).
async function poll() {
  await Promise.all(db.getProjects().map(p => syncProject(p).catch(err =>
    console.error(`[sync] ${p.name}:`, err.message))));
}

let timer = null;

function start(publisher) {
  if (publisher) setPublisher(publisher);
  const interval = Math.max(15, parseInt(db.get('poll_interval') || '60', 10)) * 1000;
  console.log(`[sync] starting, every ${interval / 1000}s`);
  poll().catch(err => console.error('[sync] first run failed:', err.message));
  timer = setInterval(() => poll().catch(err => console.error('[sync]', err.message)), interval);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, poll, syncProject, handleMerge, applyMergeAutomation, setPublisher, DEFAULT_TRANSITION };
