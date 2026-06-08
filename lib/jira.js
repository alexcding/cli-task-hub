const { spawnSync } = require('child_process');

const run = (args) => {
  const result = spawnSync('acli', ['jira', ...args], { encoding: 'utf8' });
  if (result.error) throw new Error(`acli not found: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr || `acli exited ${result.status}`).trim());
  return result.stdout.trim();
};

const getWorkItem = (key) =>
  JSON.parse(run(['workitem', 'view', key, '--json']));

// The authenticated Jira site host, parsed from `acli jira auth status`
// (e.g. "accedobroadband.jira.com"). Used to build ticket links without hardcoding.
const getSite = () => {
  const out = run(['auth', 'status']);
  const m = out.match(/Site:\s*(\S+)/i);
  return m ? m[1] : null;
};

const searchWorkItems = (jql, limit = 50) =>
  JSON.parse(run(['workitem', 'search', '--jql', jql, '--limit', String(limit), '--json']));

// acli returns a huge object per item (avatars, changelog, schema…). The poller
// stores a snapshot the UI reads, so trim each item to just what the UI needs —
// mirrors lib/poller.js `lean(pr)` for PRs.
const leanItem = (it) => {
  const f = it.fields || {};
  return {
    key:      it.key,
    summary:  f.summary || '',
    status:   f.status?.name || '',
    type:     f.issuetype?.name || '',
    priority: f.priority?.name || '',
    assignee: f.assignee?.displayName || f.assignee?.emailAddress || '',
  };
};

// Limit the response to the fields the UI needs. acli's `--fields` only accepts
// names from its default field set here ('updated' is rejected), so keep to these.
const SEARCH_FIELDS = 'key,summary,status,issuetype,priority,assignee';

const searchLean = (jql, limit = 30) =>
  JSON.parse(run(['workitem', 'search', '--jql', jql, '--limit', String(limit), '--fields', SEARCH_FIELDS, '--json']))
    .map(leanItem);

// acli exits 0 even when a transition fails (it reports per-item results instead),
// so request --json and surface a real error when nothing transitioned. Used by the
// status menu and the PR-merge automation alike.
const transitionWorkItem = (key, status) => {
  const out = run(['workitem', 'transition', '--key', key, '--status', status, '--yes', '--json']);
  let parsed;
  try { parsed = JSON.parse(out); } catch { return out; } // older acli without --json
  const failed = (parsed.results || []).filter(r => r.status !== 'SUCCESS');
  if (failed.length || parsed.successCount === 0) {
    throw new Error(failed[0]?.message || `Could not move ${key} to "${status}"`);
  }
  return parsed;
};

module.exports = { getWorkItem, getSite, searchWorkItems, searchLean, transitionWorkItem };
