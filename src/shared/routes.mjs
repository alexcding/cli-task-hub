// Shared HTTP route contract — the single source of truth for every server route path,
// imported by the server (route registration) and the renderer (api.js call sites) so the
// two can't drift. Route drift fails LOUD (a 404), unlike the silent misroutes constants.mjs
// guards; the value here is one place to see/refactor the whole API surface.
//
// Authored as ESM (.mjs): the renderer imports it from /shared/routes.mjs (browsers require
// ESM); Node consumers require() it from disk (Node >=22.12). See docs/ARCHITECTURE.md.
//
// Two shapes:
//   • STATIC routes — UPPER_SNAKE string constants, used verbatim by both sides. Callers
//     that add a query string append it: `api(ROUTES.LOGS + '?' + params)`.
//   • PARAMETERIZED routes — the server's Express pattern (with `:param`) and the client's
//     path differ, so each gets BOTH: an UPPER pattern for `app.get(...)` and a lowerCamel
//     builder for the client, e.g. ROUTES.SETTINGS_KEY ('/api/settings/:key') + ROUTES.settingsKey(key).

export const ROUTES = Object.freeze({
  // ── Config / settings / tabs ────────────────────────────────────────────────
  CONFIG: '/api/config',
  SETTINGS: '/api/settings',
  SETTINGS_KEY: '/api/settings/:key',                 // server pattern (PUT)
  settingsKey: key => `/api/settings/${encodeURIComponent(key)}`, // client
  SOUNDS: '/api/sounds',
  TABS: '/api/tabs',
  TASKS: '/api/tasks',                                // durable New Task sessions (GET list / POST upsert / DELETE ?url=)
  FILE: '/api/file',                                  // local file for the embedded editor (GET ?path= read / PUT write)

  // ── Projects ─────────────────────────────────────────────────────────────────
  PROJECTS: '/api/projects',
  PROJECT: '/api/projects/:id',
  project: id => `/api/projects/${id}`,
  PROJECT_PRS: '/api/projects/:id/prs',
  projectPrs: id => `/api/projects/${id}/prs`,
  PROJECT_JIRA: '/api/projects/:id/jira',
  projectJira: id => `/api/projects/${id}/jira`,
  // The project's Scrumboard: its active sprint (all assignees, scoped to its component).
  PROJECT_BOARD: '/api/projects/:id/board',
  projectBoard: id => `/api/projects/${id}/board`,
  // Evaluate an (unsaved) fix-version script + prefix and return the assembled preview.
  PROJECT_FIXVERSION_PREVIEW: '/api/projects/:id/fixversion-preview',
  projectFixversionPreview: id => `/api/projects/${id}/fixversion-preview`,

  // ── Repo / worktree / git ──────────────────────────────────────────────────
  DETECT_REPO: '/api/detect-repo',
  WORKTREE: '/api/worktree',
  WORKTREE_REMOVE: '/api/worktree/remove',
  WORKTREE_HOLDERS: '/api/worktree/holders',
  DIFF: '/api/diff',
  GIT_COMMIT: '/api/git/commit',
  GIT_PUSH: '/api/git/push',
  GIT_LOG: '/api/git/log',
  GIT_REFS: '/api/git/refs',
  GIT_COMMIT_AVATARS: '/api/git/commit-avatars',
  GIT_SHOW: '/api/git/show',
  GIT_DISCARD: '/api/git/discard',

  // ── PRs / dashboard ──────────────────────────────────────────────────────────
  PRS_TRAY: '/api/prs/tray',
  PRS_VIEWED: '/api/prs/viewed',
  DASHBOARD: '/api/dashboard',

  // ── Jira ───────────────────────────────────────────────────────────────────
  JIRA_SITE: '/api/jira/site',
  JIRA_SPRINT: '/api/jira/sprint',
  JIRA_KEY_TRANSITION: '/api/jira/:key/transition',
  jiraKeyTransition: key => `/api/jira/${encodeURIComponent(key)}/transition`,
  JIRA_KEY_ASSIGN: '/api/jira/:key/assign',
  jiraKeyAssign: key => `/api/jira/${encodeURIComponent(key)}/assign`,

  // ── Links ──────────────────────────────────────────────────────────────────
  LINKS: '/api/links',
  LINK: '/api/links/:id',   // server pattern only — no renderer call site deletes links yet

  // ── Misc / system ────────────────────────────────────────────────────────────
  WHOAMI: '/api/whoami',
  USAGE: '/api/usage',
  EVENTS: '/api/events',
  LOGS: '/api/logs',
  LOGS_CATEGORIES: '/api/logs/categories',
  LOGS_CLEAR: '/api/logs/clear',
  DB: '/api/db',
  STREAM: '/api/stream',
  FORWARDERS: '/api/forwarders',
  POLL: '/api/poll',
  WEBHOOK_GITHUB: '/webhook/github',

  // ── CLI detection (Settings → CLIs): which CLIs are installed on PATH ──────────────────
  CLI_TOOLS: '/api/cli-tools',                // GET presence { claude, codex, gh, acli }

  // ── Agent CLI hooks (Settings → CLIs): install/inspect the "turn finished" hook ──────
  AGENT_HOOKS: '/api/agent-hooks',            // GET status { claude, codex }
  AGENT_HOOK: '/api/agent-hooks/:cli',        // POST install / DELETE remove (server pattern)
  agentHook: cli => `/api/agent-hooks/${cli}`,// client
  HOOK_TURN_START: '/api/hooks/turn-start',   // POST — installed UserPromptSubmit hook pings on turn start
  HOOK_TURN_DONE: '/api/hooks/turn-done',     // POST — installed Stop hook pings on turn end

  // ── Headless CLI analysis (Tasks page + workflow automation) ────────────────────────
  // POST { cli, text, context? } → { summary, state, decision?, reason? } via a one-shot headless
  // CLI call. The card reads summary/state; an automated workflow passes step context and gates
  // its loop on decision (proceed/retry/stop). One call, two consumers.
  AGENT_ANALYZE: '/api/agent-analyze',
});
