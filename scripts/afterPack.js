// electron-builder afterPack hook — ad-hoc sign the assembled .app before the
// DMG is built. electron-builder skips signing (identity: null), leaving only
// the linker's stub signature, which is invalid for arm64 (no sealed
// resources). Re-sign the whole bundle ad-hoc here, while the .app still lives
// on disk, so the signature is sealed into the copy that goes into the DMG.

const { execSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  // macOS-only step.
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  console.log(`\n── Ad-hoc signing ${appName}`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
  execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'inherit' });
};
