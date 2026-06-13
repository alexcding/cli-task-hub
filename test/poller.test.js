// Guards the sync-coalescing in services/poller.js: concurrent syncs of the SAME
// project must share one in-flight `gh` run (no duplicate spawns), a later sync must run
// fresh once the first settles, and the inflight gauge must return to baseline (the ++/--
// pairing is the wrapper's primary failure mode).
process.env.TASKHUB_DATA_DIR ||= require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'taskhub-test-'));

const { test, mock } = require('node:test');
const assert = require('node:assert');

const poller = require('../src/server/services/poller');
const github = require('../src/server/repositories/github');

test('syncProject coalesces concurrent syncs of one project, then runs fresh after', async (t) => {
  let calls = 0;
  mock.method(github, 'getPRs', async () => {
    calls++;
    await new Promise(r => setTimeout(r, 30)); // hold the "spawn" open so both calls overlap
    return [];
  });
  t.after(() => mock.restoreAll()); // restore even if an assertion below throws

  const project = { id: 'coalesce-test', repo: 'octo/repo', name: 'Coalesce' };
  const coalescedBefore = github.ghStats().coalesced;
  const inflightBefore = github.ghStats().inflight;

  const a = poller.syncProject(project);
  const b = poller.syncProject(project);
  assert.strictEqual(a, b, 'concurrent calls return the same in-flight promise');
  await Promise.all([a, b]);

  assert.strictEqual(calls, 1, 'gh (getPRs) spawned once for two concurrent syncs');
  assert.strictEqual(github.ghStats().coalesced, coalescedBefore + 1, 'coalesced metric bumped once');
  assert.strictEqual(github.ghStats().inflight, inflightBefore,
    'inflight gauge returns to baseline — the ++/-- pairing held');

  await poller.syncProject(project);
  assert.strictEqual(calls, 2, 'a sync after the first settled runs fresh (not stuck on a stale promise)');
  assert.strictEqual(github.ghStats().inflight, inflightBefore, 'inflight still balanced after the fresh sync');
});
