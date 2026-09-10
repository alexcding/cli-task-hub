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
  mock.method(github, 'getOpenPRs', async () => {
    calls++;
    await new Promise(r => setTimeout(r, 30)); // hold the "spawn" open so both calls overlap
    return [];
  });
  mock.method(github, 'getRecentClosedPRs', async () => []);
  t.after(() => mock.restoreAll()); // restore even if an assertion below throws

  const project = { id: 'coalesce-test', repo: 'octo/repo', name: 'Coalesce' };
  const coalescedBefore = github.ghStats().coalesced;
  const inflightBefore = github.ghStats().inflight;

  const a = poller.syncProject(project);
  const b = poller.syncProject(project);
  assert.strictEqual(a, b, 'concurrent calls return the same in-flight promise');
  await Promise.all([a, b]);

  assert.strictEqual(calls, 1, 'gh (getOpenPRs) spawned once for two concurrent syncs');
  assert.strictEqual(github.ghStats().coalesced, coalescedBefore + 1, 'coalesced metric bumped once');
  assert.strictEqual(github.ghStats().inflight, inflightBefore,
    'inflight gauge returns to baseline — the ++/-- pairing held');

  await poller.syncProject(project);
  assert.strictEqual(calls, 2, 'a sync after the first settled runs fresh (not stuck on a stale promise)');
  assert.strictEqual(github.ghStats().inflight, inflightBefore, 'inflight still balanced after the fresh sync');
});

// The bug this guards: the snapshot used to come from ONE `gh pr list --state all --limit 60`,
// a recency window over every state. In a repo with steady merge traffic the merged PRs crowd
// out older still-open ones, so a long-lived open PR silently disappeared from the dashboard and
// its project page. Open PRs are now fetched by status, in full, so merge volume can't hide one.
test('an open PR older than the whole merged window still lands in the snapshot', async (t) => {
  const db = require('../src/server/database/db');
  const oldOpen = { number: 525, title: 'UX Request: secondary button style', url: 'u/525',
    state: 'OPEN', headRefName: 'cding/fix/social', author: { login: 'alexcding' }, category: 'mine' };
  // 30 newer merged PRs — under the old single-window fetch these consumed the whole limit.
  const merged = Array.from({ length: 30 }, (_, i) => ({
    number: 609 - i, title: `merged ${609 - i}`, url: `u/${609 - i}`, state: 'MERGED' }));

  mock.method(github, 'getOpenPRs', async () => [oldOpen]);
  mock.method(github, 'getRecentClosedPRs', async () => merged);
  t.after(() => mock.restoreAll());

  // A repo string unique to this test: seededRepos/prState are module-level in poller.js, so
  // sharing 'octo/repo' with the coalesce test above would leave firstTime false and make these
  // 30 fabricated merged PRs fire real pr_merged events + merge automation this test never
  // asserts on (and which would mask a regression in the first-sync seeding path).
  const project = { id: 'window-test', repo: 'octo/window-repo', name: 'Window' };
  await poller.syncProject(project);

  const prs = db.getSnapshot(project.id)?.prs || [];
  assert.deepStrictEqual(prs.map(p => p.number), [525],
    'the snapshot holds the open PR and only the open PR (merged ones never render)');
  assert.strictEqual(prs[0].repo, 'octo/window-repo', 'lean() stamps the repo onto the snapshot row');
});

test('projectJql ANDs the saved filter clause into the Tickets query, keeping ORDER BY last', () => {
  const db = require('../src/server/database/db');
  const p = { id: 'clause-test', jiraProjectKey: 'REC' };
  db.set('board_query_clause-test', '');
  assert.equal(poller.projectJql(p), 'project = REC AND statusCategory != Done ORDER BY updated DESC');
  db.set('board_query_clause-test', 'component = iOS');
  assert.equal(poller.projectJql(p), '(project = REC AND statusCategory != Done) AND (component = iOS) ORDER BY updated DESC');
  assert.equal(poller.projectJql({ ...p, jql: 'assignee = currentUser()' }), '(assignee = currentUser()) AND (component = iOS)');
  db.set('board_query_clause-test', '');
});

test('projectJql drops an ORDER BY inside the filter clause (it would be invalid in parentheses)', () => {
  const db = require('../src/server/database/db');
  const p = { id: 'clause-order-test', jiraProjectKey: 'REC' };
  db.set('board_query_clause-order-test', 'component = iOS ORDER BY rank');
  assert.equal(poller.projectJql(p), '(project = REC AND statusCategory != Done) AND (component = iOS) ORDER BY updated DESC');
  db.set('board_query_clause-order-test', '');
});
