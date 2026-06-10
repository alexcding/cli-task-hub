const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// PR fields. statusCheckRollup gives CI status inline — one call returns PRs + CI,
// so we never need a separate `gh run list` per PR. author/isDraft/reviewRequests
// drive per-user categorization (mine / review / other); latestReviews adds "I've
// commented but not finished" so a PR I'm reviewing doesn't vanish (see awaitingReview).
const PR_FIELDS = 'number,title,state,url,headRefName,baseRefName,mergedAt,author,labels,body,createdAt,updatedAt,isDraft,reviewRequests,latestReviews,reviewDecision';
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

// Whether a PR is still in MY review orbit — drives the dashboard's "Review Requested"
// section (NOT the tray/sound, which stay keyed on category==='review'; see notifications.js).
// Broader than categoryOf's 'review' on purpose: GitHub drops you from reviewRequests the
// moment you submit ANY review — even a plain comment — so a PR you're involved in would
// otherwise vanish while it's still open. Keep it for a non-draft PR you didn't author while
// you're a requested reviewer OR you've left any review on it (commented, approved, or
// requested changes — an approved-but-unmerged PR still belongs here). Drops only when it
// merges/closes (the snapshot holds open PRs only) or you were never involved.
function awaitingReview(pr, me) {
  if (!me || pr.isDraft || pr.author?.login === me) return false;
  if ((pr.reviewRequests || []).some(r => r.login === me)) return true;
  return (pr.latestReviews || []).some(r => r.author?.login === me);
}

