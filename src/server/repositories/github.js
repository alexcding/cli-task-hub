const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { PR_CATEGORY } = require('../../shared/constants.mjs');

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
  if (me && pr.author?.login === me) return PR_CATEGORY.MINE;
  const isReviewer = (pr.reviewRequests || []).some(r => r.login === me);
  if (me && isReviewer && !pr.isDraft) return PR_CATEGORY.REVIEW;
  return PR_CATEGORY.OTHER;
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

// Display name for the dashboard greeting: GitHub profile name (often a real
// "First Last", but empty unless set on the profile) → git config user.name →
// GitHub login. Resolved once per process — it doesn't change while the app runs.
let _userName;
function getUserName() {
  _userName ??= (async () => {
    try { const n = (await gh(['api', 'user', '--jq', '.name'])).trim(); if (n) return n; } catch {}
    try {
      const { stdout } = await execFileAsync('git', ['config', '--get', 'user.name'], { maxBuffer: MAX_BUFFER });
      if (stdout.trim()) return stdout.trim();
    } catch {}
    return (await getCurrentUser()) || '';
  })();
  return _userName;
}

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

// Parse `git worktree list --porcelain` into [{ path, branch, isMain }] (branch sans
// refs/heads/, '' for a detached HEAD). `git` lists the MAIN working tree first, so the
// first entry is flagged isMain — callers distinguish a dedicated (linked) worktree from
// the shared checkout. Returns [] if `dir` isn't a worktree / git is unavailable.
async function listWorktrees(dir) {
  if (!dir) return [];
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { maxBuffer: MAX_BUFFER });
    const out = [];
    let cur = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) out.push(cur = { path: line.slice(9).trim(), branch: '', isMain: out.length === 0 });
      else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    }
    return out;
  } catch { return []; /* not a worktree / no git */ }
}

// The folder a branch's worktree lands in: the LAST branch segment (the user/feature prefix
// is dropped, so `accedo/feature/RECORD-1458` → `RECORD-1458`). createWorktree names the
// dest with this, and worktreeForBranch matches on it — both MUST derive it the same way,
// or detection (full branch) and creation (last segment) disagree and the app offers to
// create a worktree whose folder already exists.
function worktreeFolder(branch) {
  return branch.split(/[/\\]+/).filter(Boolean).pop() || branch;
}

// The git worktree checked out at `branch`, if any (so a PR's terminal can open in the
// matching worktree instead of the main checkout). Returns the entry { path, isMain } —
// isMain true means the branch is checked out in the shared main tree, not a dedicated
// worktree — or null when no tree has it.
//
// Exact branch match first; then fall back to the dedicated worktree occupying the folder
// this branch WOULD create. A PR's remote head can carry an owner prefix the local checkout
// dropped (head `accedo/feature/RECORD-1458-x`, local branch `feature/RECORD-1458-x`) — both
// map to `<workspace>.worktrees/RECORD-1458-x`, so without this fallback the app wouldn't
// recognise the existing worktree and would offer a create that git/the folder check rejects.
async function worktreeForBranch(dir, branch) {
  if (!branch) return null;
  const trees = await listWorktrees(dir);
  const exact = trees.find(w => w.branch === branch);
  if (exact) return exact;
  const folder = worktreeFolder(branch);
  return trees.find(w => !w.isMain && (w.path.split(/[/\\]+/).filter(Boolean).pop() || '') === folder) || null;
}

// The worktree whose branch name embeds `key` (a Jira ticket key, e.g. RECORD-1234).
// Branch names conventionally carry the ticket key (feature/RECORD-1234-foo), so this
// maps a Jira ticket → its checkout. Returns an entry { path, isMain } ONLY when exactly
// one worktree matches — 0 or >1 is ambiguous, so the caller falls back to the project
// workspace. Match is case-insensitive and substring (the key is rarely the whole branch).
async function worktreeForJiraKey(dir, key) {
  if (!key) return null;
  const needle = String(key).toLowerCase();
  const hits = (await listWorktrees(dir)).filter(w => w.branch.toLowerCase().includes(needle));
  return hits.length === 1 ? hits[0] : null;
}

