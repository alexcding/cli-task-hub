// Start only the packaged Express app (no pollers/hooks) and verify its web assets.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const assert = require('node:assert/strict');

async function main() {
  const app = path.resolve(process.argv[2]);
  const entry = path.join(app, 'Contents/Resources/backend/src/server/app.js');
  const helper = path.join(app, 'Contents/Helpers/taskhub-node');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-assets-smoke-'));
  const source = `const {app}=require(process.argv[1]);
    const server=app.listen(0,'127.0.0.1',()=>console.log('ASSET_ORIGIN=http://127.0.0.1:'+server.address().port));
    process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});`;
  const child = spawn(helper, ['-e', source, entry], { env: { ...process.env, TASKHUB_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', diagnostics = '';
  child.stderr.on('data', data => { diagnostics += data; });
  try {
    const origin = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Packaged backend timed out: ${diagnostics}`)), 10000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Packaged backend exited ${code}: ${diagnostics}`)); });
      child.stdout.on('data', data => {
        output += data;
        const match = output.match(/ASSET_ORIGIN=(http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    const assets = fs.readFileSync(path.join(__dirname, '../web-assets.txt'), 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#'));
    for (const asset of [...assets, 'shared/routes.mjs', 'shared/constants.mjs', 'shared/jql.mjs']) {
      const response = await fetch(`${origin}/${asset}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200, `${asset}: ${response.status}`);
      assert.ok((await response.text()).length > 0, `${asset} is empty`);
    }
    assert.equal((await fetch(`${origin}/app.js`)).status, 404, 'Full SPA must not be in the native bundle');
    console.log(`Packaged backend served ${assets.length + 3} focused web assets; full SPA absent.`);
  } finally {
    if (child.pid && child.exitCode == null && child.signalCode == null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
