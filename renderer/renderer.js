const MAX_CONCURRENT = 3;

const state = {
  folder: null,
  queue: [], // { id, title, url, format, status, percent, speed, eta, total }
  nextId: 1,
};

const els = {
  urlInput: document.getElementById('url-input'),
  formatSelect: document.getElementById('format-select'),
  addBtn: document.getElementById('add-btn'),
  folderBtn: document.getElementById('folder-btn'),
  folderPathText: document.getElementById('folder-path-text'),
  intakeMessage: document.getElementById('intake-message'),
  queueList: document.getElementById('queue-list'),
  emptyState: document.getElementById('empty-state'),
  statActive: document.getElementById('stat-active'),
  statQueued: document.getElementById('stat-queued'),
  statDone: document.getElementById('stat-done'),
  ffmpegBanner: document.getElementById('ffmpeg-banner'),
  ffmpegBannerText: document.getElementById('ffmpeg-banner-text'),
  subtitlesCheckbox: document.getElementById('subtitles-checkbox'),
  cookiesSelect: document.getElementById('cookies-select'),
  tabManifest: document.getElementById('tab-manifest'),
  tabHistory: document.getElementById('tab-history'),
  historyList: document.getElementById('history-list'),
  historyEmptyState: document.getElementById('history-empty-state'),
  clearHistoryBtn: document.getElementById('clear-history-btn'),
};

function thumbHtml(thumbnail) {
  return thumbnail
    ? `<div class="ticket-thumb"><img src="${escapeHtml(thumbnail)}" loading="lazy" referrerpolicy="no-referrer" /></div>`
    : `<div class="ticket-thumb"><span class="ticket-thumb-placeholder">▢</span></div>`;
}

// Swap a broken thumbnail image for the placeholder glyph. Done via an actual
// event listener (not an inline onerror= attribute) since inline handlers are
// blocked by this app's CSP (script-src doesn't include 'unsafe-inline').
function wireThumbFallback(container) {
  container.querySelectorAll('.ticket-thumb img').forEach((img) => {
    img.addEventListener('error', () => {
      img.parentElement.innerHTML = '<span class="ticket-thumb-placeholder">▢</span>';
    });
  });
}

function shortFolder(p) {
  if (!p) return 'Loading…';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}

function setFfmpegBanner(status) {
  const { ffmpegBanner, ffmpegBannerText } = els;

  if (status.state === 'ready') {
    ffmpegBanner.style.display = 'none';
    els.addBtn.disabled = false;
    return;
  }

  ffmpegBanner.style.display = 'flex';
  ffmpegBanner.classList.toggle('is-error', status.state === 'error');

  if (status.state === 'checking') {
    ffmpegBannerText.textContent = 'Checking for ffmpeg…';
    els.addBtn.disabled = true;
  } else if (status.state === 'downloading') {
    ffmpegBannerText.textContent = `Setting up ffmpeg (one-time, ~100MB)… ${status.percent ?? 0}%`;
    els.addBtn.disabled = true;
  } else if (status.state === 'extracting') {
    ffmpegBannerText.textContent = 'Setting up ffmpeg — almost done…';
    els.addBtn.disabled = true;
  } else if (status.state === 'error') {
    ffmpegBannerText.textContent = `Couldn't set up ffmpeg automatically (${status.message || 'unknown error'}). You can still queue downloads, but merging/audio-only formats may fail until ffmpeg is installed manually.`;
    els.addBtn.disabled = false;
  }
}

window.api.onFfmpegStatus(setFfmpegBanner);

async function init() {
  state.folder = await window.api.defaultDownloadFolder();
  els.folderPathText.textContent = shortFolder(state.folder);
  els.folderPathText.title = state.folder;

  const settings = await window.api.getSettings();
  if (settings.cookiesBrowser) els.cookiesSelect.value = settings.cookiesBrowser;
  if (settings.subtitlesDefault) els.subtitlesCheckbox.checked = true;

  els.addBtn.disabled = true;
  const result = await window.api.ensureFfmpeg();
  if (result.ok) {
    setFfmpegBanner({ state: 'ready' });
  }
}
init();

