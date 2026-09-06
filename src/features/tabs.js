import { renderAll } from '../lib/store.js';

const TAB_NAMES = ['practice', 'sentences', 'reading', 'write', 'corrections', 'bank'];

/** Show one tab and refresh the UI behind it. */
export function activateTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    const selected = tab.dataset.tab === name;
    tab.classList.toggle('active', selected);
    // Six tabs do not fit across an iPad, so the bar scrolls — the selected one
    // has to be brought into view or it can end up off-screen after a jump.
    if (selected && tab.scrollIntoView) {
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
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
