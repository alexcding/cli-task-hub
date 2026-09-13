#!/usr/bin/env node
// Exercise only copied packaged resources, with no checkout-relative imports or
// real user data. No server, poller, application UI or terminal daemon is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const app = process.argv[2];
if (!app) throw new Error('Usage: node macos/scripts/smoke-data-recovery.cjs /absolute/path/TaskHub.app');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-packaged-recovery-'));
try {
  const node = path.join(root, 'taskhub-node'), script = path.join(root, 'data-snapshot.js');
  fs.copyFileSync(path.join(app, 'Contents/Helpers/taskhub-node'), node); fs.chmodSync(node, 0o700);
  fs.copyFileSync(path.join(app, 'Contents/Resources/backend/src/server/database/data-snapshot.js'), script);
  const source = path.join(root, 'source'), snapshot = path.join(root, 'snapshot'), restored = path.join(root, 'restored');
  fs.mkdirSync(source);
  function run(args, dataDirectory = path.join(root, 'must-not-open')) {
    const result = spawnSync(node, args, { cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, TASKHUB_DATA_DIR: dataDirectory } });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout;
  }
  run(['-e', `const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec("CREATE TABLE tasks (url TEXT, historical_column TEXT); INSERT INTO tasks VALUES ('fixture', 'preserved')");
    db.close();`, path.join(source, 'taskhub.db')]);
  const hash = () => createHash('sha256').update(fs.readFileSync(path.join(source, 'taskhub.db'))).digest('hex');
  const before = hash();
  for (const args of [['backup', source, snapshot], ['verify', snapshot], ['restore', snapshot, restored]]) {
    assert.match(run([script, ...args]), /verified 1 snapshot files/);
  }
  assert.equal(run(['-e', `const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    console.log(db.prepare('SELECT historical_column FROM tasks').get().historical_column);
    db.close();`, path.join(restored, 'taskhub.db')]).trim(), 'preserved');
  assert.equal(hash(), before);
  assert.equal(fs.existsSync(path.join(root, 'must-not-open')), false);
  console.log('Packaged Node and recovery tool backed up, verified and restored an isolated legacy schema; source unchanged.');

  const backend = path.join(root, 'backend'), packagedBackend = path.join(app, 'Contents/Resources/backend');
  for (const name of ['release.json', 'src/server/native-launcher.js',
    'src/server/database/native-checkpoint.js', 'src/server/database/data-snapshot.js']) {
    const output = path.join(backend, name); fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(path.join(packagedBackend, name), output);
  }
  // Keep the packaged preflight unchanged; inject only a no-network application
  // module to prove when it is (and is not) loaded.
  fs.writeFileSync(path.join(backend, 'src/server/app.js'), `
    require('node:fs').writeFileSync(require('node:path').join(process.env.TASKHUB_DATA_DIR, 'loaded'), 'yes');
    module.exports = { start() {}, stop() {} };`);
  const launcher = path.join(backend, 'src/server/native-launcher.js'), automatic = path.join(root, 'automatic');
  fs.mkdirSync(automatic); fs.copyFileSync(path.join(source, 'taskhub.db'), path.join(automatic, 'taskhub.db'));
  assert.match(run([launcher], automatic), /checkpoint: created/);
  assert.match(run([launcher], automatic), /checkpoint: unchanged/);
  const backups = path.join(automatic, 'native-backups');
  const checkpoints = fs.readdirSync(backups).filter(name => name.startsWith('checkpoint-'));
  assert.equal(checkpoints.length, 1);
  fs.appendFileSync(path.join(backups, checkpoints[0], 'taskhub.db'), 'corrupt');
  fs.unlinkSync(path.join(automatic, 'loaded'));
  const failed = spawnSync(node, [launcher], { cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, TASKHUB_DATA_DIR: automatic } });
  assert.equal(failed.status, 1, failed.error?.message ?? failed.stderr);
  assert.match(failed.stderr, /checksum mismatch/);
  assert.equal(fs.existsSync(path.join(automatic, 'loaded')), false);
  console.log('Packaged preflight created and reused its checkpoint, then refused corrupt data before loading the fixture app.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
