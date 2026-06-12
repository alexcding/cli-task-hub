// Pure unified-diff parser: `git diff` text → files → hunks → numbered lines for the
// diff pane. Dependency-free (no DOM, no other modules) so node:test can import it
// directly. Rendering caps/guards live in diff.js — this parses whatever it's given.

// Decode a git C-style quoted path body: octal escapes are UTF-8 BYTES (ä → \303\244
// with the default core.quotePath), so collect bytes and decode once at the end.
// Without this, reconstructed discard patches would name files that don't exist.
function unquoteC(s) {
  if (!s.includes('\\')) return s;
  const enc = new TextEncoder(), bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { for (const b of enc.encode(s[i])) bytes.push(b); continue; }
    const n = s[++i];
    if (n >= '0' && n <= '7') { bytes.push(parseInt(s.slice(i, i + 3), 8)); i += 2; }
    else bytes.push({ n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7 }[n] ?? n.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// A git path token: drop the quotes git adds for special characters (decoding their
// escapes), then the a/ b/ prefix; /dev/null (the "no file" side) becomes ''. Leading
// and trailing quotes are stripped independently — the `diff --git` fallback regex can
// hand us a token with only one of them.
function cleanPath(p) {
  let s = (p || '').trim();
  const quoted = s.startsWith('"');
  if (quoted) s = s.slice(1);
  if (s.endsWith('"')) s = s.slice(0, -1);
  if (quoted) s = unquoteC(s);
  if (s === '/dev/null') return '';
  return s.replace(/^[ab]\//, '');
}

// Parse one `git diff` patch into:
//   [{ oldPath, newPath, status: 'modified'|'added'|'deleted'|'renamed',
//      binary, adds, dels, hunks: [{ header, lines: [{ t:'+'|'-'|' ', text, oldNo, newNo }] }] }]
// Paths come from the unambiguous per-file lines (`--- a/…`, `+++ b/…`, `rename from/to`);
// the `diff --git a/X b/Y` header is only a fallback (it can't be split reliably when a
// path contains spaces — greedy match on the last ` b/` is the best heuristic).
export function parseDiff(text) {
  const files = [];
  if (!text) return files;
  let f = null, h = null, oldNo = 0, newNo = 0;
  for (const ln of text.split('\n')) {
    if (ln.startsWith('diff --git ')) {
      const m = ln.match(/^diff --git "?a\/(.*?)"? "?b\/(.*)"?$/);
      f = { oldPath: cleanPath(m ? 'a/' + m[1] : ''), newPath: cleanPath(m ? 'b/' + m[2] : ''),
            status: 'modified', binary: false, adds: 0, dels: 0, hunks: [] };
      files.push(f); h = null;
      continue;
    }
    if (!f) continue; // preamble before the first file header
    if (h) {
      // Inside a hunk: classify by the first character. `\` is the "No newline at end
      // of file" marker — metadata, not content. Anything else ends the hunk and falls
      // through to the per-file header parsing below.
      const c = ln[0];
      if (c === '+') { f.adds++; h.lines.push({ t: '+', text: ln.slice(1), oldNo: 0, newNo: newNo++ }); continue; }
      if (c === '-') { f.dels++; h.lines.push({ t: '-', text: ln.slice(1), oldNo: oldNo++, newNo: 0 }); continue; }
      if (c === ' ') { h.lines.push({ t: ' ', text: ln.slice(1), oldNo: oldNo++, newNo: newNo++ }); continue; }
      // "\ No newline at end of file" — flag the line it annotates so hunkPatch() can
      // re-emit it; dropping it would corrupt a reconstructed patch for such files.
      if (c === '\\') { const last = h.lines[h.lines.length - 1]; if (last) last.noNl = true; continue; }
      if (ln === '') continue; // blank context line with trailing whitespace stripped (or EOF)
      h = null;
    }
    const at = ln.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (at) {
      oldNo = +at[1]; newNo = +at[2];
      h = { header: ln, oldStart: oldNo, newStart: newNo, lines: [] };
      f.hunks.push(h);
    }
    else if (ln.startsWith('--- '))         { const p = cleanPath(ln.slice(4)); if (p) f.oldPath = p; else f.status = 'added'; }
    else if (ln.startsWith('+++ '))         { const p = cleanPath(ln.slice(4)); if (p) f.newPath = p; else f.status = 'deleted'; }
    else if (ln.startsWith('rename from ')) { f.oldPath = cleanPath(ln.slice(12)); f.status = 'renamed'; }
    else if (ln.startsWith('rename to '))   { f.newPath = cleanPath(ln.slice(10)); f.status = 'renamed'; }
    else if (ln.startsWith('new file mode '))     f.status = 'added';
    else if (ln.startsWith('deleted file mode ')) f.status = 'deleted';
    else if (ln.startsWith('Binary files ') || ln === 'GIT binary patch') f.binary = true;
  }
  return files;
}

// Display path for a parsed file: the surviving side, with renames shown as old → new.
export function diffPath(f) {
  if (f.status === 'renamed' && f.oldPath && f.oldPath !== f.newPath) return `${f.oldPath} → ${f.newPath}`;
  return f.newPath || f.oldPath || '(unknown)';
}

// The path a discard patch should target. For renames the content lives at newPath in
// the worktree — naming oldPath on the a/ side would make `git apply -R` look for a
// file that no longer exists (or undo the rename); we only revert content, on newPath.
const patchPath = f => (f.status === 'renamed' ? f.newPath : f.oldPath || f.newPath);

// Reconstruct a minimal applicable patch (file header + ONE hunk) from parsed data, so
// a single hunk can be reverse-applied (`git apply -R`) to discard it from the worktree.
export function hunkPatch(f, h) {
  const oldSide = f.status === 'added' ? '/dev/null' : `a/${patchPath(f)}`;
  const newSide = f.status === 'deleted' ? '/dev/null' : `b/${f.newPath || f.oldPath}`;
  const out = [`--- ${oldSide}`, `+++ ${newSide}`, h.header];
  for (const l of h.lines) {
    out.push(l.t + l.text);
    if (l.noNl) out.push('\\ No newline at end of file');
  }
  return out.join('\n') + '\n';
}

// Block segmentation: a "block" is a group of changed (+/−) runs separated by at most
// `gap` unchanged lines — bridging context lines belong to the block. This mirrors how
// git itself forms hunks (runs within 2×context = 6 lines share a hunk, which is what
// Fork displays); gap=3 sits one notch finer, so a comment + its code edit act as one
// block while edits further apart stay independently discardable.
// Returns a block id per line, null for context lines outside any block.
export function hunkBlocks(h, gap = 3) {
  const ids = new Array(h.lines.length).fill(null);
  const runs = [];
  let lastChanged = -Infinity;
  h.lines.forEach((l, i) => {
    if (l.t === ' ') return;
    const cur = runs[runs.length - 1];
    if (cur && i - lastChanged - 1 <= gap) cur.end = i;
    else runs.push({ start: i, end: i });
    lastChanged = i;
  });
  runs.forEach((r, b) => { for (let i = r.start; i <= r.end; i++) ids[i] = b; });
  return ids;
}

// Patch that reverts ONLY block `target` of a hunk. The other blocks' changes must
// stay: their '+' lines appear as context (they're in the worktree now and survive the
// discard) and their '−' lines appear on neither side. Both sides then share the
// hunk's new-side start — everything before it is identical in worktree and result.
// A hunk whose changes are all one block degrades to hunkPatch (exact original header,
// which also keeps the added/deleted-file /dev/null cases trivially correct).
export function blockPatch(f, h, target) {
  const ids = hunkBlocks(h);
  if (!ids.some(id => id !== null && id !== target)) return hunkPatch(f, h);
  const out = [`--- a/${patchPath(f)}`, `+++ b/${f.newPath || f.oldPath}`];
  const body = [];
  let oldC = 0, newC = 0;
  h.lines.forEach((l, i) => {
    if (ids[i] === target && l.t !== ' ') { // the block's own changes (bridging context falls through)
      body.push(l.t + l.text);
      if (l.t === '-') oldC++; else newC++;
    } else if (l.t !== '-') { // context, or another block's '+' line
      body.push(' ' + l.text);
      oldC++; newC++;
    } else return; // another block's '-' line — on neither side of this patch
    if (l.noNl) body.push('\\ No newline at end of file');
  });
  out.push(`@@ -${h.newStart},${oldC} +${h.newStart},${newC} @@`, ...body);
  return out.join('\n') + '\n';
}