// Latest time MY review was (re-)requested, per open PR in a repo. `gh pr list` only
// exposes the CURRENT reviewRequests (logins, no timestamps), so it can't tell a first
// request from a re-request. The PR timeline can: each ReviewRequestedEvent carries a
// createdAt, and GitHub emits a fresh one every time you're (re-)requested. We take the
// most recent event naming me → a single timestamp the tray compares against viewed_at.
// Returns { [prNumber]: ISO } for PRs with such an event; {} if not authed / on failure.
const REVIEW_TIMELINE_QUERY = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    pullRequests(states:OPEN,first:100,orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{ number timelineItems(itemTypes:[REVIEW_REQUESTED_EVENT],last:30){
        nodes{ ... on ReviewRequestedEvent{ createdAt requestedReviewer{ ... on User{ login } } } } } }
    }
  }
}`;
async function reviewRequestedAt(repo, me) {
  if (!me || !repo.includes('/')) return {};
  const [owner, name] = repo.split('/');
  const out = await gh(['api', 'graphql', '-f', `query=${REVIEW_TIMELINE_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`]);
  const nodes = JSON.parse(out)?.data?.repository?.pullRequests?.nodes || [];
  const map = {};
  for (const pr of nodes) {
    let latest = null;
    for (const ev of pr.timelineItems?.nodes || []) {
      // ISO-8601 UTC strings sort lexicographically, so > is a valid recency test.
      if (ev?.requestedReviewer?.login === me && (!latest || ev.createdAt > latest)) latest = ev.createdAt;
    }
    if (latest) map[pr.number] = latest;
  }
  return map;
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

// One exec wrapper for every git invocation the diff-pane endpoints make, so buffer
// limits / env / timeout policy live in one place. And one error formatter: git puts
// the useful line on stderr OR stdout ("nothing to commit"), and rejection reasons on
// an "error:"/"! [rejected]" line that isn't first — scan, then fall back to line 0.
const gitRun = (dir, args, opts = {}) =>
  execFileAsync('git', ['-C', dir, ...args], { maxBuffer: MAX_BUFFER, ...opts });
function gitErrLine(err, fallback) {
  const lines = (err.stderr || err.stdout || err.message || fallback).toString().trim().split('\n').filter(Boolean);
  return lines.find(l => /error|rejected|fatal/i.test(l)) || lines[0] || fallback;
}

// Uncommitted changes in a checkout, for the diff pane: raw `git diff HEAD` text
// (staged + unstaged in one patch), the untracked file list, and branch/divergence
// meta for the commit popover — the three are independent, so they run in parallel.
// Never throws — errors come back as { error } for the endpoint to pass through.
async function gitDiff(dir) {
  if (!dir) return { error: 'path required' };
  const text = async () => {
    try {
      return (await gitRun(dir, ['diff', 'HEAD', '--no-color', '--no-ext-diff'])).stdout;
    } catch (err) {
      // Unborn HEAD (fresh repo, no commits yet) → fall back to index-vs-worktree.
      if (!/unknown revision|ambiguous argument|bad revision/i.test(String(err.stderr || ''))) throw err;
      return (await gitRun(dir, ['diff', '--no-color', '--no-ext-diff'])).stdout;
    }
  };
  try {
    const [diff, others, meta] = await Promise.all([
      text(),
      gitRun(dir, ['ls-files', '--others', '--exclude-standard']),
      gitMeta(dir),
    ]);
    return { diff, untracked: others.stdout.split('\n').filter(Boolean), ...meta };
  } catch (err) {
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { error: 'Diff too large to display' };
    return { error: gitErrLine(err, 'git failed') };
  }
}

// Branch + upstream divergence. ahead/behind are null when the branch has no upstream
// yet (first push will create it). Never throws.
async function gitMeta(dir) {
  try {
    const { stdout: branch } = await gitRun(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    let ahead = null, behind = null;
    try {
      // rev-list --left-right --count upstream...HEAD → "<behind>\t<ahead>"
      const { stdout } = await gitRun(dir, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
      [behind, ahead] = stdout.trim().split(/\s+/).map(Number);
    } catch { /* no upstream */ }
    return { branch: branch.trim(), ahead, behind };
  } catch { return { branch: '', ahead: null, behind: null }; }
}

// Commit the worktree's changes (`add -A`, or `add -u` to leave untracked files out).
// Signing/hooks run exactly as they would in a shell — this is the user's real commit.
// Never throws; "nothing to commit" comes back as an error string like any other.
async function gitCommit(dir, message, includeUntracked = true) {
  try {
    await gitRun(dir, ['add', includeUntracked ? '-A' : '-u']);
    await gitRun(dir, ['commit', '-m', message]);
    const { stdout } = await gitRun(dir, ['rev-parse', '--short', 'HEAD']);
    return { ok: true, hash: stdout.trim() };
  } catch (err) {
    return { error: gitErrLine(err, 'git commit failed') };
  }
}

// Discard one hunk: reverse-apply a renderer-reconstructed single-hunk patch onto the
// worktree (`git apply -R`). If the file drifted since the diff was rendered the apply
// fails cleanly and the caller re-renders — it can never half-apply a stale hunk.
async function gitDiscard(dir, patch) {
  const fs = require('fs/promises');
  const os = require('os');
  const file = require('path').join(os.tmpdir(), `taskhub-discard-${process.pid}-${Date.now()}.patch`);
  try {
    await fs.writeFile(file, patch);
    await gitRun(dir, ['apply', '-R', file]);
    return { ok: true };
  } catch (err) {
    return { error: gitErrLine(err, 'git apply failed') };
  } finally {
    fs.unlink(file).catch(() => {});
  }
}

// Push the branch; a branch with no upstream yet gets one (`-u origin HEAD`). Network
// op → bounded by a timeout instead of hanging the request forever.
async function gitPush(dir) {
  const opts = { timeout: 60_000 };
  try {
    try { await gitRun(dir, ['push'], opts); }
    catch (err) {
      if (!/no upstream/i.test(String(err.stderr || ''))) throw err;
      await gitRun(dir, ['push', '-u', 'origin', 'HEAD'], opts);
    }
    return { ok: true };
  } catch (err) {
    return { error: gitErrLine(err, 'git push failed') };
  }
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
      awaitingMyReview: awaitingReview(pr, me),
    };
    if (ci) { enriched.ci = summarizeCI(pr.statusCheckRollup); delete enriched.statusCheckRollup; }
    delete enriched.reviewRequests; // only needed for categorization
    delete enriched.latestReviews;  // only needed for awaitingReview
    return enriched;
  });
  prCache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { gh, getPRs, getCurrentUser, reviewRequestedAt, categoryOf, awaitingReview, extractJiraKeys, parseRepo, gitRemoteRepo, worktreeForBranch, worktreeForJiraKey, gitDiff, gitCommit, gitPush, gitDiscard, summarizeCI };
