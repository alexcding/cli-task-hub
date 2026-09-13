const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createSnapshot, verifySnapshot, restoreSnapshot } = require('../src/server/database/data-snapshot');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-snapshot-'));
  const databases = [];
  t.snapshotDatabases = databases;
  t.after(() => {
    for (const database of databases) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  return { root, source, snapshot: path.join(root, 'snapshot'), restored: path.join(root, 'restored') };
}
function openFixture(t, file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE durable (key TEXT PRIMARY KEY, value TEXT)');
  t.snapshotDatabases.push(db);
  return db;
}
function value(file, key) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT value FROM durable WHERE key = ?').get(key)?.value; }
  finally { db.close(); }
}
function manifest(snapshot, mutate) {
  const file = path.join(snapshot, 'manifest.json');
  const result = JSON.parse(fs.readFileSync(file));
  mutate(result);
  fs.writeFileSync(file, JSON.stringify(result));
}

test('snapshot captures committed WAL state, pending native pages and logs without opening application migrations', async t => {
  const { source, snapshot, restored } = fixture(t);
  const db = openFixture(t, path.join(source, 'taskhub.db'));
  db.prepare('INSERT INTO durable VALUES (?, ?)').run('session', '日本語 🦀');
  // Unknown schema and columns must survive byte-preserving SQLite backup.
  db.exec("CREATE TABLE tasks (url TEXT PRIMARY KEY, historical_column TEXT); INSERT INTO tasks VALUES ('fixture', 'keep for rollback')");
  const logs = openFixture(t, path.join(source, 'logs.db'));
  logs.prepare('INSERT INTO durable VALUES (?, ?)').run('activity', 'old event');
  const local = path.join(source, 'ptyd-native-spike'); fs.mkdirSync(local);
  const pages = JSON.stringify({ snapshots: { fixture: { title: 'unsynced page' } }, pending: ['fixture'] });
  fs.writeFileSync(path.join(local, 'page-tabs.json'), pages);
  fs.writeFileSync(path.join(source, 'data.db'), 'regenerable cache, not a SQLite fixture');
  fs.mkdirSync(path.join(local, 'terms')); fs.writeFileSync(path.join(local, 'terms', 'live.json'), 'live process metadata');
  assert.ok(fs.statSync(path.join(source, 'taskhub.db-wal')).size > 0);
  // A raw main-file copy would miss the committed WAL rows.
  const raw = path.join(source, 'raw.db'); fs.copyFileSync(path.join(source, 'taskhub.db'), raw);
  assert.throws(() => value(raw, 'session'), /no such table/);
  const captured = await createSnapshot(source, snapshot);
  assert.deepEqual(captured.files.map(file => file.path), ['taskhub.db', 'logs.db', 'ptyd-native-spike/page-tabs.json']);
  db.prepare('UPDATE durable SET value = ? WHERE key = ?').run('after snapshot', 'session');
  await verifySnapshot(snapshot);
  await restoreSnapshot(snapshot, restored);
  assert.equal(value(path.join(restored, 'taskhub.db'), 'session'), '日本語 🦀');
  assert.equal(value(path.join(source, 'taskhub.db'), 'session'), 'after snapshot');
  assert.equal(value(path.join(restored, 'logs.db'), 'activity'), 'old event');
  assert.equal(fs.readFileSync(path.join(restored, 'ptyd-native-spike/page-tabs.json'), 'utf8'), pages);
  assert.equal(fs.existsSync(path.join(restored, 'data.db')), false);
  assert.equal(fs.existsSync(path.join(restored, 'ptyd-native-spike/terms')), false);
  assert.equal(fs.existsSync(path.join(restored, 'taskhub.db-wal')), false);
  assert.equal(fs.statSync(restored).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(restored, 'taskhub.db')).mode & 0o777, 0o600);
  const old = new DatabaseSync(path.join(restored, 'taskhub.db'));
  try { assert.equal(old.prepare('SELECT historical_column FROM tasks').get().historical_column, 'keep for rollback'); }
  finally { old.close(); }
});

