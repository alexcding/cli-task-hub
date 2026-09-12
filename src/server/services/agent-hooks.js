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
const { randomUUID } = require('node:crypto');
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
const shellQuote = value => "'" + value.replace(/'/g, "'\"'\"'") + "'";
function hookCommand(cli, endpoint, portFile = PORT_FILE) {
  const script = "P=$(cat " + shellQuote(portFile) + " 2>/dev/null || echo 3000); "
    + "curl -s -m 2 -X POST \"http://127.0.0.1:$P" + endpoint + "?cli=" + cli + "&runId=${TASKHUB_RUN_ID:-}\" "
    + "-H \"Content-Type: application/json\" --data-binary @- >/dev/null 2>&1 || true # " + MARKER;
  return 'sh -c ' + shellQuote(script);
}

// ── Pure config transforms (operate on a parsed object; unit-tested directly) ──────────────
const isOurCommand = hook => typeof hook?.command === 'string' && hook.command.includes(MARKER);
const isOurs = entry => Array.isArray(entry?.hooks) && entry.hooks.some(isOurCommand);
function stripOurCommands(entry) {
  if (!isOurs(entry)) return [entry];
  const hooks = entry.hooks.filter(hook => !isOurCommand(hook));
  return hooks.length ? [{ ...entry, hooks }] : [];
}
const hasOurHookIn = (cfg, ev) => Array.isArray(cfg?.hooks?.[ev]) && cfg.hooks[ev].some(isOurs);
function addHookTo(cfg, ev, entry) {
  const c = { ...(cfg || {}) };
  c.hooks = { ...(c.hooks || {}) };
  const arr = Array.isArray(c.hooks[ev]) ? c.hooks[ev] : [];
  c.hooks[ev] = arr.flatMap(stripOurCommands).concat(entry);
  return c;
}
function removeHookFrom(cfg, ev) {
  if (!Array.isArray(cfg?.hooks?.[ev])) return cfg;
  const c = { ...cfg, hooks: { ...cfg.hooks } };
  c.hooks[ev] = c.hooks[ev].flatMap(stripOurCommands);
  return c;
}
// Claude hook entries carry a `matcher`; Codex entries don't.
const entryFor = (cli, endpoint) => {
  const e = { hooks: [{ type: 'command', command: hookCommand(cli, endpoint) }] };
  return cli === 'claude' ? { matcher: '.*', ...e } : e;
};

// ── File I/O ───────────────────────────────────────────────────────────────────────────────
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function readForUpdate(file, missingValue) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return missingValue; throw error; }
  let config;
  try { config = JSON.parse(text); }
  catch { throw new Error(`Cannot update hooks: ${file} contains invalid JSON. The file was not changed.`); }
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(config) || ('hooks' in config && !object(config.hooks)) ||
      HOOKS.some(([event]) => config.hooks?.[event] !== undefined && !Array.isArray(config.hooks[event]))) {
    throw new Error(`Cannot update hooks: ${file} has an unsupported configuration shape. The file was not changed.`);
  }
  return config;
}
// Atomic replacement avoids partial files and retains existing file permissions.
// New configs are private because the agent file may also contain credentials.
function writeJson(file, obj) {
  // Respect dotfile-manager symlinks. A dangling link must not be replaced by a
  // new ordinary file just because its intended destination cannot be resolved.
  try { file = fs.realpathSync(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    let entry;
    try { entry = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (entry?.isSymbolicLink()) throw new Error(`Cannot update hooks through a dangling link: ${file}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tmp = `${file}.taskhub.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(tmp, 'wx', mode);
  try {
    try { fs.writeFileSync(descriptor, JSON.stringify(obj, null, 2) + '\n'); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
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
  let cfg = readForUpdate(t.file, t.base);
  for (const [ev, ep] of HOOKS) cfg = addHookTo(cfg, ev, entryFor(cli, ep));
  writeJson(t.file, cfg);
}
function uninstall(cli) {
  const t = TARGETS[cli];
  if (!t) throw new Error(`unknown CLI: ${cli}`);
  let cfg = readForUpdate(t.file, null);
  if (!cfg) return;
  for (const [ev] of HOOKS) cfg = removeHookFrom(cfg, ev);
  writeJson(t.file, cfg);
}

module.exports = {
  status, install, uninstall, writePort, ENDPOINT_START, ENDPOINT_DONE,
  // exported for tests
  _isOurs: isOurs, _hasOurHookIn: hasOurHookIn, _addHookTo: addHookTo, _removeHookFrom: removeHookFrom,
  _entryFor: entryFor, _hookCommand: hookCommand,
  _readForUpdate: readForUpdate, _writeJson: writeJson,
};
