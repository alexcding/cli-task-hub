// Review-request notifications. Notify (and play a system sound) when a PR newly needs
// your review. "Newly" is driven by the server's durable review state, not in-memory
// guesswork: each review PR carries reviewPending (still awaiting your eyes) and
// requestedAt (when GitHub last requested you). We notify whenever a PR is pending with a
// requestedAt we haven't already announced — so both a first request and a genuine
// re-request (newer requestedAt) alert exactly once, and opening it (which bumps the
// server's viewed_at, clearing reviewPending) stops the alerts.
const { Notification, shell } = require('electron');
const { execFile } = require('child_process');
const { openLinkInApp } = require('./window');

let reviewSeeded = false;           // first sync seeds silently — don't notify for reviews
                                    // already pending when the app launches
// prKey -> the requestedAt we last notified for. In-memory: a fresh launch re-seeds
// silently, so currently-pending reviews don't re-alert on restart (the menu still shows
// them — that list is driven by the server's persisted viewed_at, not this map).
const notifiedAt = new Map();

const prKey = pr => `${pr.repo}#${pr.number}`;
// Stable marker for "this exact request": its timestamp, or a constant when the server
// couldn't supply one (still pending, just not re-notified on every cycle).
const reqMarker = pr => pr.requestedAt || 'pending';

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

// Notify + play a sound for any PR that is pending review with a request we haven't
// announced yet. `reviewPRs` is the tray snapshot's review-category PRs (each with
// reviewPending / requestedAt attached by the server).
function detectReviewChanges(reviewPRs) {
  const pending = reviewPRs.filter(pr => pr.reviewPending);
  const fresh = pending.filter(pr => notifiedAt.get(prKey(pr)) !== reqMarker(pr));

  if (reviewSeeded && fresh.length) {
    for (const pr of fresh) notifyReviewRequested(pr);
    playReviewSound(); // one sound per cycle, even if several reviews arrive at once
  }

  // Remember what we've announced for every pending PR; forget PRs no longer pending
  // (opened / reviewed / closed) so a later re-request re-alerts and the map stays bounded.
  const current = new Set(pending.map(prKey));
  for (const pr of pending) notifiedAt.set(prKey(pr), reqMarker(pr));
  for (const key of [...notifiedAt.keys()]) if (!current.has(key)) notifiedAt.delete(key);
  reviewSeeded = true;
}

module.exports = { detectReviewChanges, prKey };
