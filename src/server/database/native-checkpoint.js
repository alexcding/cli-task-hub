// Native packaged startup only. No application store imports before checkpoint.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createSnapshot, verifySnapshot, syncPath } = require('./data-snapshot');

function privateDirectory(directory) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Native checkpoint directory must be private, owned by this user, and not a symlink.');
  }
}

function hasFile(file) {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('Native checkpoint state must be a regular file.');
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function readState(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (fs.fstatSync(descriptor).size > 65536) throw new Error('Native checkpoint state is too large.');
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } finally { fs.closeSync(descriptor); }
}

function writeState(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
  syncPath(path.dirname(file));
}

function acquireNativeDataLock(dataDirectory) {
  const data = fs.realpathSync(dataDirectory), directory = path.join(data, 'native-backups');
  privateDirectory(directory);
  syncPath(data);
  const file = path.join(directory, 'owner.db');
  for (const suffix of ['', '-wal', '-shm', '-journal']) hasFile(file + suffix);
  // SQLite releases this separate DB's OS locks on exit/crash. Never unlink it:
  // all contenders must lock the same inode, not trust a stale PID file.
  if (!hasFile(file)) {
    try {
      const descriptor = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.closeSync(descriptor);
    } catch (error) { if (error.code !== 'EEXIST') throw error; hasFile(file); }
  }
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
  } catch (error) {
    db.close();
    throw new Error('Another native backend may be using this data directory; checkpoint ownership could not be acquired.', { cause: error });
  }
  let released = false;
  return { directory, release() {
    if (released) return;
    released = true;
    try { db.exec('ROLLBACK'); } finally { db.close(); }
  } };
}

async function prepareNativeData(dataDirectory, releaseID, lock) {
  if (!/^[a-f0-9]{64}$/.test(releaseID)) throw new Error('Invalid packaged backend release identity.');
  const directory = lock.directory, stateFile = path.join(directory, 'last-launch.json');
  let previous = null;
  if (hasFile(stateFile)) {
    previous = readState(stateFile);
    if (previous?.format !== 1 || !/^[a-f0-9]{64}$/.test(previous.releaseID)
        || (previous.snapshot !== null && !/^checkpoint-[a-f0-9-]{36}$/.test(previous.snapshot))) {
      throw new Error('Invalid native checkpoint state. Preserve native-backups and inspect it before retrying.');
    }
  }
  if (previous?.releaseID === releaseID) {
    if (previous.snapshot) {
      const snapshot = path.join(directory, previous.snapshot);
      if (!fs.lstatSync(snapshot).isDirectory()) throw new Error('Native checkpoint must not be a symlink.');
      // Never silently replace the original pre-upgrade data with post-upgrade
      // state when a previous checkpoint has been damaged or removed.
      await verifySnapshot(snapshot);
    }
    return { kind: 'unchanged', snapshot: previous.snapshot };
  }
  const hasData = hasFile(path.join(dataDirectory, 'taskhub.db')) || hasFile(path.join(dataDirectory, 'config.db'));
  const snapshot = hasData ? `checkpoint-${randomUUID()}` : null;
  if (snapshot) {
    const destination = path.join(directory, snapshot);
    await createSnapshot(dataDirectory, destination);
    await verifySnapshot(destination);
  }
  writeState(stateFile, { format: 1, releaseID, snapshot, previousReleaseID: previous?.releaseID ?? null,
    preparedAt: new Date().toISOString() });
  return { kind: snapshot ? 'created' : 'fresh', snapshot };
}

module.exports = { acquireNativeDataLock, prepareNativeData };
