const { execFile } = require('child_process');
const { promisify } = require('util');
const fsp = require('fs/promises');
const path = require('path');
const execFileAsync = promisify(execFile);
const { PR_CATEGORY } = require('../../shared/constants.mjs');
const { prJiraKeys } = require('../../shared/jira-keys.mjs'); // Jira-key scraping policy (pure, shared)

const MAX_BUFFER = 10 * 1024 * 1024;
// gh is a network CLI — bound every invocation so a stalled call (network stall, stuck
// credential helper, wedged subprocess) rejects instead of hanging forever. Essential now
// that the poller coalesces on the in-flight promise: an unbounded hang would otherwise pin
// a project's sync for the whole process lifetime (the snapshot would freeze). 60s matches
// the deliberate timeout on gitPush below.
const GH_TIMEOUT = 60_000;

// Lightweight gh metrics — answers "is gh where the time goes?" without a profiler.
// Surfaced in the Settings DB inspector (/api/db → ghStats). `calls/errors/totalMs/maxMs/
// slowest` are gh-spawn timing; `inflight/coalesced` are the poller's sync-dedup gauges,
// bumped through noteInflight/noteCoalesced so the field names stay private to this module.
const _gh = { calls: 0, errors: 0, totalMs: 0, maxMs: 0, slowest: null, inflight: 0, coalesced: 0 };
const ghStats = () => ({ ..._gh, avgMs: _gh.calls ? Math.round(_gh.totalMs / _gh.calls) : 0 });
const noteInflight = delta => { _gh.inflight += delta; };
const noteCoalesced = () => { _gh.coalesced++; };

async function gh(args) {
  const startedAt = Date.now();
  try {
    const { stdout } = await execFileAsync('gh', args, { maxBuffer: MAX_BUFFER, timeout: GH_TIMEOUT });
    return stdout.trim();
  } catch (err) {
    _gh.errors++;
    throw new Error((err.stderr || err.message || 'gh failed').toString().trim());
  } finally {
    const ms = Date.now() - startedAt;
    _gh.calls++; _gh.totalMs += ms;
    if (ms > _gh.maxMs) { _gh.maxMs = ms; _gh.slowest = args.join(' ').slice(0, 80); }
  }
}

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

