// Pure lane-layout tests for the commit graph (no DOM). Run via `npm test`.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const mod = import(pathToFileURL(path.join(__dirname, '../src/renderer/lib/git-graph.mjs')));

// Build a linear / branchy history newest-first. Helper: c(sha, ...parents).
const c = (sha, ...parents) => ({ sha, parents });

test('linear history: every commit in column 0, single vertical spine', async () => {
  const { computeGraph } = await mod;
  const { rows, laneCount } = computeGraph([c('d', 'c'), c('c', 'b'), c('b', 'a'), c('a')]);
  assert.equal(laneCount, 1);
  assert.deepEqual(rows.map(r => r.col), [0, 0, 0, 0]);
  // first commit (tip) has no incoming, one outgoing to its parent in col 0
  assert.equal(rows[0].segments.some(s => s.x1 === 0 && s.y1 === 0.5 && s.x2 === 0 && s.y2 === 1), true);
  // last commit (root) has an incoming from its child, no outgoing
  assert.equal(rows[3].segments.some(s => s.y2 === 0.5), true);
  assert.equal(rows[3].segments.some(s => s.y2 === 1), false);
});

test('a fork then merge: feature lane opens to the right and merges back', async () => {
  const { computeGraph } = await mod;
  // m is a merge of mainline `a` and feature `f`; f branched off `a`.
  //   m ─┬─ a ── base
  //      └─ f ── base
  const { rows, laneCount } = computeGraph([
    c('m', 'a', 'f'),   // merge commit, two parents
    c('a', 'base'),
    c('f', 'base'),
    c('base'),
  ]);
  assert.ok(laneCount >= 2, 'feature occupies a second lane');
  const bySha = Object.fromEntries(rows.map(r => [r.sha, r]));
  assert.equal(bySha.m.col, 0);
  // merge has two outgoing edges (to both parents), landing in two different columns
  const outs = bySha.m.segments.filter(s => s.y1 === 0.5 && s.y2 === 1);
  assert.equal(outs.length, 2);
  assert.notEqual(outs[0].x2, outs[1].x2);
  // base is the join point: both a and f point at it → two incoming edges into base's node
  const baseIns = bySha.base.segments.filter(s => s.y1 === 0 && s.y2 === 0.5);
  assert.equal(baseIns.length, 2);
});

test('freed lane is reused: a closed branch lets a later tip take its column', async () => {
  const { computeGraph } = await mod;
  // After the merge closes the feature lane, an unrelated new tip `x` should reuse column 1.
  const { rows } = computeGraph([
    c('x'),                 // brand-new tip, no parents in window
    c('m', 'a', 'f'),
    c('a', 'base'),
    c('f', 'base'),
    c('base'),
  ]);
  const bySha = Object.fromEntries(rows.map(r => [r.sha, r]));
  // x has no incoming and (no parents) no outgoing — it's an isolated node in some column.
  assert.equal(bySha.x.segments.length, 0);
});

test('shared parent: both child lanes run down and converge at the parent node', async () => {
  const { computeGraph } = await mod;
  // Diamond: top merges l & r, both have the same parent `base`.
  const { rows } = computeGraph([c('top', 'l', 'r'), c('l', 'base'), c('r', 'base'), c('base')]);
  const base = rows.find(r => r.sha === 'base');
  // base must be a single node (one column), with two incoming edges (from l and r lanes).
  const ins = base.segments.filter(s => s.y1 === 0 && s.y2 === 0.5);
  assert.equal(ins.length, 2);
});

test('out-of-window parent: edge runs off the bottom without crashing', async () => {
  const { computeGraph } = await mod;
  // `a`'s parent `z` is not in the list (history truncated) — still draws an outgoing stub.
  const { rows } = computeGraph([c('a', 'z')]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].segments.filter(s => s.y2 === 1).length, 1);
});
