// App resource usage (memory + CPU): "How much RAM and CPU is TaskHub using, all in?"
// — shown in the menu-bar menu. We sum every Electron process via getAppMetrics(): the
// main tray process, each window, every embedded GitHub/Jira <webview>, the GPU process,
// and utilities. Then we add the forked backend server and terminals because they are
// plain OS child processes, not Electron processes, so getAppMetrics() never sees them.
// Memory is KB (getAppMetrics workingSetSize and ps rss); CPU is percent of one core
// (can exceed 100% across cores — same convention as Activity Monitor and ps %cpu).
const { app } = require('electron');
const { execSync } = require('child_process');
const { getServerPid } = require('./server-supervisor');
const { getPids } = require('./terminals');

const MEM_TYPE_LABELS = { Browser: 'Main', Tab: 'Windows & web views', GPU: 'GPU', Utility: 'Utilities' };

function computeUsage() {
  const groups = new Map(); // label -> { kb, cpu }
  const add = (label, kb, cpu) => {
    const g = groups.get(label) || { kb: 0, cpu: 0 };
    g.kb += kb; g.cpu += cpu;
    groups.set(label, g);
  };

  for (const m of app.getAppMetrics()) {
    add(MEM_TYPE_LABELS[m.type] || m.type, m.memory?.workingSetSize || 0, m.cpu?.percentCPUUsage || 0);
  }

  const snap = psSnapshot(); // one (cached) ps pass shared by both tree walks below
  const serverPid = getServerPid();
  const server = ptyTreeStats(serverPid ? [serverPid] : [], snap);
  if (server.kb || server.cpu) add('Server', server.kb, server.cpu);

  const pty = ptyTreeStats(getPids(), snap);
  if (pty.kb || pty.cpu) add('Terminals', pty.kb, pty.cpu);

  let totalKB = 0, totalCPU = 0;
  const breakdown = [];
  for (const [label, g] of groups) { totalKB += g.kb; totalCPU += g.cpu; breakdown.push({ label, ...g }); }
  breakdown.sort((a, b) => b.kb - a.kb);
  return { totalKB, totalCPU, breakdown };
}

// KB → a compact human figure for the menu (MB up to a GB, then GB).
function fmtKB(kb) {
  const mb = kb / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
}

// One `ps` pass parsed into { children: ppid->[pid], stat: pid->{kb,cpu} }, cached briefly so
// the two tree walks in a single menu build — and rapid rebuilds (blur + the 60s tick) — don't
// each shell out. macOS/Linux only; returns empty maps on any failure so the readout still
// shows the Electron totals. The TTL is well under the 60s refresh, so the figure stays fresh.
const PS_CACHE_MS = 3000;
let _psCache = null, _psCacheAt = 0;
function psSnapshot() {
  const now = Date.now();
  if (_psCache && now - _psCacheAt < PS_CACHE_MS) return _psCache;
  const children = new Map(); // ppid -> [pid]
  const stat = new Map();     // pid -> { kb, cpu }
  try {
    const out = execSync('ps -axo pid=,ppid=,rss=,%cpu=', { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)$/);
      if (!m) continue;
      const pid = +m[1], ppid = +m[2];
      stat.set(pid, { kb: +m[3], cpu: +m[4] });
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }
  } catch { /* leave maps empty → zeros below */ }
  _psCache = { children, stat };
  _psCacheAt = now;
  return _psCache;
}

// Sum RSS (KB) and CPU (% of one core) of the given pids plus all their descendants, using a
// snapshot from psSnapshot(). Returns zeros when the pids aren't found.
function ptyTreeStats(rootPids, snap = psSnapshot()) {
  if (!rootPids.length) return { kb: 0, cpu: 0 };
  const { children, stat } = snap;
  let kb = 0, cpu = 0;
  const seen = new Set();
  const stack = [...rootPids];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const s = stat.get(pid);
    if (s) { kb += s.kb; cpu += s.cpu; }
    for (const c of children.get(pid) || []) stack.push(c);
  }
  return { kb, cpu };
}

module.exports = { computeUsage, fmtKB };
