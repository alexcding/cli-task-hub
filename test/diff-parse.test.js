// Parser tests for public/js/diff-parse.mjs (an ES module — loaded via dynamic import).
const { test } = require('node:test');
const assert = require('node:assert');

const mod = import('../public/js/diff-parse.mjs');

const MODIFIED = `diff --git a/lib/foo.js b/lib/foo.js
index 1111111..2222222 100644
--- a/lib/foo.js
+++ b/lib/foo.js
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 module.exports = a;
@@ -10,2 +11,2 @@ function tail() {
-  return b;
+  return c;
 }
`;

test('modified file: hunks, counts, line numbers', async () => {
  const { parseDiff } = await mod;
  const [f] = parseDiff(MODIFIED);
  assert.equal(f.newPath, 'lib/foo.js');
  assert.equal(f.status, 'modified');
  assert.equal(f.adds, 3);
  assert.equal(f.dels, 2);
  assert.equal(f.hunks.length, 2);
  const lines = f.hunks[0].lines;
  assert.deepEqual(lines.map(l => l.t), [' ', '-', '+', '+', ' ']);
  assert.equal(lines[0].oldNo, 1); assert.equal(lines[0].newNo, 1);
  assert.equal(lines[1].oldNo, 2); assert.equal(lines[1].newNo, 0);  // deletion: old side only
  assert.equal(lines[2].oldNo, 0); assert.equal(lines[2].newNo, 2);  // addition: new side only
  assert.equal(lines[4].oldNo, 3); assert.equal(lines[4].newNo, 4);  // context resumes both
  assert.equal(f.hunks[1].lines[0].oldNo, 10);
});

test('added and deleted files', async () => {
  const { parseDiff } = await mod;
  const files = parseDiff(`diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`);
  assert.equal(files.length, 2);
  assert.equal(files[0].status, 'added');
  assert.equal(files[0].newPath, 'new.txt');
  assert.equal(files[0].adds, 2);
  assert.equal(files[1].status, 'deleted');
  assert.equal(files[1].oldPath, 'gone.txt');
  assert.equal(files[1].dels, 1);
});

test('rename without content changes has no hunks', async () => {
  const { parseDiff, diffPath } = await mod;
  const [f] = parseDiff(`diff --git a/old-name.js b/new-name.js
similarity index 100%
rename from old-name.js
rename to new-name.js
`);
  assert.equal(f.status, 'renamed');
  assert.equal(f.hunks.length, 0);
  assert.equal(diffPath(f), 'old-name.js → new-name.js');
});

test('binary file is flagged, not parsed', async () => {
  const { parseDiff } = await mod;
  const [f] = parseDiff(`diff --git a/img.png b/img.png
index 1111111..2222222 100644
Binary files a/img.png and b/img.png differ
`);
  assert.equal(f.binary, true);
  assert.equal(f.newPath, 'img.png');
  assert.equal(f.hunks.length, 0);
});

test('"no newline at end of file" markers are skipped', async () => {
  const { parseDiff } = await mod;
  const [f] = parseDiff(`diff --git a/x b/x
--- a/x
+++ b/x
@@ -1,1 +1,1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`);
  assert.equal(f.adds, 1);
  assert.equal(f.dels, 1);
  assert.equal(f.hunks[0].lines.length, 2);
});

test('renamed file with edits: patch targets the NEW path on both sides', async () => {
  const { parseDiff, blockPatch } = await mod;
  const [f] = parseDiff(`diff --git a/old.js b/new.js
similarity index 90%
rename from old.js
rename to new.js
--- a/old.js
+++ b/new.js
@@ -1,2 +1,2 @@
-x
+X
 keep
`);
  assert.equal(f.status, 'renamed');
  // a/old.js would point git apply -R at a file that no longer exists in the worktree.
  assert.match(blockPatch(f, f.hunks[0], 0), /^--- a\/new\.js\n\+\+\+ b\/new\.js\n/);
});

