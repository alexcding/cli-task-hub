// Grab-bag system surface: PR↔Jira links, the dashboard greeting, AI token usage,
// the Settings DB inspector, the GitHub webhook receiver, forwarder status, and the
// manual poll trigger.
const db = require('../database/db');
const github = require('../repositories/github');
const usage = require('../repositories/usage');
const poller = require('../services/poller');
const forwarder = require('../services/webhook-forwarder');
const agentHooks = require('../services/agent-hooks');
const sse = require('./sse');
const { ROUTES } = require('../../shared/routes.mjs');

function register(app) {
  // ── Links ───────────────────────────────────────────────────────────────────────
  app.get(ROUTES.LINKS, (req, res) => res.json(db.getLinks(req.query.project)));
  app.post(ROUTES.LINKS, (req, res) => {
    const { prNumber, prRepo, jiraKey, projectId } = req.body;
    if (!prNumber || !prRepo || !jiraKey) return res.status(400).json({ error: 'prNumber, prRepo, jiraKey required' });
    db.addLink(prNumber, prRepo, jiraKey, projectId);
    res.json({ ok: true });
  });
  app.delete(ROUTES.LINK, (req, res) => { db.removeLink(req.params.id); res.json({ ok: true }); });

  // ── Who am I (dashboard greeting) ───────────────────────────────────────────────
  app.get(ROUTES.WHOAMI, (req, res) => {
    github.getUserName()
      .then(name => res.json({ name }))
      .catch(() => res.json({ name: '' }));
  });

  // ── AI token usage (dashboard hero) ─────────────────────────────────────────────
  // Today's Claude Code / Codex usage via ccusage; repositories/usage.js caches SWR-style.
  app.get(ROUTES.USAGE, (req, res) => {
    usage.getUsage()
      .then(u => res.json(u))
      .catch(err => res.status(500).json({ error: err.message }));
  });

  // ── DB inspector (Settings) ─────────────────────────────────────────────────────
  app.get(ROUTES.DB, (req, res) => {
    const snaps = db.getAllSnapshots();
    const jsnaps = db.getAllJiraSnapshots();
    res.json({
      config: db.getConfig(),
      projects: db.getProjects(),
      counts: { projects: db.getProjects().length, links: db.getLinks().length, events: db.getEvents(1000).length },
      ghStats: github.ghStats(), // gh CLI latency + coalescing metrics (see repositories/github.js)
      snapshots: Object.fromEntries(Object.entries(snaps).map(([id, s]) =>
        [id, { open: s.prs?.length || 0, lastSynced: s.lastSynced, error: s.error || null }])),
      jiraSnapshots: Object.fromEntries(Object.entries(jsnaps).map(([id, s]) =>
        [id, { tickets: s.items?.length || 0, lastSynced: s.lastSynced, error: s.error || null }])),
    });
  });

  // ── GitHub webhook ──────────────────────────────────────────────────────────────
  app.post(ROUTES.WEBHOOK_GITHUB, (req, res) => {
    res.sendStatus(200);
    if (req.headers['x-github-event'] !== 'pull_request') return;
    const { action, pull_request: pr, repository } = req.body;
    if (action !== 'closed' || !pr?.merged) return;
    const repo = repository?.full_name;
    if (!repo) return;
    console.log(`[webhook] PR #${pr.number} merged in ${repo}`);
    poller.handleMerge(repo, { number: pr.number, title: pr.title, url: pr.html_url, body: pr.body });
  });

  // ── Forwarders ────────────────────────────────────────────────────────────────
  app.get(ROUTES.FORWARDERS, (req, res) => res.json(forwarder.list()));

  // ── Poll trigger ────────────────────────────────────────────────────────────────
  app.post(ROUTES.POLL, async (req, res) => {
    try { await Promise.all([poller.poll(), poller.pollJira()]); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Agent CLI hooks (Settings → Agents) ───────────────────────────────────────────
  app.get(ROUTES.AGENT_HOOKS, (req, res) => res.json(agentHooks.status()));
  app.post(ROUTES.AGENT_HOOK, (req, res) => {
    try { agentHooks.install(req.params.cli); res.json({ ok: true, status: agentHooks.status() }); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });
  app.delete(ROUTES.AGENT_HOOK, (req, res) => {
    try { agentHooks.uninstall(req.params.cli); res.json({ ok: true, status: agentHooks.status() }); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });
  // The installed hooks ping these as a CLI turn starts (UserPromptSubmit) and ends (Stop).
  // cli/runId arrive as query params; the CLI's own hook payload is the JSON body. We broadcast
  // over SSE; the renderer maps runId (= the terminal id we injected as TASKHUB_RUN_ID) to a
  // terminal and drives its busy spinner. runId is empty for sessions TaskHub didn't launch.
  const relayHook = sseType => (req, res) => {
    res.sendStatus(204);
    const { cli, runId } = req.query;
    try { sse.broadcast({ type: sseType, cli: cli || '', runId: runId || '', payload: req.body || null }); } catch { /* no listeners */ }
  };
  app.post(ROUTES.HOOK_TURN_START, relayHook('agent-turn-start'));
  app.post(ROUTES.HOOK_TURN_DONE, relayHook('agent-turn-done'));
}

module.exports = { register };
