// Install/inspect/remove TaskHub's hooks in the user's Claude Code and Codex configs (both JSON:
// ~/.claude/settings.json and ~/.codex/hooks.json). We install TWO hooks per CLI:
//   • UserPromptSubmit → /api/hooks/turn-start  ("the CLI started working" — spinner ON)
//   • Stop            → /api/hooks/turn-done   ("the CLI finished its turn" — spinner OFF)
// This gives a precise, hook-driven busy indicator instead of guessing from terminal output.
// We MERGE idempotently and tag our entries by the /api/hooks/ marker, so installing never
// clobbers the user's existing hooks and uninstalling removes only ours.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dataDir } = require('../database/datadir');

// The live HTTP port is written here on server start so the (config-baked) hook command can reach
// us even if the port drifts off 3000 between launches.
const PORT_FILE = path.join(dataDir, '.server-port');
// A dedicated sentinel embedded in our hook command marks it as ours — far less collision-prone
// than matching the endpoint substring, so uninstall can never strip an unrelated user hook that
// merely happens to call a /api/hooks/ URL.
const MARKER = 'taskhub-workflow-hook';
const ENDPOINT_START = '/api/hooks/turn-start';     // UserPromptSubmit → spinner ON
const ENDPOINT_DONE = '/api/hooks/turn-done';       // Stop → spinner OFF

const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const CODEX_HOOKS = path.join(os.homedir(), '.codex', 'hooks.json');

function writePort(port) {
  try { fs.writeFileSync(PORT_FILE, String(port)); } catch { /* non-fatal: hook falls back to 3000 */ }
}

// The shell command a hook runs: read the live port, POST the hook's stdin payload to us, tagging
// the CLI and the per-terminal runId (TASKHUB_RUN_ID, injected into the PTY env when WE launch it).
// Fire-and-forget with a 2s cap so a down/slow TaskHub never blocks the CLI. Built with string
// concatenation (not a template literal) so $P / $(...) / ${TASKHUB_RUN_ID:-} stay literal.
function hookCommand(cli, endpoint) {
  return "sh -c 'P=$(cat \"" + PORT_FILE + "\" 2>/dev/null || echo 3000); "
    + "curl -s -m 2 -X POST \"http://127.0.0.1:$P" + endpoint + "?cli=" + cli + "&runId=${TASKHUB_RUN_ID:-}\" "
    + "-H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1 || true # " + MARKER + "'";
}

// ── Pure config transforms (operate on a parsed object; unit-tested directly) ──────────────
const isOurs = entry => Array.isArray(entry?.hooks) && entry.hooks.some(h => typeof h.command === 'string' && h.command.includes(MARKER));
const hasOurHookIn = (cfg, ev) => Array.isArray(cfg?.hooks?.[ev]) && cfg.hooks[ev].some(isOurs);
function addHookTo(cfg, ev, entry) {
  const c = { ...(cfg || {}) };
  c.hooks = { ...(c.hooks || {}) };
  const arr = Array.isArray(c.hooks[ev]) ? c.hooks[ev] : [];
  c.hooks[ev] = arr.filter(e => !isOurs(e)).concat(entry); // filter-then-add = idempotent
  return c;
}
function removeHookFrom(cfg, ev) {
  if (!Array.isArray(cfg?.hooks?.[ev])) return cfg;
  const c = { ...cfg, hooks: { ...cfg.hooks } };
  c.hooks[ev] = c.hooks[ev].filter(e => !isOurs(e));
  return c;
}
// Claude hook entries carry a `matcher`; Codex entries don't.
const entryFor = (cli, endpoint) => {
  const e = { hooks: [{ type: 'command', command: hookCommand(cli, endpoint) }] };
  return cli === 'claude' ? { matcher: '.*', ...e } : e;
};

// ── File I/O ───────────────────────────────────────────────────────────────────────────────
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
// Atomic write (temp file + rename) so a crash or a concurrent edit of the user's settings can
// never leave it half-written/corrupt — we'd rather no-op than truncate ~/.claude/settings.json.
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.taskhub.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const TARGETS = {
  claude: { file: CLAUDE_SETTINGS, base: {} },
  codex: { file: CODEX_HOOKS, base: { hooks: {} } },
};

// The hooks we install, as (event → ping endpoint) pairs — one source of truth for
// install/uninstall/status so adding an event is a single-line change.
const HOOKS = [['UserPromptSubmit', ENDPOINT_START], ['Stop', ENDPOINT_DONE]];

function status() {
  // Installed = ALL of our hook events are present, so a partial/older install (e.g. only Stop,
  // missing the turn-start hook) correctly reads as not-installed and prompts a reinstall.
  const installed = file => { const cfg = readJson(file); return HOOKS.every(([ev]) => hasOurHookIn(cfg, ev)) ? 'installed' : 'absent'; };
  return { claude: installed(TARGETS.claude.file), codex: installed(TARGETS.codex.file) };
}
function install(cli) {
  const t = TARGETS[cli];
  if (!t) throw new Error(`unknown CLI: ${cli}`);
  let cfg = readJson(t.file) || t.base;
  for (const [ev, ep] of HOOKS) cfg = addHookTo(cfg, ev, entryFor(cli, ep));
  writeJson(t.file, cfg);
}
function uninstall(cli) {
  const t = TARGETS[cli];
  if (!t) throw new Error(`unknown CLI: ${cli}`);
  let cfg = readJson(t.file);
  if (!cfg) return;
  for (const [ev] of HOOKS) cfg = removeHookFrom(cfg, ev);
  writeJson(t.file, cfg);
}

module.exports = {
  status, install, uninstall, writePort, ENDPOINT_START, ENDPOINT_DONE,
  // exported for tests
  _isOurs: isOurs, _hasOurHookIn: hasOurHookIn, _addHookTo: addHookTo, _removeHookFrom: removeHookFrom,
  _entryFor: entryFor, _hookCommand: hookCommand,
};
