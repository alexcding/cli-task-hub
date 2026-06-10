// Review-request notifications. Notify (and play a system sound) when a PR newly needs
// your review. GitHub drops you from a PR's reviewRequests the moment you submit a
// review, so a PR that LEAVES the review set and later RE-ENTERS it is a genuine
// re-request. That single absent→present transition covers both the first request and
// any re-request — so we just diff the current review set against last cycle and act
// on whatever newly entered it.
const { Notification, shell } = require('electron');
const { execFile } = require('child_process');
const { openLinkInApp } = require('./window');

let reviewSeeded = false;        // first sync seeds silently — don't notify for reviews
                                 // already pending when the app launches
const knownReviews = new Set();  // PR keys requesting my review as of last cycle
// PR keys you've CLICKED in "Review requested" — hidden from that list afterward, until
// GitHub re-requests your review (the key re-enters the review set as 'fresh'; see below).
// In-memory: a fresh app launch re-surfaces all current requests.
const acknowledgedReviews = new Set();

const prKey = pr => `${pr.repo}#${pr.number}`;

// Play a macOS system sound to announce a newly-requested review (replaces the old
// menu-bar blink). Best-effort: afplay is macOS-only; fall back to the system beep.
function playReviewSound() {
  if (process.platform === 'darwin') {
    execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], () => {});
  } else {
    shell.beep();
  }
}

// Native notification; clicking it opens that PR in the dashboard.
function notifyReviewRequested(pr) {
  if (!Notification.isSupported()) return;
  const full = `PR #${pr.number} ${pr.title}`;
  const n = new Notification({ title: 'Review requested', body: full });
  n.on('click', () => openLinkInApp(pr.url, full, 'github'));
  n.show();
}

// Diff this cycle's review PRs against the last; notify + play a sound for any that
// just entered the set. PRs that left it (reviewed / closed / merged) just fall out.
function detectReviewChanges(reviewPRs) {
  const current = new Set(reviewPRs.map(prKey));
  const fresh = reviewPRs.filter(pr => !knownReviews.has(prKey(pr)));

  if (reviewSeeded && fresh.length) {
    for (const pr of fresh) notifyReviewRequested(pr);
    playReviewSound(); // one sound per cycle, even if several reviews arrive at once
  }

  // A (re-)requested PR must re-appear in "Review requested" even if you clicked it
  // before — so clear its acknowledgement whenever it newly (re-)enters the review set.
  for (const pr of fresh) acknowledgedReviews.delete(prKey(pr));
  // Drop acks for PRs no longer requesting review (a later re-request re-enters as
  // 'fresh' anyway), keeping the set bounded.
  for (const key of [...acknowledgedReviews]) if (!current.has(key)) acknowledgedReviews.delete(key);

  knownReviews.clear();
  for (const key of current) knownReviews.add(key);
  reviewSeeded = true;
}

module.exports = { detectReviewChanges, acknowledgedReviews, prKey };
