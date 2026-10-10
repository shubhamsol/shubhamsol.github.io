'use strict';

/**
 * Study Tracker & Analytics Application Logic
 * Persistent Storage Path: localStorage['study_tracker_sessions_v1']
 */

const STORAGE_KEY = 'study_tracker_sessions_v1';

// App State
let sessions = [];
let timerMode = 'stopwatch'; // 'stopwatch' or countdown minutes (e.g. 25, 50)
let targetSeconds = 0;
let elapsedSeconds = 0;
let timerInterval = null;
let isTimerRunning = false;

// DOM Elements
const sidebar = document.querySelector('[data-sidebar]');
const sidebarBtn = document.querySelector('[data-sidebar-btn]');

// Tab Elements
const navTabs = document.querySelectorAll('[data-tracker-tab]');
const articles = document.querySelectorAll('[data-tracker-page]');

// Timer Elements
const timerDisplay = document.getElementById('timer-display');
const timerStatusLabel = document.getElementById('timer-status-label');
const presetButtons = document.querySelectorAll('.preset-btn');
const studySubjectSelect = document.getElementById('study-subject');
const studyActivitySelect = document.getElementById('study-activity');
const studyNotesInput = document.getElementById('study-notes');

const btnStart = document.getElementById('btn-start');
const btnPause = document.getElementById('btn-pause');
const btnSave = document.getElementById('btn-save');
const btnReset = document.getElementById('btn-reset');

// Manual Log Elements
const toggleManualBtn = document.getElementById('toggle-manual-entry');
const manualForm = document.getElementById('manual-log-form');
const manualChevron = document.getElementById('manual-chevron');

// Analytics Elements
const statTotalTime = document.getElementById('stat-total-time');
const statTodayTime = document.getElementById('stat-today-time');
const statWeekTime = document.getElementById('stat-week-time');
const statStreak = document.getElementById('stat-streak');
const subjectProgressList = document.getElementById('subject-progress-list');
const weeklyBarChart = document.getElementById('weekly-bar-chart');

// History Elements
const historyItemsWrapper = document.getElementById('history-items-wrapper');
const historySubjectFilter = document.getElementById('history-subject-filter');
const historyCountText = document.getElementById('history-count-text');
const btnExportJson = document.getElementById('btn-export-json');
const importJsonInput = document.getElementById('import-json-input');
const btnClearHistory = document.getElementById('btn-clear-history');


/* ==========================================================================
   INITIALIZATION
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  initSidebarToggle();
  initTabsNavigation();
  loadSessionsFromStorage();
  initTimerControls();
  initManualLogForm();
  initHistoryControls();
  updateAllViews();

  // Set default manual log date to today
  const manualDateInput = document.getElementById('manual-date');
  if (manualDateInput) {
    manualDateInput.value = new Date().toISOString().split('T')[0];
  }
});


/* ==========================================================================
   SIDEBAR & TAB NAVIGATION
   ========================================================================== */

function initSidebarToggle() {
  if (sidebar && sidebarBtn) {
    sidebarBtn.addEventListener('click', () => {
      sidebar.classList.toggle('active');
    });
  }
}

function initTabsNavigation() {
  navTabs.forEach(tab => {
    tab.addEventListener('click', function () {
      const targetPage = this.dataset.trackerTab;

      navTabs.forEach(t => t.classList.remove('active'));
      this.classList.add('active');

      articles.forEach(article => {
        if (article.dataset.trackerPage === targetPage) {
          article.classList.add('active');
        } else {
          article.classList.remove('active');
        }
      });

      // Refresh analytics or history when switching tabs
      if (targetPage === 'analytics') {
        renderAnalytics();
      } else if (targetPage === 'history') {
        renderHistory();
      }
    });
  });
}


/* ==========================================================================
   PERSISTENT STORAGE MANAGEMENT
   ========================================================================== */

