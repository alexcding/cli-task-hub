// Manages `gh webhook forward` child processes, one per watched repo.
const { spawn } = require('child_process');
const db = require('./db');

const processes = new Map(); // repo -> ChildProcess

const start = (repo, port) => {
  if (processes.has(repo)) return;

  const url = `http://localhost:${port}/webhook/github`;
  console.log(`[webhook] Starting forwarder for ${repo} → ${url}`);

  const proc = spawn('gh', [
    'webhook', 'forward',
    `--repo=${repo}`,
    '--events=pull_request',
    `--url=${url}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  proc.stdout.on('data', d => console.log(`[webhook:${repo}]`, d.toString().trim()));
  proc.stderr.on('data', d => console.error(`[webhook:${repo}]`, d.toString().trim()));

  proc.on('exit', (code) => {
    console.log(`[webhook] Forwarder for ${repo} exited (${code})`);
    processes.delete(repo);
  });

  processes.set(repo, proc);
};

const stop = (repo) => {
  const proc = processes.get(repo);
  if (proc) { proc.kill(); processes.delete(repo); }
};

const stopAll = () => {
  for (const [repo, proc] of processes) { proc.kill(); }
  processes.clear();
};

// Sync running forwarders to match the current repo list
const sync = (port) => {
  const repos = new Set(db.getAllRepos());

  // Start missing
  for (const repo of repos) {
    if (!processes.has(repo)) start(repo, port);
  }

  // Stop removed
  for (const repo of processes.keys()) {
    if (!repos.has(repo)) stop(repo);
  }
};

const list = () => [...processes.keys()];

module.exports = { start, stop, stopAll, sync, list };
