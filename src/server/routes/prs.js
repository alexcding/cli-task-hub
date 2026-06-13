// Pull-request reads (stale-while-revalidate). The UI always reads the snapshot the
// sync loop writes — never `gh` directly; snapshotFor (services/sync.js) kicks a
// background revalidate when stale and the result lands over SSE.
const db = require('../database/db');
const github = require('../repositories/github');
const { snapshotFor } = require('../services/sync');
const { PR_CATEGORY } = require('../../shared/constants.mjs');
const { ROUTES } = require('../../shared/routes.mjs');

function register(app) {
  // Project-scoped PR list. `open` is served from the snapshot; merged/all is a live
  // fetch (rare, on-demand from the state filter).
  app.get(ROUTES.PROJECT_PRS, async (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    if (!project.repo) return res.json([]);

    const state = req.query.state || 'open';
    if (state === 'open') return res.json(snapshotFor(project)?.prs || []);

    try {
      const prs = await github.getPRs(project.repo, state, 30, { ci: true });
      res.json(prs.map(p => ({ ...p, repo: project.repo })));
    } catch (err) {
      res.json([{ repo: project.repo, error: err.message }]);
    }
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
