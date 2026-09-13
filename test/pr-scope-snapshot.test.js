const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.TASKHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-pr-scopes-'));
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const db = require('../src/server/database/db');
const poller = require('../src/server/services/poller');
const github = require('../src/server/repositories/github');
const { prSnapshotFor, jiraStale } = require('../src/server/services/sync');
const app = express();
require('../src/server/routes/prs').register(app);
let server, base;
before(async () => {
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { poller.stop(); await new Promise(resolve => server.close(resolve)); });
const project = id => db.addProject({ id, name: id, repo: `fixture/${id}`, jiraProjectKey: 'FIX' });
const get = async (p, state, extra = '') => {
  const response = await fetch(`${base}/api/projects/${p.id}/prs?state=${state}${extra}`, { signal: AbortSignal.timeout(2000) });
  return { status: response.status, body: await response.json() };
};
const held = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const pr = number => ({ number, state: 'MERGED', title: 'History', url: `https://github.com/fixture/repo/pull/${number}`,
  headRefName: 'feature', baseRefName: 'release', category: 'other', awaitingMyReview: true, ci: 'success', body: 'omit large body' });

test('history routes return immediately, coalesce, publish after storage, and preserve legacy arrays', async t => {
  const p = project('immediate'), pending = held(), calls = [], published = [];
  t.mock.method(github, 'getPRs', async (...args) => { calls.push(args); return pending.promise; });
  t.mock.method(github, 'getOpenPRs', () => { throw new Error('history must not sync open'); });
  poller.setPublisher(id => published.push({ id, refreshing: poller.prScopeSyncing(p, 'merged'), snap: db.getPRScopeSnapshot(p, 'merged') }));
  t.after(() => { pending.resolve([]); poller.setPublisher(null); });
  db.setSnapshot(p.id, { prs: [{ number: 99 }], lastSynced: new Date().toISOString() });
  const first = await get(p, 'merged', '&snapshot=1');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { prs: [], lastSynced: null, error: null, refreshing: true });
  assert.deepEqual((await get(p, 'merged')).body, []);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [p.repo, 'merged', 30, { ci: true, jiraProjectKey: 'FIX' }]);
  const completion = poller.syncPRScope(p, 'merged');
  pending.resolve([pr(1)]); await completion;
  const snap = (await get(p, 'merged', '&snapshot=1')).body;
  assert.equal(snap.refreshing, false); assert.equal(snap.prs[0].baseRefName, 'release');
  assert.equal(snap.prs[0].awaitingMyReview, true); assert.equal(snap.prs[0].body, undefined);
  assert.deepEqual((await get(p, 'merged')).body, snap.prs);
  assert.equal(calls.length, 1); assert.equal(published.length, 1);
  assert.equal(published[0].refreshing, false); assert.deepEqual(published[0].snap.prs, snap.prs);
  assert.deepEqual(db.getAllSnapshots()[p.id].prs, [{ number: 99 }]);
  assert.equal(db.getEvents(100).filter(e => e.type === 'pr_merged').length, 0);
});

test('failed history revalidation keeps cards, backs off, and explicit retry recovers', async t => {
  const p = project('failure'); let calls = 0, fail = true;
  t.mock.method(github, 'getPRs', async () => { calls++; if (fail) throw new Error('Offline'); return [pr(2)]; });
  db.setPRScopeSnapshot(p, 'all', { prs: [pr(1)], lastSynced: 'invalid' });
  assert.equal(prSnapshotFor(p, 'all').refreshing, true);
  await poller.syncPRScope(p, 'all');
  const failed = prSnapshotFor(p, 'all');
  assert.equal(failed.error, 'Offline'); assert.equal(failed.prs[0].number, 1); assert.equal(failed.refreshing, false);
  assert.equal(calls, 1);
  assert.equal((await get(p, 'all')).body.at(-1).error, 'Offline');
  fail = false;
  prSnapshotFor(p, 'all', true); await poller.syncPRScope(p, 'all');
  assert.equal(prSnapshotFor(p, 'all').prs[0].number, 2); assert.equal(prSnapshotFor(p, 'all').error, null);
  assert.equal(calls, 2);
  assert.equal(jiraStale({ lastSynced: 'invalid' }), true);
});

test('scope and project identity isolate reads and invalidate late replies after edits, deletion and stop', async t => {
  let p = project('identity');
  const pending = [];
  t.mock.method(github, 'getPRs', async () => { const request = held(); pending.push(request); return request.promise; });
  t.after(() => pending.forEach(p => p.resolve([])));
  const a = poller.syncPRScope(p, 'merged'); await Promise.resolve();
  const b = poller.syncPRScope(p, 'all'); await Promise.resolve();
  assert.notEqual(a, b);
  pending[1].resolve([pr(2)]); await b;
  assert.equal(db.getPRScopeSnapshot(p, 'merged'), null);
  p = db.updateProject(p.id, { repo: 'fixture/new-repo' });
  assert.equal(db.getPRScopeSnapshot(p, 'all'), null);
  const newer = poller.syncPRScope(p, 'merged'); await Promise.resolve();
  pending[2].resolve([pr(3)]); await newer;
  pending[0].resolve([pr(1)]); await a;
  assert.equal(db.getPRScopeSnapshot(p, 'merged').prs[0].number, 3);
  const removed = poller.syncPRScope(p, 'merged'); await Promise.resolve();
  db.deleteProject(p.id);
  // Even recreating the exact identity cannot revive an old in-flight write.
  t.mock.method(db, 'getProject', () => p);
  pending[3].resolve([pr(4)]); await removed;
  assert.equal(db.getPRScopeSnapshot(p, 'merged'), null);
  const stopped = poller.syncPRScope(p, 'all'); await Promise.resolve();
  poller.stop(); pending[4].resolve([pr(5)]); await stopped;
  assert.equal(db.getPRScopeSnapshot(p, 'all'), null);
  assert.equal(github.ghStats().inflight, 0);
});

test('state validation runs before scheduling a CLI, including projects without a repository', async t => {
  const p = project('validation');
  t.mock.method(github, 'getPRs', () => { throw new Error('must not run'); });
  assert.equal((await get(p, 'unsupported')).status, 400);
  assert.equal((await get(p, 'all&state=merged')).status, 400);
  const empty = db.updateProject(p.id, { repo: '' });
  assert.deepEqual((await get(empty, 'merged', '&snapshot=1')).body, { prs: [], lastSynced: null, error: null, refreshing: false });
  assert.equal((await get(empty, 'unsupported')).status, 400);
});
