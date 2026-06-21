// Tests for src/renderer/lib/terminal-tail.mjs (a DOM-free ES module — loaded via dynamic
// import). The extraction must surface the agent's last message (Claude's ⏺-marked block) from a
// TUI screen, skipping the working/"Brewed for…" line, the recap, the input box, and the status
// bar. This is the shared "what did it just say" read reused by the Tasks page and (later) the
// workflow next-step decider.
const { test } = require('node:test');
const assert = require('node:assert');

const mod = import('../src/renderer/lib/terminal-tail.mjs');

// A real Claude screen tail: the ⏺ message, then the "Brewed for…" line, the recap, the input
// box, and the cost/mode status bar — the layout that made naive "last lines" show only chrome.
const CLAUDE_SCREEN = [
  '⏺ Done. I reviewed the recent updates and updated PR #211\'s description.',
  '',
  '  What I changed in the description',
  '',
  '  Refined the Player dismissal bullet in section 2.',
  '  - Refresh is now asset-scoped.',
  '  - Removed the dead per-view dismiss plumbing.',
  '',
  '✻ Brewed for 2m 37s',
  '',
  '※ recap: You wanted PR #211\'s description reviewed and updated, which I\'ve done.',
  '',
  '─────────────────────────────────────────────────────────',
  '❯ ',
  '─────────────────────────────────────────────────────────',
  '  🤖  Opus 4.8 (1M context) | 💰  $1.03 session / $72.54',
  '  ⏵⏵ auto mode on · PR #211 · ← for agents',
];

test('lastDotMessage returns the ⏺ block, dot stripped, stopping before the Brewed/recap chrome', async () => {
  const { lastDotMessage } = await mod;
  const msg = lastDotMessage(CLAUDE_SCREEN, 6);
  assert.equal(msg[0], 'Done. I reviewed the recent updates and updated PR #211\'s description.');
  // Stops at the "✻ Brewed" line — no spinner, recap, rules, prompt or status leak in.
  const joined = msg.join('\n');
  assert.ok(!/Brewed|recap|❯|🤖|💰|⏵|─{3,}/.test(joined), `chrome leaked: ${joined}`);
  // Captures the body up to the cap.
  assert.ok(joined.includes('What I changed in the description'));
  assert.ok(joined.includes('Refresh is now asset-scoped'));
});

test('agentOutput falls back to the line-tail when there is no dot marker', async () => {
  const { agentOutput } = await mod;
  const shell = [
    'npm test',
    '  87 passing',
    '  0 failing',
    '─────────────',
    '$ ',
  ];
  assert.deepEqual(agentOutput(shell, { maxLines: 2 }), ['87 passing', '0 failing']);
});

test('lastDotMessage does NOT truncate at the agent\'s own markdown divider or prose words', async () => {
  const { lastDotMessage } = await mod;
  const screen = [
    '⏺ Heres the plan.',
    '',
    '--------------------------------',          // the agent's own divider — content, not chrome
    'I left auto mode on for the next run.',     // "auto mode" must not read as the status bar
    'Done — these notes are for agents to read.',// "for agents" must not read as the status bar
    '',
    '✻ Brewed for 12s',                          // THIS ends the block
    '※ recap: …',
    '❯ ',
  ];
  const msg = lastDotMessage(screen, 10).join('\n');
  assert.ok(msg.includes('I left auto mode on for the next run.'), `lost a prose line: ${msg}`);
  assert.ok(msg.includes('for agents to read'), `lost a prose line: ${msg}`);
  assert.ok(!/Brewed|recap|❯/.test(msg));        // real chrome still excluded
});

test('lastDotMessage stops at the input line (no spinner/recap layout) without swallowing typed input', async () => {
  const { lastDotMessage } = await mod;
  // A Codex-style screen: '•' marker, NO ✻/※, just a rule then the input line with typed text.
  const screen = [
    '• Fixed the bug and ran the tests.',
    '',
    '────────────────────────────',   // input-box separator — not a terminator, but trimmed if trailing
    '❯ git status',                    // the typed input line MUST end the block, not be absorbed
    '────────────────────────────',
  ];
  const msg = lastDotMessage(screen, 40).join('\n');
  assert.ok(msg.includes('Fixed the bug and ran the tests.'));
  assert.ok(!msg.includes('git status'), `swallowed the input line: ${msg}`);
});

test('classifiers identify chrome; empty input is safe', async () => {
  const { agentOutput, isRule, isPrompt, isStatus } = await mod;
  assert.ok(isRule('──────────'));
  assert.ok(isPrompt('❯'));
  assert.ok(isStatus('  ⏵⏵ auto mode on · ← for agents'));
  assert.ok(!isRule('real text — with a dash'));
  assert.deepEqual(agentOutput([], {}), []);
  assert.deepEqual(agentOutput(null, {}), []);
});
