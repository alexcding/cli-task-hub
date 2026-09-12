const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const github = require('../src/server/repositories/github');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskhub-history-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', ['-C', dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trim();
  await git('init', '-q', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  const commit = async (message, content) => {
    await fs.writeFile(path.join(dir, 'file.txt'), content);
    await git('add', '-A'); await git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

test('history preserves PR base scope, page identity, metadata and read-only merge details', async t => {
  const { dir, git, commit } = await fixture(t);
  assert.deepEqual((await github.gitLog(dir)).commits, []);
  const root = await commit('Root', 'base\n');
  await git('checkout', '-qb', 'release/next');
  const target = await commit('Target work', 'target\n');
  await git('checkout', '-qb', 'feature/work');
  const first = await commit('First feature', 'first\n');
  const second = await commit('Second feature\n\nBody with \x1f separator', 'second\n');
  const page1 = await github.gitLog(dir, { aheadOnly: true, base: 'release/next', limit: 1 });
  assert.equal(page1.base, 'release/next');
  assert.deepEqual(page1.commits.map(c => c.sha), [second]);
  assert.match(page1.historyRevision, /^[a-f0-9]{64}$/);
  const page2 = await github.gitLog(dir, { aheadOnly: true, base: 'release/next', skip: 1, limit: 1 });
  assert.deepEqual(page2.commits.map(c => c.sha), [first]);
  assert.equal(page2.historyRevision, page1.historyRevision);
  const whole = await github.gitLog(dir, { ref: 'HEAD', limit: 10 });
  assert.deepEqual(whole.commits.map(c => c.sha), [second, first, target, root]);
  const detail = await github.gitShow(dir, second);
  assert.equal(detail.meta.sha, second); assert.equal(detail.meta.author, 'Fixture');
  assert.equal(detail.meta.message, 'Second feature\n\nBody with \x1f separator');
  assert.match(detail.diff, /\+second/);
  assert.match((await github.gitShow(dir, root)).diff, /\+base/);
  await commit('New head', 'new head\n');
  assert.notEqual((await github.gitLog(dir, { aheadOnly: true, base: 'release/next', skip: 1, limit: 1 })).historyRevision, page1.historyRevision);
  assert.equal(await git('status', '--porcelain'), '');
  assert.equal((await github.gitShow(dir, '--help')).error, 'invalid sha');
});

test('merge commit details compare the first parent and refs remain typed', async t => {
  const { dir, git, commit } = await fixture(t);
  await commit('Root', 'base\n');
  await git('checkout', '-qb', 'feature/topic');
  const feature = await commit('Feature', 'feature\n');
  await git('tag', 'v1');
  await git('checkout', '-q', 'main');
  await git('commit', '--allow-empty', '-qm', 'Parallel parent');
  await git('merge', '--no-ff', '-m', 'Merge feature', 'feature/topic');
  const sha = await git('rev-parse', 'HEAD');
  const detail = await github.gitShow(dir, sha);
  assert.equal(detail.meta.parents.length, 2);
  assert.match(detail.diff, /\+feature/);
  const log = await github.gitLog(dir, { ref: 'HEAD' });
  assert.ok(log.commits.find(c => c.sha === feature).refs.some(ref => ref.type === 'tag' && ref.name === 'v1'));
  assert.ok(log.commits.find(c => c.sha === sha).refs.some(ref => ref.type === 'head' && ref.name === 'main'));
});
