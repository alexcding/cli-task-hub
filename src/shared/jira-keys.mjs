// Jira-key scraping: turn a PR's title/body into the Jira ticket keys it touches.
//
// Pure, dependency-free string logic — no gh/network/db — so it's unit-testable on its own and
// shareable across server + renderer. The whole linking POLICY lives here (prJiraKeys); callers
// (server/repositories/github.js, server/services/poller.js) just feed it a PR + the project's
// Jira key. Centralized on purpose: per-project extraction RULES are likely to become a project
// setting later, and this is the single seam they'd thread through.

// Strip fenced code blocks (``` … ``` / ~~~ … ~~~) and inline code spans (`…`) — those carry
// example output, changelog samples and command snippets whose keys aren't tickets this PR
// touches. Shared by both extractors.
const stripCode = (text) => (text || '')
  .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ')
  .replace(/`[^`]*`/g, ' ');

// Plain Jira keys (KEY-123) in text — case-insensitive, normalized to upper-case, with NO
// shorthand expansion. Used ONLY for the TITLE fallback (see prJiraKeys), so a focused PR titled
// "RECORD-22: …" or "record-22 fix" still links when its description carries no Jira link.
// Shorthand like "RECORD-22/23/24" yields only RECORD-22 (the 23/24 lack a prefix) — deliberately
// no expansion, per the "no extreme cases" rule.
export const extractJiraKeys = (text) => {
  const matches = stripCode(text).match(/\b[A-Za-z][A-Za-z0-9]+-\d+\b/g);
  return matches ? [...new Set(matches.map(k => k.toUpperCase()))] : [];
};

// Jira keys that appear as FULL links — {base}/browse/KEY — in the text, NOT bare "KEY" mentions
// in prose. This is the description's source of truth: a browse link is a deliberate, full-URL
// "this PR touches this ticket" signal, whereas a bare key in the Summary is usually just a
// reference to another PR/ticket. Host-agnostic — any {base}; "/browse/" is the path Jira Cloud
// and Server both use. Works wherever the link sits in the body (no section/heading dependency).
export const extractJiraLinks = (text) => {
  const keys = [];
  for (const m of stripCode(text).matchAll(/\/browse\/([A-Za-z][A-Za-z0-9]+-\d+)\b/g)) keys.push(m[1].toUpperCase());
  return [...new Set(keys)];
};

// The Jira keys THIS PR touches, scoped to the project's own Jira key (RECORD, …). Resolution:
//   1. Description Jira LINKS (extractJiraLinks) are the source of truth — a bare key in the body
//      (even "[RECORD-29022]") or a "builds on #207 (RECORD-2228)" aside never counts.
//   2. Only when the description carries NO Jira link do we fall back to a plain key in the TITLE
//      ("RECORD-22" / "record-22"). No shorthand expansion, no other heuristics.
// In BOTH paths the key must belong to `projectKey` (case-insensitive) when one is configured —
// so an unrelated "UTF-8" in a title, or a cross-project link, can't link. With no projectKey
// (project not yet configured) nothing is filtered. Order follows the description / title.
export const prJiraKeys = (pr, projectKey = '') => {
  const pk = String(projectKey || '').toUpperCase();
  const ours = k => !pk || k.startsWith(`${pk}-`);
  const descKeys = extractJiraLinks(pr.body || '').filter(ours);
  if (descKeys.length) return descKeys;            // description links are authoritative
  return extractJiraKeys(pr.title || '').filter(ours); // none in the body → fall back to the title
};
