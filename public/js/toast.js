export function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'show' + (type ? ' ' + type : '');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 3500);
}
export const toastErr = msg => toast(msg, 'error');
