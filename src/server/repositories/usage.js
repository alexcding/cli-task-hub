// Today's AI-CLI token usage (Claude Code, Codex) via `ccusage`, which reads the
// local session logs (~/.claude/projects, ~/.codex/sessions). Same SWR discipline
// as the PR snapshot: /api/usage serves the cached value instantly and refreshes
// in the background when stale — a ccusage run is ~0.5s, never pay it per-request.
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const execFileAsync = promisify(execFile);

const TTL = 5 * 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;

// ccusage may be installed globally or only reachable through bunx/npx (bunx is
// guaranteed in this environment, see AGENTS.md). Remember the first runner that
// works so the fallback probing happens once.
const RUNNERS = [['ccusage'], ['bunx', 'ccusage'], ['npx', '-y', 'ccusage']];
let runner = null;

async function ccusage(args) {
  const candidates = runner ? [runner] : RUNNERS;
  let lastErr;
  for (const cmd of candidates) {
    try {
      const { stdout } = await execFileAsync(cmd[0], [...cmd.slice(1), ...args], { maxBuffer: MAX_BUFFER });
      runner = cmd;
      return JSON.parse(stdout);
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

const localYMD = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// One agent's numbers: today's detail plus a gap-filled day-by-day history for the
// dashboard histogram — one ccusage call covers both. The per-agent subcommands emit
// slightly different day shapes (claude: totalCost, codex: costUSD), so normalize here.
const HISTORY_DAYS = 30;
async function agentStats(agent) {
  const since = localYMD(new Date(Date.now() - (HISTORY_DAYS - 1) * 86_400_000));
  const data = await ccusage([agent, 'daily', '--json', '--since', since.replaceAll('-', '')]);
  const byDate = new Map((data.daily || []).map(d => [d.date, d]));
  const history = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const date = localYMD(new Date(Date.now() - i * 86_400_000));
    const d = byDate.get(date);
    history.push({ date, tokens: d?.totalTokens ?? 0, cost: d?.totalCost ?? d?.costUSD ?? 0 });
  }
  const today = byDate.get(localYMD());
  return {
    tokens: today?.totalTokens ?? 0,
    cost: today?.totalCost ?? today?.costUSD ?? 0,
    history,
  };
}

// The active Claude billing block (5h session): bounds plus tokens/cost so far and
// the projected end-of-block cost. Times are shipped raw — the renderer computes
// "time left" / progress at paint time, so the countdown doesn't go stale with the cache.
async function activeBlock() {
  const data = await ccusage(['blocks', '--active', '--json']);
  const b = (data.blocks || []).find(x => x.isActive);
  return b ? {
    startTime: b.startTime,
    endTime: b.endTime,
    tokens: b.totalTokens ?? 0,
    cost: b.costUSD ?? 0,
    projectedCost: b.projection?.totalCost ?? null,
  } : null;
}

// ── Plan limits (Session / Weekly bars) ─────────────────────────────────────────
// Claude's OAuth usage endpoint reports the subscription's rate-limit windows: the
// 5h session and the 7-day week, each with a utilization % and a reset time. It
// needs the local Claude Code OAuth token (credentials file, or macOS Keychain —
// the same store Claude Code itself reads). The token never leaves this module;
// only the derived percentages are shipped to the renderer.
async function oauthToken() {
  try {
    const j = JSON.parse(fs.readFileSync(`${os.homedir()}/.claude/.credentials.json`, 'utf8'));
    if (j.claudeAiOauth?.accessToken) return j.claudeAiOauth.accessToken;
  } catch { /* fall through to Keychain */ }
  try {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
    return JSON.parse(stdout.trim()).claudeAiOauth?.accessToken || null;
  } catch { return null; }
}

async function planLimits() {
  const token = await oauthToken();
  if (!token) return null;
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  // Field names vary across rollouts; try the known aliases and ship null when a
  // window is absent so the renderer just skips that bar.
  const win = (w) => (w && w.utilization != null)
    ? { usedPct: Math.max(0, Math.min(100, Math.round(w.utilization))), resetsAt: w.resets_at ?? null }
    : null;
  const session = win(data.five_hour);
  const weekly = win(data.seven_day ?? data.seven_day_overall ?? data.seven_day_oauth_apps);
  return (session || weekly) ? { session, weekly } : null;
}

// Codex's plan limits, unlike Claude's, are written to the local session logs — the
// Codex CLI records a `rate_limits` snapshot (primary = 5h window, secondary = 7-day)
// in each rollout file's token-count events. We read the newest session's latest
// snapshot, so no auth/network is needed. Shape mirrors planLimits(): {session, weekly}
// with usedPct + ISO resetsAt, or null when unavailable (not signed in / no usage yet).
const CODEX_SESSIONS = `${os.homedir()}/.codex/sessions`;

// The .jsonl rollout most recently written, found by descending the newest
// year/month/day dirs (names sort chronologically) — cheap vs walking the whole tree.
function newestRolloutFile() {
  let dir = CODEX_SESSIONS;
  for (let i = 0; i < 3; i++) {
    const subs = fs.readdirSync(dir).filter(n => /^\d+$/.test(n)).sort();
    if (!subs.length) return null;
    dir = `${dir}/${subs[subs.length - 1]}`;
  }
  const files = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'))
    .map(n => ({ n, t: fs.statSync(`${dir}/${n}`).mtimeMs })).sort((a, b) => a.t - b.t);
  return files.length ? `${dir}/${files[files.length - 1].n}` : null;
}

const findRateLimits = (o) => {
  if (!o || typeof o !== 'object') return null;
  if (o.rate_limits) return o.rate_limits;
  for (const v of Object.values(o)) { const r = findRateLimits(v); if (r) return r; }
  return null;
};

async function codexLimits() {
  const file = newestRolloutFile();
  if (!file) return null;
  const lines = (await fs.promises.readFile(file, 'utf8')).split('\n');
  let rl = null;
  for (let i = lines.length - 1; i >= 0 && !rl; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    try { rl = findRateLimits(JSON.parse(lines[i])); } catch { /* skip malformed */ }
  }
  if (!rl) return null;
  // primary = 5h session window, secondary = weekly. resets_at is unix seconds.
  const win = (w) => (w && w.used_percent != null)
    ? { usedPct: Math.max(0, Math.min(100, Math.round(w.used_percent))), resetsAt: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null }
    : null;
  const session = win(rl.primary), weekly = win(rl.secondary);
  return (session || weekly) ? { session, weekly } : null;
}

let cache = null;     // { claude, codex, block, limits, asOf } — per-agent {tokens,cost}|null
let fetchedAt = 0;
let inflight = null;

function refresh() {
  inflight ??= (async () => {
    const [claude, codex, block, limits, codexLim] = await Promise.all([
      agentStats('claude').catch(() => null),
      agentStats('codex').catch(() => null),
      activeBlock().catch(() => null),
      planLimits().catch(() => null),
      codexLimits().catch(() => null),
    ]);
    // block/limits come from flaky sources (the active-block scan, a network fetch to
    // the OAuth endpoint, a local-file read). A transient failure must NOT blank the
    // Session/Weekly bars — keep the last good value, mirroring the poller's
    // stale-while-revalidate snapshots. Per-agent stats hold their last good too.
    if (claude || codex || block || limits || codexLim || !cache) {
      cache = {
        claude: claude ?? cache?.claude ?? null,
        codex:  codex  ?? cache?.codex  ?? null,
        block:  block  ?? cache?.block  ?? null,
        limits: limits ?? cache?.limits ?? null,         // Claude (OAuth)
        codexLimits: codexLim ?? cache?.codexLimits ?? null, // Codex (rollout file)
        asOf: new Date().toISOString(),
      };
    }
    fetchedAt = Date.now();
  })().finally(() => { inflight = null; });
  return inflight;
}

// SWR read: block only on the very first call; afterwards always answer from cache
// and refresh in the background once it's older than TTL.
async function getUsage() {
  if (!cache) await refresh();
  else if (Date.now() - fetchedAt > TTL && !inflight) refresh();
  return cache;
}

module.exports = { getUsage };
