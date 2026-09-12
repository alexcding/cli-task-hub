const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { FileStore, MAX_BYTES } = require('../src/server/services/file-store');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-files-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, '日本語 quoted "file.swift');
  fs.writeFileSync(file, '\ufefflet value = "Original 🦀"\r\n', { mode: 0o640 });
  return { file, directory, store: new FileStore() };
}
const status = code => error => error.status === code;

test('revision save preserves permissions, symlink identity and native metadata', async t => {
  const { file, directory, store } = fixture(t);
  const link = path.join(directory, 'alias.swift');
  fs.symlinkSync(file, link);
  if (process.platform === 'darwin') execFileSync('/usr/bin/xattr', ['-w', 'tv.accedo.taskhub.fixture', 'keep metadata', file]);
  const opened = await store.read(link);
  assert.equal(opened.content, '\ufefflet value = "Original 🦀"\r\n');
  assert.equal(opened.readOnly, false);
  const saved = await store.save(link, '\ufefflet value = "Saved 日本語"\r\n', opened.revision);
  assert.notEqual(saved.revision, opened.revision);
  assert.equal((await store.read(link)).revision, saved.revision);
  assert.equal(fs.readFileSync(file, 'utf8'), '\ufefflet value = "Saved 日本語"\r\n');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  if (process.platform === 'darwin') assert.equal(execFileSync('/usr/bin/xattr', ['-p', 'tv.accedo.taskhub.fixture', file], { encoding: 'utf8' }).trim(), 'keep metadata');
  assert.equal(fs.readdirSync(directory).some(name => name.startsWith('.taskhub-save-')), false);
});

test('stale and simultaneous saves never overwrite a newer document revision', async t => {
  const { file, store } = fixture(t);
  const opened = await store.read(file);
  const outcomes = await Promise.allSettled([
    store.save(file, 'first', opened.revision), store.save(file, 'second', opened.revision),
  ]);
  assert.deepEqual(outcomes.map(value => value.status), ['fulfilled', 'rejected']);
  assert.equal(outcomes[1].reason.status, 409);
  assert.equal(fs.readFileSync(file, 'utf8'), 'first');
  const revision = (await store.read(file)).revision;
  fs.writeFileSync(file, 'external edit');
  await assert.rejects(store.save(file, 'stale edit', revision), status(409));
  assert.equal(fs.readFileSync(file, 'utf8'), 'external edit');
  assert.equal(store.writes.size, 0);
});

test('retargeted symlinks, deleted files and hard links do not get replaced', async t => {
  const { file, directory, store } = fixture(t);
  const link = path.join(directory, 'alias');
  const other = path.join(directory, 'other');
  fs.copyFileSync(file, other);
  fs.symlinkSync(file, link);
  const original = await store.read(link);
  fs.unlinkSync(link); fs.symlinkSync(other, link);
  await assert.rejects(store.save(link, 'wrong target', original.revision), status(409));
  const opened = await store.read(file);
  fs.unlinkSync(file);
  await assert.rejects(store.save(file, 'recreated accidentally', opened.revision), status(409));
  assert.equal(fs.existsSync(file), false);
  fs.linkSync(other, file);
  const hardLink = await store.read(file);
  assert.equal(hardLink.readOnly, true);
  await assert.rejects(store.save(file, 'break hard link', hardLink.revision), status(403));
  assert.equal(fs.statSync(file).ino, fs.statSync(other).ino);
});

test('failed staged writes and rename failures preserve original content and remove staging', async t => {
  const { file, directory, store } = fixture(t);
  const opened = await store.read(file);
  for (const operation of ['write', 'rename']) {
    const io = Object.create(fs.promises);
    if (operation === 'rename') io.rename = async () => { throw new Error('rename failed'); };
    else io.open = async (...args) => {
      const handle = await fs.promises.open(...args);
      if (String(args[0]).includes('.taskhub-save-')) {
        handle.writeFile = async () => { await handle.write('partial bytes'); throw new Error('write failed'); };
      }
      return handle;
    };
    await assert.rejects(new FileStore(io).save(file, 'new bytes', opened.revision), new RegExp(`${operation} failed`));
    assert.equal(fs.readFileSync(file, 'utf8'), opened.content);
    assert.equal(fs.readdirSync(directory).some(name => name.startsWith('.taskhub-save-')), false);
  }
});

test('binary, oversized, invalid text and missing revision cannot corrupt files', async t => {
  const { file, store } = fixture(t);
  const original = await store.read(file);
  await assert.rejects(store.save(file, 'write without revision'), status(428));
  await assert.rejects(store.save(file, '\ud800', original.revision), status(415));
  await assert.rejects(store.save(file, '\0', original.revision), status(415));
  await assert.rejects(store.save(file, 'a'.repeat(MAX_BYTES + 1), original.revision), status(413));
  assert.equal(fs.readFileSync(file, 'utf8'), original.content);
  fs.writeFileSync(file, Buffer.from([0xff]));
  await assert.rejects(store.read(file), status(415));
  fs.writeFileSync(file, Buffer.alloc(MAX_BYTES + 1));
  await assert.rejects(store.read(file), status(413));
});
