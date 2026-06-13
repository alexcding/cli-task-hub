// Unit tests for github.awaitingReview — the dashboard "Review Requested" predicate.
// It must keep a PR I'm mid-review on (commented, no verdict) even after GitHub drops me
// from reviewRequests, while staying independent of categoryOf (which drives the tray).
const { test } = require('node:test');
const assert = require('node:assert');
const { awaitingReview, categoryOf } = require('../src/server/repositories/github');

const ME = 'alexcding';
const base = { author: { login: 'someoneElse' }, isDraft: false, reviewRequests: [], latestReviews: [] };

test('awaitingReview: requested reviewer on a non-draft PR I did not author', () => {
  const pr = { ...base, reviewRequests: [{ login: ME }] };
  assert.equal(awaitingReview(pr, ME), true);
});

test('awaitingReview: I commented but am no longer requested → still awaiting (the #179 case)', () => {
  // GitHub removed me from reviewRequests when I submitted the comment review.
  const pr = { ...base, reviewRequests: [], latestReviews: [{ author: { login: ME }, state: 'COMMENTED' }] };
  assert.equal(awaitingReview(pr, ME), true);
  assert.equal(categoryOf(pr, ME), 'other'); // category stays 'other' → tray unaffected
});

test('awaitingReview: kept for any review state while open — incl. approved-but-unmerged', () => {
  for (const state of ['PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']) {
    const pr = { ...base, latestReviews: [{ author: { login: ME }, state }] };
    assert.equal(awaitingReview(pr, ME), true, `review state ${state} should keep it`);
  }
});

test('awaitingReview: never for my own PRs, drafts, or others-only reviews', () => {
  assert.equal(awaitingReview({ ...base, author: { login: ME }, reviewRequests: [{ login: ME }] }, ME), false);
  assert.equal(awaitingReview({ ...base, isDraft: true, reviewRequests: [{ login: ME }] }, ME), false);
  assert.equal(awaitingReview({ ...base, latestReviews: [{ author: { login: 'bob' }, state: 'COMMENTED' }] }, ME), false);
  assert.equal(awaitingReview(base, null), false); // not authenticated
});
