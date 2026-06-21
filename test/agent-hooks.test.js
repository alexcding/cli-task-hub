// Tests for the pure config transforms in src/server/services/agent-hooks.js — installing the
// "turn start/finished" hooks must preserve the user's existing hooks and be idempotent.
const { test } = require('node:test');
const assert = require('node:assert');
const hooks = require('../src/server/services/agent-hooks');

test('hook command targets the marker endpoint and stays shell-literal', () => {
  const cmd = hooks._hookCommand('claude', hooks.ENDPOINT_DONE);
  assert.match(cmd, /\/api\/hooks\/turn-done\?cli=claude/);
  assert.match(cmd, /\$\{TASKHUB_RUN_ID:-\}/);   // literal env expansion, not JS-interpolated
  assert.match(cmd, /\|\| true /);               // fire-and-forget
  assert.ok(cmd.endsWith("taskhub-workflow-hook'")); // ownership marker (so isOurs can't false-match)
});

test('claude entries carry a matcher, codex entries do not', () => {
  assert.equal(hooks._entryFor('claude', hooks.ENDPOINT_START).matcher, '.*');
  assert.ok(!('matcher' in hooks._entryFor('codex', hooks.ENDPOINT_START)));
});

test('merge preserves existing hooks, is idempotent, and removes cleanly', () => {
  const existing = { model: 'opus', hooks: { Stop: [
    { matcher: '.*', hooks: [{ type: 'command', command: '/Users/me/.claude/count_tokens.js' }] },
  ] } };

  // install both events
  let cfg = hooks._addHookTo(existing, 'UserPromptSubmit', hooks._entryFor('claude', hooks.ENDPOINT_START));
  cfg = hooks._addHookTo(cfg, 'Stop', hooks._entryFor('claude', hooks.ENDPOINT_DONE));
  assert.equal(cfg.hooks.Stop.length, 2);                 // theirs + ours
  assert.equal(cfg.hooks.UserPromptSubmit.length, 1);     // ours
  assert.ok(hooks._hasOurHookIn(cfg, 'Stop'));
  assert.ok(hooks._hasOurHookIn(cfg, 'UserPromptSubmit'));
  assert.equal(cfg.model, 'opus');                         // unrelated keys untouched

  // re-install = no duplicates
  cfg = hooks._addHookTo(cfg, 'Stop', hooks._entryFor('claude', hooks.ENDPOINT_DONE));
  assert.equal(cfg.hooks.Stop.length, 2);

  // uninstall both
  cfg = hooks._removeHookFrom(cfg, 'UserPromptSubmit');
  cfg = hooks._removeHookFrom(cfg, 'Stop');
  assert.equal(cfg.hooks.Stop.length, 1);
  assert.equal(cfg.hooks.Stop[0].hooks[0].command, '/Users/me/.claude/count_tokens.js'); // theirs survives
  assert.equal(cfg.hooks.UserPromptSubmit.length, 0);
  assert.ok(!hooks._hasOurHookIn(cfg, 'Stop'));
});

test('codex merge works from an empty hooks config', () => {
  const empty = { hooks: {} };
  assert.ok(!hooks._hasOurHookIn(empty, 'Stop'));
  const cfg = hooks._addHookTo(empty, 'Stop', hooks._entryFor('codex', hooks.ENDPOINT_DONE));
  assert.equal(cfg.hooks.Stop.length, 1);
  assert.ok(hooks._hasOurHookIn(cfg, 'Stop'));
});

test('install/uninstall reject an unknown CLI', () => {
  assert.throws(() => hooks.install('gemini'), /unknown CLI/);
  assert.throws(() => hooks.uninstall('gemini'), /unknown CLI/);
});
