// Manages `gh webhook forward` child processes, one per watched repo.
const { spawn } = require('child_process');
const db = require('../database/db');
const { gh } = require('../repositories/github'); // shared `gh` CLI wrapper (binary, maxBuffer, error handling)

const processes = new Map();     // repo -> ChildProcess
const restartTimers = new Map(); // repo -> timeout handle for a pending restart
const failures = new Map();      // repo -> consecutive failure count (drives backoff)
const starting = new Set();      // repos mid-(re)start — guards against double spawn
const stuckConflict = new Set(); // repos stuck on a 422 we can't self-heal — error logged once
let stopped = false;             // set by stopAll() (app quitting) so an in-flight start() bails

// Restart backoff: a forwarder that dies unexpectedly is re-spawned, with the delay
// growing on repeated quick failures so a persistently broken repo doesn't hot-loop.
const BASE_DELAY = 1000;        // first retry after ~1s
const MAX_DELAY  = 30000;       // cap retries at 30s apart
const HEALTHY_MS = 60000;       // a process that ran this long is "stable" → reset backoff
const STUCK_DELAY = 5 * 60_000; // unrecoverable 422: retry rarely (vs 30s) — fast retries here
                                // only spam the log and leak another hook each time, never converging

// `gh webhook forward` creates this hook (name "cli", delivering to the relay below)
// and removes it on graceful exit. A hard kill / crash leaks it, and the next launch
// then fails with "HTTP 422 — Hook already exists". Track the hook id TaskHub created
// so cleanup never deletes another active `gh webhook forward` process' hook.
const RELAY_HOST = 'webhook-forwarder.github.com';
const HOOKS_CONFIG_KEY = 'webhook_forwarder_hooks';
const HOOK_CONFLICT_RE = /hook already exists|http\s*422/i;

// gh wrappers with forgiving semantics for self-heal: JSON-or-null, and ran-ok boolean.
const ghJson = (args) => gh(args).then(out => { try { return JSON.parse(out); } catch { return null; } }).catch(() => null);
const ghRun  = (args) => gh(args).then(() => true).catch(() => false);

const relayHooks = async (repo) => {
  const hooks = await ghJson(['api', `repos/${repo}/hooks`]);
  return Array.isArray(hooks)
    ? hooks.filter(h => String(h?.config?.url || '').includes(RELAY_HOST))
    : [];
};

const trackedHooks = () => {
  try { return JSON.parse(db.get(HOOKS_CONFIG_KEY) || '{}') || {}; }
  catch { return {}; }
};

const setTrackedHook = (repo, hookId) => {
  const hooks = trackedHooks();
  if (hookId) hooks[repo] = hookId;
  else delete hooks[repo];
  db.set(HOOKS_CONFIG_KEY, JSON.stringify(hooks));
};

// Record the relay hook this TaskHub process created. If another forwarder already had a
// relay hook before we started, it stays untracked and will never be cleaned up by us.
const rememberCreatedHook = async (repo, beforeIds) => {
  const before = new Set(beforeIds);
  const created = (await relayHooks(repo)).filter(h => !before.has(h.id));
  if (created.length === 1) {
    setTrackedHook(repo, created[0].id);
    db.addLog({ category: 'webhook', level: 'info', type: 'hook_tracked', payload: { repo, hookId: created[0].id } });
  }
};

// Self-heal only for a hook id we previously observed TaskHub create. This preserves the
// old recovery behavior for TaskHub-owned leaked hooks without deleting another active
// `gh webhook forward` session that happens to use the same relay host.
const cleanupTrackedHook = async (repo) => {
  const hookId = trackedHooks()[repo];
  if (!hookId) return false;
  console.log(`[webhook] Removing tracked stale forwarder hook ${hookId} on ${repo}`);
  db.addLog({ category: 'webhook', level: 'info', type: 'stale_hook_removed', payload: { repo, hookId } });
  await ghRun(['api', '-X', 'DELETE', `repos/${repo}/hooks/${hookId}`]);
  setTrackedHook(repo, null);
  return true;
};

const clearRestart = (repo) => {
  const t = restartTimers.get(repo);
  if (t) { clearTimeout(t); restartTimers.delete(repo); }
};

