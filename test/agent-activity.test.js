// Tests for src/renderer/lib/agent-activity.mjs (a DOM-free ES module — loaded via dynamic
// import). Maps a CLI's PreToolUse hook payload to the short status shown on the Tasks page.
const { test } = require('node:test');
const assert = require('node:assert');

const mod = import('../src/renderer/lib/agent-activity.mjs');

test('activityFromTool: edits/writes show the file basename', async () => {
  const { activityFromTool } = await mod;
  assert.equal(activityFromTool('Edit', { file_path: '/Users/me/proj/src/auth.js' }), 'Editing auth.js');
  assert.equal(activityFromTool('Write', { file_path: 'a/b/c.txt' }), 'Editing c.txt');
  assert.equal(activityFromTool('MultiEdit', {}), 'Editing files');
});

test('activityFromTool: reads show the file', async () => {
  const { activityFromTool } = await mod;
  assert.equal(activityFromTool('Read', { file_path: 'pkg/index.ts' }), 'Reading index.ts');
});

test('activityFromTool: Bash shows the command (clipped)', async () => {
  const { activityFromTool } = await mod;
  assert.equal(activityFromTool('Bash', { command: 'npm test' }), 'Running: npm test');
  const long = activityFromTool('Bash', { command: 'x'.repeat(80) });
  assert.ok(long.startsWith('Running: '));
  assert.ok(long.length <= 'Running: '.length + 40);
  assert.ok(long.endsWith('…'));
});

test('activityFromTool: search/web/task/todo get friendly phrases', async () => {
  const { activityFromTool } = await mod;
  assert.equal(activityFromTool('Grep', { pattern: 'foo' }), 'Searching the codebase');
  assert.equal(activityFromTool('Glob', {}), 'Searching the codebase');
  assert.equal(activityFromTool('WebFetch', {}), 'Researching the web');
  assert.equal(activityFromTool('Task', {}), 'Delegating to a subagent');
  assert.equal(activityFromTool('TodoWrite', {}), 'Planning its next steps');
});

test('activityFromTool: unknown tool falls back to the raw name; empty → empty', async () => {
  const { activityFromTool } = await mod;
  assert.equal(activityFromTool('SomeCustomTool', {}), 'SomeCustomTool');
  assert.equal(activityFromTool('', null), '');
  assert.equal(activityFromTool(undefined, undefined), '');
});
