// Unit tests for the PR → Jira-key linker. Three layers:
//   extractJiraLinks — full {base}/browse/KEY links only; the DESCRIPTION source of truth.
//   extractJiraKeys  — plain key matcher (case-insensitive, no shorthand expansion); TITLE only.
//   prJiraKeys       — the policy: description links → else the title's keys, both scoped to the
//                      project's own Jira key.
// Keys feed both the dashboard card AND the on-merge Fix Version / transition automation
// (services/poller.js), so example keys inside code blocks must NOT be treated as tickets.
const { test } = require('node:test');
const assert = require('node:assert');
const { extractJiraKeys, extractJiraLinks, prJiraKeys } = require('../src/shared/jira-keys.mjs');

// ── extractJiraLinks: full {base}/browse/KEY links only, host-agnostic ────────────
test('extractJiraLinks: pulls keys from browse URLs on any host, deduped + upper-cased', () => {
  const body = [
    '### Issue Id',
    'https://accedobroadband.jira.com/browse/RECORD-2216',
    'https://example.atlassian.net/browse/record-2228', // lower-case in URL still normalizes
    'https://accedobroadband.jira.com/browse/RECORD-2216', // dup
  ].join('\n');
  assert.deepEqual(extractJiraLinks(body), ['RECORD-2216', 'RECORD-2228']);
});

test('extractJiraLinks: ignores BARE keyword mentions — only full links count', () => {
  // The #210 release body lists keys as prose, not links — and a bracketed bare key is ignored too.
  assert.deepEqual(extractJiraLinks('Profile fixes — RECORD-2216 / 2228 / 2229 (sizing).'), []);
  assert.deepEqual(extractJiraLinks('builds on #207 (RECORD-2228)'), []);
  assert.deepEqual(extractJiraLinks('[JIRA-29022] is just a label, not a link'), []);
});

test('extractJiraLinks: ignores a sample browse URL inside a code block', () => {
  assert.deepEqual(extractJiraLinks('```\ncurl https://x.jira.com/browse/RECORD-1 \n```'), []);
});

// ── extractJiraKeys: plain key matcher for the title (case-insensitive, NO expansion) ──
test('extractJiraKeys: matches plain keys, case-insensitive, normalized + deduped', () => {
  assert.deepEqual(extractJiraKeys('Fix RECORD-22 and record-22 plus RECORD-23'), ['RECORD-22', 'RECORD-23']);
});

test('extractJiraKeys: NO shorthand expansion — only the fully-prefixed key', () => {
  assert.deepEqual(extractJiraKeys('RECORD-2216/2228/2229: Profile Management bug fixes'), ['RECORD-2216']);
});

test('extractJiraKeys: ignores keys inside code blocks / inline spans', () => {
  assert.deepEqual(extractJiraKeys('```\nRECORD-471 : sample\n```'), []);
  assert.deepEqual(extractJiraKeys('the build `RECORD-2260` is a sample'), []);
});

test('extractJiraKeys: empty / nullish input', () => {
  assert.deepEqual(extractJiraKeys(''), []);
  assert.deepEqual(extractJiraKeys(null), []);
  assert.deepEqual(extractJiraKeys(undefined), []);
});

// ── prJiraKeys: description links → title fallback, scoped to the project key ──────
test('prJiraKeys: description links are authoritative; the title is ignored when links exist', () => {
  const pr = {
    title: 'RECORD-2216: Fix PIN keyboard sizing', // does NOT narrow
    body: 'x https://x.jira.com/browse/RECORD-2216 y https://x.jira.com/browse/RECORD-2228',
  };
  assert.deepEqual(prJiraKeys(pr, 'RECORD'), ['RECORD-2216', 'RECORD-2228']);
});

test('prJiraKeys: no links in body → falls back to the plain title key', () => {
  const pr = { title: 'record-2216: keyboard fix', body: 'no links, just prose RECORD-9999' };
  assert.deepEqual(prJiraKeys(pr, 'RECORD'), ['RECORD-2216']);
});

test('prJiraKeys: project key scopes BOTH paths — unrelated keys never link', () => {
  // A cross-project browse link and a "UTF-8"-style token in the title are both filtered out.
  assert.deepEqual(
    prJiraKeys({ title: 't', body: 'https://x.jira.com/browse/OTHER-5 https://x.jira.com/browse/RECORD-7' }, 'RECORD'),
    ['RECORD-7']);
  assert.deepEqual(prJiraKeys({ title: 'Fix UTF-8 and RECORD-7 encoding', body: '' }, 'RECORD'), ['RECORD-7']);
});

test('prJiraKeys: no project key configured → nothing is filtered', () => {
  assert.deepEqual(prJiraKeys({ title: '', body: 'https://x.jira.com/browse/OTHER-5' }, ''), ['OTHER-5']);
});

test('prJiraKeys: #210 release PR (bare keys in body, none in title) → no links', () => {
  const pr = { title: 'Release: merge develop into main', body: 'Profile fixes — RECORD-2216 / 2228 / 2229.' };
  assert.deepEqual(prJiraKeys(pr, 'RECORD'), []);
});
