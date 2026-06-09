const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// PR fields. statusCheckRollup gives CI status inline — one call returns PRs + CI,
// so we never need a separate `gh run list` per PR. author/isDraft/reviewRequests
// drive per-user categorization (mine / review / other).
const PR_FIELDS = 'number,title,state,url,headRefName,baseRefName,mergedAt,author,labels,body,createdAt,updatedAt,isDraft,reviewRequests';
const PR_FIELDS_CI = `${PR_FIELDS},statusCheckRollup`;

const MAX_BUFFER = 10 * 1024 * 1024;

async function gh(args) {
  try {
    const { stdout } = await execFileAsync('gh', args, { maxBuffer: MAX_BUFFER });
    return stdout.trim();
  } catch (err) {
    throw new Error((err.stderr || err.message || 'gh failed').toString().trim());
  }
}

const extractJiraKeys = (text) => {
  const matches = (text || '').match(/\b[A-Z][A-Z0-9]+-\d+\b/g);
  return matches ? [...new Set(matches)] : [];
};

// Current GitHub login — memoized for the process lifetime (it never changes).
let _me;
function getCurrentUser() {
  if (_me === undefined) {
    _me = gh(['api', 'user', '--jq', '.login']).then(s => s.trim()).catch(() => null);
  }
  return _me;
}

// Classify a PR relative to the current user:
//   'mine'   — you authored it          (→ Tasks)
//   'review' — you're a requested reviewer on a non-draft PR you didn't author (→ Review)
//   'other'  — everyone else's          (shown only under the project)
function categoryOf(pr, me) {
  if (me && pr.author?.login === me) return 'mine';
  const isReviewer = (pr.reviewRequests || []).some(r => r.login === me);
  if (me && isReviewer && !pr.isDraft) return 'review';
  return 'other';
}

// "owner/repo", a github.com URL, or an SSH remote (git@github.com:owner/repo.git)
// → "owner/repo", else null.
const parseRepo = (input) => {
  let repo = (input || '').trim();
  if (!repo) return null;
  const urlMatch = repo.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (urlMatch) repo = urlMatch[1];
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
};

// Resolve the GitHub "owner/repo" for a local checkout via its `origin` remote.
// Returns null if the path isn't a git repo, has no origin, or origin isn't GitHub.
async function gitRemoteRepo(dir) {
  if (!dir) return null;
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { maxBuffer: MAX_BUFFER });
    return parseRepo(stdout.trim());
  } catch {
    return null;
  }
}

// Parse `git worktree list --porcelain` into [{ path, branch }] (branch sans refs/heads/,
// '' for a detached HEAD). Returns [] if `dir` isn't a worktree / git is unavailable.
async function listWorktrees(dir) {
  if (!dir) return [];
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { maxBuffer: MAX_BUFFER });
    const out = [];
    let cur = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) out.push(cur = { path: line.slice(9).trim(), branch: '' });
      else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    }
    return out;
  } catch { return []; /* not a worktree / no git */ }
}

// The local git worktree checked out at `branch`, if any (so a PR's terminal can open
// in the matching worktree instead of the main checkout). Returns its path or null.
async function worktreeForBranch(dir, branch) {
  if (!branch) return null;
  return (await listWorktrees(dir)).find(w => w.branch === branch)?.path || null;
}

// The local worktree whose branch name embeds `key` (a Jira ticket key, e.g.
// RECORD-1234). Branch names conventionally carry the ticket key (feature/RECORD-1234-foo),
// so this maps a Jira ticket → its checkout. Returns a path ONLY when exactly one worktree
// matches — 0 or >1 is ambiguous, so the caller falls back to the project workspace. Match
// is case-insensitive and substring (the key is rarely the whole branch name).
async function worktreeForJiraKey(dir, key) {
  if (!key) return null;
  const needle = String(key).toLowerCase();
  const hits = (await listWorktrees(dir)).filter(w => w.branch.toLowerCase().includes(needle));
  return hits.length === 1 ? hits[0].path : null;
}

// Collapse a statusCheckRollup array into one { status, conclusion } (lowercase),
// matching what the UI/tray expect. Priority: running > failure > success.
const FAIL = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
function summarizeCI(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return null;
  let running = false, failure = false, success = false;
  for (const c of rollup) {
    const status = (c.status || '').toUpperCase();
    const concl  = (c.conclusion || c.state || '').toUpperCase();
    if (status === 'IN_PROGRESS' || status === 'QUEUED' || status === 'PENDING' || concl === 'PENDING') running = true;
    else if (FAIL.has(concl)) failure = true;
    else if (concl === 'SUCCESS') success = true;
  }
  if (running) return { status: 'in_progress', conclusion: null };
  if (failure) return { status: 'completed',   conclusion: 'failure' };
  if (success) return { status: 'completed',   conclusion: 'success' };
  return null;
}

// ── PR cache (shared by dashboard, tray, project page) ───────────────────────────
const PR_TTL_MS = 20_000;
const prCache = new Map(); // key -> { at, value }

async function getPRs(repo, state = 'open', limit = 30, { ci = false, fresh = false } = {}) {
  const key = `${repo}|${state}|${limit}|${ci}`;
  if (!fresh) {
    const hit = prCache.get(key);
    if (hit && Date.now() - hit.at < PR_TTL_MS) return hit.value;
  }
  const [out, me] = await Promise.all([
    gh(['pr', 'list', '--repo', repo, '--state', state, '--limit', String(limit), '--json', ci ? PR_FIELDS_CI : PR_FIELDS]),
    getCurrentUser(),
  ]);
  const value = JSON.parse(out).map(pr => {
    const enriched = {
      ...pr,
      jiraKeys: extractJiraKeys(`${pr.title} ${pr.body || ''}`),
      category: categoryOf(pr, me),
    };
    if (ci) { enriched.ci = summarizeCI(pr.statusCheckRollup); delete enriched.statusCheckRollup; }
    delete enriched.reviewRequests; // only needed for categorization
    return enriched;
  });
  prCache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { getPRs, getCurrentUser, categoryOf, extractJiraKeys, parseRepo, gitRemoteRepo, worktreeForBranch, worktreeForJiraKey, summarizeCI };