els.cookiesSelect.addEventListener('change', () => {
  window.api.setSettings({ cookiesBrowser: els.cookiesSelect.value });
});

els.subtitlesCheckbox.addEventListener('change', () => {
  window.api.setSettings({ subtitlesDefault: els.subtitlesCheckbox.checked });
});

els.folderBtn.addEventListener('click', async () => {
  const chosen = await window.api.chooseFolder();
  if (chosen) {
    state.folder = chosen;
    els.folderPathText.textContent = shortFolder(chosen);
    els.folderPathText.title = chosen;
  }
});

els.urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleAdd();
});
els.addBtn.addEventListener('click', handleAdd);

async function handleAdd() {
  const url = els.urlInput.value.trim();
  if (!url) return;

  els.intakeMessage.textContent = '';
  els.addBtn.disabled = true;
  els.addBtn.textContent = 'Reading…';

  try {
    const result = await window.api.resolveUrl(url);
    const format = els.formatSelect.value;
    const subtitles = els.subtitlesCheckbox.checked;

    result.items.forEach((item) => {
      state.queue.push({
        id: state.nextId++,
        title: item.title,
        url: item.url,
        thumbnail: item.thumbnail || null,
        format,
        subtitles,
        status: 'queued',
        percent: 0,
        speed: '',
        eta: '',
        total: '',
      });
    });

    els.urlInput.value = '';
    renderQueue();
    processQueue();
  } catch (err) {
    els.intakeMessage.textContent = err.message || 'Could not read that URL.';
  } finally {
    els.addBtn.disabled = false;
    els.addBtn.textContent = 'Add to queue';
  }
}

function activeCount() {
  return state.queue.filter((i) => i.status === 'downloading' || i.status === 'processing').length;
}

function processQueue() {
  const slotsFree = MAX_CONCURRENT - activeCount();
  if (slotsFree <= 0) return;

  const nextItems = state.queue.filter((i) => i.status === 'queued').slice(0, slotsFree);
  nextItems.forEach((item) => startItem(item));
}

async function startItem(item) {
  item.status = 'downloading';
  item.message = '';
  renderQueue();

  try {
    const ok = await window.api.startDownload({
      id: item.id,
      url: item.url,
      folder: state.folder,
      format: item.format,
      title: item.title,
      thumbnail: item.thumbnail,
      subtitles: item.subtitles,
    });
    if (ok === false) {
      // Main process caught a setup error and already sent a progress event
      // with the real message; nothing else to do here.
      return;
    }
  } catch (err) {
    item.status = 'error';
    item.message = err.message || 'Failed to start the download.';
    renderQueue();
    processQueue();
  }
}

window.api.onProgress((data) => {
  const item = state.queue.find((i) => i.id === data.id);
  if (!item) return;

  if ('percent' in data) item.percent = data.percent; // may be null — handled at render time
  if (data.total) item.total = data.total;
  if (data.speed) item.speed = data.speed;
  if (data.eta) item.eta = data.eta;
  if (data.message) item.message = data.message;
  if (data.filepath) item.filepath = data.filepath;
  if (data.status) item.status = data.status;

  renderQueue();

  if (['done', 'error', 'cancelled', 'paused'].includes(data.status)) {
    processQueue();
  }
});

function removeFromQueue(id) {
  state.queue = state.queue.filter((i) => i.id !== id);
  renderQueue();
}

function pauseItem(id) {
  window.api.pauseDownload(id);
  // Actual status flips to 'paused' once the process reports back over onProgress.
}

function resumeItem(id) {
  const item = state.queue.find((i) => i.id === id);
  if (item) startItem(item);
}

function discardItem(id) {
  window.api.cancelDownload(id);
  removeFromQueue(id);
}

