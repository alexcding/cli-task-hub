// Pure workflow helpers — no DOM, no imports — so they're unit-testable directly (like
// diff-parse.mjs). Shared by the Workflows config tab (live preview) and, later, the run-time
// executor that resolves a command before typing it into the terminal.

// A git-branch-safe slug from a ticket key/summary: lowercase, non-alphanumerics → single dash,
// trimmed, capped. Used to build the default new-task branch name (feature/{key}-{slug}).
export const wfSlug = s =>
  String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// The default branch name for a new-task worktree, from a ticket key + summary. One source of
// truth so the Workflows-tab preview and the run-time executor can't drift on the format.
export const wfBranchName = (key, summary) =>
  `feature/${[wfSlug(key), wfSlug(summary)].filter(Boolean).join('-')}`;

// A New Task worktree's branch/folder name: the ticket KEY kept verbatim (e.g. RECORD-648) plus a
// short title slug so the worktree reads at a glance — RECORD-648-ios-vod-player-display. The key
// already being branch-safe, only the summary is slugified. Empty summary → just the key.
export const jiraTaskBranch = (key, summary) =>
  [String(key == null ? '' : key).trim(), wfSlug(summary)].filter(Boolean).join('-');

// Normalize a workflow's steps to [{title, command}], tolerating the legacy commands:[string]
// shape. Pure (no UI defaults) so both the editor buffer and any other reader share one rule.
export function normalizeSteps(w) {
  const raw = Array.isArray(w?.steps) ? w.steps
    : Array.isArray(w?.commands) ? w.commands.map(c => ({ command: c }))
      : [];
  return raw.map(s => ({ title: s?.title || '', command: s?.command || '' }));
}

// Substitute {placeholders} in a command line from a context object. An unknown or empty key is
// left as the literal {token} so the preview visibly shows what didn't resolve, rather than a gap.
// Recognized keys: url, key, pr (GitHub PR number), branch, repo, worktree, workspace.
export function resolvePlaceholders(text, ctx = {}) {
  return String(text == null ? '' : text).replace(/\{(\w+)\}/g, (m, k) =>
    (ctx[k] != null && ctx[k] !== '') ? String(ctx[k]) : m);
}
