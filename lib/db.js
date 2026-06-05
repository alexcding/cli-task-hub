const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Resolve a writable location for taskhub.json.
//  1. TASKHUB_DATA_DIR — set by the Electron tray (points at app.getPath('userData')).
//     The forked server runs as plain Node, so it can't read Electron's app paths itself.
//  2. Electron app.getPath (when db.js happens to run inside the main process).
//  3. Repo root — for `node server.js` / `bun` development.
const dataDir = (() => {
  if (process.env.TASKHUB_DATA_DIR) return process.env.TASKHUB_DATA_DIR;
  try {
    const { app } = require('electron');
    if (app && app.getPath) return app.getPath('userData');
  } catch {}
  return path.join(__dirname, '..');
})();

const dbPath       = path.join(dataDir, 'taskhub.json');          // config + projects (source of truth)
const snapshotPath = path.join(dataDir, 'taskhub-snapshot.json'); // cached PR data (volatile, rebuilt by sync)

const uuid = () => crypto.randomUUID();

// ── Project shape ───────────────────────────────────────────────────────────────
// { id, name, color, repo, jql, mergeTransition, created_at }
//   repo            "owner/repo"  — single GitHub repo (empty string = none)
//   jql             saved Jira query for this project
//   mergeTransition Jira status to move linked tickets to when a PR merges

const PROJECT_FIELDS = ['name', 'color', 'repo', 'jql', 'mergeTransition'];

function normalizeProject(p) {
  return {
    id:              p.id,
    name:            p.name || '',
    color:           p.color || '#6366f1',
    repo:            p.repo || '',
    jql:             p.jql || '',
    mergeTransition: p.mergeTransition || '',
    created_at:      p.created_at || new Date().toISOString(),
  };
}

let _data = null;

function load() {
  if (_data) return _data;
  try { _data = JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch { _data = {}; }
  _data.config   = _data.config   || {};
  _data.projects = _data.projects || [];
  _data.links    = _data.links    || [];
  _data.events   = _data.events   || [];
  return _data;
}

function save() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, JSON.stringify(_data, null, 2));
}

// ── Snapshot store (cached PR data the UI reads) ────────────────────────────────
// Shape: { [projectId]: { prs: [...lean PRs], lastSynced: ISO, error: string|null } }
// Persisted to a sidecar file so a freshly-opened UI shows last-known data instantly.
let _snap = null;
function loadSnap() {
  if (_snap) return _snap;
  try { _snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')); } catch { _snap = {}; }
  return _snap;
}
function saveSnap() {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, JSON.stringify(_snap));
}
const getSnapshot     = id => loadSnap()[id] || null;
const getAllSnapshots = () => ({ ...loadSnap() });
const setSnapshot     = (id, snap) => { loadSnap()[id] = snap; saveSnap(); };
const deleteSnapshot  = id => { const s = loadSnap(); if (id in s) { delete s[id]; saveSnap(); } };

// ── Config (poll_interval, etc.) ────────────────────────────────────────────────
const get       = key => load().config[key] ?? null;
const set       = (key, val) => { load().config[key] = String(val); save(); };
const getConfig = () => ({ ...load().config });

// ── Projects ────────────────────────────────────────────────────────────────────
const getProjects = () => load().projects;
const getProject  = id => load().projects.find(p => p.id === id) || null;

const addProject = (fields = {}) => {
  const d = load();
  const project = normalizeProject({ ...fields, id: uuid(), created_at: new Date().toISOString() });
  d.projects.push(project);
  save();
  return project;
};

const updateProject = (id, patch = {}) => {
  const d = load();
  const p = d.projects.find(p => p.id === id);
  if (!p) return null;
  for (const field of PROJECT_FIELDS) {
    if (patch[field] !== undefined) p[field] = patch[field];
  }
  save();
  return p;
};

const deleteProject = id => {
  const d = load();
  d.projects = d.projects.filter(p => p.id !== id);
  d.links    = d.links.filter(l => l.project_id !== id);
  save();
  deleteSnapshot(id);
};

const projectForRepo = repo => load().projects.find(p => p.repo === repo) || null;

const getAllRepos = () =>
  [...new Set(load().projects.map(p => p.repo).filter(Boolean))];

// ── Links (PR ↔ Jira) ─────────────────────────────────────────────────────────
const getLinks       = projectId => {
  const links = load().links;
  return projectId ? links.filter(l => l.project_id === projectId) : links;
};
const getLinksByPR   = (prNumber, prRepo) =>
  load().links.filter(l => l.pr_number === prNumber && l.pr_repo === prRepo);

const addLink = (prNumber, prRepo, jiraKey, projectId = null) => {
  const d = load();
  const key = jiraKey.toUpperCase();
  if (d.links.some(l => l.pr_number === prNumber && l.pr_repo === prRepo && l.jira_key === key)) return;
  d.links.push({ id: uuid(), pr_number: prNumber, pr_repo: prRepo, jira_key: key, project_id: projectId || null, created_at: new Date().toISOString() });
  save();
};

const removeLink = id => {
  const d = load();
  d.links = d.links.filter(l => l.id !== id);
  save();
};

// ── Events ──────────────────────────────────────────────────────────────────────
const addEvent = (type, payload) => {
  const d = load();
  d.events.unshift({ id: uuid(), type, payload: JSON.stringify(payload), created_at: new Date().toISOString() });
  if (d.events.length > 500) d.events.length = 500;
  save();
};

const getEvents = (limit = 100) => load().events.slice(0, limit);

module.exports = {
  get, set, getConfig,
  getProjects, getProject, addProject, updateProject, deleteProject,
  projectForRepo, getAllRepos,
  getSnapshot, getAllSnapshots, setSnapshot, deleteSnapshot,
  getLinks, getLinksByPR, addLink, removeLink,
  addEvent, getEvents,
};
