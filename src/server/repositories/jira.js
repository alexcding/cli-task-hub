const { spawnSync } = require('child_process');

const run = (args) => {
  const result = spawnSync('acli', ['jira', ...args], { encoding: 'utf8' });
  if (result.error) throw new Error(`acli not found: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr || `acli exited ${result.status}`).trim());
  return result.stdout.trim();
};

const getWorkItem = (key) =>
  JSON.parse(run(['workitem', 'view', key, '--json']));

// The authenticated Jira account, parsed from `acli jira auth status` (e.g. site
// "accedobroadband.jira.com", email "you@org.com"). The email + a user API token authenticate
// the REST writes acli can't do (see repositories/jira-rest.js); the site builds ticket links.
const getAuth = () => {
  const out = run(['auth', 'status']);
  return {
    site:  (out.match(/Site:\s*(\S+)/i)  || [])[1] || null,
    email: (out.match(/Email:\s*(\S+)/i) || [])[1] || null,
  };
};

// Just the site host — used to build ticket links without hardcoding.
const getSite = () => getAuth().site;

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
    // The status' workflow category ('new' | 'indeterminate' | 'done') — nested in the
    // status field acli already returns. Drives the board's left→right column order so
    // To Do columns sit left of In Progress, In Progress left of Done.
    statusCategory: f.status?.statusCategory?.key || '',
    // Status id maps a ticket to its board COLUMN (the board config groups status ids
    // into ordered columns) so the Scrumboard can mirror the web board's column order.
    statusId: f.status?.id || '',
    type:     f.issuetype?.name || '',
    priority: f.priority?.name || '',
    assignee: f.assignee?.displayName || f.assignee?.emailAddress || '',
    // accountId lets the UI reassign to a known person (acli assign needs an id/email,
    // not a display name) and builds the board's "who's on this sprint" roster.
    assigneeId: f.assignee?.accountId || '',
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

// Assign a work item to someone (account id, email, or '@me'), or unassign when the
// assignee is blank. Like transitionWorkItem, acli can exit 0 while reporting a per-item
// failure, so request --json and surface a real error when nothing was assigned.
const assignWorkItem = (key, assignee) => {
  const args = ['workitem', 'assign', '--key', key, '--yes', '--json'];
  if (assignee) args.push('--assignee', assignee);
  else args.push('--remove-assignee');
  const out = run(args);
  let parsed;
  try { parsed = JSON.parse(out); } catch { return out; } // older acli without --json
  const failed = (parsed.results || []).filter(r => r.status !== 'SUCCESS');
  if (failed.length || parsed.successCount === 0) {
    throw new Error(failed[0]?.message || `Could not assign ${key}`);
  }
  return parsed;
};

// Existing release versions for a Jira project, as [{ id, name, released, archived }].
// Backs the fix-version automation (the "does it exist yet?" check + the script's `versions`).
const listVersions = (projectKey) => {
  if (!projectKey) return [];
  const out = JSON.parse(run(['project', 'view', '--key', projectKey, '--json']));
  return (out.versions || []).map(v => ({ id: v.id, name: v.name, released: !!v.released, archived: !!v.archived }));
};

// The active sprint for a project: first scrum board for the key → first active
// sprint on it. acli's workitem search never returns the sprint custom field, so
// this two-call chain is the only way to get the sprint's id/name/dates. The id lets
// the board feed query `sprint = <id>` (the exact active sprint, all assignees).
const activeSprint = (projectKey) => {
  const boards = JSON.parse(run(['board', 'search', '--project', projectKey, '--json', '--limit', '50']));
  const board = (boards.values || []).find(b => b.type === 'scrum');
  if (!board) return null;
  const out = JSON.parse(run(['board', 'list-sprints', '--id', String(board.id), '--state', 'active', '--json']));
  const s = (out.sprints || [])[0];
  return s ? { id: s.id, name: s.name, endDate: s.endDate || null, boardId: board.id } : null;
};

module.exports = { getWorkItem, getSite, getAuth, searchWorkItems, searchLean, transitionWorkItem, assignWorkItem, activeSprint, listVersions };
