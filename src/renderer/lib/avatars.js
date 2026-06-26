// Shared avatar cache: one GitHub login → data-URI, reused everywhere avatars render (sidebar
// tabs, dashboard PR cards). A data URI repaints synchronously, so reusing one across re-renders
// avoids the flicker a live github.com/<login>.png <img> shows whenever its element is recreated.
// freezeAvatar (viewer.js) seeds this on tab open; ensureAvatar warms it on demand for cards.
// Pure module-level state — no DOM/window access at import, so it's safe to import from util.js.

const cache = new Map();      // login -> data URI
const inflight = new Set();   // logins being fetched (dedupe concurrent + repeat requests)

// Synchronous read for ghAvatarSrc — '' when not cached yet (caller falls back to the live URL).
export const avatarUri = login => (login && cache.get(login)) || '';

// Store a data URI someone else already fetched (e.g. freezeAvatar onto a tab) so other views reuse it.
export function seedAvatar(login, uri) {
  if (login && uri && !cache.has(login)) cache.set(login, uri);
}

// Fetch + cache a login's avatar once (via main), then swap it into any <img data-av="login">
// already on screen — no re-render, and the in-place src swap doesn't flicker (the element keeps
// showing the live URL until the data URI decodes). No-op if cached, in flight, or the fetch
// bridge is absent (plain browser → callers keep the live github.com URL, which works there).
export function ensureAvatar(login) {
  if (!login || cache.has(login) || inflight.has(login) || !window.taskhub?.fetchAvatar) return;
  inflight.add(login);
  Promise.resolve(window.taskhub.fetchAvatar(login)).then(uri => {
    inflight.delete(login);
    // Cache the result either way — INCLUDING a miss (fetchAvatar returns null on a failed/rate-
    // limited fetch). Caching '' for a miss makes cache.has(login) true, so we don't re-fetch on
    // every render; avatarUri('') is falsy, so ghAvatarSrc falls back to the live github.com URL.
    // Without this, a login whose fetch keeps failing would re-issue the IPC on every SSE re-render
    // and every dashboard card — a request storm that worsens the rate-limiting that caused it.
    cache.set(login, uri || '');
    if (!uri) return;
    document.querySelectorAll(`img[data-av="${CSS.escape(login)}"]`).forEach(im => { im.src = uri; });
  }).catch(() => { inflight.delete(login); cache.set(login, ''); });
}
