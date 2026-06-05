#!/usr/bin/env node
// TaskHub build script — generates icons then runs electron-builder

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function run(cmd, opts = {}) {
  console.log(`\n› ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function step(msg) {
  console.log(`\n\x1b[36m── ${msg}\x1b[0m`);
}

// ── 1. Icons ──────────────────────────────────────────────────────────────────
step('Generating icons');

if (!fs.existsSync(path.join(ROOT, 'build', 'icon.icns'))) {
  run('node scripts/gen-icon.js');

  const ICONSET = path.join(ROOT, 'build', 'icon.iconset');
  const SRC = path.join(ROOT, 'build', 'icon.png');
  fs.mkdirSync(ICONSET, { recursive: true });

  for (const size of [16, 32, 64, 128, 256, 512]) {
    run(`sips -z ${size} ${size} "${SRC}" --out "${ICONSET}/icon_${size}x${size}.png"`);
    run(`sips -z ${size * 2} ${size * 2} "${SRC}" --out "${ICONSET}/icon_${size}x${size}@2x.png"`);
  }

  run(`iconutil -c icns "${ICONSET}" -o "${path.join(ROOT, 'build', 'icon.icns')}"`);
  console.log('icon.icns ready');
} else {
  console.log('icon.icns already exists, skipping');
}

// Tray icon — monochrome template glyph (transparent bg, auto-tinted by macOS)
run('node scripts/gen-tray-icon.js');

// ── 2. Build ──────────────────────────────────────────────────────────────────
step('Building TaskHub.app (arm64)');
// dir target → unpacked .app only, no DMG/installer. Ad-hoc sign for local use.
run('CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64');

// ── 3. Done ───────────────────────────────────────────────────────────────────
const distDir = path.join(ROOT, 'dist');
const appDir = path.join(distDir, 'mac-arm64', 'TaskHub.app');

console.log('\n\x1b[32m✓ Build complete\x1b[0m');
console.log(`  ${path.relative(ROOT, appDir)}`);

// ── 4. Run (optional) ─────────────────────────────────────────────────────────
function killPrevious() {
  step('Stopping any running TaskHub');
  // Packaged app, dev server, and anything still holding the port.
  const cmds = [
    `pkill -f "TaskHub.app/Contents/MacOS/TaskHub"`,
    `pkill -f "${ROOT}/server.js"`,
    `lsof -ti:${process.env.PORT || 3000} | xargs kill -9`,
  ];
  for (const c of cmds) {
    try { execSync(c, { stdio: 'ignore' }); } catch { /* nothing to kill */ }
  }
}

if (process.argv.includes('--run')) {
  if (fs.existsSync(appDir)) {
    killPrevious();
    step('Launching TaskHub.app');
    run(`open "${appDir}"`);
  } else {
    console.log('\nApp not found at', appDir);
  }
} else {
  console.log('\nTo build and launch: npm run build:run');
}