test('snapshot preserves a legacy config.db name and rejects every existing destination', async t => {
  const { source, snapshot, restored } = fixture(t);
  const db = openFixture(t, path.join(source, 'config.db'));
  db.prepare('INSERT INTO durable VALUES (?, ?)').run('old-version', 'legacy');
  const result = await createSnapshot(source, snapshot);
  assert.equal(result.files[0].path, 'config.db');
  await assert.rejects(createSnapshot(source, snapshot), { code: 'EEXIST' });
  fs.mkdirSync(restored); fs.writeFileSync(path.join(restored, 'sentinel'), 'existing installation');
  await assert.rejects(restoreSnapshot(snapshot, restored), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(path.join(restored, 'sentinel'), 'utf8'), 'existing installation');
  assert.equal(fs.existsSync(path.join(restored, 'config.db')), false);
  assert.equal(fs.existsSync(path.join(source, 'taskhub.db')), false);
});

test('restore rejects corruption, unverified sidecars, traversal and unsupported formats before creating output', async t => {
  const { source, snapshot, restored } = fixture(t);
  openFixture(t, path.join(source, 'taskhub.db'));
  await createSnapshot(source, snapshot);
  const originalManifest = fs.readFileSync(path.join(snapshot, 'manifest.json'));
  const database = path.join(snapshot, 'taskhub.db'), originalDB = fs.readFileSync(database);
  fs.appendFileSync(database, 'corrupt');
  await assert.rejects(restoreSnapshot(snapshot, restored), /checksum mismatch/);
  assert.equal(fs.existsSync(restored), false);
  fs.writeFileSync(database, originalDB);
  fs.writeFileSync(database + '-wal', 'unverified');
  await assert.rejects(restoreSnapshot(snapshot, restored), /sidecars/);
  fs.unlinkSync(database + '-wal');
  for (const change of [m => { m.files[0].path = '../outside.db'; }, m => { m.format = 999; },
    m => { m.files.push(m.files[0]); }, m => { m.files = []; }]) {
    fs.writeFileSync(path.join(snapshot, 'manifest.json'), originalManifest);
    manifest(snapshot, change);
    await assert.rejects(restoreSnapshot(snapshot, restored));
    assert.equal(fs.existsSync(restored), false);
  }
  fs.writeFileSync(path.join(snapshot, 'manifest.json'), originalManifest);
  // Even a recomputed checksum cannot turn a non-SQLite file into a valid backup.
  fs.writeFileSync(database, 'not sqlite');
  manifest(snapshot, m => {
    m.files[0].size = 10; m.files[0].sha256 = createHash('sha256').update('not sqlite').digest('hex');
  });
  await assert.rejects(restoreSnapshot(snapshot, restored), /database|SQLite/);
  assert.equal(fs.existsSync(restored), false);
});

test('symlink inputs and incomplete snapshots fail closed', async t => {
  const { root, source, snapshot, restored } = fixture(t);
  const database = path.join(root, 'outside.db'); openFixture(t, database);
  fs.symlinkSync(database, path.join(source, 'taskhub.db'));
  await assert.rejects(createSnapshot(source, snapshot), /symlinks/);
  assert.equal(fs.existsSync(snapshot), false);
  fs.unlinkSync(path.join(source, 'taskhub.db'));
  openFixture(t, path.join(source, 'taskhub.db'));
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'page-tabs.json'), '{}');
  fs.symlinkSync(outside, path.join(source, 'ptyd-native-spike'));
  await assert.rejects(createSnapshot(source, snapshot), /symlinks/);
  fs.unlinkSync(path.join(source, 'ptyd-native-spike'));
  await createSnapshot(source, snapshot);
  fs.unlinkSync(path.join(snapshot, 'taskhub.db')); fs.symlinkSync(database, path.join(snapshot, 'taskhub.db'));
  await assert.rejects(restoreSnapshot(snapshot, restored), /symlinks/);
  fs.unlinkSync(path.join(snapshot, 'manifest.json'));
  await assert.rejects(restoreSnapshot(snapshot, restored), /ENOENT/);
  assert.equal(fs.existsSync(restored), false);
});

