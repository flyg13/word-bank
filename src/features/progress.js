import { PRACTICE_WORDS } from '../data/practice-words.js';
import { state, onRender } from '../lib/store.js';

export function totalMastered() {
  return state.verifiedWords.length;
}

export function renderProgress() {
  const mastered = totalMastered();
  const total = PRACTICE_WORDS.length;
  document.getElementById('bankCount').firstChild.textContent = mastered + ' ';
  document.getElementById('bankCountLabel').textContent = '/ ' + total + ' words mastered';
  const pct = total ? Math.min(100, Math.round((mastered / total) * 100)) : 0;
  document.getElementById('barFill').style.width = pct + '%';
}

export function initProgress() {
  onRender(renderProgress);
}

// ---------- Sync status indicator ----------
export function setSyncStatus(status, label) {
  document.getElementById('syncDot').className = 'sync-dot' + (status ? ' ' + status : '');
  document.getElementById('syncLabel').textContent = label;
}
