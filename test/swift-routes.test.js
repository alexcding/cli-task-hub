const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('generated Swift routes match the shared route contract', () => {
  execFileSync(process.execPath, [path.join(__dirname, '../scripts/gen-swift-routes.mjs'), '--check']);
});
