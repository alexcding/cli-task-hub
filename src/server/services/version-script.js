// Fix-version automation: run a user-authored snippet (sandboxed) that returns the *number*
// part of a release version, and assemble the final name as `<prefix><number>` (e.g. the
// script returns "0.0.0" and the prefix "ios-" → "ios-0.0.0"). Used by the Automation preview
// endpoint and the on-merge automation, so both evaluate identically.
//
// node:vm is NOT a hard security boundary, but the script is the user's own, runs locally, and
// is bounded by a short timeout — enough to stop an accidental infinite loop hanging the server.
const vm = require('node:vm');

// ISO-8601 week number — a common ingredient for weekly version schemes.
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// Run `script` and return the trimmed string it produces. `ctx` provides the inputs the
// snippet can read: now (Date), pr ({number,title,body}), versions (existing version names).
// Throws on timeout, a thrown error, or a non-string/empty return.
function runVersionScript(script, ctx = {}) {
  if (!script || !script.trim()) throw new Error('script is empty');
  const sandbox = {
    now: ctx.now || new Date(),
    pr: ctx.pr || {},
    versions: Array.isArray(ctx.versions) ? ctx.versions : [],
    isoWeek,
    pad: (n, w = 2) => String(n).padStart(w, '0'),
  };
  // Accept either a bare expression (no `return` needed, e.g. `` `0.${week}` ``) or a full
  // statement body that uses `return`. Try the expression form first; if it's not a valid
  // expression (statements, an explicit `return`, …) fall back to a function body. 200ms ceiling.
  const body = script.trim();
  let out;
  try {
    out = vm.runInNewContext(`(${body}\n)`, sandbox, { timeout: 200 });
  } catch (e) {
    // Not a valid expression (statements / explicit `return`) → run as a function body. Match
    // by name, not `instanceof`: the vm error belongs to the sandbox realm, so `instanceof
    // SyntaxError` is false here (cross-realm).
    if (!e || e.name !== 'SyntaxError') throw e;
    out = vm.runInNewContext(`(function(){ "use strict";\n${body}\n})()`, sandbox, { timeout: 200 });
  }
  if (typeof out !== 'string' || !out.trim()) throw new Error('script must return a non-empty string');
  return out.trim();
}

// The final version name = prefix + script output. Returns { number, version }.
function buildVersion(prefix, script, ctx) {
  const number = runVersionScript(script, ctx);
  return { number, version: `${prefix || ''}${number}` };
}

module.exports = { runVersionScript, buildVersion, isoWeek };
