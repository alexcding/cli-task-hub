// Guards the on-merge Jira automation in services/poller.js (applyMergeAutomation). A merged PR's
// linked tickets must: (1) get the Fix Version built + created + stamped BEFORE any transition,
// (2) skip the version step entirely when the feature is off, (3) take NO transition when it's
// left blank (the Automation UI promises "Leave blank to take no transition"), and (4) reuse an
// existing version rather than recreating it. Every external call is mocked at its module
// boundary, so this is pure orchestration — no acli/gh/Jira.
process.env.TASKHUB_DATA_DIR ||= require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'taskhub-test-'));

const { test, mock } = require('node:test');
const assert = require('node:assert');

const poller = require('../src/server/services/poller');
const db = require('../src/server/database/db');
const github = require('../src/server/repositories/github');
const jira = require('../src/server/repositories/jira');
const jiraRest = require('../src/server/repositories/jira-rest');

// Mock every boundary applyMergeAutomation touches and return a `calls` log so tests can assert
// both WHAT ran and the ORDER (fix version before transition). Two linked keys: one from a stored
// link, one auto-extracted from the PR — so per-ticket fan-out is covered.
function harness(t, { versions = [], created = true } = {}) {
  const calls = [];
  mock.method(db, 'getLinksByPR', () => [{ jira_key: 'ABC-1' }]);
  // Tag the events that carry a version so tests can assert where the version surfaces.
  mock.method(db, 'addEvent', (type, payload = {}) => {
    const v = (type === 'jira_transitioned' || type === 'jira_fixversion_set') && payload.version ? `:${payload.version}` : '';
    calls.push(`event:${type}${v}`);
  });
  // ABC-2 is auto-linked from a real browse URL in the PR body (see PR below); no mock needed.
  mock.method(jira, 'listVersions', () => versions.map(name => ({ name })));
  mock.method(jira, 'transitionWorkItem', (key, status) => { calls.push(`transition:${key}:${status}`); });
  // ensureVersion's return models "did I create one?" — true unless the version already existed.
  mock.method(jiraRest, 'ensureVersion', async (_k, name) => { calls.push(`ensureVersion:${name}`); return created; });
  mock.method(jiraRest, 'setFixVersion', async (key, name) => { calls.push(`setFixVersion:${key}:${name}`); });
  t.after(() => mock.restoreAll());
  return calls;
}

const PR = { number: 7, title: 'Fix ABC-2', body: '### Issue Id\nhttps://acme.jira.com/browse/ABC-2' };
const writes = calls => calls.filter(c => /^(ensureVersion|setFixVersion|transition):/.test(c));

test('merge automation: Fix Version is created + stamped on every linked ticket, THEN transition runs', async (t) => {
  const calls = harness(t);
  const keys = await poller.applyMergeAutomation({
    repo: 'octo/repo', jiraProjectKey: 'ABC',
    fixVersionEnabled: true, fixVersionPrefix: 'ios-', fixVersionScript: '`1.0`',
    mergeTransition: 'Ready for QA',
  }, PR);

  assert.deepStrictEqual(keys, ['ABC-1', 'ABC-2'], 'links + auto-extracted keys, deduped');
  assert.deepStrictEqual(writes(calls), [
    'ensureVersion:ios-1.0',
    'setFixVersion:ABC-1:ios-1.0',
    'setFixVersion:ABC-2:ios-1.0',
    'transition:ABC-1:Ready for QA',
    'transition:ABC-2:Ready for QA',
  ], 'version step precedes the transition, prefix+script assembled, applied per key');
  assert.ok(calls.includes('event:jira_version_created'), 'a newly-created version logs an event');
});

test('merge automation: a blank transition takes NO transition action (regression for the old DEFAULT fallback)', async (t) => {
  const calls = harness(t);
  await poller.applyMergeAutomation({
    repo: 'octo/repo', jiraProjectKey: 'ABC',
    fixVersionEnabled: true, fixVersionPrefix: '', fixVersionScript: '`1.0`',
    mergeTransition: '',
  }, PR);

  assert.ok(!calls.some(c => c.startsWith('transition:')), 'blank transition → transitionWorkItem never called');
  assert.ok(calls.includes('setFixVersion:ABC-1:1.0'), 'fix version is still applied');
});

test('merge automation: the Fix Version step is skipped when the feature is off', async (t) => {
  const calls = harness(t);
  await poller.applyMergeAutomation({
    repo: 'octo/repo', jiraProjectKey: 'ABC',
    fixVersionEnabled: false, mergeTransition: 'Ready for QA',
  }, PR);

  assert.ok(!calls.some(c => /^(ensureVersion|setFixVersion):/.test(c)), 'no version writes when disabled');
  assert.ok(calls.includes('transition:ABC-1:Ready for QA'), 'the transition still runs on its own');
});

test('merge automation: the Fix Version rides on the transition entry, not a separate one', async (t) => {
  const calls = harness(t);
  await poller.applyMergeAutomation({
    repo: 'octo/repo', jiraProjectKey: 'ABC',
    fixVersionEnabled: true, fixVersionPrefix: 'ios-', fixVersionScript: '`1.0`',
    mergeTransition: 'Ready for QA',
  }, PR);

  assert.ok(calls.includes('event:jira_transitioned:ios-1.0'), 'the transition entry carries the version');
  assert.ok(!calls.some(c => c.startsWith('event:jira_fixversion_set')), 'no separate "set" entry when a transition follows');
});

test('merge automation: with no transition, the Fix Version gets its own entry', async (t) => {
  const calls = harness(t);
  await poller.applyMergeAutomation({
    repo: 'octo/repo', jiraProjectKey: 'ABC',
    fixVersionEnabled: true, fixVersionPrefix: 'ios-', fixVersionScript: '`1.0`',
    mergeTransition: '',
  }, PR);

  assert.ok(calls.includes('event:jira_fixversion_set:ios-1.0'), 'standalone set entry records the version when nothing else does');
});

test('merge automation: an already-existing version is reused, not re-created', async (t) => {
  const calls = harness(t, { versions: ['ios-1.0'], created: false });
  await poller.applyMergeAutomation({
    repo: 'octo/repo', jiraProjectKey: 'ABC',
    fixVersionEnabled: true, fixVersionPrefix: 'ios-', fixVersionScript: '`1.0`',
    mergeTransition: '',
  }, PR);

  assert.ok(!calls.includes('event:jira_version_created'), 'no version_created event when it already exists');
  assert.ok(calls.includes('setFixVersion:ABC-1:ios-1.0'), 'the existing version is still stamped on the ticket');
});
