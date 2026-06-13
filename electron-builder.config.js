// electron-builder configuration.
//
// Signing is env-driven so the same config serves two very different builds:
//
//   • Local / dev (default)  — ad-hoc signed, no Apple account needed. Fast
//     iteration via ./build.sh and `npm run build`. These builds CANNOT
//     auto-update (Squirrel.Mac rejects ad-hoc signatures), which is fine.
//
//   • Release (TASKHUB_RELEASE=1) — real Developer ID signing + notarization +
//     hardened runtime, the combination macOS requires for silent auto-update.
//     Driven by `npm run release`. Notarization uses an App Store Connect API
//     key, supplied entirely via env so nothing secret lives in this repo:
//        APPLE_API_KEY        path to the AuthKey_XXXXXX.p8 (kept on the runner)
//        APPLE_API_KEY_ID     the key ID
//        APPLE_API_ISSUER     the issuer UUID
//     plus a "Developer ID Application" cert in the login keychain (or CSC_LINK
//     / CSC_KEY_PASSWORD pointing at a .p12).
//
//     Falls back to the Apple-ID method (APPLE_TEAM_ID + APPLE_ID +
//     APPLE_APP_SPECIFIC_PASSWORD) when no API key is present.
//
// Squirrel.Mac auto-update requires BOTH dmg and zip targets; latest-mac.yml
// (the update manifest) is generated from the zip and uploaded by --publish.

const releasing = process.env.TASKHUB_RELEASE === '1';

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'tv.accedo.taskhub',
  productName: 'TaskHub',
  copyright: 'Copyright © 2025 Accedo',
  afterPack: 'scripts/afterPack.js',
  npmRebuild: false,
  publish: {
    provider: 'github',
    owner: 'alexcding',
    repo: 'cli-task-hub',
    // Publish immediately (not as a draft) so electron-updater clients pick it
    // up — a draft release is invisible to the auto-updater. The release branch
    // is the gate; landing on it ships to users.
    releaseType: 'release',
  },
  files: [
    'src/**',
    'node_modules/**',
    '!node_modules/.cache/**',
    '!**/*.md',
    '!**/*.map',
  ],
  asarUnpack: ['**/node_modules/*node-pty*/**'],
  extraResources: [
    { from: 'build', to: '.', filter: ['tray-jira.png'] },
  ],
  mac: {
    category: 'public.app-category.productivity',
    icon: 'build/icon.icns',
    // Both targets: dmg for distribution, zip for Squirrel.Mac auto-update.
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    ...(releasing
      ? {
          // Real distribution build: Developer ID + hardened runtime + notarize.
          hardenedRuntime: true,
          gatekeeperAssess: false,
          entitlements: 'build/entitlements.mac.plist',
          entitlementsInherit: 'build/entitlements.mac.plist',
          // App Store Connect API key (env-driven) when available; else the
          // legacy Apple-ID method. Both read their secrets from the env — see
          // the header comment.
          notarize: process.env.APPLE_API_KEY_ID
            ? true
            : { teamId: process.env.APPLE_TEAM_ID },
        }
      : {
          // Local build: ad-hoc signed by scripts/afterPack.js (identity: null
          // tells electron-builder to skip its own signing step).
          hardenedRuntime: false,
          gatekeeperAssess: false,
          identity: null,
        }),
  },
  dmg: {
    title: '${productName} ${version}',
    contents: [
      { x: 130, y: 180 },
      { x: 410, y: 180, type: 'link', path: '/Applications' },
    ],
  },
};
