// Local-git surface: worktrees, the diff pane, commit/push, and the Git tab's
// history/refs. All on-demand local exec (same class as /api/detect-repo), except
// commit-avatars which is `gh`-backed and cached.
const github = require('../repositories/github');
const { ROUTES } = require('../../shared/routes.mjs');

function register(app) {
  // Where a tab's branch/key is checked out, so the terminal can open there and the titlebar
  // chip can label it. Resolve by exact `branch` (GitHub PR) or by Jira `key` embedded in a
  // branch name (RECORD-1234 → feature/RECORD-1234-foo). Returns:
  //   { path, matched, isWorktree } — matched: a tree has it checked out; isWorktree: that
  //   tree is a dedicated (linked) worktree, not the shared main checkout.
  // { path: '', matched: false } when nothing matches (or, for a key, the match is ambiguous).
  app.get(ROUTES.WORKTREE, async (req, res) => {
    const { path: dir, branch, key } = req.query;
    if (!dir || (!branch && !key)) return res.json({ path: '', matched: false, isWorktree: false });
    const found = key
      ? await github.worktreeForJiraKey(String(dir), String(key))
      : await github.worktreeForBranch(String(dir), String(branch));
    res.json({ path: found?.path || '', matched: !!found, isWorktree: !!(found && !found.isMain) });
  });

  // Create a git worktree for a PR branch as a sibling of the project workspace, so the
  // tab can get its own checkout. Local git only. Returns { path } on success or { error }.
  app.post(ROUTES.WORKTREE, async (req, res) => {
    const { path: dir, branch } = req.body || {};
    if (!dir || !branch) return res.status(400).json({ error: 'path and branch required' });
    res.json(await github.createWorktree(String(dir), String(branch)));
  });

  // Remove a worktree (folder + admin entry), run from the project workspace. Local git only.
  app.post(ROUTES.WORKTREE_REMOVE, async (req, res) => {
    const { path: dir, worktree } = req.body || {};
    if (!dir || !worktree) return res.status(400).json({ error: 'path and worktree required' });
    res.json(await github.removeWorktree(String(dir), String(worktree)));
  });

  // Uncommitted changes in a checkout (the diff pane).
  app.get(ROUTES.DIFF, async (req, res) => {
    const dir = req.query.path;
    if (!dir) return res.status(400).json({ error: 'path required' });
    res.json(await github.gitDiff(String(dir)));
  });

  // Commit/push the worktree's changes (the diff pane's commit popover). The renderer
  // always sends a message — blank input is auto-filled client-side before the request.
  app.post(ROUTES.GIT_COMMIT, async (req, res) => {
    const { path: dir, message, includeUntracked } = req.body || {};
    if (!dir) return res.status(400).json({ error: 'path required' });
    if (!String(message || '').trim()) return res.status(400).json({ error: 'message required' });
    res.json(await github.gitCommit(String(dir), String(message), includeUntracked !== false));
  });

  app.post(ROUTES.GIT_PUSH, async (req, res) => {
    const dir = req.body && req.body.path;
    if (!dir) return res.status(400).json({ error: 'path required' });
    res.json(await github.gitPush(String(dir)));
  });

  // Commit history for the project History view (graph + list). Read-only local git.
  app.get(ROUTES.GIT_LOG, async (req, res) => {
    const dir = req.query.path;
    if (!dir) return res.status(400).json({ error: 'path required' });
    res.json(await github.gitLog(String(dir), { limit: Number(req.query.limit) || 100, skip: Number(req.query.skip) || 0, ref: req.query.ref ? String(req.query.ref) : '' }));
  });

  // Local branches + worktree folders + default branch for the Git tab's left rail. Read-only
  // local git. defaultBranch ships here (not just in /log) so the rail can pin it on first paint.
  app.get(ROUTES.GIT_REFS, async (req, res) => {
    const dir = req.query.path;
    if (!dir) return res.status(400).json({ error: 'path required' });
    const [branches, worktrees, defaultBranch] = await Promise.all([
      github.gitBranches(String(dir)), github.listWorktrees(String(dir)), github.gitDefaultBranch(String(dir)),
    ]);
    res.json({ branches, worktrees, defaultBranch });
  });

  // Real GitHub avatars for commit authors (keyed by SHA) — the Git tab overlays these on its
  // generated initials avatars. `gh`-backed, cached; returns {} when the repo isn't on GitHub.
  app.get(ROUTES.GIT_COMMIT_AVATARS, async (req, res) => {
    const { repo, ref, limit } = req.query;
    res.json(await github.commitAvatars(repo ? String(repo) : '', ref ? String(ref) : '', Number(limit) || 100));
  });

  // One commit's detail (meta + patch) for the History detail pane.
  app.get(ROUTES.GIT_SHOW, async (req, res) => {
    const { path: dir, sha } = req.query;
    if (!dir || !sha) return res.status(400).json({ error: 'path and sha required' });
    res.json(await github.gitShow(String(dir), String(sha)));
  });

  // Discard one hunk from the worktree (reverse-apply a single-hunk patch the renderer
  // rebuilt from its parsed diff — see hunkPatch in src/renderer/lib/diff-parse.mjs).
  app.post(ROUTES.GIT_DISCARD, async (req, res) => {
    const { path: dir, patch } = req.body || {};
    if (!dir || !patch) return res.status(400).json({ error: 'path and patch required' });
    res.json(await github.gitDiscard(String(dir), String(patch)));
  });
}

module.exports = { register };
