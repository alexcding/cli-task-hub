// Git-client launch templates: the tokenizer must split argv the way a shell-free spawn
// needs (quoted app names stay one token), and {path} substitution must keep the path as a
// single argument — never re-split — so a folder with spaces/metacharacters can't inject.
const { test } = require('node:test');
const assert = require('node:assert');
const { tokenize, openInGitClient } = require('../src/main/native/git-client');

test('tokenize splits on whitespace', () => {
  assert.deepEqual(tokenize('open -a Fork {path}'), ['open', '-a', 'Fork', '{path}']);
});

test('tokenize keeps a "double quoted" run as one token', () => {
  assert.deepEqual(tokenize('open -a "GitHub Desktop" {path}'),
    ['open', '-a', 'GitHub Desktop', '{path}']);
});

test('tokenize handles deeplink templates as a single url token', () => {
  assert.deepEqual(tokenize('open x-github-client://openLocalRepo/{path}'),
    ['open', 'x-github-client://openLocalRepo/{path}']);
});

// The substitution the handler performs: tokenize, then replace {path} per token. A path
// with a space must stay ONE argv entry (no shell, no re-split → no injection).
const subst = (tmpl, p) => tokenize(tmpl).map(t => t.split('{path}').join(p));

test('a path with spaces stays a single argument', () => {
  assert.deepEqual(subst('open -a Fork {path}', '/Users/me/My Repo'),
    ['open', '-a', 'Fork', '/Users/me/My Repo']);
});

test('shell metacharacters in the path are inert (one arg, not re-tokenized)', () => {
  const evil = '/tmp/$(rm -rf ~); echo';
  assert.deepEqual(subst('open -a Fork {path}', evil), ['open', '-a', 'Fork', evil]);
});

test('path substitutes inside a deeplink token', () => {
  assert.deepEqual(subst('open x-github-client://openLocalRepo/{path}', '/Users/me/repo'),
    ['open', 'x-github-client://openLocalRepo//Users/me/repo']);
});

test('openInGitClient no-ops on a blank template or path', () => {
  assert.equal(openInGitClient('', '/tmp/x'), false);
  assert.equal(openInGitClient('open -a Fork {path}', ''), false);
});

// A custom command pointing at a missing binary fails ASYNC (ENOENT 'error' event), which an
// unlistened ChildProcess would rethrow as an uncaught exception → main-process crash. The
// 'error' listener swallows it; this test fails (uncaught) if that listener is ever removed.
test('a missing binary does not crash (async spawn error is handled)', async () => {
  assert.equal(openInGitClient('this-binary-does-not-exist-zzz {path}', '/tmp/x'), true);
  await new Promise(r => setTimeout(r, 80)); // let the async ENOENT fire while this test owns the tick
});