function loadSessionsFromStorage() {
  try {
    const rawData = localStorage.getItem(STORAGE_KEY);
    if (rawData) {
      sessions = JSON.parse(rawData);
    } else {
      sessions = [];
    }
  } catch (e) {
    console.error('Failed to load study sessions from LocalStorage:', e);
    sessions = [];
  }
}

function saveSessionsToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    updateStorageStatusBadge();
  } catch (e) {
    console.error('Failed to save study sessions to LocalStorage:', e);
    alert('Warning: Unable to save session to local browser storage.');
  }
}

function updateStorageStatusBadge() {
  const statusText = document.getElementById('storage-status-text');
  if (statusText) {
    statusText.textContent = `${sessions.length} Sessions Stored`;
  }
}


/* ==========================================================================
   TIMER / STOPWATCH LOGIC
   ========================================================================== */

function initTimerControls() {
  presetButtons.forEach(btn => {
    btn.addEventListener('click', function () {
      if (isTimerRunning) {
        if (!confirm('A session is currently running. Switch modes and reset timer?')) {
          return;
        }
        pauseTimer();
      }

      presetButtons.forEach(b => b.classList.remove('active'));
      this.classList.add('active');

      const preset = this.dataset.preset;
      if (preset === 'stopwatch') {
        timerMode = 'stopwatch';
        targetSeconds = 0;
      } else if (preset === 'custom') {
        const minutesStr = prompt('Enter custom timer duration in minutes:', '40');
        const mins = parseInt(minutesStr, 10);
        if (!isNaN(mins) && mins > 0) {
          timerMode = 'countdown';
          targetSeconds = mins * 60;
        } else {
          return;
        }
      } else {
        timerMode = 'countdown';
        targetSeconds = parseInt(preset, 10) * 60;
      }

      resetTimerState();
    });
  });

  btnStart.addEventListener('click', startTimer);
  btnPause.addEventListener('click', pauseTimer);
  btnSave.addEventListener('click', saveActiveSession);
  btnReset.addEventListener('click', () => {
    if (isTimerRunning) pauseTimer();
    resetTimerState();
  });
}

function startTimer() {
  if (isTimerRunning) return;

  isTimerRunning = true;
  btnStart.disabled = true;
  btnPause.disabled = false;
  btnSave.disabled = false;
  timerStatusLabel.textContent = 'Session in progress... Keep focused!';

  timerInterval = setInterval(() => {
    elapsedSeconds++;
    updateTimerDisplay();

    // Check countdown completion
    if (timerMode === 'countdown' && elapsedSeconds >= targetSeconds) {
      pauseTimer();
      timerStatusLabel.textContent = '🎉 Countdown target reached! Click "Save Session" to log it.';
      playNotificationSound();
    }
  }, 1000);
}

function pauseTimer() {
  if (!isTimerRunning) return;

  isTimerRunning = false;
  clearInterval(timerInterval);
  timerInterval = null;

  btnStart.disabled = false;
  btnPause.disabled = true;
  timerStatusLabel.textContent = 'Session paused.';
}

function resetTimerState() {
  clearInterval(timerInterval);
  timerInterval = null;
  isTimerRunning = false;
  elapsedSeconds = 0;

  btnStart.disabled = false;
  btnPause.disabled = true;
  btnSave.disabled = true;

  timerStatusLabel.textContent = 'Ready to start session';
  updateTimerDisplay();
}

function updateTimerDisplay() {
  let displaySeconds = elapsedSeconds;

  if (timerMode === 'countdown') {
    displaySeconds = Math.max(0, targetSeconds - elapsedSeconds);
  }

  const hours = Math.floor(displaySeconds / 3600);
  const minutes = Math.floor((displaySeconds % 3600) / 60);
  const seconds = displaySeconds % 60;

  const formatted = [
    hours.toString().padStart(2, '0'),
    minutes.toString().padStart(2, '0'),
    seconds.toString().padStart(2, '0')
  ].join(':');

  timerDisplay.textContent = formatted;
}

