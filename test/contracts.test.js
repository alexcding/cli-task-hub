// Contract coverage — turns the cross-process drift class of bug from "found at
// runtime" into "found in CI". Three checks, each targeting a real failure mode:
//
//  1. Route coverage (live): every ROUTES path is registered on the Express app, and
//     every registered route comes from ROUTES — a handler added with a literal path
//     (bypassing the contract) or a contract entry with no handler both fail here.
//  2. Preload channel drift (static): src/preload/index.js is SANDBOXED, so it cannot
//     import shared/channels.js and must inline channel names as literals. Assert every
//     literal it uses is a value in CH — a renamed channel that misses the preload
//     would otherwise fail silently at click time.
//  3. Preload sandbox guard (static): the preload may require ONLY 'electron'. A local
//     require throws inside the sandboxed preload and silently kills the whole bridge
//     (window.taskhub undefined) — the exact bug that shipped once already.
process.env.TASKHUB_DATA_DIR ||= require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'taskhub-test-'));

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { app } = require('../src/server/app');
const { ROUTES } = require('../src/shared/routes.mjs');
const { CH } = require('../src/shared/channels');

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

// Strip line comments so prose like "CANNOT require('../shared/channels')" doesn't trip
// the scans below — only real code counts.
const preload = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'preload', 'index.js'), 'utf8')
  .replace(/^\s*\/\/.*$/gm, '');

test('every channel literal in the preload matches a CH value', () => {
  const used = [...preload.matchAll(/ipcRenderer\.(?:invoke|send|on)\((['"])([^'"]+)\1/g)]
    .map(m => m[2]);
  assert.ok(used.length > 0, 'expected the preload to use ipcRenderer channels');
  const values = new Set(Object.values(CH));
  const drifted = used.filter(c => !values.has(c));
  assert.deepEqual(drifted, [], `preload channels missing from channels.js: ${drifted}`);
});

test('the sandboxed preload requires only electron', () => {
  const requires = [...preload.matchAll(/require\((['"])([^'"]+)\1\)/g)].map(m => m[2]);
  const illegal = requires.filter(r => r !== 'electron');
  assert.deepEqual(illegal, [],
    `sandboxed preload cannot require local modules (kills window.taskhub): ${illegal}`);
});
