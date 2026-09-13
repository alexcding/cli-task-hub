const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
// Execute the actual DOM adapter with injected HTTP/markup boundaries. No browser
// globals or unrelated project editors are needed to hold/reorder its responses.
const source = fs.readFileSync(require.resolve('../src/renderer/pages/project.js'), 'utf8');
const adapter = source.slice(source.indexOf('const prRequests =')).replace('export async function', 'async function');
function fixture() {
  let element = { innerHTML: '' };
  const selection = { value: 'merged' }, pending = [], project = { repo: 'o/r', prs: [] };
  const reload = vm.runInNewContext(adapter + '\nreloadProjectPRs;', {
    api: url => new Promise((resolve, reject) => pending.push({ url, resolve, reject })),
    ROUTES: { projectPrs: id => `/api/projects/${id}/prs` }, proj: () => project,
    document: { getElementById: id => id.startsWith('pr-state') ? selection : element },
    esc: value => String(value).replaceAll('<', '&lt;'),
    prListHtml: prs => prs.length ? prs.map(p => p.title).join(',') : 'Empty result',
  });
  return { reload, pending, selection, project, element: () => element, replace: () => { element = { innerHTML: 'new page' }; } };
}
test('web scopes render background status and failure with cached cards, then recover on SSE read', async () => {
  const f = fixture();
  let read = f.reload('p', 'merged');
  f.pending[0].resolve({ prs: [], refreshing: true }); await read;
  assert.match(f.element().innerHTML, /Refreshing pull requests/); assert.doesNotMatch(f.element().innerHTML, /Empty result/);
  read = f.reload('p', 'merged', { silent: true });
  f.pending[1].resolve({ prs: [{ title: 'Cached merged PR' }], error: '<offline>', refreshing: false }); await read;
  assert.match(f.element().innerHTML, /Cached merged PR/); assert.match(f.element().innerHTML, /&lt;offline>/);
  read = f.reload('p', 'merged', { force: true });
  assert.match(f.pending[2].url, /snapshot=1&refresh=1/);
  f.pending[2].resolve({ prs: [{ title: 'Updated merged PR' }], refreshing: false }); await read;
  assert.equal(f.element().innerHTML, 'Updated merged PR');
  read = f.reload('p', 'merged', { silent: true });
  f.pending[3].reject(new Error('Connection lost')); await read;
  assert.match(f.element().innerHTML, /Connection lost/); assert.match(f.element().innerHTML, /Updated merged PR/);
  assert.deepEqual(f.project.prs, []);
});
test('late scope, older reads and replaced DOM cannot overwrite the current web view or open cache', async () => {
  const f = fixture();
  const old = f.reload('p', 'merged');
  f.selection.value = 'open';
  const fresh = f.reload('p', 'open');
  f.pending[1].resolve({ prs: [{ title: 'Open PR' }] }); await fresh;
  f.pending[0].resolve({ prs: [{ title: 'Merged PR' }] }); await old;
  assert.equal(f.element().innerHTML, 'Open PR'); assert.equal(f.project.prs[0].title, 'Open PR');
  const older = f.reload('p', 'open', { silent: true }), newer = f.reload('p', 'open', { silent: true });
  f.pending[3].resolve({ prs: [{ title: 'Newer PR' }] }); await newer;
  f.pending[2].reject(new Error('Obsolete error')); await older;
  assert.equal(f.element().innerHTML, 'Newer PR');
  const removed = f.reload('p', 'open'); f.replace();
  f.pending[4].resolve({ prs: [{ title: 'Removed view reply' }] }); await removed;
  assert.equal(f.element().innerHTML, 'new page'); assert.equal(f.project.prs[0].title, 'Newer PR');
});
