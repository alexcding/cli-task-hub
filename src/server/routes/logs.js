// Activity feed + log viewer. /api/events is the activity feed (category='event');
// /api/logs is the full, filterable log viewer across all categories.
const db = require('../database/db');
const { ROUTES } = require('../../shared/routes.mjs');

function register(app) {
  app.get(ROUTES.EVENTS, (req, res) => res.json(db.getEvents(100)));
  app.get(ROUTES.LOGS, (req, res) => res.json(db.getLogs({
    category: req.query.category,
    level: req.query.level,
    limit: parseInt(req.query.limit, 10) || 200,
  })));
  app.get(ROUTES.LOGS_CATEGORIES, (req, res) => res.json(db.logCategories()));
  app.post(ROUTES.LOGS_CLEAR, (req, res) => { db.clearLogs(req.body && req.body.category); res.json({ ok: true }); });
}

module.exports = { register };
