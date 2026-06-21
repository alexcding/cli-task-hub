// Tests for the pure helpers in src/server/services/cli-analyze.js — the prompt builder, the
// argv builder, and the tolerant JSON parser. The spawn itself isn't exercised (no CLI in CI).
const { test } = require('node:test');
const assert = require('node:assert');
const a = require('../src/server/services/cli-analyze');

test('parseResult: extracts summary/state, ignores prose and code fences around the JSON', () => {
  const out = 'Here you go:\n```json\n{"summary":"Fixed the bug and added a test.","state":"done"}\n```\n';
  const r = a._parseResult(out, false);
  assert.equal(r.summary, 'Fixed the bug and added a test.');
  assert.equal(r.state, 'done');
  assert.equal(r.decision, undefined); // no decision without workflow context
});

test('parseResult: picks the real answer out of codex-style polluted stdout (banner + echoed schema + repeated answer)', () => {
  // codex exec dumps a banner, echoes the prompt (which contains our {...} schema), prints hook
  // lines, and repeats the answer — a greedy {…} match would span all of it and fail to parse.
  const out = [
    'OpenAI Codex v0.141.0',
    'workdir: /repo  model: gpt-5.5',
    'user',
    'Reply with ONLY JSON: {"summary": string, "state": "done"|"needs_input"}',  // echoed SCHEMA (not valid JSON)
    'hook: UserPromptSubmit',
    'codex',
    '{"summary":"Reviewed PR and is asking to commit.","state":"needs_input"}',   // first occurrence
    'tokens used',
    '21,602',
    '{"summary":"Reviewed PR and is asking to commit.","state":"needs_input"}',   // repeated final
  ].join('\n');
  const r = a._parseResult(out, false);
  assert.equal(r.summary, 'Reviewed PR and is asking to commit.');
  assert.equal(r.state, 'needs_input');
});

test('parseResult: a summary string containing a brace is parsed correctly (string-aware)', () => {
  const r = a._parseResult('{"summary":"use the } char to close","state":"done"}', false);
  assert.equal(r.summary, 'use the } char to close');
  assert.equal(r.state, 'done');
});

test('parseResult: with context, surfaces a validated decision + reason', () => {
  const r = a._parseResult('{"summary":"asking to confirm","state":"needs_input","decision":"stop","reason":"agent asked a question"}', true);
  assert.equal(r.decision, 'stop');
  assert.equal(r.reason, 'agent asked a question');
});

test('parseResult: garbled output → proceed (do not halt an automated run) + best-effort summary', () => {
  const r = a._parseResult('totally not json, just some words', true);
  assert.equal(r.decision, 'proceed');       // unparseable must not stop the loop
  assert.equal(r.state, '');                  // unknown state
  assert.ok(r.summary.length > 0);            // falls back to the last line of text
});

test('parseResult: an invalid decision value falls back to proceed', () => {
  const r = a._parseResult('{"summary":"x","state":"done","decision":"yolo"}', true);
  assert.equal(r.decision, 'proceed');
});

test('cmdFor: claude is non-interactive, single-turn, text output, NO --model (uses default)', () => {
  const [bin, args] = a._cmdFor('claude', 'PROMPT');
  assert.equal(bin, 'claude');
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('--max-turns') && args.includes('1'));
  assert.ok(args.includes('--output-format') && args.includes('text'));
  assert.ok(!args.includes('--model'));
  assert.equal(args[args.length - 1], 'PROMPT');
});

test('buildPrompt: only asks for a decision when workflow context is supplied', () => {
  assert.ok(!a._buildPrompt({ text: 'hi' }).includes('decision'));
  const withCtx = a._buildPrompt({ text: 'hi', context: 'step 1/2' });
  assert.ok(withCtx.includes('decision'));
  assert.ok(withCtx.includes('step 1/2'));
});
