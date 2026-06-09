const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('./datadir');
const datadb = require('./datadb'); // CLI result cache (PR + Jira snapshots) — now in data.db

const dbPath = path.join(dataDir, 'taskhub.json'); // config + projects (source of truth)

const uuid = () => crypto.randomUUID();

// ── Project shape ───────────────────────────────────────────────────────────────
// { id, name, color, repo, workspace, jiraProjectKey, jql, mergeTransition, created_at }
//   repo            "owner/repo"  — single GitHub repo (empty string = none)
//   workspace       absolute path to the local checkout (empty = none). Drives the
//                   terminal's cwd and is used to auto-detect `repo` from git origin.
//   jiraProjectKey  Jira project key (e.g. "RECORD") — scopes the assigned-to-me ticket
//                   feed: with several projects, tickets are filtered to the union of keys.
//   jql             saved Jira query for this project
//   mergeTransition Jira status to move linked tickets to when a PR merges

const PROJECT_FIELDS = ['name', 'color', 'repo', 'workspace', 'jiraProjectKey', 'jql', 'mergeTransition'];

function normalizeProject(p) {
  return {
    id:              p.id,
    name:            p.name || '',
    color:           p.color || '#6366f1',
    repo:            p.repo || '',
    workspace:       p.workspace || '',
    jiraProjectKey:  p.jiraProjectKey || '',
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

// ── CLI result cache (PR + Jira snapshots) ──────────────────────────────────────
// Backed by data.db (lib/datadb.js) — re-exported here so callers keep using db.*
// and the stale-while-revalidate flow (read cache → if stale, call CLI → write →
// publish) is untouched. Shapes are identical to the old JSON sidecar store.
const {
  getSnapshot, getAllSnapshots, setSnapshot, deleteSnapshot,
  getJiraSnapshot, getAllJiraSnapshots, setJiraSnapshot, deleteJiraSnapshot,
} = datadb;

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
  deleteJiraSnapshot(id);
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
  dataDir,
  get, set, getConfig,
  getProjects, getProject, addProject, updateProject, deleteProject,
  projectForRepo, getAllRepos,
  getSnapshot, getAllSnapshots, setSnapshot, deleteSnapshot,
  getJiraSnapshot, getAllJiraSnapshots, setJiraSnapshot, deleteJiraSnapshot,
  getLinks, getLinksByPR, addLink, removeLink,
  addEvent, getEvents,
};
