// Jira Cloud REST writes that acli can't do: create a release version and stamp it on an issue's
// Fix Version field. acli covers reads + transitions (repositories/jira.js); these two write
// endpoints aren't in acli, so they go over the REST API with Basic auth = the acli account email
// (jira.getAuth) + a user-supplied API token (Settings → Jira, config key `jira_api_token`).
// Used only by the on-merge Fix Version automation (services/poller.js).
const db = require('../database/db');
const jira = require('./jira');

// Resolve the base URL + auth header from the live acli account + the stored token. Throws (the
// caller logs it) when the token or account can't be resolved, so the rest of the merge
// automation still runs.
async function client() {
  const token = db.get('jira_api_token');
  if (!token) throw new Error('no Jira API token set (Settings → Jira)');
  const { site, email } = await jira.getAuth();
  if (!site || !email) throw new Error('could not resolve the Jira account from acli');
  return {
    base: `https://${site}`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };
}

async function call(method, path, body) {
  const { base, headers } = await client();
  const res = await fetch(`${base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    // Surface Jira's error text (trimmed), never the auth header/token.
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Jira ${method} ${path} → ${res.status}${detail ? ` ${detail}` : ''}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

// Create release `name` in `projectKey` unless `existing` (names already fetched via acli) lists
// it. Returns true if it created one, false if it was already present.
async function ensureVersion(projectKey, name, existing = []) {
  if (existing.includes(name)) return false;
  // Version create needs the numeric project id, not the key.
  const project = await call('GET', `/rest/api/3/project/${encodeURIComponent(projectKey)}`);
  if (!project?.id) throw new Error(`could not resolve Jira project ${projectKey}`);
  await call('POST', '/rest/api/3/version', { name, projectId: Number(project.id) });
  return true;
}

// The board's columns in display order, each with the status ids it contains — the Agile
// board configuration acli can't read. Lets the Scrumboard mirror the web board's column
// order/grouping AND its per-status sub-lanes. Returns
//   [{ name, statusIds:[…], statuses:[{ id, name }] }]
// — needs the Jira API token like the other REST calls, so the caller falls back to a
// category sort when it throws. The column config only carries status IDs, so we resolve
// names from the global status list; without them, empty sub-lanes (no ticket to read a
// name from) couldn't be labelled. Names are best-effort: a failed lookup leaves them ''.
async function boardConfig(boardId) {
  const cfg = await call('GET', `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/configuration`);
  const cols = (cfg?.columnConfig?.columns || []).map(c => ({
    name: c.name,
    statusIds: (c.statuses || []).map(s => String(s.id)),
  }));
  if (!cols.length) return cols; // no columns → skip the org-wide status fetch (nothing to name)
  // Resolve status names from the global status list (the column config carries only ids), so
  // even empty sub-lanes can be labelled. `/rest/api/3/status` is the flat array [{id,name,…}] —
  // NOT the paginated `/rest/api/3/statuses/search`. Best-effort: a failed lookup leaves names ''
  // and the view falls back to names learned from loaded tickets.
  const nameById = new Map();
  try {
    const statuses = await call('GET', '/rest/api/3/status');
    for (const s of (statuses || [])) if (s?.id != null) nameById.set(String(s.id), s.name || '');
  } catch { /* names best-effort */ }
  for (const c of cols) c.statuses = c.statusIds.map(id => ({ id, name: nameById.get(id) || '' }));
  return cols;
}

// Add `versionName` to issue `key`'s Fix Version field (additive — keeps any existing versions).
async function setFixVersion(key, versionName) {
  await call('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`,
    { update: { fixVersions: [{ add: { name: versionName } }] } });
}

module.exports = { ensureVersion, setFixVersion, boardConfig };
