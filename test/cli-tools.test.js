// Tests for the auth-error classifier in src/server/services/cli-tools.js — a CLI's auth-status
// probe can fail because it's signed out OR because it couldn't reach the service; only a clean
// non-zero exit means "signed out". Misclassifying a connectivity failure as signed-out flips a
// logged-in user to "Not signed in" the moment they go offline.
const { test } = require('node:test');
const assert = require('node:assert');
const { _isTransientAuthError: isTransient } = require('../src/server/services/cli-tools');

test('a killed/timed-out probe is transient (unknown), not signed-out', () => {
  assert.equal(isTransient({ killed: true, signal: 'SIGTERM' }), true);
  assert.equal(isTransient({ code: 'ETIMEDOUT' }), true);
});

test('connectivity failures in stderr/message read as transient', () => {
  for (const stderr of [
    'error connecting to api.github.com: dial tcp: lookup api.github.com: no such host',
    'Could not connect to the server',
    'Get "https://...": net/http: TLS handshake timeout',
    'connection refused',
    'network is unreachable',
    'context deadline exceeded',
  ]) {
    assert.equal(isTransient({ stderr }), true, stderr);
  }
});

test('an explicit signed-out result is NOT transient', () => {
  assert.equal(isTransient({ code: 1, stderr: 'You are not logged into any GitHub hosts. Run gh auth login to authenticate.' }), false);
  assert.equal(isTransient({ code: 1, stderr: 'No active session. Run `acli jira auth login`.' }), false);
});

test('a missing/empty error is not transient', () => {
  assert.equal(isTransient(null), false);
  assert.equal(isTransient({}), false);
});
