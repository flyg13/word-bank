import { SESSION_LOG_LIMIT } from '../config.js';
import { state, save, onRender } from '../lib/store.js';
import { totalMastered } from './progress.js';

export function newlyMasteredThisSession() {
  return Math.max(0, totalMastered() - state.sessionMasteredStart);
}

export function countAttempt() {
  state.sessionAttempted++;
}

export function renderSession() {
  document.getElementById('startSessionBtn').style.display = state.sessionActive
    ? 'none'
    : 'inline-block';
  document.getElementById('endSessionBtn').style.display = state.sessionActive
    ? 'inline-block'
    : 'none';
  document.getElementById('sessionAttemptedStat').textContent = state.sessionAttempted;
  document.getElementById('sessionMasteredStat').textContent = newlyMasteredThisSession();
}

export function renderSessionLog() {
  const el = document.getElementById('sessionLogView');
  if (!state.sessionLog.length) {
    el.innerHTML = '<span class="empty-note">No sessions logged yet.</span>';
    return;
  }
  el.innerHTML = state.sessionLog
    .map(
      (s) =>
        '<div>' + s.date + ' — ' + s.attempted + ' attempted, ' + s.mastered + ' newly mastered</div>'
    )
    .join('');
}

export function initSession() {
  document.getElementById('startSessionBtn').addEventListener('click', () => {
    state.sessionActive = true;
    state.sessionAttempted = 0;
    state.sessionMasteredStart = totalMastered();
    document.getElementById('sessionSummary').style.display = 'none';
    renderSession();
  });

  document.getElementById('endSessionBtn').addEventListener('click', () => {
    const mastered = newlyMasteredThisSession();
    state.sessionLog.unshift({
      date: new Date().toLocaleDateString(),
      attempted: state.sessionAttempted,
      mastered
    });
    state.sessionLog = state.sessionLog.slice(0, SESSION_LOG_LIMIT);
    save('session_log', state.sessionLog);
    state.sessionActive = false;

    const box = document.getElementById('sessionSummary');
    box.style.display = 'block';
    box.innerHTML =
      '<div class="big">' +
      mastered +
      '</div><div class="session-note">newly mastered this session (' +
      state.sessionAttempted +
      ' words attempted)</div>';
    renderSession();
    renderSessionLog();
  });

  onRender(renderSession);
  onRender(renderSessionLog);
}
