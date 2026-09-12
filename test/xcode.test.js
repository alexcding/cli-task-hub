// routes/xcode.js pure helpers: how a simctl runtime key becomes a menu heading, and which
// xcodebuild flag a resolved launch target takes. The routes themselves shell out to the Xcode
// toolchain, which CI needn't have.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRuntime, targetArgs } = require('../src/server/routes/xcode');

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
