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
function client() {
  const token = db.get('jira_api_token');
  if (!token) throw new Error('no Jira API token set (Settings → Jira)');
  const { site, email } = jira.getAuth();
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
  const { base, headers } = client();
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

// Add `versionName` to issue `key`'s Fix Version field (additive — keeps any existing versions).
async function setFixVersion(key, versionName) {
  await call('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`,
    { update: { fixVersions: [{ add: { name: versionName } }] } });
}

module.exports = { ensureVersion, setFixVersion };
