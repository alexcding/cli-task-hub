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
  function run(args) {
    const result = spawnSync(node, args, { cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, TASKHUB_DATA_DIR: path.join(root, 'must-not-open') } });
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
} finally { fs.rmSync(root, { recursive: true, force: true }); }
