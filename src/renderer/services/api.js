import { ROUTES } from '/shared/routes.mjs';

// Fetch wrapper for the local API: JSON in/out, throws on non-2xx with the server's
// error message.
export async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Ask the server to sync PRs + Jira *now* instead of waiting out the poll cycle (up to
// 60s for PRs / 120s for Jira). The resulting snapshot writes broadcast an SSE `sync`
// event, which the renderer turns into a seamless refreshActivePage() — so whichever
// content page is showing updates right after a change. We need this for changes the
// server can't observe on its own — chiefly a PR merged/closed inside the embedded
// GitHub webview, which produces no SSE and wouldn't surface until the next poll.
// Fire-and-forget: failures just fall back to the next scheduled poll.
export const forceSync = () => api(ROUTES.POLL, { method: 'POST' }).catch(() => {});

// Shorthand for JSON-body writes.
export const apiJson = (path, method, body) =>
  api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