async function deleteItem(id) {
  const item = state.queue.find((i) => i.id === id);
  if (item && item.filepath) {
    try {
      await window.api.deleteFile(item.filepath);
    } catch (err) {
      // File may already be gone or locked; still remove it from the list.
    }
  }
  removeFromQueue(id);
}

// Decides which action button(s) show, based on the item's current status
function actionsFor(item) {
  switch (item.status) {
    case 'queued':
      return [{ label: 'Remove', kind: 'remove', handler: () => removeFromQueue(item.id) }];
    case 'downloading':
    case 'processing':
      return [{ label: 'Pause', kind: 'pause', handler: () => pauseItem(item.id) }];
    case 'paused':
      return [
        { label: 'Resume', kind: 'resume', handler: () => resumeItem(item.id) },
        { label: 'Discard', kind: 'discard', handler: () => discardItem(item.id) },
      ];
    case 'done':
      return [{ label: 'Delete', kind: 'delete', handler: () => deleteItem(item.id) }];
    case 'error':
      return [
        { label: 'Retry', kind: 'resume', handler: () => resumeItem(item.id) },
        { label: 'Remove', kind: 'remove', handler: () => removeFromQueue(item.id) },
      ];
    default: // cancelled
      return [{ label: 'Remove', kind: 'remove', handler: () => removeFromQueue(item.id) }];
  }
}

