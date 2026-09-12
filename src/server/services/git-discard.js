const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseDiff, hunkBlocks, blockPatch } = require('../../shared/diff-parse.mjs');

const revisionFor = diff => crypto.createHash('sha256').update(diff).digest('hex');

async function scopedPath(root, relative) {
  if (!relative || relative.includes('\0') || path.isAbsolute(relative) || relative.split('/').includes('..')) {
    throw new Error('Invalid discard file path');
  }
  const canonical = await fs.realpath(root);
  const prefix = canonical === path.sep ? path.sep : canonical + path.sep;
  const target = path.resolve(canonical, relative);
  if (target === canonical || !target.startsWith(prefix)) throw new Error('Discard file is outside the worktree');
  // Walk existing parents too: a deleted file may no longer exist, but a symlink
  // parent must not redirect a recreated file outside the confirmed worktree.
  let current = target;
  while (current !== canonical) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Use the terminal to discard symbolic-link changes');
      const resolved = await fs.realpath(current);
      if (!resolved.startsWith(prefix)) throw new Error('Discard file is outside the worktree');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    current = path.dirname(current);
  }
  return target;
}

// The web surface supplies only indices. Both preview and apply reconstruct the
// patch from a fresh local Git diff and reject a stale reviewed revision.
async function discardBlock(root, request, { load, apply }) {
  const { revision, selection, mode } = request;
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision) || !Array.isArray(selection) || selection.length !== 3
      || !selection.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000)
      || !['preview', 'apply'].includes(mode)) throw new Error('Invalid discard selection');
  const snapshot = await load(root);
  if (snapshot.error) throw new Error(snapshot.error);
  if (typeof snapshot.diff !== 'string' || Buffer.byteLength(snapshot.diff) > 8 * 1024 * 1024) throw new Error('Diff too large to discard from this view');
  if (revisionFor(snapshot.diff) !== revision) throw new Error('Changes changed on disk. Refresh and review this block again.');
  const [fi, hi, bi] = selection;
  const file = parseDiff(snapshot.diff)[fi], hunk = file?.hunks[hi];
  if (!file || file.binary || !hunk || !hunkBlocks(hunk).includes(bi)) throw new Error('This change block no longer exists');
  const relative = file.status === 'renamed' ? file.newPath : file.oldPath || file.newPath;
  await scopedPath(root, relative);
  const patch = blockPatch(file, hunk, bi);
  if (Buffer.byteLength(patch) > 1024 * 1024) throw new Error('Change block too large to discard from this view');
  if (mode === 'preview') return { ok: true, path: relative, patch, revision, selection };
  // Git's context check is the final guard if another writer changes the
  // file after the revision read. It applies the patch atomically or fails.
  return apply(root, patch);
}

module.exports = { revisionFor, discardBlock };