test('quoted paths decode C-style octal escapes (UTF-8 bytes)', async () => {
  const { parseDiff } = await mod;
  // git's default core.quotePath renders "päth.txt" as "p\303\244th.txt".
  const [f] = parseDiff(`diff --git "a/p\\303\\244th.txt" "b/p\\303\\244th.txt"
--- "a/p\\303\\244th.txt"
+++ "b/p\\303\\244th.txt"
@@ -1,1 +1,1 @@
-a
+b
`);
  assert.equal(f.newPath, 'päth.txt');
  // …and a path with an escaped quote/backslash survives too.
  const [g] = parseDiff(`diff --git "a/we\\"ird.txt" "b/we\\"ird.txt"
--- "a/we\\"ird.txt"
+++ "b/we\\"ird.txt"
@@ -1,1 +1,1 @@
-a
+b
`);
  assert.equal(g.newPath, 'we"ird.txt');
});

test('empty input and non-diff text parse to no files', async () => {
  const { parseDiff } = await mod;
  assert.deepEqual(parseDiff(''), []);
  assert.deepEqual(parseDiff('warning: something\n'), []);
});

test('hunkBlocks merges runs within the gap, splits beyond it', async () => {
  const { parseDiff, hunkBlocks } = await mod;
  // Runs 1 context line apart (≤ gap 3) merge into ONE block, bridging line included.
  const [near] = parseDiff(`diff --git a/m.txt b/m.txt
--- a/m.txt
+++ b/m.txt
@@ -1,5 +1,5 @@
 ctx1
-a
+A
 ctx2
-b
+B
`);
  assert.deepEqual(hunkBlocks(near.hunks[0]), [null, 0, 0, 0, 0, 0]);
  // Runs 5 context lines apart (> gap 3) stay separate blocks.
  const [far] = parseDiff(`diff --git a/m.txt b/m.txt
--- a/m.txt
+++ b/m.txt
@@ -1,8 +1,8 @@
-one
+ONE
 two
 three
 four
 five
 six
-seven
+SEVEN
 eight
`);
  assert.deepEqual(hunkBlocks(far.hunks[0]), [0, 0, null, null, null, null, null, 1, 1, null]);
});

test('blockPatch reverts only the target block', async () => {
  const { parseDiff, blockPatch } = await mod;
  const [f] = parseDiff(`diff --git a/m.txt b/m.txt
--- a/m.txt
+++ b/m.txt
@@ -1,8 +1,8 @@
-one
+ONE
 two
 three
 four
 five
 six
-seven
+SEVEN
 eight
`);
  // Reverting block 1: block 0's '+ONE' becomes context (it stays), its '-one' vanishes.
  assert.equal(blockPatch(f, f.hunks[0], 1),
`--- a/m.txt
+++ b/m.txt
@@ -1,8 +1,8 @@
 ONE
 two
 three
 four
 five
 six
-seven
+SEVEN
 eight
`);
  // A single-block hunk falls back to the exact original hunk patch.
  const [single] = parseDiff(`diff --git a/s.txt b/s.txt
--- a/s.txt
+++ b/s.txt
@@ -1,2 +1,2 @@
-x
+X
 keep
`);
  assert.match(blockPatch(single, single.hunks[0], 0), /@@ -1,2 \+1,2 @@/);
});

test('hunkPatch reconstructs an applicable single-hunk patch', async () => {
  const { parseDiff, hunkPatch } = await mod;
  const src = `diff --git a/x.txt b/x.txt
index 1111111..2222222 100644
--- a/x.txt
+++ b/x.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
\\ No newline at end of file
`;
  const [f] = parseDiff(src);
  assert.equal(hunkPatch(f, f.hunks[0]),
`--- a/x.txt
+++ b/x.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
\\ No newline at end of file
`);
  // Added file → old side is /dev/null.
  const [added] = parseDiff(`diff --git a/n.txt b/n.txt
new file mode 100644
--- /dev/null
+++ b/n.txt
@@ -0,0 +1,1 @@
+hi
`);
  assert.match(hunkPatch(added, added.hunks[0]), /^--- \/dev\/null\n\+\+\+ b\/n\.txt\n/);
});
