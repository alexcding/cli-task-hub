const { spawnSync } = require('child_process');

const run = (args) => {
  const result = spawnSync('acli', ['jira', ...args], { encoding: 'utf8' });
  if (result.error) throw new Error(`acli not found: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr || `acli exited ${result.status}`).trim());
  return result.stdout.trim();
};

const getWorkItem = (key) =>
  JSON.parse(run(['workitem', 'view', key, '--json']));

const searchWorkItems = (jql, limit = 50) =>
  JSON.parse(run(['workitem', 'search', '--jql', jql, '--limit', String(limit), '--json']));

const transitionWorkItem = (key, status) =>
  run(['workitem', 'transition', '--key', key, '--status', status, '--yes']);

module.exports = { getWorkItem, searchWorkItems, transitionWorkItem };