function saveActiveSession() {
  if (elapsedSeconds < 5) {
    alert('Study session too short to save (minimum 5 seconds).');
    return;
  }

  const subject = studySubjectSelect.value;
  const activity = studyActivitySelect.value;
  const notes = studyNotesInput.value.trim();

  const newSession = {
    id: 'session_' + Date.now(),
    date: new Date().toISOString(),
    durationSeconds: elapsedSeconds,
    subject: subject,
    activity: activity,
    notes: notes,
    mode: timerMode
  };

  sessions.unshift(newSession); // Add to top
  saveSessionsToStorage();

  alert(`Awesome! Saved ${formatDurationText(elapsedSeconds)} of ${subject} session.`);

  studyNotesInput.value = '';
  if (isTimerRunning) pauseTimer();
  resetTimerState();
  updateAllViews();
}

function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5 note
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
  } catch (e) {
    // Audio context not allowed without interaction, ignore safely
  }
}


/* ==========================================================================
   MANUAL LOG FORM
   ========================================================================== */

function initManualLogForm() {
  if (toggleManualBtn && manualForm) {
    toggleManualBtn.addEventListener('click', () => {
      manualForm.classList.toggle('hidden');
      if (manualChevron) {
        manualChevron.name = manualForm.classList.contains('hidden') ? 'chevron-down-outline' : 'chevron-up-outline';
      }
    });
  }

  if (manualForm) {
    manualForm.addEventListener('submit', (e) => {
      e.preventDefault();

      const subject = document.getElementById('manual-subject').value;
      const activity = document.getElementById('manual-activity').value;
      const dateVal = document.getElementById('manual-date').value;
      const durationMins = parseInt(document.getElementById('manual-duration').value, 10);
      const notes = document.getElementById('manual-notes').value.trim();

      if (!dateVal || isNaN(durationMins) || durationMins <= 0) {
        alert('Please provide a valid date and duration in minutes.');
        return;
      }

      // Preserve input time or default to 12:00 PM on specified date
      const sessionDate = new Date(dateVal + 'T12:00:00');

      const manualSession = {
        id: 'session_' + Date.now(),
        date: sessionDate.toISOString(),
        durationSeconds: durationMins * 60,
        subject: subject,
        activity: activity,
        notes: notes,
        mode: 'manual'
      };

      sessions.unshift(manualSession);
      saveSessionsToStorage();

      alert(`Manual session logged successfully: ${durationMins}m of ${subject}.`);

      manualForm.reset();
      document.getElementById('manual-date').value = new Date().toISOString().split('T')[0];
      manualForm.classList.add('hidden');
      if (manualChevron) manualChevron.name = 'chevron-down-outline';

      updateAllViews();
    });
  }
}


/* ==========================================================================
   ANALYTICS ENGINE & VISUALIZATIONS
   ========================================================================== */

function renderAnalytics() {
  if (!statTotalTime) return;

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Start of week (Sunday or Monday)
  const dayOfWeek = now.getDay();
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfToday.getDate() - dayOfWeek);

  let totalSecs = 0;
  let todaySecs = 0;
  let weekSecs = 0;

  const subjectTotals = {};
  const dailyTotalsPast7Days = [0, 0, 0, 0, 0, 0, 0]; // Index 0 = 6 days ago, 6 = Today

  sessions.forEach(s => {
    const sDate = new Date(s.date);
    const secs = s.durationSeconds || 0;

    totalSecs += secs;

    if (sDate >= startOfToday) {
      todaySecs += secs;
    }

    if (sDate >= startOfWeek) {
      weekSecs += secs;
    }

    // Subject accumulator
    subjectTotals[s.subject] = (subjectTotals[s.subject] || 0) + secs;

    // Daily breakdown for last 7 days
    const diffDays = Math.floor((startOfToday - new Date(sDate.getFullYear(), sDate.getMonth(), sDate.getDate())) / (1000 * 60 * 60 * 24));
    if (diffDays >= 0 && diffDays < 7) {
      const dayIdx = 6 - diffDays;
      dailyTotalsPast7Days[dayIdx] += secs;
    }
  });

  // Calculate Streak
  const streak = calculateDayStreak();

  // Render Overview Cards
  statTotalTime.textContent = formatHoursMins(totalSecs);
  statTodayTime.textContent = formatHoursMins(todaySecs);
  statWeekTime.textContent = formatHoursMins(weekSecs);
  statStreak.textContent = `${streak} Day${streak === 1 ? '' : 's'}`;

  // Render Subject Breakdown Progress Bars
  renderSubjectBars(subjectTotals, totalSecs);

  // Render 7-day Bar Chart
  renderWeeklyChart(dailyTotalsPast7Days, now);
}

