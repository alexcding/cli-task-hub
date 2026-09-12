const { test } = require('node:test');
const assert = require('node:assert/strict');

const fixture = () => {
  let version = 2;
  const model = { getAlternativeVersionId: () => version };
  return { edit: value => { version = value; }, tab: { path: '/tmp/file.swift', dirty: true,
    _fileRevision: 'original', _savedVersion: 1, _edModel: model, edView: { getValue: () => 'submitted text' } } };
};

test('save tracks submitted version, preserves later edits, and coalesces concurrent saves', async () => {
  const { saveEditorBuffer } = await import('../src/renderer/lib/editor-save.mjs');
  const { tab, edit } = fixture();
  let finish, payload, calls = 0;
  const write = data => { calls++; payload = data; return new Promise(resolve => { finish = resolve; }); };
  const first = saveEditorBuffer(tab, write);
  assert.equal(saveEditorBuffer(tab, write), first);
  await Promise.resolve();
  assert.deepEqual(payload, { path: '/tmp/file.swift', content: 'submitted text', revision: 'original' });
  edit(3); finish({ revision: 'saved' });
  await first;
  assert.equal(tab._savedVersion, 2);
  assert.equal(tab._fileRevision, 'saved');
  assert.equal(tab.dirty, true);
  assert.equal(calls, 1);
});

test('failed save retains the baseline and edits; disposed models are never marked saved', async () => {
  const { saveEditorBuffer } = await import('../src/renderer/lib/editor-save.mjs');
  const { tab } = fixture();
  await assert.rejects(saveEditorBuffer(tab, async () => { throw new Error('conflict'); }), /conflict/);
  assert.equal(tab._fileRevision, 'original'); assert.equal(tab._savedVersion, 1); assert.equal(tab.dirty, true);
  let finish;
  const pending = saveEditorBuffer(tab, () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  tab._edModel = null; finish({ revision: 'saved' });
  await pending;
  assert.equal(tab._fileRevision, 'original'); assert.equal(tab.dirty, true);
});

test('undo to the submitted version is clean; old backends never silently bypass revisions', async () => {
  const { saveEditorBuffer } = await import('../src/renderer/lib/editor-save.mjs');
  const { tab, edit } = fixture();
  await saveEditorBuffer(tab, async () => { edit(3); edit(2); return { revision: 'saved' }; });
  assert.equal(tab.dirty, false);
  tab.dirty = true; tab._fileRevision = undefined;
  await assert.rejects(saveEditorBuffer(tab, () => { throw new Error('must not write'); }), /Reload this file/);
});
