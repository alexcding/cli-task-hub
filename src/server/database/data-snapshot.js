// Standalone upgrade/rollback tooling. Do not import db.js: opening application
// stores would run schema changes before an old installation could be backed up.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');

const FORMAT = 1;
const FILES = new Map([
  ['taskhub.db', 'sqlite'], ['config.db', 'sqlite'], ['logs.db', 'sqlite'],
  ['ptyd-native-spike/page-tabs.json', 'json'],
]);
const MAX_JSON = 16 * 1024 * 1024;

function directory(value) {
  const root = fs.realpathSync(value);
  if (!fs.statSync(root).isDirectory()) throw new Error('Expected an existing directory.');
  return root;
}

// Manifest paths are an allowlist, never an arbitrary extraction destination.
// Reject symlink components as well as symlink files, including optional inputs.
function regularFile(root, name, optional = false) {
  let current = root;
  const parts = name.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`Snapshot input must be a regular file with no symlinks: ${name}`);
    }
  }
  return current;
}

function readJSON(file, limit = MAX_JSON) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('Snapshot JSON is not a regular file or exceeds its size limit.');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > limit) throw new Error('Snapshot JSON exceeds its size limit.');
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } finally { fs.closeSync(fd); }
}

async function digest(file) {
  const hash = createHash('sha256');
  let size = 0;
  const stream = fs.createReadStream(file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
  for await (const bytes of stream) { hash.update(bytes); size += bytes.length; }
  return { size, sha256: hash.digest('hex') };
}

function checkDatabase(file) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { fs.lstatSync(file + suffix); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('A snapshot database must not depend on SQLite sidecars.');
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare('PRAGMA quick_check').all();
    if (rows.length !== 1 || rows[0].quick_check !== 'ok') throw new Error('SQLite integrity check failed.');
  } finally { db.close(); }
}

async function snapshotDatabase(source, destination) {
  if (typeof backup !== 'function') throw new Error('SQLite backup requires Node 22.16 or newer. Use the packaged Node helper.');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    regularFile(path.dirname(source), path.basename(source) + suffix, true);
  }
  const db = new DatabaseSync(source, { readOnly: true });
  let transaction = false;
  try {
    db.exec('PRAGMA busy_timeout = 5000; BEGIN;'); transaction = true;
    // Pin a read snapshot, including committed WAL pages. A busy writer cannot
    // force this backup to restart indefinitely or split one DB across versions.
    db.exec('SELECT count(*) FROM sqlite_schema;');
    await backup(db, destination);
  } finally {
    // Release the explicit WAL read transaction before disposing the connection.
    try { if (transaction) db.exec('ROLLBACK'); } finally { db.close(); }
  }
  fs.chmodSync(destination, 0o600);
  // Make the result self-contained. Restore must never need a source WAL/SHM.
  const copy = new DatabaseSync(destination);
  try { copy.exec('PRAGMA journal_mode = DELETE;'); } finally { copy.close(); }
  checkDatabase(destination);
}

async function createDestination(destination, operation) {
  const target = path.resolve(destination);
  // No recursive creation, existing-directory reuse, or replacing rename: even
  // an empty destination must be new. A failed operation has no valid manifest.
  await fsp.mkdir(target, { mode: 0o700 });
  try { return await operation(target); }
  catch (error) {
    // Leave incomplete output for diagnosis. Neither verification nor restore
    // accepts it. Never recursively delete a path that another process may use.
    throw new Error(`Snapshot operation failed; incomplete output at ${target}: ${error.message}`, { cause: error });
  }
}

async function createSnapshot(dataDirectory, destination) {
  const source = directory(dataDirectory);
  const primary = regularFile(source, 'taskhub.db', true) ? 'taskhub.db'
    : regularFile(source, 'config.db', true) ? 'config.db' : null;
  if (!primary) throw new Error('No durable taskhub.db or legacy config.db was found.');
  const names = [primary, 'logs.db', 'ptyd-native-spike/page-tabs.json']
    .filter(name => regularFile(source, name, true) !== null);
  return createDestination(destination, async target => {
    const entries = [];
    for (const name of names) {
      const input = regularFile(source, name), output = path.join(target, name);
      if (name.includes('/')) await fsp.mkdir(path.dirname(output), { mode: 0o700 });
      if (FILES.get(name) === 'sqlite') await snapshotDatabase(input, output);
      else await fsp.writeFile(output, readJSON(input).bytes, { flag: 'wx', mode: 0o600 });
      entries.push({ path: name, kind: FILES.get(name), ...await digest(output) });
    }
    const manifest = { format: FORMAT, createdAt: new Date().toISOString(), node: process.version, files: entries };
    // Publish last: an interrupted backup cannot masquerade as a completed one.
    await fsp.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return manifest;
  });
}

async function verifySnapshot(snapshotDirectory) {
  const root = directory(snapshotDirectory);
  const { value: manifest } = readJSON(regularFile(root, 'manifest.json'), 64 * 1024);
  if (manifest?.format !== FORMAT || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 3) {
    throw new Error('Unsupported or incomplete snapshot manifest.');
  }
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry || !FILES.has(entry.path) || entry.kind !== FILES.get(entry.path) || seen.has(entry.path)
        || !Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error('Invalid snapshot file entry.');
    }
    seen.add(entry.path);
    const input = regularFile(root, entry.path);
    const actual = await digest(input);
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new Error(`Snapshot checksum mismatch: ${entry.path}`);
    if (entry.kind === 'sqlite') checkDatabase(input); else readJSON(input);
  }
  if (Number(seen.has('taskhub.db')) + Number(seen.has('config.db')) !== 1) {
    throw new Error('Snapshot must contain exactly one durable database.');
  }
  return manifest;
}

async function restoreSnapshot(snapshotDirectory, destination) {
  const source = directory(snapshotDirectory);
  const manifest = await verifySnapshot(source);
  return createDestination(destination, async target => {
    for (const entry of manifest.files) {
      const input = regularFile(source, entry.path), output = path.join(target, entry.path);
      if (entry.path.includes('/')) await fsp.mkdir(path.dirname(output), { mode: 0o700 });
      await fsp.copyFile(input, output, fs.constants.COPYFILE_EXCL);
      await fsp.chmod(output, 0o600);
      const actual = await digest(output);
      if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new Error(`Snapshot changed during restore: ${entry.path}`);
      if (entry.kind === 'sqlite') checkDatabase(output); else readJSON(output);
    }
    await fsp.writeFile(path.join(target, 'restore-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return manifest;
  });
}

module.exports = { createSnapshot, verifySnapshot, restoreSnapshot };

if (require.main === module) {
  const [command, source, destination, ...extra] = process.argv.slice(2);
  const valid = !extra.length && source && (command === 'verify' ? !destination
    : ['backup', 'restore'].includes(command) && destination);
  if (!valid) {
    console.error('Usage: node data-snapshot.js backup DATA_DIR NEW_SNAPSHOT_DIR\n'
      + '       node data-snapshot.js verify SNAPSHOT_DIR\n'
      + '       node data-snapshot.js restore SNAPSHOT_DIR NEW_DATA_DIR');
    process.exitCode = 1;
  } else {
    const run = command === 'backup' ? createSnapshot : command === 'restore' ? restoreSnapshot : verifySnapshot;
    run(source, destination).then(manifest => console.log(`${command}: verified ${manifest.files.length} snapshot files.`))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
