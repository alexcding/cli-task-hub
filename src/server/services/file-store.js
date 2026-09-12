// Revision-checked local document I/O. Saves to one canonical file are serialized;
// edits are staged beside the destination, then renamed only after rechecking it.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

const MAX_BYTES = 5 * 1024 * 1024;
class FileError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const changed = () => new FileError(409, 'The file changed on disk. Your edits have been kept; reload or save a copy before replacing it.');
const metadata = st => `${st.dev}:${st.ino}:${st.mode}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
const revision = (file, st, bytes) => createHash('sha256').update(file + '\0' + metadata(st) + '\0').update(bytes).digest('hex');

class FileStore {
  constructor(io = fs.promises) { this.io = io; this.writes = new Map(); }

  async snapshot(file) {
    const realPath = await this.io.realpath(file);
    const handle = await this.io.open(realPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = await handle.stat({ bigint: true });
      if (!st.isFile()) throw new FileError(415, 'Only regular text files can be edited.');
      if (st.size > BigInt(MAX_BYTES)) throw new FileError(413, 'File too large to edit (maximum 5 MB).');
      // Bound reads even if another writer grows the file after stat(). An extra
      // byte detects growth; a second stat detects replacement or in-place edits.
      const buffer = Buffer.alloc(Number(st.size) + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const named = await this.io.stat(realPath, { bigint: true });
      if (metadata(st) !== metadata(after) || metadata(st) !== metadata(named) || BigInt(size) !== st.size || await this.io.realpath(file) !== realPath) throw changed();
      const bytes = buffer.subarray(0, size);
      const content = bytes.toString('utf8');
      if (bytes.includes(0) || !Buffer.from(content, 'utf8').equals(bytes)) throw new FileError(415, 'Not a UTF-8 text file.');
      let readOnly = st.nlink > 1n;
      try { await this.io.access(realPath, fs.constants.W_OK); } catch { readOnly = true; }
      return { realPath, st, bytes, content, readOnly, revision: revision(realPath, st, bytes) };
    } finally { await handle.close(); }
  }

  async read(file) {
    const value = await this.snapshot(file);
    return { path: file, content: value.content, readOnly: value.readOnly, revision: value.revision };
  }

  async save(file, content, expectedRevision) {
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      throw new FileError(428, 'Reload this file before saving so its current revision can be checked.');
    }
    if (typeof content !== 'string') throw new FileError(400, 'Content required.');
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > MAX_BYTES) throw new FileError(413, 'Content too large (maximum 5 MB).');
    if (content.includes('\0') || bytes.toString('utf8') !== content) throw new FileError(415, 'Content must be valid UTF-8 text.');
    let canonical;
    try { canonical = await this.io.realpath(file); }
    catch (error) { if (error.code === 'ENOENT') throw changed(); throw error; }
    const previous = this.writes.get(canonical) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.replace(file, canonical, content, bytes, expectedRevision));
    this.writes.set(canonical, pending);
    try { return await pending; }
    finally { if (this.writes.get(canonical) === pending) this.writes.delete(canonical); }
  }

  async replace(file, canonical, content, bytes, expectedRevision) {
    const original = await this.snapshot(file);
    if (original.realPath !== canonical || original.revision !== expectedRevision) throw changed();
    if (original.st.nlink > 1n) throw new FileError(403, 'Hard-linked files must be edited with an external editor.');
    if (original.readOnly) throw new FileError(403, 'This file is read-only.');
    const stage = await this.io.mkdtemp(path.join(path.dirname(canonical), '.taskhub-save-'));
    const temporary = path.join(stage, 'content');
    try {
      // macOS cp -p preserves ACLs, extended attributes and resource forks as
      // well as mode/ownership. A private staging directory prevents anyone else
      // from substituting the temporary file while it is copied and edited.
      if (process.platform === 'darwin') {
        await execFile('/bin/cp', ['-p', canonical, temporary], { timeout: 10_000, maxBuffer: 16 * 1024 });
      } else {
        await this.io.copyFile(canonical, temporary, fs.constants.COPYFILE_EXCL);
      }
      const handle = await this.io.open(temporary, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
      try {
        const copy = await handle.stat({ bigint: true });
        if (copy.uid !== original.st.uid || copy.gid !== original.st.gid) throw new FileError(403, 'File ownership could not be preserved.');
        await handle.truncate(0);
        await handle.writeFile(bytes);
        await handle.chmod(Number(original.st.mode & 0o7777n));
        await handle.sync();
      } finally { await handle.close(); }
      const current = await this.snapshot(file);
      if (current.realPath !== canonical || current.revision !== expectedRevision) throw changed();
      await this.io.rename(temporary, canonical);
      const saved = await this.snapshot(file);
      if (saved.realPath !== canonical || saved.content !== content) throw changed();
      return { ok: true, path: file, revision: saved.revision };
    } finally { await this.io.rm(stage, { recursive: true, force: true }); }
  }
}

module.exports = { FileStore, FileError, MAX_BYTES };
