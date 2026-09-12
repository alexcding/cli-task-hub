// Tests for the pure config transforms in src/server/services/agent-hooks.js — installing the
// "turn start/finished" hooks must preserve the user's existing hooks and be idempotent.
const { test } = require('node:test');
const assert = require('node:assert');
const hooks = require('../src/server/services/agent-hooks');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function directory(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-hook-test-'));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

test('hook edits retain other commands sharing a TaskHub entry', () => {
  const own = hooks._entryFor('claude', hooks.ENDPOINT_DONE).hooks[0];
  const other = { type: 'command', command: 'echo preserve-this-command' };
  const config = { hooks: { Stop: [null, { matcher: '.*', timeout: 30, hooks: [other, own] }] } };
  const removed = hooks._removeHookFrom(config, 'Stop');
  assert.deepEqual(removed.hooks.Stop, [null, { matcher: '.*', timeout: 30, hooks: [other] }]);
  const installed = hooks._addHookTo(config, 'Stop', hooks._entryFor('claude', hooks.ENDPOINT_DONE));
  assert.deepEqual(installed.hooks.Stop.slice(0, 2), removed.hooks.Stop);
  assert.equal(installed.hooks.Stop.length, 3);
  assert.equal(config.hooks.Stop[1].hooks.length, 2, 'input is not mutated');
});

test('hook updates reject malformed or unsupported config without replacing it', t => {
  const file = path.join(directory(t), 'settings.json');
  for (const text of ['{broken', 'null', '[]', '{"hooks":[]}', '{"hooks":{"Stop":"custom"}}']) {
    fs.writeFileSync(file, text);
    assert.throws(() => hooks._readForUpdate(file, {}), /file was not changed/);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
  fs.unlinkSync(file);
  assert.deepEqual(hooks._readForUpdate(file, { hooks: {} }), { hooks: {} });
});

test('atomic hook writes preserve file permissions and dotfile symlinks', t => {
  const dir = directory(t), target = path.join(dir, 'target.json'), link = path.join(dir, 'settings.json');
  fs.writeFileSync(target, '{}', { mode: 0o600 }); fs.symlinkSync(target, link);
  hooks._writeJson(link, { retained: true });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { retained: true });
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  const fresh = path.join(dir, 'new.json');
  hooks._writeJson(fresh, {});
  assert.equal(fs.statSync(fresh).mode & 0o777, 0o600);
  fs.unlinkSync(target);
  assert.throws(() => hooks._writeJson(link, {}), /dangling link/);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(!fs.readdirSync(dir).some(name => name.endsWith('.tmp')));
});

test('hook command preserves quoted port-file paths and forwards stdin to the intended endpoint', t => {
  const dir = directory(t), bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const portFile = path.join(dir, 'space \'quote" $(literal)');
  fs.writeFileSync(portFile, '45678');
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$TASKHUB_ARGS"\ncat > "$TASKHUB_BODY"\n', { mode: 0o755 });
  const argsFile = path.join(dir, 'args'), bodyFile = path.join(dir, 'body');
  const body = '{"session_id":"fixture-session"}';
  execFileSync('/bin/sh', ['-c', hooks._hookCommand('claude', hooks.ENDPOINT_DONE, portFile)], {
    input: body, timeout: 5000,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TASKHUB_RUN_ID: 'fixture-run', TASKHUB_ARGS: argsFile, TASKHUB_BODY: bodyFile },
  });
  assert.ok(fs.readFileSync(argsFile, 'utf8').split('\n').includes('http://127.0.0.1:45678/api/hooks/turn-done?cli=claude&runId=fixture-run'));
  assert.equal(fs.readFileSync(bodyFile, 'utf8'), body);
});

test('hook command targets the marker endpoint and stays shell-literal', () => {
  const cmd = hooks._hookCommand('claude', hooks.ENDPOINT_DONE);
  assert.match(cmd, /\/api\/hooks\/turn-done\?cli=claude/);
  assert.match(cmd, /\$\{TASKHUB_RUN_ID:-\}/);   // literal env expansion, not JS-interpolated
  assert.match(cmd, /\|\| true /);               // fire-and-forget
  assert.ok(cmd.endsWith("taskhub-workflow-hook'")); // ownership marker (so isOurs can't false-match)
});

test('real install/remove round-trip keeps unrelated agent configuration in an isolated home', t => {
  const dir = directory(t), configDir = path.join(dir, '.claude');
  fs.mkdirSync(configDir);
  const file = path.join(configDir, 'settings.json');
  const original = { model: 'preserve-model', hooks: { Stop: [{ matcher: '.*', hooks: [{ type: 'command', command: 'echo keep' }] }] } };
  fs.writeFileSync(file, JSON.stringify(original), { mode: 0o600 });
  const source = `const os = require('node:os'); os.homedir = () => process.argv[1];
    const assert = require('node:assert/strict'), hooks = require(process.argv[2]);
    hooks.install('claude'); hooks.install('claude'); hooks.install('codex');
    assert.deepEqual(hooks.status(), {claude:'installed',codex:'installed'});
    hooks.uninstall('claude'); hooks.uninstall('codex');
    assert.deepEqual(hooks.status(), {claude:'absent',codex:'absent'});`;
  execFileSync(process.execPath, ['-e', source, dir, require.resolve('../src/server/services/agent-hooks')], {
    timeout: 5000, env: { ...process.env, TASKHUB_DATA_DIR: dir },
  });
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(result.model, original.model);
  assert.deepEqual(result.hooks.Stop, original.hooks.Stop);
  assert.deepEqual(result.hooks.UserPromptSubmit, []);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
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
