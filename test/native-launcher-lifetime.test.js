const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

test('packaged launcher retains data ownership after startup and garbage collection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-launcher-lifetime-'));
  const backend = path.join(root, 'backend'), data = path.join(root, 'data');
  fs.mkdirSync(data);
  let owner;
  try {
    for (const name of ['native-launcher.js', 'database/native-checkpoint.js', 'database/data-snapshot.js']) {
      const target = path.join(backend, 'src/server', name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '../src/server', name), target);
    }
    fs.writeFileSync(path.join(backend, 'release.json'), JSON.stringify({ format: 1, id: 'a'.repeat(64) }));
    fs.writeFileSync(path.join(backend, 'src/server/app.js'), `
      let timer, count = 0;
      module.exports = { start() {
        timer = setInterval(() => {
          global.gc();
          if (++count === 5) require('node:fs').writeFileSync(require('node:path').join(process.env.TASKHUB_DATA_DIR, 'collected'), 'yes');
        }, 20);
      }, stop() { clearInterval(timer); } };`);
    owner = spawn(process.execPath, ['--expose-gc', path.join(backend, 'src/server/native-launcher.js')],
      { env: { ...process.env, TASKHUB_DATA_DIR: data }, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; owner.stderr.on('data', bytes => { errors += bytes; });
    for (let attempt = 0; attempt < 200 && !fs.existsSync(path.join(data, 'collected')); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(path.join(data, 'collected')), true, errors);
    const contender = spawnSync(process.execPath, ['-e',
      'require(process.argv[1]).acquireNativeDataLock(process.argv[2]).release()',
      path.resolve(__dirname, '../src/server/database/native-checkpoint.js'), data], { encoding: 'utf8', timeout: 5000 });
    assert.notEqual(contender.status, 0, 'A running native backend lost its ownership lock after GC');
    assert.match(contender.stderr, /checkpoint ownership|database is locked/);
  } finally {
    if (owner && owner.exitCode === null && owner.signalCode === null) {
      const exited = once(owner, 'exit'); owner.kill('SIGTERM'); await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
