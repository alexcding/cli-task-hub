const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const github = require('../src/server/repositories/github');
const { revisionFor, discardBlock } = require('../src/server/services/git-discard');
const { parseDiff } = require('../src/shared/diff-parse.mjs');

async function fixture(t, files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskhub-discard-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const git = (...args) => exec('git', ['-C', dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  await git('init', '-q');
  await git('config', 'user.name', 'Fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  await git('add', '-A'); await git('commit', '-qm', 'Fixture');
  return { dir, git, load: github.gitDiff, apply: github.gitDiscard };
}

test('preview is read-only, discard affects one block and stale confirmation refuses new edits', async t => {
  const original = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n';
  const current = 'ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\neight\n';
  const service = await fixture(t, { 'file.txt': original });
  const file = path.join(service.dir, 'file.txt');
  await fs.writeFile(file, current);
  const snapshot = await service.load(service.dir);
  const request = { revision: revisionFor(snapshot.diff), selection: [0, 0, 1], mode: 'preview' };
  const preview = await discardBlock(service.dir, request, service);
  assert.equal(preview.path, 'file.txt');
  assert.equal(await fs.readFile(file, 'utf8'), current);
  await fs.writeFile(file, current + 'external\n');
  await assert.rejects(discardBlock(service.dir, { ...request, mode: 'apply' }, service), /changed on disk/);
  assert.equal(await fs.readFile(file, 'utf8'), current + 'external\n');
  await fs.writeFile(file, current);
  assert.deepEqual(await discardBlock(service.dir, { ...request, mode: 'apply' }, service), { ok: true });
  assert.equal(await fs.readFile(file, 'utf8'), 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n');
  await assert.rejects(discardBlock(service.dir, { ...request, mode: 'apply' }, service), /changed on disk/);
});

test('discard round-trips quoted UTF-8, spaces, tabs, newline, quotes, backslashes and missing final newline', async t => {
  const names = ['space name.txt', 'päth.txt', 'quote"name.txt', 'back\\slash.txt', 'tab\tname.txt', 'line\nname.txt'];
  const service = await fixture(t, Object.fromEntries(names.map(name => [name, 'old'])));
  for (const name of names) await fs.writeFile(path.join(service.dir, name), 'new');
  for (const name of names) {
    const snapshot = await service.load(service.dir);
    const index = parseDiff(snapshot.diff).findIndex(file => file.newPath === name);
    assert.ok(index >= 0, name);
    const result = await discardBlock(service.dir, { revision: revisionFor(snapshot.diff), selection: [index, 0, 0], mode: 'apply' }, service);
    assert.deepEqual(result, { ok: true }, name);
    assert.equal(await fs.readFile(path.join(service.dir, name), 'utf8'), 'old', name);
  }
});

test('discard handles added/deleted files and rename contents without undoing the rename', async t => {
  const service = await fixture(t, { 'deleted.txt': 'old\n', 'a/original.txt': 'first\nsecond\nthird\nfourth\nfifth\nsixth\n' });
  await service.git('mv', 'a/original.txt', 'a/renamed.txt');
  await fs.writeFile(path.join(service.dir, 'a/renamed.txt'), 'FIRST\nsecond\nthird\nfourth\nfifth\nsixth\n');
  await fs.unlink(path.join(service.dir, 'deleted.txt'));
  await fs.writeFile(path.join(service.dir, 'added.txt'), 'new\n');
  await service.git('add', '-A');
  for (const name of ['a/renamed.txt', 'deleted.txt', 'added.txt']) {
    const snapshot = await service.load(service.dir);
    const index = parseDiff(snapshot.diff).findIndex(file => (file.newPath || file.oldPath) === name);
    assert.ok(index >= 0, name);
    const result = await discardBlock(service.dir, { revision: revisionFor(snapshot.diff), selection: [index, 0, 0], mode: 'apply' }, service);
    assert.deepEqual(result, { ok: true }, name);
  }
  assert.equal(await fs.readFile(path.join(service.dir, 'a/renamed.txt'), 'utf8'), 'first\nsecond\nthird\nfourth\nfifth\nsixth\n');
  assert.equal(await fs.readFile(path.join(service.dir, 'deleted.txt'), 'utf8'), 'old\n');
  await assert.rejects(fs.stat(path.join(service.dir, 'added.txt')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(service.dir, 'a/original.txt')), { code: 'ENOENT' });
});

test('invalid selectors and escaped paths never reach patch application', async t => {
  const service = await fixture(t, { 'file.txt': 'old\n' });
  await fs.writeFile(path.join(service.dir, 'file.txt'), 'new\n');
  const snapshot = await service.load(service.dir);
  let calls = 0;
  const guarded = { load: service.load, apply: async () => { calls++; return { ok: true }; } };
  for (const selection of [[-1,0,0], [0,0,99], [true,0,0], [0.5,0,0], [0,0], [0,0,0,0]]) {
    await assert.rejects(discardBlock(service.dir, { revision: revisionFor(snapshot.diff), selection, mode: 'apply' }, guarded));
  }
  for (const name of ['../outside', '/tmp/outside', 'escape/file']) {
    if (name === 'escape/file') await fs.symlink(os.tmpdir(), path.join(service.dir, 'escape'));
    const diff = 'diff --git a/' + name + ' b/' + name + '\n--- a/' + name + '\n+++ b/' + name + '\n@@ -1 +1 @@\n-old\n+new\n';
    await assert.rejects(discardBlock(service.dir, { revision: revisionFor(diff), selection: [0,0,0], mode: 'apply' }, { ...guarded, load: async () => ({ diff }) }));
  }
  assert.equal(calls, 0);
});

test('Git rejects a file changed after revision validation without partial application', async t => {
  const service = await fixture(t, { 'file.txt': 'one\ntwo\nthree\n' });
  const file = path.join(service.dir, 'file.txt');
  await fs.writeFile(file, 'one\nTWO\nthree\n');
  const snapshot = await service.load(service.dir);
  const result = await discardBlock(service.dir, { revision: revisionFor(snapshot.diff), selection: [0,0,0], mode: 'apply' }, {
    load: service.load,
    apply: async (root, patch) => {
      await fs.writeFile(file, 'one\nEXTERNAL\nthree\n');
      return service.apply(root, patch);
    },
  });
  assert.match(result.error, /patch|apply/i);
  assert.equal(await fs.readFile(file, 'utf8'), 'one\nEXTERNAL\nthree\n');
});
