const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('native web asset manifest includes the complete focused-board dependency graph', () => {
  const root = path.join(__dirname, '..');
  const renderer = path.join(root, 'src/renderer');
  const assets = new Set(fs.readFileSync(path.join(root, 'macos/web-assets.txt'), 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#')));
  assert.ok(assets.has('native/board.html'));
  for (const asset of assets) {
    assert.ok(!asset.startsWith('/') && !asset.split('/').includes('..'), asset);
    const source = fs.readFileSync(path.join(renderer, asset), 'utf8');
    const references = asset.endsWith('.js') && !asset.startsWith('vendor/')
      ? [...source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)].map(match => match[1])
      : asset.endsWith('.html') ? [...source.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]) : [];
    for (const reference of references) {
      if (reference.startsWith('/shared/')) {
        assert.ok(fs.existsSync(path.join(root, 'src', reference)), reference);
      } else {
        const resolved = reference.startsWith('/') ? reference.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(asset), reference));
        assert.ok(assets.has(resolved), `${asset} requires missing bundled asset ${resolved}`);
      }
    }
  }
  for (const forbidden of ['app.js', 'index.html', 'components/terminal.js', 'components/viewer.js']) {
    assert.ok(!assets.has(forbidden), `The focused board must not bootstrap ${forbidden}`);
  }
});
