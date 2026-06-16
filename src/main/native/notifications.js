// Review-request notifications. Notify (and play a system sound) when a PR newly needs
// your review. "Newly" is driven by the server's durable review state, not in-memory
// guesswork: each review PR carries reviewPending (still awaiting your eyes) and
// requestedAt (when GitHub last requested you). We notify whenever a PR is pending with a
// requestedAt we haven't already announced — so both a first request and a genuine
// re-request (newer requestedAt) alert exactly once, and opening it (which bumps the
// server's viewed_at, clearing reviewPending) stops the alerts.
const { Notification, shell } = require('electron');
const { execFile } = require('child_process');
const { openLinkInApp, runInApp } = require('../windows/window');
const { PR_CATEGORY } = require('../../shared/constants.mjs');

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

// The reviewSound setting → a sound file: an absolute path to a chosen sound, or the
// macOS default Glass chime for null/'system'.
const soundFile = sound => (sound && sound !== 'system' ? sound : '/System/Library/Sounds/Glass.aiff');

// Play a review sound via afplay (macOS). Resolves when it finishes, REJECTS on failure
// (missing/moved file, afplay error) — the Settings preview surfaces that to the user so
// it never fails silently. On non-mac there's no afplay: beep and resolve.
function previewSound(sound) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') { shell.beep(); return resolve(); }
    execFile('afplay', [soundFile(sound)], err => (err ? reject(err) : resolve()));
  });
}

// Announce a newly-requested review: fire-and-forget — same playback as the preview, but
// never throws (falls back to the system beep on any failure: missing/moved file, non-mac).
function playReviewSound(sound) {
  previewSound(sound).catch(() => shell.beep());
}

// Native notification; clicking it opens that PR in the dashboard.
function notifyReviewRequested(pr) {
  if (!Notification.isSupported()) return;
  const full = `PR #${pr.number} ${pr.title}`;
  const n = new Notification({ title: 'Review requested', body: full });
  n.on('click', () => openLinkInApp(pr.url, full, 'github', pr.category || PR_CATEGORY.REVIEW));
  n.show();
}

// Notify + play a sound for any PR that is pending review with a request we haven't
// announced yet. `reviewPRs` is the tray snapshot's review-category PRs (each with
// reviewPending / requestedAt attached by the server).
function detectReviewChanges(reviewPRs, sound) {
  const pending = reviewPRs.filter(pr => pr.reviewPending);
  const fresh = pending.filter(pr => notifiedAt.get(prKey(pr)) !== reqMarker(pr));

  if (reviewSeeded && fresh.length) {
    for (const pr of fresh) notifyReviewRequested(pr);
    playReviewSound(sound); // one sound per cycle, even if several reviews arrive at once
  }

  // Remember what we've announced for every pending PR; forget PRs no longer pending
  // (opened / reviewed / closed) so a later re-request re-alerts and the map stays bounded.
  const current = new Set(pending.map(prKey));
  for (const pr of pending) notifiedAt.set(prKey(pr), reqMarker(pr));
  for (const key of [...notifiedAt.keys()]) if (!current.has(key)) notifiedAt.delete(key);
  reviewSeeded = true;
}

// ── Activity notifications ──────────────────────────────────────────────────────
// The tray's main-process mirror of the renderer's in-app activity toast. The renderer
// toasts new activity when its window is focused; this fires a native macOS notification
// when it isn't (gated on the same focus state + the Appearance toggle — see main.js).
const shortRepo = repo => (repo || '').split('/').pop() || repo || '';

// One activity entry → { title, body, url? }. Mirrors the renderer's presentEvent() copy
// (src/renderer/pages/logs.js) so a notification reads like its Activity-page row. `url`,
// when present, is the PR to open on click; otherwise the click just opens the Activity page.
function activityMessage(ev) {
  const p = (ev && typeof ev.payload === 'object' && ev.payload) || {};
  const pr = p.pr || {};
  const prBody = `#${pr.number ?? '?'} ${pr.title || ''}`.trim();
  switch (ev && ev.type) {
    case 'pr_opened': return { title: `Pull request opened in ${shortRepo(p.repo)}`, body: prBody, url: pr.url };
    case 'pr_merged': return { title: `Pull request merged in ${shortRepo(p.repo)}`, body: prBody, url: pr.url };
    case 'pr_closed': return { title: `Pull request closed in ${shortRepo(p.repo)}`, body: prBody, url: pr.url };
    case 'jira_transitioned': return { title: `${p.key || 'Ticket'} → ${p.transition || '?'}`, body: p.version ? `Fix Version ${p.version}` : '' };
    case 'jira_version_created': return { title: `Fix Version ${p.version || '?'} created`, body: p.project || '' };
    case 'jira_fixversion_set': return { title: `Fix Version ${p.version || '?'} set`, body: p.key || '' };
    case 'jira_transition_failed': return { title: `Failed to transition ${p.key || 'ticket'}`, body: p.error || '' };
    case 'jira_fixversion_failed': return { title: 'Failed to set Fix Version', body: p.error || '' };
    case 'sync_failed': return { title: `Sync failed for ${shortRepo(p.repo)}`, body: p.error || '' };
    // Unknown / future types (e.g. jira_sync_failed): title-case the tag and still surface any
    // error/detail the payload carries, so a notification never drops the info its feed row keeps.
    default: return { title: ((ev && ev.type) || 'Activity').replace(/_/g, ' '), body: p.error || p.detail || '' };
  }
}

// Fire a native notification for one activity entry. Caller decides whether to call (focus
// + setting checks live in main.js); this just renders and wires the click.
function notifyActivity(ev) {
  if (!Notification.isSupported()) return;
  const m = activityMessage(ev);
  const n = new Notification({ title: m.title, body: m.body });
  n.on('click', () => (m.url ? openLinkInApp(m.url, m.title, 'github') : runInApp(`window.showPage && showPage('activity')`)));
  n.show();
}

module.exports = { detectReviewChanges, playReviewSound, previewSound, prKey, notifyActivity };
