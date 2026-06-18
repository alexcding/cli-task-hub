// Open a repo/worktree folder in the user's chosen git GUI (Fork, Tower, Sourcetree,
// GitHub Desktop, …) by running their configured command TEMPLATE with the tab's folder
// substituted for `{path}`. The template comes from Settings — a built-in preset like
// `open -a Fork {path}` or a user's own custom command/deeplink (see git-clients.js in
// the renderer). Backs CH.OPEN_IN_GIT_CLIENT (src/main/ipc/system.js).
//
// Safety: we tokenize the template (honoring "double quotes" for app names with spaces),
// substitute the path INTO a discrete argv entry, and spawn WITHOUT a shell — so a folder
// path containing spaces, quotes, or shell metacharacters is passed verbatim as one
// argument and can never break out into command injection.
const { spawn } = require('child_process');

// Split a command template into argv. A "double quoted" run is one token (for "GitHub
// Desktop"); everything else is whitespace-delimited.
function tokenize(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

// Substitute `{path}` into each token, then spawn argv[0] with the rest. Returns true when
// a process was launched. No-ops (returns false) on a blank template/path or spawn failure.
function openInGitClient(template, folder) {
  const tmpl = String(template || '').trim();
  const p = String(folder || '');
  if (!tmpl || !p) return false;
  const argv = tokenize(tmpl).map(tok => tok.split('{path}').join(p));
  if (!argv.length) return false;
  try {
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
    // A bad binary (ENOENT for a custom command) surfaces as an ASYNC 'error' event, not a
    // throw from spawn() — without a listener the EventEmitter would rethrow it as an uncaught
    // exception and take down the main process. Swallow it (a no-op like the blank-template
    // guard); the user just sees nothing open. Matches notifications.js handling execFile errors.
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = { openInGitClient, tokenize };