test('restored current data can reopen through the backend without losing durable domain state', async t => {
  const { source, snapshot, restored } = fixture(t);
  const script = `
    const db = require('./src/server/database/db');
    const config = require('./src/server/database/configdb');
    if (process.argv[1] === 'seed') {
      const project = db.addProject({ id: 'snapshot-project', name: 'Fixture', repo: 'fixture/repo', workspace: '/fixture' });
      db.updateProject(project.id, { workflows: [{ id: 'workflow', name: 'Review', cli: 'codex', commands: ['/check'] }] });
      config.upsertTask({ id: 'snapshot-session', projectId: project.id, workspace: '/fixture', worktree: '/fixture/worktree', sessionId: 'conversation', pinned: true });
      config.setTabs([{ url: 'https://example.invalid/pr/1', kind: 'github', links: [{ kind: 'file', path: '/fixture/File.swift' }] }]);
      config.setSetting('native.context.task:snapshot-session', '{"activeID":"editor"}');
      db.setReviewRequestedAt('fixture/repo#1', '2026-01-01'); db.setReviewViewed('fixture/repo#1', '2026-01-02');
      db.set('poll_interval', '90'); db.addEvent('snapshot-fixture', { id: 'event' });
    }
    console.log(JSON.stringify({ projects: db.getProjects(), tasks: config.getTasks(), tabs: config.getTabs(), settings: config.getAllSettings(), review: db.getReviewState('fixture/repo#1'), config: db.getConfig(), events: db.getEvents() }));
  `;
  function run(directory, mode) {
    const result = spawnSync(process.execPath, ['-e', script, mode], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, TASKHUB_DATA_DIR: directory }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  }
  const expected = run(source, 'seed');
  await createSnapshot(source, snapshot);
  await restoreSnapshot(snapshot, restored);
  assert.deepEqual(run(restored, 'read'), expected);
  assert.deepEqual(run(source, 'read'), expected);
});

test('standalone recovery commands validate arguments and restore without starting the application', async t => {
  const { root, source, snapshot, restored } = fixture(t);
  const file = path.join(source, 'taskhub.db');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE durable (key TEXT PRIMARY KEY, value TEXT); INSERT INTO durable VALUES ('fixture', 'retained')");
  db.close();
  const script = path.join(__dirname, '../src/server/database/data-snapshot.js');
  function run(args) {
    return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, TASKHUB_DATA_DIR: path.join(root, 'must-not-open') } });
  }
  assert.equal(run([]).status, 1);
  assert.equal(run(['restore', snapshot]).status, 1);
  for (const args of [['backup', source, snapshot], ['verify', snapshot], ['restore', snapshot, restored]]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /verified 1 snapshot files/);
    assert.equal(result.stdout.includes('retained'), false);
  }
  assert.equal(value(path.join(restored, 'taskhub.db'), 'fixture'), 'retained');
  assert.equal(fs.existsSync(path.join(root, 'must-not-open')), false);
});

test('backup refuses a symlinked SQLite sidecar and leaves no completed manifest', async t => {
  const { root, source, snapshot } = fixture(t);
  const file = path.join(source, 'taskhub.db'), db = new DatabaseSync(file);
  db.exec('CREATE TABLE fixture (value TEXT)'); db.close();
  const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'must not be touched');
  fs.symlinkSync(outside, file + '-wal');
  await assert.rejects(createSnapshot(source, snapshot), /symlinks/);
  assert.equal(fs.existsSync(path.join(snapshot, 'manifest.json')), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'must not be touched');
});