// Create a git worktree for `branch` as a sibling of the main checkout:
//   <workspace>.worktrees/<name>   where <name> is just the LAST branch segment — the
//   user/feature prefix is dropped, so `alex/feature/RECORD-1234` → `RECORD-1234`.
// Best-effort `fetch origin <branch>` first so a PR branch that only exists on the remote
// can be checked out; `git worktree add <dest> <branch>` then DWIMs a local branch from
// origin/<branch> when there's no local one. Never throws — failures come back as { error }.
async function createWorktree(workspace, branch) {
  if (!workspace || !branch) return { error: 'workspace and branch required' };
  const path = require('path');
  const fsp = require('fs/promises');
  // Strip any trailing slash first: `${ws}.worktrees` only lands a SIBLING of the checkout
  // when ws has no trailing separator ("/x/repo" → "/x/repo.worktrees"); "/x/repo/" would
  // give "/x/repo/.worktrees" — a hidden dir nested INSIDE the repo.
  const ws = String(workspace).replace(/[/\\]+$/, '');
  const folder = worktreeFolder(branch);
  const dest = path.join(`${ws}.worktrees`, folder);
  const exists = async p => { try { await fsp.access(p); return true; } catch { return false; } };
  try {
    if (await exists(dest)) {
      // Folder's already there. If git knows it as a worktree, adopt it (idempotent) instead
      // of erroring — covers a re-click after the branch-prefix match above resolved late, or
      // a worktree created outside the app. Only a non-worktree folder is a real conflict.
      const registered = (await listWorktrees(workspace)).some(w => w.path === dest);
      if (registered) return { ok: true, path: dest };
      return { error: 'A folder already exists at ' + dest };
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    // Clear admin entries for worktrees whose folders were deleted by hand — otherwise
    // `worktree add` can fail with "already registered" for a dest that no longer exists.
    try { await gitRun(workspace, ['worktree', 'prune']); } catch { /* nothing to prune */ }
    try { await gitRun(workspace, ['fetch', 'origin', branch]); } catch { /* local-only branch / offline */ }
    await gitRun(workspace, ['worktree', 'add', dest, branch]);
    return { ok: true, path: dest };
  } catch (err) {
    const msg = gitErrLine(err, 'git worktree add failed');
    // No local or origin/<branch> ref to check out — typically a PR from a fork, whose
    // branch isn't on `origin`. Give that a clearer message than git's "invalid reference".
    // Kept narrow to the phrases `worktree add` actually emits for a missing ref, so an
    // unrelated failure still surfaces its real cause.
    if (/invalid reference|unknown revision/i.test(msg)) {
      return { error: `Branch "${branch}" isn't available locally or on origin (a PR from a fork needs its branch fetched first).` };
    }
    return { error: msg };
  }
}

// Remove a git worktree (the folder + its admin entry) via `git -C <workspace> worktree
// remove <dest>`, run from the MAIN checkout so git never refuses "can't remove current
// worktree". NOT forced: git declines if the worktree has uncommitted/untracked changes,
// and that error surfaces to the user rather than silently destroying work. The branch
// itself is left intact. Never throws — failures come back as { error }.
async function removeWorktree(workspace, dest) {
  if (!workspace || !dest) return { error: 'workspace and worktree path required' };
  try {
    await gitRun(workspace, ['worktree', 'remove', dest]);
    return { ok: true };
  } catch (err) {
    return { error: gitErrLine(err, 'git worktree remove failed') };
  }
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

// Slow-changing repo facts (default branch, remote names) cached per-dir with a short TTL so
// the History/refs views don't respawn git for them on every click. 30s stays fresh per session.
const _repoCache = new Map();
async function cachedRepoFact(key, fn, ttl = 30_000) {
  const hit = _repoCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.val;
  const val = await fn();
  _repoCache.set(key, { at: Date.now(), val });
  return val;
}

// The repo's default branch — the remote's HEAD (origin/HEAD → e.g. "main"), else the first of
// main/master/develop that exists locally, else null (caller falls back to HEAD). This is what
// the History view shows by default, rather than whatever the workspace folder has checked out
// (it may be a worktree or a feature branch). Cached per-dir (rarely changes within a session).
function gitDefaultBranch(dir) {
  return cachedRepoFact(`default:${dir}`, async () => {
    try {
      const { stdout } = await gitRun(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      const b = stdout.trim().replace(/^origin\//, '');
      if (b) return b;
    } catch { /* no origin/HEAD set */ }
    for (const cand of ['main', 'master', 'develop']) {
      try { await gitRun(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${cand}`]); return cand; } catch { /* not present */ }
    }
    return null;
  });
}

// Real GitHub avatars for commit authors, keyed by full SHA, via one `gh api` commits call —
// the local `git log` only has name+email, which don't map to a GitHub login/avatar. Only
// commits actually pushed to GitHub resolve; the rest fall back to a generated initials avatar
// client-side. Cached per repo|ref (avatars change rarely) so branch toggles don't refetch.
// Never throws → {} on any error/offline. GitHub caps per_page at 100, so only the newest 100
// commits of the view get real avatars; older rows keep their initials.
async function commitAvatars(repo, ref = '', limit = 100) {
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return {};
  const per = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 100));
  return cachedRepoFact(`avatars:${repo}|${ref}|${per}`, async () => {
    try {
      const path = `/repos/${repo}/commits?per_page=${per}${ref ? `&sha=${encodeURIComponent(ref)}` : ''}`;
      const out = await gh(['api', path, '--jq', '.[] | [.sha, (.author.avatar_url // "")] | @tsv']);
      const map = {};
      for (const line of out.split('\n')) {
        const tab = line.indexOf('\t');
        if (tab < 0) continue;
        const sha = line.slice(0, tab), url = line.slice(tab + 1).trim();
        if (sha && url) map[sha] = url;
      }
      return map;
    } catch { return {}; }
  }, 120_000);
}

// Configured remote names (origin, upstream, …), cached per-dir. Lets parseRefs tell a remote-
// tracking ref (origin/foo) from a local branch whose name merely contains a slash (feature/foo).
function gitRemotes(dir) {
  return cachedRepoFact(`remotes:${dir}`, async () => {
    try { const { stdout } = await gitRun(dir, ['remote']); return stdout.split('\n').map(s => s.trim()).filter(Boolean); }
    catch { return []; }
  });
}

// Commit history for the project's History view. One `git log` with a field-delimited pretty
// format (US unit separator \x1f between fields, record separator \x1e between commits) — parses
// with two splits, no regex. Full SHAs (%H/%P) so the graph can match parent→child; %h is for
// display. Newest-first, which computeGraph() in git-graph.mjs expects. Never throws.
const REF_RE = /^[^-][\w./-]*$/; // ref-ish token, never a flag — safe to hand to `git log`
const LOG_FMT = '%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1e';
async function gitLog(dir, { limit = 100, skip = 0, ref = '' } = {}) {
  if (!dir) return { error: 'path required' };
  try {
    // Pick the branch to show: an explicit (validated) pick from the head's branch picker,
    // else the repo's default branch, else plain HEAD ('' → git's current checkout). Resolve
    // the default only when nothing was picked (the picked ref already decides `viewing`).
    const picked = ref && REF_RE.test(ref) ? ref : '';
    const defaultBranch = picked ? null : await gitDefaultBranch(dir);
    const viewing = picked || defaultBranch || '';
    // Clamp count/skip with Math (not `| 0`, which truncates to 32-bit and wraps large values
    // negative — e.g. skip=3e9 would become a negative --skip git rejects).
    const maxCount = Math.max(1, Math.min(1000, Math.floor(Number(limit)) || 100));
    const skp = Math.max(0, Math.min(2_147_483_647, Math.floor(Number(skip)) || 0)); // git --skip caps at INT_MAX
    const args = ['log', '--no-color', `--max-count=${maxCount}`];
    if (skp > 0) args.push(`--skip=${skp}`);
    args.push(`--pretty=format:${LOG_FMT}`);
    // Trailing `--` disambiguates the ref as a revision, not a pathspec (`git log main` alone
    // is "ambiguous" when a file named main could exist).
    if (viewing) args.push(viewing, '--');
    const [{ stdout }, remotes] = await Promise.all([gitRun(dir, args), gitRemotes(dir)]);
    const commits = stdout.split('\x1e').map(rec => rec.replace(/^\n/, '')).filter(Boolean).map(rec => {
      const [sha, short, parents, author, email, date, refs, subject] = rec.split('\x1f');
      return {
        sha, short,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        author, email, date, subject,
        refs: parseRefs(refs, remotes),
      };
    });
    const meta = await gitMeta(dir);
    // `branch` is the checked-out HEAD; `viewing` is the branch this log actually shows.
    return { commits, ...meta, viewing: viewing || meta.branch, defaultBranch };
  } catch (err) {
    // Unborn HEAD (no commits yet) is not an error for this view — show an empty history.
    if (/does not have any commits|unknown revision|bad default revision/i.test(String(err.stderr || ''))) {
      return { commits: [], branch: '', ahead: null, behind: null, viewing: '', defaultBranch: null };
    }
    return { error: gitErrLine(err, 'git log failed') };
  }
}

// Local branches for the History branch picker, most-recently-committed first. `%(HEAD)`
// is '*' for the checked-out branch. Never throws → [] on error.
async function gitBranches(dir) {
  if (!dir) return [];
  try {
    // `git for-each-ref` does NOT translate `%x1f` escapes the way `git log` does, so embed
    // the actual unit-separator byte (refnames can't contain control chars) as the delimiter.
    const fmt = '%(HEAD)\x1f%(refname:short)\x1f%(upstream:short)\x1f%(objectname:short)';
    const { stdout } = await gitRun(dir, ['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/heads']);
    return stdout.split('\n').filter(Boolean).map(l => {
      const [head, name, upstream, short] = l.split('\x1f');
      return { name, current: head === '*', upstream: upstream || null, short };
    });
  } catch { return []; }
}

// Split the `%D` decoration ("HEAD -> main, origin/main, tag: v1.0") into typed chips. A ref is
// remote-tracking only when its first segment is an actual remote name — otherwise a local
// branch with a slash (feature/foo) would be misread as a remote.
function parseRefs(d, remotes = []) {
  if (!d) return [];
  const remoteSet = new Set(remotes);
  return d.split(',').map(s => s.trim()).filter(Boolean).map(name => {
    if (name.startsWith('tag: ')) return { type: 'tag', name: name.slice(5) };
    if (name.startsWith('HEAD -> ')) return { type: 'head', name: name.slice(8) };
    if (name === 'HEAD') return { type: 'head-detached', name: 'HEAD' };
    if (name.includes('/') && remoteSet.has(name.slice(0, name.indexOf('/')))) return { type: 'remote', name };
    return { type: 'branch', name };
  });
}

// One commit's full detail for the History detail pane: author + committer + message, and the
// patch text (fed to diff2html; the renderer derives the file list from it). `git show` diffs a
// normal commit against its parent and a root commit against the empty tree. `-m --first-parent`
// makes merge commits show their diff against the first parent (plain `git show` prints nothing
// for a merge), while leaving non-merge commits unchanged. Never throws.
async function gitShow(dir, sha) {
  if (!dir || !sha) return { error: 'path and sha required' };
  if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) return { error: 'invalid sha' };
  const SHOW_FMT = '%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%B';
  try {
    const [info, patch] = await Promise.all([
      gitRun(dir, ['show', '-s', `--pretty=format:${SHOW_FMT}`, sha]),
      gitRun(dir, ['show', sha, '-m', '--first-parent', '--no-color', '--no-ext-diff', '--format=']),
    ]);
    const [full, short, parents, an, ae, ad, cn, ce, cd, body] = info.stdout.split('\x1f');
    return {
      meta: {
        sha: full, short, parents: parents ? parents.split(' ').filter(Boolean) : [],
        author: an, authorEmail: ae, authorDate: ad,
        committer: cn, committerEmail: ce, commitDate: cd,
        message: (body || '').trim(),
      },
      diff: patch.stdout.replace(/^\n+/, ''),
    };
  } catch (err) {
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { error: 'Commit too large to display' };
    return { error: gitErrLine(err, 'git show failed') };
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

module.exports = { gh, getPRs, getCurrentUser, getUserName, reviewRequestedAt, categoryOf, awaitingReview, extractJiraKeys, parseRepo, gitRemoteRepo, worktreeForBranch, worktreeForJiraKey, createWorktree, removeWorktree, gitDiff, gitCommit, gitPush, gitDiscard, gitLog, gitShow, gitBranches, gitDefaultBranch, commitAvatars, listWorktrees, summarizeCI };
