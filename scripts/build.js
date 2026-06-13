#!/usr/bin/env node
// TaskHub build script — generates icons then runs electron-builder

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

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

// ── 2. Build ──────────────────────────────────────────────────────────────────
// Produces a DMG (shareable image) + ZIP (Squirrel.Mac auto-update) + the
// unpacked .app in dist/mac-arm64/.
//
//   default      → ad-hoc signed local build (no Apple account). Signed by
//                  scripts/afterPack.js. CANNOT auto-update — for local testing.
//   --publish    → real release: Developer ID signing + notarization (so
//                  auto-update works) and upload to GitHub Releases.
const publish = process.argv.includes('--publish');

let buildCmd = 'npx electron-builder --mac --arm64';

if (publish) {
  // Real signing/notarization needs Apple credentials. Accept either auth
  // method and fail early with a clear message rather than deep inside
  // electron-builder. (Signing also needs a Developer ID cert in the keychain.)
  const haveApiKey = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].every((k) => process.env[k]);
  const havePassword = ['APPLE_TEAM_ID', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD'].every((k) => process.env[k]);
  if (!haveApiKey && !havePassword) {
    console.error('\n\x1b[31m✗ Missing Apple credentials for a signed release.\x1b[0m');
    console.error('  Provide ONE of these sets via the environment:');
    console.error('    • API key:  APPLE_API_KEY (path to .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER');
    console.error('    • Apple ID: APPLE_TEAM_ID, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD');
    console.error('  Plus a "Developer ID Application" cert in the keychain. See electron-builder.config.js.');
    process.exit(1);
  }

  // electron-builder reads GH_TOKEN to push to GitHub Releases. In CI the token
  // is provided directly (GH_TOKEN / GITHUB_TOKEN); locally, fall back to the
  // gh CLI so we don't depend on a separately-exported env var.
  let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    step('Resolving GitHub token from gh CLI');
    try {
      token = execSync('gh auth token', { cwd: ROOT }).toString().trim();
    } catch {
      console.error('\n\x1b[31m✗ Could not get a token from `gh auth token`.\x1b[0m');
      console.error('  Run `gh auth login` (or set GH_TOKEN) and retry.');
      process.exit(1);
    }
  }
  process.env.GH_TOKEN = token;
  // Switches electron-builder.config.js to the signed/notarized/hardened path.
  process.env.TASKHUB_RELEASE = '1';
  // --publish always → upload artifacts (incl. latest-mac.yml); electron-builder
  // creates a draft release tagged v<version> on first run for that version.
  buildCmd += ' --publish always';
  step('Building + publishing TaskHub (signed + notarized, arm64) to GitHub Releases');
} else {
  // Ad-hoc local build — skip identity auto-discovery so it doesn't try to sign
  // with a real cert; scripts/afterPack.js handles the ad-hoc signature.
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  // --publish never: on CI electron-builder otherwise defaults to trying to
  // publish (because a publish config exists) and fails demanding a GH_TOKEN.
  // The ad-hoc build is verification-only and must never upload.
  buildCmd += ' --publish never';
  step('Building TaskHub DMG (arm64, ad-hoc — no auto-update)');
}

run(buildCmd);

const distDir = path.join(ROOT, 'dist');
const appDir = path.join(distDir, 'mac-arm64', 'TaskHub.app');

// ── 3. Done ───────────────────────────────────────────────────────────────────
console.log('\n\x1b[32m✓ Build complete\x1b[0m');
console.log(`  ${path.relative(ROOT, appDir)}`);
const dmgName = `${pkg.productName}-${pkg.version}-arm64.dmg`;
console.log(`  ${path.join('dist', dmgName)}`);
if (publish) {
  console.log(`\n  Published GitHub release v${pkg.version} — auto-updater clients will pick it up:`);
  console.log('  https://github.com/alexcding/cli-task-hub/releases');
}
