// Pull-request reads (stale-while-revalidate). The UI always reads the snapshot the
// sync loop writes — never `gh` directly; snapshotFor (services/sync.js) kicks a
// background revalidate when stale and the result lands over SSE.
const db = require('../database/db');
const github = require('../repositories/github');
const { snapshotFor, prSnapshotFor } = require('../services/sync');
const { PR_LIST_STATES } = require('../services/poller');
const { PR_CATEGORY } = require('../../shared/constants.mjs');
const { ROUTES } = require('../../shared/routes.mjs');
const sse = require('./sse');

function register(app) {
  // All scopes are immediate SWR reads. Opt-in metadata preserves the legacy array contract.
  app.get(ROUTES.PROJECT_PRS, (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const state = req.query.state || 'open';
    if (!PR_LIST_STATES.has(state)) return res.status(400).json({ error: 'Invalid pull request state' });
    const snap = prSnapshotFor(project, state, req.query.refresh === '1');
    res.json(req.query.snapshot === '1' ? snap : [...snap.prs, ...(snap.error ? [{ repo: project.repo, error: snap.error }] : [])]);
  });

  // One PR by url — the only PR read that ISN'T snapshot-backed, because its whole job is to answer
  // for a PR no snapshot has: a link pasted into the New session dialog. Always 200: a lookup that
  // fails (offline, no access, not a PR) returns null and the dialog carries on with what was typed.
  app.get(ROUTES.PR_LOOKUP, async (req, res) => {
    res.json(await github.lookupPr(req.query.url || ''));
  });

  // Compact list with CI for the tray — read straight from snapshots. For PRs awaiting my
  // review we attach reviewPending: the tray's "Review requested" list shows a PR while its
  // latest request (requestedAt, set by the poller) is newer than when I last opened it
  // (viewedAt). Missing requestedAt → pending (never silently drop a request).
  app.get(ROUTES.PRS_TRAY, (req, res) => {
    const items = [];
    for (const project of db.getProjects()) {
      const snap = snapshotFor(project);
      for (const pr of snap?.prs || []) {
        const item = { ...pr, projectId: project.id, projectName: project.name };
        if (pr.category === PR_CATEGORY.REVIEW) {
          const st = db.getReviewState(`${pr.repo}#${pr.number}`);
          item.viewedAt = st?.viewed_at || null;
          item.requestedAt = pr.requestedAt || st?.requested_at || null;
          item.reviewPending = !item.requestedAt || !item.viewedAt || item.requestedAt > item.viewedAt;
        }
        items.push(item);
      }
    }
    res.json(items);
  });

  // Mark a review request as opened (acknowledged) — clicked from the tray's "Review
  // requested" list. Hides it until a newer request arrives (see /api/prs/tray).
  app.post(ROUTES.PRS_VIEWED, (req, res) => {
    const { repo, number } = req.body || {};
    if (!repo || number == null) return res.status(400).json({ error: 'repo and number required' });
    db.setReviewViewed(`${repo}#${number}`, new Date().toISOString());
    sse.broadcast({ type: 'reviews' });
    res.json({ ok: true });
  });

  // Dashboard: every project with its snapshotted open PRs + freshness info.
  app.get(ROUTES.DASHBOARD, (req, res) => {
    res.json(db.getProjects().map(project => {
      const snap = snapshotFor(project);
      return { ...project, prs: snap?.prs || [], lastSynced: snap?.lastSynced || null, syncError: snap?.error || null };
    }));
  });
}

module.exports = { register };