function statusLabel(status) {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'downloading':
      return 'Downloading';
    case 'processing':
      return 'Processing';
    case 'paused':
      return 'Paused';
    case 'done':
      return 'Done';
    case 'error':
      return 'Error';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

function renderQueue() {
  els.emptyState.style.display = state.queue.length ? 'none' : 'flex';

  els.statActive.textContent = state.queue.filter(
    (i) => i.status === 'downloading' || i.status === 'processing'
  ).length;
  els.statQueued.textContent = state.queue.filter((i) => i.status === 'queued').length;
  els.statDone.textContent = state.queue.filter((i) => i.status === 'done').length;

  // Remove old tickets (keep empty state node)
  [...els.queueList.querySelectorAll('.ticket')].forEach((el) => el.remove());

  state.queue
    .slice()
    .reverse()
    .forEach((item) => {
      const ticket = document.createElement('div');
      ticket.className = `ticket is-${item.status}`;

      const readoutParts = [];
      if (item.status === 'downloading') {
        if (typeof item.percent === 'number') readoutParts.push(`${item.percent.toFixed(1)}%`);
        if (item.total) readoutParts.push(item.total);
        if (item.speed) readoutParts.push(item.speed);
        if (item.eta) readoutParts.push(`ETA ${item.eta}`);
        if (readoutParts.length === 0) readoutParts.push('Starting…');
      } else if (item.status === 'error') {
        readoutParts.push(item.message || 'Something went wrong');
      } else if (item.status === 'processing') {
        readoutParts.push('Merging / converting…');
      } else if (item.status === 'done') {
        readoutParts.push('Saved to ' + shortFolder(state.folder));
      } else if (item.status === 'paused') {
        readoutParts.push('Paused — resume to continue from where it left off');
      } else if (item.status === 'cancelled') {
        readoutParts.push('Cancelled');
      } else {
        readoutParts.push('Waiting in queue…');
      }

      const actions = actionsFor(item);
      const actionsHtml = actions
        .map((a) => `<button class="ticket-action ticket-action-${a.kind}" data-kind="${a.kind}">${a.label}</button>`)
        .join('');

      const hasPercent = typeof item.percent === 'number';
      const isIndeterminate = item.status === 'downloading' && !hasPercent;
      const barWidth = item.status === 'done' ? 100 : hasPercent ? item.percent : 0;

      ticket.innerHTML = `
        <div class="ticket-stub">${String(item.id).padStart(2, '0')}</div>
        ${thumbHtml(item.thumbnail)}
        <div class="ticket-body">
          <div class="ticket-top">
            <div class="ticket-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
            <div class="ticket-tags">
              <span class="tag">${item.format}</span>
              <span class="tag status-${item.status}">${statusLabel(item.status)}</span>
            </div>
          </div>
          <div class="ticket-progress-track">
            <div class="ticket-progress-fill${isIndeterminate ? ' is-indeterminate' : ''}" style="width:${barWidth}%"></div>
          </div>
          <div class="ticket-bottom">
            <div class="ticket-readout">${escapeHtml(readoutParts.join('  ·  '))}</div>
            <div class="ticket-actions">${actionsHtml}</div>
          </div>
        </div>
      `;

      ticket.querySelectorAll('.ticket-action').forEach((btn, i) => {
        btn.addEventListener('click', actions[i].handler);
      });
      wireThumbFallback(ticket);

      els.queueList.appendChild(ticket);
    });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---- History tab ----------------------------------------------------------

function switchTab(tab) {
  els.tabManifest.classList.toggle('is-active', tab === 'manifest');
  els.tabHistory.classList.toggle('is-active', tab === 'history');
  els.queueList.style.display = tab === 'manifest' ? 'flex' : 'none';
  els.historyList.style.display = tab === 'history' ? 'flex' : 'none';
  els.clearHistoryBtn.style.display = tab === 'history' ? 'inline-block' : 'none';
  if (tab === 'history') loadHistory();
}

els.tabManifest.addEventListener('click', () => switchTab('manifest'));
els.tabHistory.addEventListener('click', () => switchTab('history'));

function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

async function loadHistory() {
  const history = await window.api.getHistory();
  renderHistory(history);
}

async function openHistoryFolder(entry) {
  if (!entry.filepath) return;
  const folder = entry.filepath.split(/[\\/]/).slice(0, -1).join('/');
  window.api.openFolder(folder);
}

async function deleteHistoryFile(entry) {
  if (entry.filepath) {
    try {
      await window.api.deleteFile(entry.filepath);
    } catch (_e) {
      // File may already be gone; still drop the history entry itself.
    }
  }
  await window.api.removeHistoryEntry(entry.id);
  loadHistory();
}

async function removeHistoryEntryOnly(entry) {
  await window.api.removeHistoryEntry(entry.id);
  loadHistory();
}

els.clearHistoryBtn.addEventListener('click', async () => {
  if (!confirm('Clear your whole download history? This only removes the list — it does not delete the files themselves.')) return;
  await window.api.clearHistory();
  loadHistory();
});

function renderHistory(history) {
  els.historyEmptyState.style.display = history.length ? 'none' : 'flex';

  [...els.historyList.querySelectorAll('.ticket')].forEach((el) => el.remove());

  history.forEach((entry) => {
    const ticket = document.createElement('div');
    ticket.className = 'ticket is-done';

    ticket.innerHTML = `
      ${thumbHtml(entry.thumbnail)}
      <div class="ticket-body">
        <div class="ticket-top">
          <div class="ticket-title" title="${escapeHtml(entry.title)}">${escapeHtml(entry.title)}</div>
          <div class="ticket-tags">
            <span class="tag">${escapeHtml(entry.format || '')}</span>
          </div>
        </div>
        <div class="ticket-bottom">
          <div class="ticket-readout">${escapeHtml(formatTimestamp(entry.timestamp))}</div>
          <div class="ticket-actions">
            <button class="ticket-action ticket-action-open">Open folder</button>
            <button class="ticket-action ticket-action-delete">Delete</button>
            <button class="ticket-action ticket-action-remove">Remove</button>
          </div>
        </div>
      </div>
    `;

    ticket.querySelector('.ticket-action-open').addEventListener('click', () => openHistoryFolder(entry));
    ticket.querySelector('.ticket-action-delete').addEventListener('click', () => deleteHistoryFile(entry));
    ticket.querySelector('.ticket-action-remove').addEventListener('click', () => removeHistoryEntryOnly(entry));
    wireThumbFallback(ticket);

    els.historyList.appendChild(ticket);
  });
}

renderQueue();