function calculateDayStreak() {
  if (sessions.length === 0) return 0;

  const activeDates = new Set();
  sessions.forEach(s => {
    const dStr = new Date(s.date).toISOString().split('T')[0];
    activeDates.add(dStr);
  });

  const today = new Date();
  let streak = 0;
  let checkDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  // If didn't study today, check if studied yesterday to keep streak
  const todayStr = checkDate.toISOString().split('T')[0];
  if (!activeDates.has(todayStr)) {
    checkDate.setDate(checkDate.getDate() - 1);
    const yesterdayStr = checkDate.toISOString().split('T')[0];
    if (!activeDates.has(yesterdayStr)) {
      return 0;
    }
  }

  // Count backwards continuously
  while (true) {
    const dStr = checkDate.toISOString().split('T')[0];
    if (activeDates.has(dStr)) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  return streak;
}

function renderSubjectBars(subjectTotals, totalSecs) {
  if (!subjectProgressList) return;

  if (totalSecs === 0 || Object.keys(subjectTotals).length === 0) {
    subjectProgressList.innerHTML = '<p class="empty-msg">No study data logged yet.</p>';
    return;
  }

  const sortedSubjects = Object.keys(subjectTotals).sort((a, b) => subjectTotals[b] - subjectTotals[a]);

  let html = '';
  sortedSubjects.forEach(sub => {
    const secs = subjectTotals[sub];
    const pct = Math.round((secs / totalSecs) * 100);

    html += `
      <div class="progress-item">
        <div class="progress-item-header">
          <span class="progress-subject-name">${escapeHtml(sub)}</span>
          <span class="progress-time-text">${formatHoursMins(secs)} (${pct}%)</span>
        </div>
        <div class="skill-progress-bg">
          <div class="skill-progress-fill" style="width: ${pct}%;"></div>
        </div>
      </div>
    `;
  });

  subjectProgressList.innerHTML = html;
}

function renderWeeklyChart(dailyTotals, endDate) {
  if (!weeklyBarChart) return;

  const maxSecs = Math.max(...dailyTotals, 1);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let html = '';
  for (let i = 0; i < 7; i++) {
    const d = new Date(endDate);
    d.setDate(d.getDate() - (6 - i));
    const label = i === 6 ? 'Today' : dayNames[d.getDay()];

    const secs = dailyTotals[i];
    const heightPct = Math.max(Math.round((secs / maxSecs) * 100), 5); // Minimum 5% visible height
    const minsText = secs > 0 ? (secs >= 3600 ? (secs / 3600).toFixed(1) + 'h' : Math.round(secs / 60) + 'm') : '0m';

    html += `
      <div class="bar-col">
        <span class="bar-val">${minsText}</span>
        <div class="bar-fill" style="height: ${heightPct}%;" title="${label}: ${formatHoursMins(secs)}"></div>
        <span class="bar-label">${label}</span>
      </div>
    `;
  }

  weeklyBarChart.innerHTML = html;
}


/* ==========================================================================
   HISTORY LOGS & IMPORT / EXPORT
   ========================================================================== */

function initHistoryControls() {
  if (historySubjectFilter) {
    historySubjectFilter.addEventListener('change', renderHistory);
  }

  if (btnExportJson) {
    btnExportJson.addEventListener('click', exportSessionsJSON);
  }

  if (importJsonInput) {
    importJsonInput.addEventListener('change', importSessionsJSON);
  }

  if (btnClearHistory) {
    btnClearHistory.addEventListener('click', () => {
      if (sessions.length === 0) {
        alert('History is already empty.');
        return;
      }

      if (confirm('Are you sure you want to delete ALL logged study sessions? This action cannot be undone.')) {
        sessions = [];
        saveSessionsToStorage();
        updateAllViews();
      }
    });
  }
}

function renderHistory() {
  if (!historyItemsWrapper) return;

  const selectedFilter = historySubjectFilter ? historySubjectFilter.value : 'ALL';

  let filtered = sessions;
  if (selectedFilter !== 'ALL') {
    filtered = sessions.filter(s => s.subject === selectedFilter);
  }

  if (historyCountText) {
    historyCountText.textContent = `${filtered.length} session${filtered.length === 1 ? '' : 's'} displayed`;
  }

  if (filtered.length === 0) {
    historyItemsWrapper.innerHTML = '<p class="empty-msg">No matching study sessions found.</p>';
    return;
  }

  let html = '';
  filtered.forEach(session => {
    const formattedDate = new Date(session.date).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const durationText = formatDurationText(session.durationSeconds);
    const notesText = session.notes ? escapeHtml(session.notes) : 'No notes entered';

    html += `
      <div class="history-item">
        <div class="history-item-details">
          <span class="history-subject-tag">${escapeHtml(session.subject)}</span>
          <div class="history-meta-text">
            <span>Tag: <strong>${escapeHtml(session.activity || 'Study')}</strong></span>
            <span>•</span>
            <span>Date: ${formattedDate}</span>
          </div>
          <p class="history-notes">"${notesText}"</p>
        </div>
        <div class="history-item-right">
          <span class="history-duration-badge">${durationText}</span>
          <button class="btn-delete-item" onclick="deleteSession('${session.id}')" title="Delete entry">
            <ion-icon name="trash-outline"></ion-icon>
          </button>
        </div>
      </div>
    `;
  });

  historyItemsWrapper.innerHTML = html;
}

window.deleteSession = function (id) {
  if (confirm('Delete this study log entry?')) {
    sessions = sessions.filter(s => s.id !== id);
    saveSessionsToStorage();
    updateAllViews();
  }
};

function exportSessionsJSON() {
  if (sessions.length === 0) {
    alert('No sessions to export.');
    return;
  }

  const jsonStr = JSON.stringify(sessions, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `study_history_backup_${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importSessionsJSON(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (event) {
    try {
      const importedData = JSON.parse(event.target.result);
      if (Array.isArray(importedData)) {
        sessions = importedData;
        saveSessionsToStorage();
        updateAllViews();
        alert(`Success! Imported ${importedData.length} study sessions.`);
      } else {
        alert('Invalid JSON file format. Expected an array of sessions.');
      }
    } catch (err) {
      alert('Error parsing JSON file.');
      console.error(err);
    }
  };
  reader.readAsText(file);
  e.target.value = ''; // Reset input
}


/* ==========================================================================
   HELPER UTILITIES
   ========================================================================== */

function updateAllViews() {
  updateStorageStatusBadge();
  renderAnalytics();
  renderHistory();
}

function formatDurationText(totalSeconds) {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hrs > 0) {
    return `${hrs}h ${mins}m ${secs}s`;
  } else if (mins > 0) {
    return `${mins}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

function formatHoursMins(totalSeconds) {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  return `${hrs}h ${mins}m`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
