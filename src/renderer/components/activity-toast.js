// Live in-app activity toasts. The server pushes each new activity-feed entry over SSE
// (db.addEvent → publishActivity); app.js calls showActivityToast() when the window is
// focused and the Appearance toggle is on (otherwise the tray fires a native macOS
// notification instead — see src/main/native/notifications.js). Presentation reuses
// presentEvent() so a toast reads exactly like the matching Activity-page row.
import { presentEvent } from '../pages/logs.js';
import { ICON } from '../lib/icons.js';

const STACK_MAX = 4;     // most recent N stay on screen; older ones drop off
const LINGER_MS = 6000;  // auto-dismiss after this; hovering pauses the countdown

function container() {
  let el = document.getElementById('activity-toasts');
  if (!el) { el = document.createElement('div'); el.id = 'activity-toasts'; document.body.appendChild(el); }
  return el;
}

function dismiss(node) {
  if (!node || node._leaving) return;
  node._leaving = true;
  clearTimeout(node._t);
  node.classList.remove('show');
  node.addEventListener('transitionend', () => node.remove(), { once: true });
  setTimeout(() => node.remove(), 400); // fallback if the transition never fires
}

// ev: { type, payload, level, created_at } as broadcast over SSE. payload arrives parsed.
export function showActivityToast(ev) {
  if (!ev) return;
  let p = ev.payload || {};
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = { raw: ev.payload }; } }
  const v = presentEvent(ev, p);

  const root = container();
  const node = document.createElement('div');
  node.className = 'act-toast';
  // The body reuses the activity row's linked HTML (PR/Jira links keep their own onclick
  // handlers); the close button stops the click from also hitting a link underneath.
  node.innerHTML = `
    <div class="act-toast-icon" style="color:${v.tint};background:${v.bg}">${v.icon}</div>
    <div class="act-toast-body">
      <div>${v.html}</div>
      ${v.detail ? `<div class="act-toast-detail">${v.detail}</div>` : ''}
    </div>
    <button class="act-toast-close" aria-label="Dismiss">${ICON.close}</button>`;
  node.querySelector('.act-toast-close').addEventListener('click', (e) => { e.stopPropagation(); dismiss(node); });

  root.appendChild(node);
  // Trim the stack to the most recent few so a burst (e.g. a multi-PR sync) can't fill the
  // screen. Remove overflow SYNCHRONOUSLY — dismiss() only defers removal to a timer, so
  // looping on it here would spin forever (the node lingers, the count never drops).
  while (root.children.length > STACK_MAX) {
    const oldest = root.firstElementChild;
    clearTimeout(oldest._t);
    oldest.remove();
  }

  requestAnimationFrame(() => node.classList.add('show')); // trigger the slide-in transition
  const arm = () => { node._t = setTimeout(() => dismiss(node), LINGER_MS); };
  node.addEventListener('mouseenter', () => clearTimeout(node._t));
  node.addEventListener('mouseleave', arm);
  arm();
}
