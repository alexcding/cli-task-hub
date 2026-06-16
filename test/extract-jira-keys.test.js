// Unit tests for github.extractJiraKeys — the title/body → Jira-key linker.
// Keys feed both the dashboard card AND the on-merge Fix Version / transition automation
// (services/poller.js), so example keys inside code blocks must NOT be treated as tickets.
const { test } = require('node:test');
const assert = require('node:assert');
const { extractJiraKeys } = require('../src/server/repositories/github');

test('extractJiraKeys: picks up keys in prose, deduped', () => {
  assert.deepEqual(extractJiraKeys('Fixes ABC-1 and ABC-1 plus ABC-22'), ['ABC-1', 'ABC-22']);
});

test('extractJiraKeys: ignores keys inside fenced code blocks (the PR #206 case)', () => {
  // Example release-notes output is illustrative, not tickets this PR touches.
  const body = [
    'Polish for the dev TestFlight release flow.',
    '',
    'Example output:',
    '```',
    'RECORD-471 : Browse a swipeable hero carousel.',
    'RECORD-487 : Novelas rail shows badge overlays.',
    'RECORD-1487 : You can now delete a profile.',
    'RECORD-2260 : The Favoritos tab no longer shows up empty.',
    '```',
    'The fallback also keeps the JIRA key (`RECORD-XXX : description`).',
  ].join('\n');
  assert.deepEqual(extractJiraKeys(body), []);
});

test('extractJiraKeys: ignores keys inside inline code spans', () => {
  assert.deepEqual(extractJiraKeys('the build `RECORD-2260` is a sample'), []);
});

test('extractJiraKeys: a real reference outside code still links', () => {
  const body = 'Implements ABC-9.\n\n```\nlog: ABC-999 sample\n```';
  assert.deepEqual(extractJiraKeys(body), ['ABC-9']);
});

test('extractJiraKeys: empty / nullish input', () => {
  assert.deepEqual(extractJiraKeys(''), []);
  assert.deepEqual(extractJiraKeys(null), []);
  assert.deepEqual(extractJiraKeys(undefined), []);
});
