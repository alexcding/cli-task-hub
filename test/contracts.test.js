// Contract coverage — turns the cross-process drift class of bug from "found at
// runtime" into "found in CI". The renderer reaches the server only over HTTP (ROUTES),
// so these guard that contract: every ROUTES path is registered on the Express app, every
// registered route comes from ROUTES (a handler added with a literal path, or a contract
// entry with no handler, both fail here), and no :param route shadows a literal sibling.
process.env.TASKHUB_DATA_DIR ||= require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'taskhub-test-'));

const { test } = require('node:test');
const assert = require('node:assert');

const { app } = require('../src/server/app');
const { ROUTES } = require('../src/shared/routes.mjs');

const routeLayers = (app.router || app._router).stack
  .filter(l => l.route)
  .map((l, i) => ({ i, path: l.route.path }));
const registered = new Set(routeLayers.map(r => r.path));

test('every ROUTES path has a registered Express handler', () => {
  const missing = Object.entries(ROUTES)
    .filter(([, v]) => typeof v === 'string') // builders' patterns are the UPPER twins
    .filter(([, v]) => !registered.has(v));
  assert.deepEqual(missing, [], `ROUTES entries with no handler: ${missing.map(([k]) => k)}`);
});

test('every registered route path comes from the ROUTES contract', () => {
  const contract = new Set(Object.values(ROUTES).filter(v => typeof v === 'string'));
  const rogue = [...registered].filter(p => !contract.has(p));
  assert.deepEqual(rogue, [], `routes registered outside the contract: ${rogue}`);
});

// Express matches in registration order, so a `:param` route registered BEFORE a literal
// sibling it pattern-matches (e.g. /api/jira/:key before /api/jira/mine) silently shadows
// the literal. The route split spreads these across modules, so guard the ordering here.
test('no :param route shadows a literal sibling registered after it', () => {
  const matches = (paramPath, literal) =>
    new RegExp('^' + paramPath.replace(/:[^/]+/g, '[^/]+') + '$').test(literal);
  const shadowed = [];
  for (const a of routeLayers) {
    if (!a.path.includes(':')) continue;
    for (const b of routeLayers) {
      if (b.i > a.i && !b.path.includes(':') && matches(a.path, b.path)) {
        shadowed.push(`${a.path} (registered first) shadows ${b.path}`);
      }
    }
  }
  assert.deepEqual(shadowed, [], `route-ordering shadow: ${shadowed.join('; ')}`);
});
