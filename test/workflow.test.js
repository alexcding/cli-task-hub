// Tests for src/renderer/lib/workflow.mjs (a DOM-free ES module — loaded via dynamic import).
const { test } = require('node:test');
const assert = require('node:assert');

const mod = import('../src/renderer/lib/workflow.mjs');

test('wfSlug: lowercases, collapses non-alphanumerics, trims, caps', async () => {
  const { wfSlug } = await mod;
  assert.equal(wfSlug('REC-1234 Fix the Login!'), 'rec-1234-fix-the-login');
  assert.equal(wfSlug('  --weird__name--  '), 'weird-name');
  assert.equal(wfSlug(''), '');
  assert.equal(wfSlug(null), '');
  assert.equal(wfSlug('x'.repeat(60)).length, 40);
});

test('wfBranchName: feature/<key>-<summary>, drops an empty summary cleanly', async () => {
  const { wfBranchName } = await mod;
  assert.equal(wfBranchName('REC-12', 'Fix the login bug'), 'feature/rec-12-fix-the-login-bug');
  assert.equal(wfBranchName('REC-12', ''), 'feature/rec-12'); // no trailing dash
  assert.equal(wfBranchName('REC-12', null), 'feature/rec-12');
});

test('normalizeSteps: passes steps through, converts the legacy commands[] shape, defaults fields', async () => {
  const { normalizeSteps } = await mod;
  assert.deepEqual(normalizeSteps({ steps: [{ title: 'a', command: 'x' }, { command: 'y' }] }),
    [{ title: 'a', command: 'x' }, { title: '', command: 'y' }]);
  assert.deepEqual(normalizeSteps({ commands: ['x', 'y'] }),
    [{ title: '', command: 'x' }, { title: '', command: 'y' }]); // legacy shape
  assert.deepEqual(normalizeSteps({}), []);
});

test('resolvePlaceholders: substitutes known keys, leaves unknown/empty literal', async () => {
  const { resolvePlaceholders } = await mod;
  const ctx = { url: 'https://j/browse/REC-1', key: 'REC-1', branch: 'feature/rec-1', repo: 'o/r' };
  assert.equal(resolvePlaceholders('/feature_dev {url}', ctx), '/feature_dev https://j/browse/REC-1');
  assert.equal(resolvePlaceholders('git checkout {branch} # {key}', ctx), 'git checkout feature/rec-1 # REC-1');
  assert.equal(resolvePlaceholders('echo {missing}', ctx), 'echo {missing}'); // unknown → literal
  assert.equal(resolvePlaceholders('echo {worktree}', { worktree: '' }), 'echo {worktree}'); // empty → literal
  assert.equal(resolvePlaceholders('', ctx), '');
  assert.equal(resolvePlaceholders(null, ctx), '');
});