const start = async (repo, port) => {
  if (stopped || processes.has(repo) || starting.has(repo)) return;
  starting.add(repo);
  clearRestart(repo); // starting now supersedes any pending retry

  let beforeHookIds = [];
  try { beforeHookIds = (await relayHooks(repo)).map(h => h.id); } catch { /* best-effort */ }

  // stopAll() (app quitting), the toggle flipping off, or a racing start may have happened
  // during the await above — bail rather than spawning a child nothing will clean up.
  if (stopped || processes.has(repo) || !db.getForwardedRepos().includes(repo)) { starting.delete(repo); return; }

  const url = `http://localhost:${port}/webhook/github`;
  console.log(`[webhook] Starting forwarder for ${repo} → ${url}`);
  db.addLog({ category: 'webhook', level: 'info', type: 'forwarder_started', payload: { repo } });

  const proc = spawn('gh', [
    'webhook', 'forward',
    `--repo=${repo}`,
    '--events=pull_request',
    `--url=${url}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const startedAt = Date.now();
  let stderrTail = '';
  const rememberTimer = setTimeout(() => {
    if (processes.get(repo) === proc) rememberCreatedHook(repo, beforeHookIds).catch(() => {});
  }, 3000);

  proc.stdout.on('data', d => console.log(`[webhook:${repo}]`, d.toString().trim()));
  proc.stderr.on('data', d => {
    const s = d.toString();
    stderrTail = (stderrTail + s).slice(-4096);
    console.error(`[webhook:${repo}]`, s.trim());
  });

  proc.on('exit', async (code) => {
    clearTimeout(rememberTimer);
    console.log(`[webhook] Forwarder for ${repo} exited (${code})`);
    processes.delete(repo);

    // Intentional stop (stop/stopAll) or repo no longer enabled → don't restart.
    if (proc._stopping) return;
    if (!db.getForwardedRepos().includes(repo)) { failures.delete(repo); return; }

    const conflict = HOOK_CONFLICT_RE.test(stderrTail);
    if (conflict) {
      db.addLog({ category: 'webhook', level: 'warn', type: 'hook_conflict', payload: { repo, code } });
      const cleaned = await cleanupTrackedHook(repo).catch(() => false);
      if (stopped || !db.getForwardedRepos().includes(repo)) { failures.delete(repo); return; }
      if (cleaned && db.getForwardedRepos().includes(repo)) {
        failures.delete(repo);
        stuckConflict.delete(repo); // self-healed → reset so a future conflict logs again
        restartTimers.set(repo, setTimeout(() => {
          restartTimers.delete(repo);
          start(repo, port);
        }, BASE_DELAY));
        return;
      }
      // Conflict we can't heal: the leaked relay hook wasn't created by us (untracked), so
      // every restart deterministically re-hits 422 — and each `gh webhook forward` attempt
      // leaks yet another hook, so fast retries never converge (observed: 40+ leaked hooks,
      // 50+ failures in 2h). Surface it once, then retry on a long interval instead of the 30s
      // backoff: that stops the log/API spam while still recovering if the hook is cleared.
      if (!stuckConflict.has(repo)) {
        stuckConflict.add(repo);
        console.error(`[webhook] ${repo}: stuck on a 'hook already exists' (422) conflict TaskHub can't auto-clear — remove the stale 'gh webhook forward' hook in the repo's webhook settings.`);
        db.addLog({ category: 'webhook', level: 'error', type: 'hook_conflict_unrecoverable', payload: { repo, hint: `Delete the leaked relay hook (config.url contains ${RELAY_HOST}) in ${repo}'s webhook settings, or via 'gh api -X DELETE repos/${repo}/hooks/<id>'.` } });
      }
      console.warn(`[webhook] Retrying ${repo} in ${STUCK_DELAY}ms (stuck on a 422 conflict)`);
      db.addLog({ category: 'webhook', level: 'warn', type: 'forwarder_restart', payload: { repo, code, stuck: true, delayMs: STUCK_DELAY } });
      restartTimers.set(repo, setTimeout(() => {
        restartTimers.delete(repo);
        start(repo, port);
      }, STUCK_DELAY));
      return;
    } else {
      stuckConflict.delete(repo); // exited for some other reason → no longer a stuck conflict
    }

    // A process that stayed up a while was healthy; treat this as a fresh failure.
    if (Date.now() - startedAt > HEALTHY_MS) failures.delete(repo);
    const n = (failures.get(repo) || 0) + 1;
    failures.set(repo, n);

    const delay = Math.min(BASE_DELAY * 2 ** (n - 1), MAX_DELAY);
    console.warn(`[webhook] Restarting forwarder for ${repo} in ${delay}ms (attempt ${n})`);
    db.addLog({ category: 'webhook', level: 'warn', type: 'forwarder_restart', payload: { repo, code, attempt: n, delayMs: delay } });
    restartTimers.set(repo, setTimeout(() => {
      restartTimers.delete(repo);
      start(repo, port);
    }, delay));
  });

  processes.set(repo, proc);
  starting.delete(repo);
};

const stop = (repo) => {
  clearRestart(repo);
  failures.delete(repo);
  starting.delete(repo); // a start mid-cleanup re-checks the desired set and will bail
  stuckConflict.delete(repo);
  const proc = processes.get(repo);
  if (proc) { proc._stopping = true; proc.kill(); processes.delete(repo); }
};

const stopAll = () => {
  stopped = true; // block any start() currently awaiting cleanupStaleHooks from spawning
  for (const t of restartTimers.values()) clearTimeout(t);
  restartTimers.clear();
  failures.clear();
  starting.clear();
  stuckConflict.clear();
  for (const [, proc] of processes) { proc._stopping = true; proc.kill(); }
  processes.clear();
};

// Sync running forwarders to match the current repo list
const sync = (port) => {
  stopped = false; // a fresh sync re-enables starting (clears a prior stopAll)
  const repos = new Set(db.getForwardedRepos());

  // Start missing
  for (const repo of repos) {
    if (!processes.has(repo)) start(repo, port);
  }

  // Stop removed (also cancels any pending restart for them)
  for (const repo of processes.keys()) {
    if (!repos.has(repo)) stop(repo);
  }
  for (const repo of restartTimers.keys()) {
    if (!repos.has(repo)) clearRestart(repo);
  }
};

const list = () => [...processes.keys()];

module.exports = { start, stop, stopAll, sync, list };
