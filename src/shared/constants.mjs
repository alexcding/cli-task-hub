// Shared cross-process enums — the single source of truth for value strings that travel
// between the server (which produces them) and the renderer (which groups/filters on them).
// Drift here is a SILENT bug, not a loud 404: a mistyped category quietly misroutes a PR
// into the wrong sidebar group. That's exactly why these belong in one contract.
//
// Authored as ESM (.mjs) because the RENDERER imports it (browsers require ESM); it's served
// to the page at /shared/constants.mjs (see server.js) and `require()`d from disk by Node
// consumers (Node ≥22.12 supports require() of ESM). See docs/ARCHITECTURE.md.

// How a PR relates to me, as classified server-side by categoryOf() in lib/github.js:
//   mine   — I authored it
//   review — I'm a requested reviewer on a non-draft PR I didn't author
//   other  — everyone else's (shown only under its project)
export const PR_CATEGORY = Object.freeze({
  MINE: 'mine',
  REVIEW: 'review',
  OTHER: 'other',
});

// Which sidebar/tab GROUP a PR renders under. A narrower set than PR_CATEGORY on purpose:
// a PR I've only commented on is category 'other' but still in my review orbit, so it groups
// under Review. Always derive this via store.prGroup(pr), never from the raw category.
export const PR_GROUP = Object.freeze({
  MINE: 'mine',
  REVIEW: 'review',
});
