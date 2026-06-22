// Tests for src/renderer/lib/highlight.mjs (an ES module — loaded via dynamic import).
const { test } = require('node:test');
const assert = require('node:assert');

const mod = import('../src/renderer/lib/highlight.mjs');

test('langForPath maps extensions, unknown → empty', async () => {
  const { langForPath } = await mod;
  assert.equal(langForPath('src/foo.ts'), 'js');
  assert.equal(langForPath('a/b/c.py'), 'py');
  assert.equal(langForPath('main.go'), 'go');
  assert.equal(langForPath('build.sh'), 'sh');
  assert.equal(langForPath('README.md'), '');   // no highlighter → plain
  assert.equal(langForPath('noext'), '');
});

test('no language → text is escaped, untouched otherwise', async () => {
  const { highlightLine } = await mod;
  assert.equal(highlightLine('a < b && c', ''), 'a &lt; b &amp;&amp; c');
});

test('keywords, numbers, strings, comments get token spans', async () => {
  const { highlightLine } = await mod;
  const out = highlightLine('const x = 42;', 'js');
  assert.match(out, /<span class="tok-kw">const<\/span>/);
  assert.match(out, /<span class="tok-num">42<\/span>/);

  assert.match(highlightLine('const s = "hi";', 'js'), /<span class="tok-str">"hi"<\/span>/);
  assert.match(highlightLine('// a comment', 'js'), /<span class="tok-com">\/\/ a comment<\/span>/);
  assert.match(highlightLine('# py comment', 'py'), /<span class="tok-com"># py comment<\/span>/);
});

test('a // inside a string is NOT treated as a comment', async () => {
  const { highlightLine } = await mod;
  const out = highlightLine('const u = "http://x";', 'js');
  assert.match(out, /<span class="tok-str">"http:\/\/x"<\/span>/);
  assert.doesNotMatch(out, /tok-com/);
});

test('function-call names highlight; content is escaped', async () => {
  const { highlightLine } = await mod;
  const out = highlightLine('render(a < b)', 'js');
  assert.match(out, /<span class="tok-fn">render<\/span>/);
  assert.match(out, /a &lt; b/);
});

test('# is a comment only where the language uses it (not in JS)', async () => {
  const { highlightLine } = await mod;
  assert.doesNotMatch(highlightLine('a = b #notcomment', 'js'), /tok-com/);
});
