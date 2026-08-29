import { renderAll } from '../lib/store.js';

const TAB_NAMES = ['practice', 'sentences', 'reading', 'write', 'bank'];

/** Show one tab and refresh the UI behind it. */
export function activateTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === name);
  });
  TAB_NAMES.forEach((tabName) => {
    document.getElementById('tab-' + tabName).style.display =
      tabName === name ? 'block' : 'none';
  });
  renderAll();
}

export function initTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });
}
