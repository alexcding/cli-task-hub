const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { acquireNativeDataLock, prepareNativeData } = require('../src/server/database/native-checkpoint');
const { restoreSnapshot } = require('../src/server/database/data-snapshot');
const { launchNativeBackend } = require('../src/server/native-launcher');
const A = 'a'.repeat(64), B = 'b'.repeat(64);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-checkpoint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  return { root, data, backups: path.join(data, 'native-backups') };
}
function mutate(data, sql) {
  const db = new DatabaseSync(path.join(data, 'taskhub.db'));
  try { db.exec(sql); } finally { db.close(); }
}
function current(backups) { return JSON.parse(fs.readFileSync(path.join(backups, 'last-launch.json'))); }
function snapshots(backups) { return fs.readdirSync(backups).filter(name => name.startsWith('checkpoint-')); }
async function prepare(data, id) {
  const lock = acquireNativeDataLock(data);
  try { return await prepareNativeData(data, id, lock); } finally { lock.release(); }
}

test('fresh native installation records its release without making an empty backup; repeated launch is stable', async t => {
  const { data, backups } = fixture(t);
  assert.deepEqual(await prepare(data, A), { kind: 'fresh', snapshot: null });
  mutate(data, 'CREATE TABLE fixture (value TEXT)');
  assert.deepEqual(await prepare(data, A), { kind: 'unchanged', snapshot: null });
  assert.deepEqual(snapshots(backups), []);
  assert.equal(current(backups).releaseID, A);
});

test('existing data is checkpointed before application schema code, with separate checkpoints for upgrades and rollback', async t => {
  const { root, data, backups } = fixture(t);
  mutate(data, "CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('before A')");
  let loaded = 0;
  const running = await launchNativeBackend({ dataDirectory: data, releaseID: A, loadApplication: () => {
    loaded++;
    assert.equal(snapshots(backups).length, 1);
    assert.equal(current(backups).releaseID, A);
    // This is a deliberately destructive fixture schema change. The snapshot
    // must precede even loading the module which performs it.
    mutate(data, "UPDATE fixture SET value = 'after A'");
    return { start() {}, stop() {} };
  } });
  running.release(); assert.equal(loaded, 1);
  const first = current(backups).snapshot;
  await prepare(data, A); assert.equal(snapshots(backups).length, 1);
  await prepare(data, B); assert.equal(snapshots(backups).length, 2);
  const second = current(backups).snapshot;
  mutate(data, "UPDATE fixture SET value = 'after B'");
  await prepare(data, A); assert.equal(snapshots(backups).length, 3);
  assert.notEqual(current(backups).snapshot, first);
  for (const [snapshot, expected] of [[first, 'before A'], [second, 'after A']]) {
    const restored = path.join(root, snapshot);
    await restoreSnapshot(path.join(backups, snapshot), restored);
    const db = new DatabaseSync(path.join(restored, 'taskhub.db'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT value FROM fixture').get().value, expected); } finally { db.close(); }
  }
});

test('failed and damaged checkpoints prevent application loading and preserve earlier rollback data', async t => {
  const { data, backups } = fixture(t);
  mutate(data, 'CREATE TABLE fixture (value TEXT)');
  const local = path.join(data, 'ptyd-native-spike'); fs.mkdirSync(local);
  fs.writeFileSync(path.join(local, 'page-tabs.json'), '{broken');
  let loaded = false;
  const launch = () => launchNativeBackend({ dataDirectory: data, releaseID: A,
    loadApplication: () => { loaded = true; throw new Error('must not load'); } });
  await assert.rejects(launch(), /incomplete output/);
  assert.equal(loaded, false);
  assert.equal(fs.existsSync(path.join(backups, 'last-launch.json')), false);
  fs.writeFileSync(path.join(local, 'page-tabs.json'), '{}');
  await prepare(data, A);
  const record = current(backups), count = snapshots(backups).length;
  fs.appendFileSync(path.join(backups, record.snapshot, 'taskhub.db'), 'corrupted');
  await assert.rejects(launch(), /checksum mismatch/);
  assert.equal(loaded, false);
  assert.deepEqual(current(backups), record);
  assert.equal(snapshots(backups).length, count);
});

test('native data ownership rejects another process and recovers after the owner is killed without deleting lock files', async t => {
  const { data, backups } = fixture(t);
  const modulePath = path.resolve(__dirname, '../src/server/database/native-checkpoint.js');
  const script = `const lock = require(process.argv[1]).acquireNativeDataLock(process.argv[2]);
    console.log('owned'); if (process.argv[3] === 'hold') setInterval(() => {}, 1000); else lock.release();`;
  const first = acquireNativeDataLock(data);
  try {
    const blocked = spawnSync(process.execPath, ['-e', script, modulePath, data], { encoding: 'utf8', timeout: 10000 });
    assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /checkpoint ownership|database is locked/);
  } finally { first.release(); }
  const owner = spawn(process.execPath, ['-e', script, modulePath, data, 'hold'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); });
  let output = '';
  owner.stdout.on('data', bytes => { output += bytes; });
  for (let attempt = 0; attempt < 200 && !output.includes('owned'); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(output, /owned/);
  assert.throws(() => acquireNativeDataLock(data), /checkpoint ownership|database is locked/);
  const inode = fs.statSync(path.join(backups, 'owner.db')).ino;
  const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited;
  const replacement = acquireNativeDataLock(data); replacement.release();
  assert.equal(fs.statSync(path.join(backups, 'owner.db')).ino, inode);
});

test('invalid release/state and a symlinked checkpoint directory fail before loading application code', async t => {
  const { root, data, backups } = fixture(t);
  await assert.rejects(prepare(data, '../escape'), /release identity/);
  fs.writeFileSync(path.join(backups, 'last-launch.json'), JSON.stringify({ format: 1, releaseID: A, snapshot: '../escape' }));
  await assert.rejects(prepare(data, A), /Invalid native checkpoint state/);
  fs.unlinkSync(path.join(backups, 'last-launch.json'));
  mutate(data, 'CREATE TABLE fixture (value TEXT)'); await prepare(data, A);
  const record = current(backups), target = path.join(backups, record.snapshot), outside = path.join(root, 'outside');
  fs.renameSync(target, outside); fs.symlinkSync(outside, target);
  await assert.rejects(prepare(data, A), /symlink/);
});
