// routes/xcode.js pure helpers: how a simctl runtime key becomes a menu heading, and which
// xcodebuild flag a resolved launch target takes. The routes themselves shell out to the Xcode
// toolchain, which CI needn't have.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseRuntime, targetArgs, filterRunnableSchemes } = require('../src/server/routes/xcode');

test('parseRuntime: SimRuntime key → platform + dotted version', () => {
  assert.deepEqual(parseRuntime('com.apple.CoreSimulator.SimRuntime.iOS-27-0'), { platform: 'iOS', runtime: 'iOS 27.0' });
  assert.deepEqual(parseRuntime('com.apple.CoreSimulator.SimRuntime.tvOS-26-5'), { platform: 'tvOS', runtime: 'tvOS 26.5' });
  assert.deepEqual(parseRuntime('com.apple.CoreSimulator.SimRuntime.iOS-18-6-1'), { platform: 'iOS', runtime: 'iOS 18.6.1' });
  assert.deepEqual(parseRuntime('weird'), { platform: '', runtime: 'weird' });
});

test('targetArgs: workspace / project flags, nothing for a package or folder', () => {
  assert.deepEqual(targetArgs('/r/App.xcworkspace'), ['-workspace', '/r/App.xcworkspace']);
  assert.deepEqual(targetArgs('/r/App.xcodeproj/'), ['-project', '/r/App.xcodeproj/']);
  assert.deepEqual(targetArgs('/r/Package.swift'), []);
  assert.deepEqual(targetArgs('/r'), []);
});

test('filterRunnableSchemes keeps only schemes that build an app for Run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-schemes-'));
  const project = path.join(root, 'Record.xcodeproj');
  const schemes = path.join(project, 'xcshareddata', 'xcschemes');
  fs.mkdirSync(schemes, { recursive: true });
  const entry = (running, product) => `<Scheme><BuildAction><BuildActionEntries><BuildActionEntry buildForRunning="${running}"><BuildableReference BuildableName="${product}"/></BuildActionEntry></BuildActionEntries></BuildAction></Scheme>`;
  fs.writeFileSync(path.join(schemes, 'Record.xcscheme'), entry('YES', 'Record.app'));
  fs.writeFileSync(path.join(schemes, 'Record Prod.xcscheme'), entry('YES', 'Record.app'));
  fs.writeFileSync(path.join(schemes, 'RecordTests.xcscheme'), '<Scheme><BuildAction/></Scheme>');
  fs.writeFileSync(path.join(schemes, 'Library.xcscheme'), entry('YES', 'Library.framework'));
  const listed = ['Dependency', 'Library', 'Record', 'Record Prod', 'RecordTests'];
  assert.deepEqual(await filterRunnableSchemes(project, listed), ['Record', 'Record Prod']);
  assert.deepEqual(await filterRunnableSchemes(path.join(root, 'Package.swift'), listed), listed);
  fs.rmSync(root, { recursive: true, force: true });
});