// Is `branch` a name git would accept (check-ref-format) AND safe to derive a folder from? Rejects
// `.`/`..` segments, a leading `-`, control chars and git's forbidden punctuation. The folder is the
// last segment, so a bad segment could otherwise resolve OUTSIDE `${ws}.worktrees` (e.g. `..` → the
// repo's parent) and the override path would rm -rf it.
function validBranchName(branch) {
  const b = String(branch || '');
  if (!b || b.startsWith('-') || b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock')) return false;
  if (/[\x00-\x20\x7f~^:?*\[\\]|\.\.|@\{|\/\/|^@$/.test(b)) return false;
  return b.split('/').every(seg => seg && seg !== '.' && !seg.startsWith('.'));
}

// Does `ref` resolve in this repo? (`rev-parse --verify` is quiet and never throws here.)
async function refExists(dir, ref) {
  try { await gitRun(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return true; } catch { return false; }
}

// Files an abandoned worktree regenerates on its own — IDE/OS state that carries no work. Xcode,
// left open on a worktree whose checkout was already removed, re-saves its UI state and recreates a
// `<proj>.xcodeproj/project.xcworkspace/xcuserdata/…/UserInterfaceState.xcuserstate` tree; Finder
// drops `.DS_Store`. A `<ws>.worktrees/<x>` folder holding ONLY these (and no `.git`) is leftover
// cruft, not a checkout — so createWorktree can clear it and recreate rather than dead-ending on
// "a folder already exists". Anything outside this set is treated as real content and left intact.
const isDisposableName = name =>
  name === '.DS_Store' || name === 'contents.xcworkspacedata' || /\.xcuserstate$/.test(name);
async function isDisposableLeftover(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === '.git') return false;                                  // a (possibly broken) checkout — never auto-clear
      if (!(await isDisposableLeftover(path.join(dir, e.name)))) return false;
    } else if (e.isFile()) {
      if (!isDisposableName(e.name)) return false;                          // any real file → not disposable
    } else return false;                                                     // symlink/socket/etc. → be safe, leave it
  }
  return true;
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
async function createWorktree(workspace, branch, opts = {}) {
  if (!workspace || !branch) return { error: 'workspace and branch required' };
  // Strip any trailing slash first: `${ws}.worktrees` only lands a SIBLING of the checkout
  // when ws has no trailing separator ("/x/repo" → "/x/repo.worktrees"); "/x/repo/" would
  // give "/x/repo/.worktrees" — a hidden dir nested INSIDE the repo.
  const ws = String(workspace).replace(/[/\\]+$/, '');
  if (!validBranchName(branch)) return { error: `"${branch}" is not a valid branch name` };
  const folder = worktreeFolder(branch);
  const root = `${ws}.worktrees`;
  const dest = path.join(root, folder);
  // Belt and braces over validBranchName: the folder must sit strictly inside the worktrees root.
  if (path.dirname(dest) !== root) return { error: `Refusing to create a worktree outside ${root}` };
  const exists = async p => { try { await fsp.access(p); return true; } catch { return false; } };
  try {
    if (await exists(dest)) {
      // Folder's already there. If git knows it as a worktree, adopt it (idempotent) instead
      // of erroring — covers a re-click after the branch-prefix match above resolved late, or
      // a worktree created outside the app.
      const registered = async () => (await listWorktrees(workspace)).some(w => w.path === dest);
      if (await registered()) return { ok: true, path: dest };
      // Not registered, but the folder exists. Resolve it instead of dead-ending on "a folder
      // already exists":
      //   • a real worktree that lost its admin link (its `.git` pointer survives but git's
      //     bookkeeping was pruned/orphaned, e.g. the main repo was re-cloned) → `worktree repair`
      //     re-establishes the connection from the worktree side, then we adopt it.
      //   • an empty husk (a half-finished create, or a worktree whose folder was hand-deleted and
      //     re-made) → remove it and fall through to create cleanly below.
      //   • anything else (a non-worktree folder with real content) → DON'T unilaterally delete a
      //     folder we didn't create. Report it as a conflict so the caller can ask the user, then
      //     retry with opts.override to wipe + recreate. We tag whether it's only regenerable IDE
      //     state (isDisposableLeftover) so the prompt can say how safe the deletion is.
      if (await exists(path.join(dest, '.git'))) {
        try { await gitRun(workspace, ['worktree', 'repair', dest]); } catch { /* not repairable */ }
        if (await registered()) return { ok: true, path: dest };
      }
      const entries = await fsp.readdir(dest).catch(() => ['?']); // unreadable → treat as non-empty (don't touch it)
      if (entries.length && !opts.override) {
        return { error: 'A folder already exists at ' + dest, folderConflict: true, path: dest, disposable: await isDisposableLeftover(dest) };
      }
      // The lexical containment check above can be defeated by a symlinked `${ws}.worktrees` (or a
      // symlinked folder inside it): resolve both and refuse to rm anything that doesn't REALLY sit
      // directly under the real worktrees root.
      const [realRoot, realDest] = await Promise.all([fsp.realpath(root).catch(() => ''), fsp.realpath(dest).catch(() => '')]);
      if (!realRoot || !realDest || path.dirname(realDest) !== realRoot) return { error: `Refusing to replace ${dest}: it resolves outside ${root}` };
      await fsp.rm(dest, { recursive: true, force: true }).catch(() => {}); // empty husk, or user-confirmed override → wipe, then create below
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    // Clear admin entries for worktrees whose folders were deleted by hand — otherwise
    // `worktree add` can fail with "already registered" for a dest that no longer exists.
    try { await gitRun(workspace, ['worktree', 'prune']); } catch { /* nothing to prune */ }
    try { await gitRun(workspace, ['fetch', 'origin', branch]); } catch { /* local-only branch / offline */ }
    try {
      await gitRun(workspace, ['worktree', 'add', dest, branch]); // existing branch (local or origin/<branch>)
    } catch (addErr) {
      // No such branch yet. For a new task (opts.create) branch it off the default branch; otherwise
      // surface the missing-ref error (e.g. a fork PR whose branch isn't on origin). Match ONLY the
      // missing-ref phrases `worktree add` emits — same narrow set as the fork-message check below —
      // so an unrelated failure (bad path "No such file…", a flag error) throws instead of silently
      // creating an unintended branch.
      if (!opts.create || !/invalid reference|unknown revision/i.test(gitErrLine(addErr, ''))) throw addErr;
      const base = opts.base || await gitDefaultBranch(workspace) || 'main';
      if (opts.base && !validBranchName(base)) return { error: `"${base}" is not a valid base branch name` };
      try { await gitRun(workspace, ['fetch', 'origin', '--', base]); } catch { /* offline / local-only base */ }
      // Start point: origin/<base> (just fetched — the freshest tip) when it exists, else the local
      // <base> (a branch never pushed / no remote). An EXPLICIT base that resolves nowhere is an
      // error — never silently fork off whatever HEAD the main checkout has; the HEAD fallback is
      // kept only for the implicit default-branch case (e.g. a fresh repo with no remote).
      const start = (await refExists(workspace, `origin/${base}`)) ? `origin/${base}`
        : (await refExists(workspace, base)) ? base : '';
      if (!start && opts.base) return { error: `Base branch "${base}" was not found locally or on origin` };
      await gitRun(workspace, start ? ['worktree', 'add', '-b', branch, dest, start] : ['worktree', 'add', '-b', branch, dest]);
    }
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

// Processes with a file OPEN under a worktree, so the delete flow can warn that an external app
// (typically Xcode) is sitting on it. On macOS an open file unlinks fine, so this never BLOCKS
// removal — but the app re-saves state into the just-removed folder, leaving the husk that blocks
// the next New Task; closing it first is the only real prevention. Advisory only: we name holders,
// never kill them. `lsof +D` walks the tree (can be slow on a big checkout) so it's bounded and
// only ever run on an explicit delete.
//
// The key filter is fd TYPE, not the command name (unreliable — the task's own `claude` shows up
// under a versioned exec name lsof can't be allow-listed against). A shell or CLI merely PARKED in
// the worktree holds it only as its `cwd`/`rtd` (a directory fd); an editor actually editing holds
// open REGULAR files (numbered fds). So we count a process only when it has a real open file there —
// that cleanly drops the task's own shell + CLI and keeps the GUI app the user should quit. Returns
// distinct [{ command, pid }] (empty on any failure — a missing/odd `lsof` must never wedge a delete).
async function worktreeHolders(dir) {
  if (!dir) return [];
  let stdout = '';
  // -F pcft → field-tagged lines: `p<pid>` + `c<command>` per process, then `f<fd>` + `t<type>` per
  // open file. lsof exits non-zero when a path is inaccessible or nothing matches, but still prints
  // what it found, so we read partial output off the error rather than discarding it.
  try { ({ stdout } = await execFileAsync('lsof', ['-F', 'pcft', '+D', String(dir)], { maxBuffer: MAX_BUFFER, timeout: 8000 })); }
  catch (e) { stdout = (e.stdout || '').toString(); }
  const holders = new Map(); // pid → command, only for processes holding a real open file
  let pid = '', cmd = '', fd = '';
  for (const line of stdout.split('\n')) {
    const tag = line[0], val = line.slice(1);
    if (tag === 'p') { pid = val; cmd = ''; fd = ''; }
    else if (tag === 'c') cmd = val;
    else if (tag === 'f') fd = val;                                  // fd: a number (open file) or cwd/rtd/txt/mem
    else if (tag === 't' && val === 'REG' && /^\d/.test(fd)) holders.set(pid, cmd); // a numbered fd on a REG file = genuinely open
  }
  return [...holders.entries()].map(([p, command]) => ({ command, pid: Number(p) || 0 }));
}

// Ask Xcode to close every workspace/project document under `dir` (AppleScript; macOS only). Runs
// only when lsof reported Xcode holding files there, so it never launches Xcode. Best effort.
async function closeInXcode(dir) {
  if (process.platform !== 'darwin') return;
  const script = `tell application "Xcode"
  repeat with d in (every workspace document)
    try
      if (path of d as string) starts with "${String(dir).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" then close d saving no
    end try
  end repeat
end tell`;
  try { await execFileAsync('osascript', ['-e', script], { timeout: 8000 }); } catch { /* Xcode not scriptable right now */ }
}

// Remove a git worktree (the folder + its admin entry) via `git -C <workspace> worktree
// remove <dest>`, run from the MAIN checkout so git never refuses "can't remove current
// worktree". Plain: git declines if the worktree has uncommitted/untracked changes, and that
// error surfaces to the user. `force` (the task delete, after its confirm): close it in Xcode if
// Xcode holds it, `worktree remove --force` (discards uncommitted changes), and if anything is
// still left, delete the folder outright and prune git's bookkeeping — everything goes. The
// branch itself is left intact either way. Never throws — failures come back as { error }.
async function removeWorktree(workspace, dest, { force = false } = {}) {
  if (!workspace || !dest) return { error: 'workspace and worktree path required' };
  if (force) {
    // Force still only ever deletes something that IS (or was) a linked worktree of this workspace:
    // git-registered and not the main checkout, or an unregistered folder that is either gone or a
    // disposable IDE husk. Anything else — the main checkout itself, an arbitrary folder — is refused,
    // so a bad path from the renderer can never rm -rf a repo.
    const norm = p => String(p).replace(/[/\\]+$/, '');
    if (norm(dest) === norm(workspace)) return { error: 'refusing to remove the main checkout' };
    const trees = await listWorktrees(workspace);
    const tree = trees.find(w => norm(w.path) === norm(dest));
    if (tree?.isMain) return { error: 'refusing to remove the main checkout' };
    const present = await fsp.access(dest).then(() => true, () => false);
    if (!tree && present && !(await isDisposableLeftover(dest))) return { error: `${dest} is not a worktree of this project` };
    const holders = await worktreeHolders(dest);
    if (holders.some(h => /xcode/i.test(h.command))) await closeInXcode(dest);
    if (tree) { try { await gitRun(workspace, ['worktree', 'remove', '--force', dest]); } catch { /* fall through to the sweep */ } }
    try { await fsp.rm(dest, { recursive: true, force: true }); } catch (err) { return { error: `could not delete ${dest}: ${err.message}` }; }
    try { await gitRun(workspace, ['worktree', 'prune']); } catch { /* best effort */ }
    return { ok: true, forced: true };
  }
  try {
    // Already gone (folder deleted by hand, or removed while the task record outlived it): git says
    // "is not a working tree" — that is success for the caller, not a reason to keep the task. Prune
    // any stale admin entry so the next create is clean. A folder that still EXISTS but isn't a
    // registered worktree falls through to git's error: we never delete a folder we don't own.
    const registered = (await listWorktrees(workspace)).some(w => w.path === dest);
    const present = await fsp.access(dest).then(() => true, () => false);
    if (!registered && !present) {
      try { await gitRun(workspace, ['worktree', 'prune']); } catch { /* best effort */ }
      return { ok: true, gone: true };
    }
    await gitRun(workspace, ['worktree', 'remove', dest]);
    // `worktree remove` deletes the folder, but an IDE still open on the checkout (Xcode) re-saves
    // its UI state to the just-removed path moments later, recreating an `xcuserdata` husk that then
    // blocks the next New Task. Sweep that leftover now if it's nothing but regenerable IDE state —
    // shrinking the race so the husk doesn't linger (createWorktree clears any straggler on re-create).
    try { if (await isDisposableLeftover(dest)) await fsp.rm(dest, { recursive: true, force: true }); } catch { /* gone already / unreadable */ }
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

// Resolve a base branch NAME to a ref that exists in this worktree for `base..HEAD`: the local
// branch first, then the remote-tracking origin/<name> (a PR base often isn't checked out
// locally). Returns null if neither resolves, so the caller can skip the range cleanly.
async function resolveBaseRef(dir, name) {
  for (const cand of [name, `origin/${name}`]) {
    try { await gitRun(dir, ['rev-parse', '--verify', '--quiet', cand]); return cand; } catch { /* not present */ }
  }
  return null;
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

// Commit history for the session's Review → History view. One `git log` with a field-delimited
// pretty format (US unit separator \x1f between fields, record separator \x1e between commits) —
// parses with two splits, no regex. Full SHAs (%H/%P), %h for display. Newest-first. Never throws.
const REF_RE = /^[^-][\w./-]*$/; // ref-ish token, never a flag — safe to hand to `git log`
const LOG_FMT = '%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1e';
async function gitLog(dir, { limit = 100, skip = 0, ref = '', aheadOnly = false, base = '' } = {}) {
  if (!dir) return { error: 'path required' };
  try {
    // Pick the branch to show: an explicit (validated) pick from the head's branch picker,
    // else the repo's default branch, else plain HEAD ('' → git's current checkout). Resolve
    // the default only when nothing was picked (the picked ref already decides `viewing`).
    const picked = ref && REF_RE.test(ref) ? ref : '';
    // The default branch and HEAD metadata both feed the ahead-of-base range and are independent,
    // so resolve them together rather than serially.
    const [defaultBranch, meta] = await Promise.all([
      picked ? Promise.resolve(null) : gitDefaultBranch(dir),
      gitMeta(dir),
    ]);
    let viewing = picked || defaultBranch || '';
    // aheadOnly (the inline PR history): show just this branch's own commits — the range
    // base..HEAD — instead of the whole graph. Prefer the PR's real base branch (passed in,
    // validated), else the repo default. On the base branch itself there's nothing to diff, so
    // fall back to the normal newest-first log. `baseUsed` rides back for the header.
    let revision = viewing;
    let baseUsed = null;
    if (aheadOnly && !picked && meta.branch) {
      const want = base && REF_RE.test(base) ? base : defaultBranch;
      const baseRef = want && want !== meta.branch ? await resolveBaseRef(dir, want) : null;
      if (baseRef) {
        baseUsed = want;            // report the human branch name, not the resolved origin/<name>
        viewing = meta.branch;
        revision = `${baseRef}..HEAD`; // HEAD always resolves; baseRef is verified to exist
      }
    }
    // Clamp count/skip with Math (not `| 0`, which truncates to 32-bit and wraps large values
    // negative — e.g. skip=3e9 would become a negative --skip git rejects).
    const maxCount = Math.max(1, Math.min(1000, Math.floor(Number(limit)) || 100));
    const skp = Math.max(0, Math.min(2_147_483_647, Math.floor(Number(skip)) || 0)); // git --skip caps at INT_MAX
    const args = ['log', '--no-color', `--max-count=${maxCount}`];
    if (skp > 0) args.push(`--skip=${skp}`);
    args.push(`--pretty=format:${LOG_FMT}`);
    // Trailing `--` disambiguates the ref as a revision, not a pathspec (`git log main` alone
    // is "ambiguous" when a file named main could exist).
    if (revision) args.push(revision, '--');
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
    // `branch` is the checked-out HEAD; `viewing` is the branch this log actually shows.
    return { commits, ...meta, viewing: viewing || meta.branch, defaultBranch, base: baseUsed };
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
  const os = require('os');
  const file = path.join(os.tmpdir(), `taskhub-discard-${process.pid}-${Date.now()}.patch`);
  try {
    await fsp.writeFile(file, patch);
    await gitRun(dir, ['apply', '-R', file]);
    return { ok: true };
  } catch (err) {
    return { error: gitErrLine(err, 'git apply failed') };
  } finally {
    fsp.unlink(file).catch(() => {});
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

// ── PR fetch (GraphQL: cursor-paginated, status-scoped) ──────────────────────────
const PR_TTL_MS = 20_000;
const prCache = new Map(); // key -> { at, value }

// 100 is GitHub's max page size for a connection. Every repo we track holds its entire OPEN
// set in one page, so "fetch ALL open PRs" normally still costs exactly one call.
const PR_PAGE_SIZE = 100;
// Hard stop on the cursor walk, so a huge history (or a hasNextPage that never settles) can
// never spin forever inside one sync.
const PR_MAX_PAGES = 20;

// Why GraphQL and not `gh pr list`: the CLI takes ONE --state and exposes no cursor, so it can
// only ever answer "the newest N across the states you asked for". That is how an old-but-OPEN
// PR silently disappeared from a `--state all --limit 60` window once 60 newer PRs had merged —
// the snapshot is built from that list, so the PR vanished from the dashboard AND its project.
// Here the state set is a real server-side filter and the pages are real cursors, so open PRs
// are fetched COMPLETELY and independently of merge volume.
//
// The states are our own fixed literals (never user input), so they're interpolated into the
// query as GraphQL enums rather than bound as a variable: `gh` rejects the repeated `-f k=v`
// form needed to pass a list ("unexpected override existing field").
const PR_STATES = Object.freeze({
  open:   ['OPEN'],
  closed: ['CLOSED'],
  merged: ['MERGED'],
  all:    ['OPEN', 'MERGED', 'CLOSED'],
});

// What every consumer needs: categorization (author/reviewRequests/latestReviews/isDraft),
// Jira-key scraping (title/body) and the card (the rest).
const PR_GQL_CORE = `number title state url headRefName baseRefName mergedAt isDraft createdAt updatedAt reviewDecision body
    author{ login ... on User{ name } }
    labels(first:20){ nodes{ name color description } }
    reviewRequests(first:20){ nodes{ requestedReviewer{ ... on User{ login } } } }
    latestReviews(first:20){ nodes{ state author{ login } } }`;

// The CI rollup walks the head commit's check runs — by far the most expensive part of the
// query. Requested ONLY for the status that actually displays it (open PRs); merge detection
// never reads CI, so the closed window doesn't pay for it.
const PR_GQL_CI = `commits(last:1){ nodes{ commit{ statusCheckRollup{ contexts(first:100){ nodes{
      ... on CheckRun{ status conclusion }
      ... on StatusContext{ state }
    } } } } } }`;

// Lifecycle-only projection: exactly what the pr_merged / pr_closed events read. No labels,
// reviews, CI or branch refs — a merged PR never renders a card, so fetching those is waste.
//
// `body` is deliberately NOT here even though the Jira merge automation needs it (prJiraKeys
// reads title + body): it's the single largest field on a PR, and only the 0-1 PRs that merged
// SINCE THE LAST POLL ever have it read. Carrying it for the whole window made bodies ~71% of
// the sync payload to serve a once-in-a-while lookup, so the merge path fetches it on demand
// via getPRBody instead.
const PR_GQL_LIFECYCLE = `number title state url mergedAt updatedAt author{ login }`;

const prQuery = (states, fields) => `query($owner:String!,$name:String!,$first:Int!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:[${states.join(',')}],first:$first,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{ hasNextPage endCursor }
      nodes{ ${fields} }
    }
  }
}`;

// GraphQL connections nest ({nodes:[…]}) where `gh pr list` handed back flat arrays. Flatten to
// the CLI's shape so categoryOf / awaitingReview / prJiraKeys / summarizeCI / lean() — and every
// renderer field they feed — keep working untouched. Absent selections stay absent (the
// lifecycle projection asks for none of these), so callers can still tell "empty" from
// "not requested".
function flattenPR(node) {
  const pr = { ...node };
  if (node.labels)         pr.labels         = (node.labels.nodes || []).filter(Boolean);
  if (node.reviewRequests) pr.reviewRequests = (node.reviewRequests.nodes || []).map(r => r.requestedReviewer).filter(Boolean);
  if (node.latestReviews)  pr.latestReviews  = (node.latestReviews.nodes || []).filter(Boolean);
  if (node.commits) {
    // summarizeCI reads `.status` / `.conclusion || .state` per entry — which is exactly the
    // CheckRun ({status, conclusion}) and StatusContext ({state}) shape, so it needs no change.
    pr.statusCheckRollup = node.commits.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || [];
    delete pr.commits;
  }
  return pr;
}

// Walk the connection's cursors until the states are exhausted, `limit` is reached, or
// PR_MAX_PAGES trips. `limit: Infinity` means "every PR in these states" — the point of
// paginating: open-PR coverage no longer depends on a guessed limit.
async function fetchPRPages(repo, { states, fields, limit = Infinity, until = null }) {
  // The GraphQL query needs owner and name separately (the CLI took `--repo owner/name` whole),
  // so a malformed repo must fail loudly here rather than as an opaque gh error.
  const [owner, name] = String(repo || '').split('/');
  if (!owner || !name) throw new Error(`invalid repo "${repo}" (expected owner/name)`);
  const query = prQuery(states, fields);
  const out = [];
  let after = null;
  let more = false; // did we stop with pages still left? (cap hit, not a natural end)
  for (let page = 0; page < PR_MAX_PAGES; page++) {
    const first = Math.max(1, Math.min(PR_PAGE_SIZE, limit - out.length));
    const args = ['api', 'graphql', '-f', `query=${query}`,
      '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `first=${first}`];
    // Cursors are opaque base64 (with '='), so pass as a raw string (-f), never typed (-F).
    if (after) args.push('-f', `after=${after}`);
    const conn = JSON.parse(await gh(args))?.data?.repository?.pullRequests;
    // A missing connection is a BAD RESPONSE, not the end of the walk — `repository: null` on a
    // transient permission/visibility hiccup would otherwise look like "no more pages" and hand
    // back a truncated list, which the poller would then write as a complete snapshot. Throwing
    // keeps that on the sync-failure path, where the previous snapshot is preserved.
    if (!conn) throw new Error(`unexpected gh graphql response for ${repo} (no pullRequests connection)`);
    const nodes = (conn.nodes || []).filter(Boolean).map(flattenPR);
    // `until` walks back only as far as a timestamp instead of trusting a fixed count. The
    // connection is ordered UPDATED_AT desc, so the first node older than the boundary means
    // every node after it is older too — take the prefix and stop.
    if (until) {
      const past = nodes.findIndex(n => n.updatedAt && n.updatedAt < until);
      if (past !== -1) { out.push(...nodes.slice(0, past)); more = false; break; }
    }
    out.push(...nodes);
    // Reaching `limit` is a COMPLETE walk as far as the caller asked, not a truncated one —
    // clear `more` so it can't trip the cap warning below.
    if (out.length >= limit) { more = false; break; }
    if (!conn.pageInfo?.hasNextPage) { more = false; break; }
    more = true;
    after = conn.pageInfo.endCursor;
  }
  // Only reachable with an absurd open-PR count; log it rather than truncate in silence, so a
  // repo that outgrows the cap is diagnosable instead of just quietly missing PRs.
  if (more) console.warn(`[gh] ${repo}: stopped at PR_MAX_PAGES (${PR_MAX_PAGES}) with pages remaining — ${out.length} fetched`);
  return out;
}

// Per-user classification + Jira keys + CI, on a flattened PR. The reviewRequests/latestReviews
// selections exist only to compute category/awaitingMyReview, so they're dropped afterwards.
function enrichPR(pr, me, jiraProjectKey, ci) {
  const enriched = {
    ...pr,
    jiraKeys: prJiraKeys(pr, jiraProjectKey),
    category: categoryOf(pr, me),
    awaitingMyReview: awaitingReview(pr, me),
  };
  if (ci) { enriched.ci = summarizeCI(pr.statusCheckRollup); delete enriched.statusCheckRollup; }
  delete enriched.reviewRequests; // only needed for categorization
  delete enriched.latestReviews;  // only needed for awaitingReview
  return enriched;
}

// PRs in `state` ('open' | 'closed' | 'merged' | 'all'), newest-updated first. `limit`
// Infinity fetches every match. Unknown state falls back to open rather than querying
// every state (an unbounded 'all' walk is the expensive mistake to guard against).
async function getPRs(repo, state = 'open', limit = 30, { ci = false, fresh = false, jiraProjectKey = '' } = {}) {
  // jiraProjectKey scopes Jira-key extraction (see prJiraKeys), so it's part of the cache identity —
  // two projects sharing a repo but different keys must not read each other's cached jiraKeys.
  const key = `${repo}|${state}|${limit}|${ci}|${jiraProjectKey}`;
  if (!fresh) {
    const hit = prCache.get(key);
    if (hit && Date.now() - hit.at < PR_TTL_MS) return hit.value;
  }
  const states = PR_STATES[state] || PR_STATES.open;
  const [nodes, me] = await Promise.all([
    fetchPRPages(repo, { states, fields: ci ? `${PR_GQL_CORE}\n    ${PR_GQL_CI}` : PR_GQL_CORE, limit }),
    getCurrentUser(),
  ]);
  const value = nodes.map(pr => enrichPR(pr, me, jiraProjectKey, ci));
  prCache.set(key, { at: Date.now(), value });
  return value;
}

// EVERY open PR in the repo, with CI — the snapshot's sole input. Unlimited on purpose: the
// open set is small and bounded by how much work is actually in flight, so it's safe to fetch
// whole, and doing so is what keeps a long-lived PR visible no matter how much has merged past it.
const getOpenPRs = (repo, { jiraProjectKey = '', fresh = true } = {}) =>
  getPRs(repo, 'open', Infinity, { ci: true, fresh, jiraProjectKey });

// A recent window of merged/closed PRs, for lifecycle events + merge automation ONLY.
// Ordered by UPDATED_AT desc, and merging/closing a PR updates it, so a PR that changed since
// the last poll is at the TOP of this window — which makes a small window correct here, unlike
// the old created-order window that let a merge slip past unseen. Lean projection, no CI.
// One PR's description, fetched on demand. Pairs with PR_GQL_LIFECYCLE dropping `body`: the
// merge automation needs it for exactly the PR it's acting on.
//
// Returns the body ('' when the PR genuinely has no description) or NULL when it could not be
// read. That distinction is load-bearing: prJiraKeys falls back to the TITLE when a body
// carries no /browse/ link, so treating a failed fetch as '' would transition whatever ticket
// the title happens to name — the wrong one on a PR whose description links a different ticket.
// The caller must defer the merge on null rather than guess (see the poller's lifecycle loop).
async function getPRBody(repo, number) {
  const [owner, name] = String(repo || '').split('/');
  if (!owner || !name) return null;
  const query = `query($owner:String!,$name:String!,$number:Int!){
    repository(owner:$owner,name:$name){ pullRequest(number:$number){ body } }
  }`;
  try {
    const out = await gh(['api', 'graphql', '-f', `query=${query}`,
      '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`]);
    const pr = JSON.parse(out)?.data?.repository?.pullRequest;
    if (!pr) return null; // bad response — NOT an empty description
    return pr.body || ''; // GitHub reports no description as null
  } catch (err) {
    console.error(`[gh] body for ${repo}#${number}:`, err.message);
    return null;
  }
}

// A window of recently merged/closed PRs, for lifecycle events + merge automation ONLY.
// Ordered UPDATED_AT desc, and merging/closing a PR updates it, so what changed since the last
// poll is at the top. `since` (the last successful sync) makes the window TIME-bounded: a count
// alone silently drops the overflow forever, because next poll the same top-N are still the top
// N and the missed PRs sit below the cut with nothing left to re-detect them. `limit` stays as
// the fallback for the first sync (which seeds silently anyway) and as a backstop.
const getRecentClosedPRs = (repo, { limit = 30, since = null } = {}) => fetchPRPages(repo, {
  states: [...PR_STATES.merged, ...PR_STATES.closed],
  fields: PR_GQL_LIFECYCLE,
  limit: since ? Infinity : limit,
  until: since,
});

// ghStats reads the metrics; noteInflight/noteCoalesced let the poller's sync-dedup layer
// bump the gauges without reaching into _gh's field names.
module.exports = { gh, ghStats, noteInflight, noteCoalesced, getPRs, getOpenPRs, getRecentClosedPRs, getPRBody, getCurrentUser, getUserName, reviewRequestedAt, categoryOf, awaitingReview, parseRepo, gitRemoteRepo, worktreeForBranch, worktreeForJiraKey, createWorktree, removeWorktree, worktreeHolders, gitDiff, gitCommit, gitPush, gitDiscard, gitLog, gitShow, gitBranches, gitDefaultBranch, commitAvatars, listWorktrees, summarizeCI };
