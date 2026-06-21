// Detect which of the CLIs TaskHub drives are installed on the user's PATH — and, for the
// polling CLIs (gh/acli), whether they're signed in. Claude Code / Codex are the agent CLIs we
// install workflow hooks into (see agent-hooks.js); gh / acli are what the server shells out to
// for GitHub PRs and Jira tickets, and a present-but-logged-out CLI silently returns nothing —
// so Settings reports both "installed" and "authorized" to explain an empty feed.
//
// Presence: probe `<bin> --version` (same execFile path the real calls take, so PATH/Homebrew
// resolution matches) — ENOENT = absent; any other outcome (success OR a non-zero exit) = present.
// Auth: `gh auth status` / `acli jira auth status` exit 0 only when signed in. We only run the
// auth probe when the binary is present. The renderer calls this lazily — only when the Settings
// → CLIs tab is shown — so there's no TTL cache (a stale pill that ignores a just-completed
// `gh auth login` was worse than the spawns); instead concurrent calls are coalesced (in-flight
// dedupe) and every fresh visit re-probes.
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// bin = the executable we invoke elsewhere; authArgs = a status probe that exits non-zero when
// signed out (omitted for the agent CLIs, where auth is the user's concern at run time). Keep
// these in sync with the real call sites (repositories/github.js, repositories/jira.js).
const CLIS = [
  { id: 'claude', bin: 'claude' },
  { id: 'codex', bin: 'codex' },
  { id: 'gh', bin: 'gh', authArgs: ['auth', 'status'] },
  { id: 'acli', bin: 'acli', authArgs: ['jira', 'auth', 'status'] },
];

const PROBE_TIMEOUT = 4000;
const AUTH_TIMEOUT = 8000;  // a status check can hit the network (token validation)
let _inflight = null;       // coalesce concurrent probes; fresh on every new visit (no TTL)

async function present(bin) {
  try {
    await execFileAsync(bin, ['--version'], { timeout: PROBE_TIMEOUT });
    return true;
  } catch (err) {
    // ENOENT = not found on PATH. Anything else (non-zero exit, timeout) means it ran, so it exists.
    return err?.code !== 'ENOENT';
  }
}

// A status probe can fail because the CLI isn't signed in OR because it couldn't reach the
// service (gh auth status validates the token over the network; a killed/timed-out probe too).
// Only the former means "signed out" — a connectivity failure tells us nothing, so we must not
// report it as signed-out (it'd flip a logged-in user to "Not signed in" the moment they go
// offline). Pure + exported so the classification is unit-tested directly.
function isTransientAuthError(err) {
  if (!err) return false;
  if (err.killed || err.signal || err.code === 'ETIMEDOUT') return true; // hit AUTH_TIMEOUT / SIGTERM
  const msg = `${err.stderr || ''} ${err.message || ''}`.toLowerCase();
  return /could not connect|connection (refused|reset)|dial tcp|no such host|network is unreachable|timeout|timed out|i\/o timeout|eai_again|temporary failure|tls handshake|deadline exceeded/.test(msg);
}

// null = unknown (no auth probe for this CLI, or the probe couldn't reach the service);
// true/false = signed in / signed out.
async function authed(bin, authArgs) {
  if (!authArgs) return null;
  try {
    await execFileAsync(bin, authArgs, { timeout: AUTH_TIMEOUT });
    return true; // exit 0 = signed in
  } catch (err) {
    return isTransientAuthError(err) ? null : false; // unreachable = unknown; clean non-zero = signed out
  }
}

async function probe(cli) {
  const isPresent = await present(cli.bin);
  const out = { present: isPresent };
  if (isPresent && cli.authArgs) out.authed = await authed(cli.bin, cli.authArgs);
  return out;
}

async function detect() {
  // Coalesce overlapping calls (rapid tab toggles, a double render) onto one set of spawns, but
  // never reuse a settled result — the next visit re-probes so a just-completed install/login shows.
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const results = await Promise.all(CLIS.map(probe));
    return Object.fromEntries(CLIS.map((c, i) => [c.id, results[i]]));
  })();
  try { return await _inflight; }
  finally { _inflight = null; }
}

module.exports = { detect, _isTransientAuthError: isTransientAuthError };
