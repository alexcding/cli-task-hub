// New / Edit Project modal.
import { ROUTES } from '/shared/routes.mjs';
import { state } from '../stores/store.js';
import { api, apiJson } from '../services/api.js';
import { esc } from '../lib/util.js';
import { COLORS } from '../lib/icons.js';
import { toast, toastErr } from './toast.js';
import { renderProjectNav } from './sidebar.js';
import { loadDashboard } from '../pages/dashboard.js';
import { loadProjectPage } from '../pages/project.js';
import { loadSettings, deleteProject } from '../pages/settings.js';

let _selectedColor = COLORS[0];

function buildColorPicker(selected) {
  _selectedColor = selected || COLORS[0];
  document.getElementById('color-options').innerHTML = COLORS.map(c =>
    `<span class="color-opt${c===_selectedColor?' selected':''}" style="background:${c}" onclick="selectColor('${c}')"></span>`
  ).join('');
}

export function selectColor(c) {
  _selectedColor = c;
  document.querySelectorAll('.color-opt').forEach(el => {
    el.classList.toggle('selected', el.style.background===c||el.style.backgroundColor===c);
  });
}

// Store the (auto-detected) GitHub repo in the hidden field and reflect it as a footer
// hint under the Local Git Repo input — it's derived from git, not entered by hand.
function setModalRepo(repo) {
  document.getElementById('modal-repo').value = repo || '';
  const hint = document.getElementById('modal-repo-hint');
  if (!hint) return;
  hint.innerHTML = repo
    ? `GitHub repo: <code class="code-chip">${esc(repo)}</code>`
    : `Sets the terminal's working directory; the GitHub repo is auto-detected from its <code class="code-chip">git</code> origin.`;
}

// Native folder picker for the modal's "Local Git Repo" field. Fills the workspace
// path, then auto-detects the GitHub repo from its git origin into the modal's
// Repository field (only overwrites it when a GitHub remote is actually found).
export async function chooseModalWorkspace() {
  if (!window.taskhub?.chooseFolder) { toastErr('Folder picker is only available in the app'); return; }
  const dir = await window.taskhub.chooseFolder();
  if (!dir) return;
  document.getElementById('modal-workspace').value = dir;
  try {
    const { repo } = await api(`${ROUTES.DETECT_REPO}?path=${encodeURIComponent(dir)}`);
    if (repo) { setModalRepo(repo); toast(`Detected ${repo}`); }
    else toast('No GitHub remote found in that folder');
  } catch {}
}

// Fill the (shared) project modal from a project object, or blanks for a new one.
function fillProjectModal(proj) {
  document.getElementById('modal-name').value      = proj.name || '';
  document.getElementById('modal-workspace').value = proj.workspace || '';
  setModalRepo(proj.repo || '');
  document.getElementById('modal-jira-key').value  = proj.jiraProjectKey || '';
  document.getElementById('modal-jql').value       = proj.jql || '';
}

export function openNewProjectModal() {
  document.getElementById('modal-title').textContent = 'New Project';
  document.getElementById('modal-project-id').value = '';
  fillProjectModal({});
  document.getElementById('modal-delete').style.display = 'none';
  buildColorPicker(COLORS[0]);
  document.getElementById('modal').style.display = 'flex';
  document.getElementById('modal-name').focus();
}

export function openEditProjectModal(id) {
  const proj = state.projects.find(p=>p.id===id);
  if (!proj) return;
  document.getElementById('modal-title').textContent = 'Edit Project';
  document.getElementById('modal-project-id').value = id;
  fillProjectModal(proj);
  document.getElementById('modal-delete').style.display = ''; // existing project → can delete
  buildColorPicker(proj.color);
  document.getElementById('modal').style.display = 'flex';
  document.getElementById('modal-name').focus();
}

export function closeModal() {
  document.getElementById('modal').style.display = 'none';
  document.getElementById('modal-project-id').value = '';
}

export function deleteProjectFromModal() {
  const id = document.getElementById('modal-project-id').value;
  if (!id) return;
  closeModal();
  deleteProject(id);
}

export async function saveProject() {
  const id        = document.getElementById('modal-project-id').value;
  const name      = document.getElementById('modal-name').value.trim();
  if (!name) { toastErr('Name required'); return; }
  const payload = {
    name,
    color:          _selectedColor,
    workspace:      document.getElementById('modal-workspace').value.trim(),
    repo:           document.getElementById('modal-repo').value.trim(),
    jiraProjectKey: document.getElementById('modal-jira-key').value.trim(),
    jql:            document.getElementById('modal-jql').value.trim(),
  };
  try {
    if (id) {
      await apiJson(ROUTES.project(id), 'PUT', payload);
      toast('Project updated');
    } else {
      await apiJson(ROUTES.PROJECTS, 'POST', payload);
      toast(`Project "${name}" created`);
    }
    closeModal();
    const projects = await api(ROUTES.PROJECTS);
    renderProjectNav(projects);
    if (document.getElementById('page-settings').classList.contains('active')) loadSettings();
    else if (document.getElementById('page-dashboard').classList.contains('active')) loadDashboard();
    else if (id && state.activeProjectId === id && document.getElementById('page-project').classList.contains('active')) {
      document.getElementById('page-title').textContent = name; // name may have changed
      loadProjectPage(id);
    }
  } catch(e) { toastErr(e.message); }
}
