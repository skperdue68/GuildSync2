// Alphabet Mafia guild chat archive. Vanilla JS on purpose: this page is served
// as plain files by the GuildSync backend, with no build step.
const SORT_LABELS = {
  time: 'Local time',
  sender: 'Sender',
  message: 'Message'
};
const PAGE_LIMIT = 500;
const DEFAULT_TIME = '00:00:00';
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;

const state = {
  sort: 'time',
  dir: 'desc',
  search: '',
  start: null,
  end: null,
  total: 0
};

const elements = {
  body: document.getElementById('chat-body'),
  summary: document.getElementById('table-summary'),
  error: document.getElementById('table-error'),
  tableScroll: document.getElementById('table-scroll'),
  search: document.getElementById('search-input'),
  rangeStart: document.getElementById('range-start'),
  rangeStartTime: document.getElementById('range-start-time'),
  rangeEnd: document.getElementById('range-end'),
  rangeEndTime: document.getElementById('range-end-time'),
  rangeClear: document.getElementById('range-clear'),
  refresh: document.getElementById('refresh-button'),
  banner: document.getElementById('update-banner'),
  bannerText: document.getElementById('update-banner-text'),
  bannerRefresh: document.getElementById('update-banner-refresh'),
  connection: document.getElementById('connection-status'),
  tooltip: document.getElementById('row-tooltip')
};

let searchTimer = null;
let requestController = null;
let requestSequence = 0;

// mm/dd/yyyy hh:ii:ss, always 24-hour, in the reader's own time zone.
function pad(value) {
  return String(value).padStart(2, '0');
}

function formatLocalDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return (
    `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function formatLocalTimestamp(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '';
  return formatLocalDate(new Date(value * 1000));
}

function formatLocalIso(isoString) {
  if (!isoString) return '—';
  return formatLocalDate(new Date(isoString)) || '—';
}

// yyyy-mm-dd, the value a date input expects.
function dateInputValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The page opens on today's messages: from today 00:00:00 to tomorrow 00:00:00.
function applyDefaultRange() {
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

  elements.rangeStart.value = dateInputValue(today);
  elements.rangeEnd.value = dateInputValue(tomorrow);
  elements.rangeStartTime.value = DEFAULT_TIME;
  elements.rangeEndTime.value = DEFAULT_TIME;
}

function setConnection(stateName, label) {
  elements.connection.dataset.state = stateName;
  elements.connection.textContent = label;
}

function setError(message) {
  elements.error.textContent = message || '';
  elements.error.hidden = !message;
}

function showUpdateBanner(message) {
  elements.bannerText.textContent = message;
  elements.banner.hidden = false;
  elements.refresh.classList.add('refresh-button-attention');
}

function clearUpdateBanner() {
  elements.banner.hidden = true;
  elements.refresh.classList.remove('refresh-button-attention');
}

// A date plus a 24-hour hh:mm:ss time, read in the reader's own time zone.
function parseBoundary(dateInput, timeInput) {
  const dateValue = dateInput.value.trim();
  if (!dateValue) return {seconds: null};

  const time = TIME_PATTERN.exec(timeInput.value.trim() || DEFAULT_TIME);
  if (!time) return {error: 'Times must use the 24-hour hh:mm:ss format.'};

  const [year, month, day] = dateValue.split('-').map(Number);
  const parsed = new Date(year, month - 1, day, Number(time[1]), Number(time[2]), Number(time[3]));
  if (Number.isNaN(parsed.getTime())) return {error: 'The date range is not a valid date.'};

  return {seconds: Math.floor(parsed.getTime() / 1000)};
}

function readRange() {
  const start = parseBoundary(elements.rangeStart, elements.rangeStartTime);
  const end = parseBoundary(elements.rangeEnd, elements.rangeEndTime);

  if (start.error || end.error) {
    setError(start.error || end.error);
    return false;
  }

  if (start.seconds != null && end.seconds != null && start.seconds > end.seconds) {
    setError('The start of the range must be before the end.');
    return false;
  }

  state.start = start.seconds;
  state.end = end.seconds;
  return true;
}

function renderSummary(loaded) {
  const total = Number(state.total) || 0;
  const noun = total === 1 ? 'message' : 'messages';
  const parts = [`${total.toLocaleString()} ${noun}`];

  if (total > loaded) {
    parts.push(`showing ${loaded.toLocaleString()} — narrow the date range to see the rest`);
  }

  elements.summary.textContent = parts.join(' · ');
}

function renderEmpty(message) {
  const row = document.createElement('tr');
  row.className = 'empty-row';
  const cell = document.createElement('td');
  cell.colSpan = 3;
  cell.textContent = message;
  row.append(cell);
  elements.body.replaceChildren(row);
  elements.summary.textContent = 'No messages';
}

function cell(className, text) {
  const element = document.createElement('td');
  element.className = className;
  element.textContent = text;
  return element;
}

function renderMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    renderEmpty('No guild chat messages match these filters.');
    return;
  }

  const rows = messages.map(message => {
    const row = document.createElement('tr');

    row.append(cell('cell-time', formatLocalTimestamp(message.message_timestamp)));
    row.append(cell('cell-sender', message.sender || 'unknown'));
    row.append(cell('cell-message', message.message_text || ''));

    // Source and uploader are not columns any more; the row tooltip carries them.
    row.dataset.receivedAt = message.received_at || '';
    row.dataset.uploadedBy = message.uploaded_by || '';

    return row;
  });

  elements.body.replaceChildren(...rows);
  renderSummary(messages.length);
}

function setLoading(loading) {
  elements.refresh.disabled = loading;
  if (loading) elements.summary.textContent = 'Loading…';
}

async function loadMessages() {
  const sequence = ++requestSequence;
  if (requestController) requestController.abort();
  requestController = new AbortController();

  const params = new URLSearchParams({
    sort: state.sort,
    dir: state.dir,
    limit: String(PAGE_LIMIT)
  });

  if (state.search) params.set('q', state.search);
  if (state.start != null) params.set('start', String(state.start));
  if (state.end != null) params.set('end', String(state.end));

  setLoading(true);
  setError('');

  try {
    const response = await fetch(`/api/mafia/chat/messages?${params}`, {
      headers: {Accept: 'application/json'},
      signal: requestController.signal
    });
    const payload = await response.json().catch(() => ({}));

    if (sequence !== requestSequence) return;

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `The server answered ${response.status}.`);
    }

    state.total = Number(payload.total) || 0;
    renderMessages(payload.messages);
  } catch (error) {
    if (error.name === 'AbortError' || sequence !== requestSequence) return;
    renderEmpty('Guild chat messages could not be loaded.');
    setError(error.message || 'Guild chat messages could not be loaded.');
  } finally {
    if (sequence === requestSequence) setLoading(false);
  }
}

async function refreshMessages() {
  clearUpdateBanner();
  await loadMessages();
}

function updateSortHeaders() {
  document.querySelectorAll('.chat-table thead th[data-sort]').forEach(header => {
    const key = header.dataset.sort;
    const button = header.querySelector('.sort-button');

    if (key === state.sort) {
      header.setAttribute('aria-sort', state.dir === 'asc' ? 'ascending' : 'descending');
      button.title = `${SORT_LABELS[key]}: sorted ${state.dir === 'asc' ? 'ascending' : 'descending'}`;
    } else {
      header.removeAttribute('aria-sort');
      button.title = `Sort by ${SORT_LABELS[key].toLowerCase()}`;
    }
  });
}

function applySort(key) {
  if (!SORT_LABELS[key]) return;

  if (state.sort === key) {
    state.dir = state.dir === 'desc' ? 'asc' : 'desc';
  } else {
    state.sort = key;
    // Newest first stays the default, including when the column changes.
    state.dir = 'desc';
  }

  updateSortHeaders();
  loadMessages();
}

function hideTooltip() {
  elements.tooltip.hidden = true;
}

function tooltipLine(label, value) {
  const line = document.createElement('div');
  line.className = 'tooltip-line';

  const name = document.createElement('strong');
  name.textContent = `${label}: `;

  line.append(name, document.createTextNode(value));
  return line;
}

function fillTooltip(row) {
  elements.tooltip.replaceChildren(
    tooltipLine('Received', formatLocalIso(row.dataset.receivedAt)),
    tooltipLine('Uploaded by', row.dataset.uploadedBy || 'unknown')
  );
}

function placeTooltip(x, y) {
  const margin = 14;
  const rect = elements.tooltip.getBoundingClientRect();
  let left = x + margin;
  let top = y + margin;

  if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
  if (top + rect.height > window.innerHeight - 8) top = y - rect.height - margin;

  elements.tooltip.style.left = `${Math.max(8, left)}px`;
  elements.tooltip.style.top = `${Math.max(8, top)}px`;
}

function showTooltip(row, x, y) {
  fillTooltip(row);
  elements.tooltip.hidden = false;
  placeTooltip(x, y);
}

function connectLiveFeed() {
  if (!window.io) {
    setConnection('offline', 'Live updates unavailable');
    return;
  }

  let connectedBefore = false;
  const socket = window.io('/mafia', {transports: ['websocket', 'polling']});

  socket.on('connect', () => {
    setConnection('live', 'Live');
    if (connectedBefore) {
      showUpdateBanner('Reconnected — messages saved while you were away need a refresh.');
    }
    connectedBefore = true;
  });

  socket.on('disconnect', () => setConnection('offline', 'Disconnected'));

  socket.on('connect_error', () => setConnection('offline', 'Live updates unavailable'));

  // The backend only announces that rows were inserted. Reloading stays the
  // reader's choice; automatic pulls can be added here later.
  socket.on('chat-updated', detail => {
    const count = Number(detail?.inserted);
    const suffix = Number.isFinite(count) && count > 0
      ? ` (${count} new message${count === 1 ? '' : 's'})`
      : '';
    showUpdateBanner(`New guild chat messages were saved${suffix}. Refresh to show them.`);
  });
}

elements.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = elements.search.value.trim();
    loadMessages();
  }, 150);
});

for (const input of [elements.rangeStart, elements.rangeStartTime, elements.rangeEnd, elements.rangeEndTime]) {
  input.addEventListener('change', () => {
    if (readRange()) loadMessages();
  });
}

elements.rangeClear.addEventListener('click', () => {
  elements.rangeStart.value = '';
  elements.rangeEnd.value = '';
  elements.rangeStartTime.value = DEFAULT_TIME;
  elements.rangeEndTime.value = DEFAULT_TIME;
  state.start = null;
  state.end = null;
  setError('');
  loadMessages();
});

elements.refresh.addEventListener('click', refreshMessages);
elements.bannerRefresh.addEventListener('click', refreshMessages);

document.querySelectorAll('.chat-table thead th[data-sort]').forEach(header => {
  header.addEventListener('click', () => applySort(header.dataset.sort));
});

// Hovering anywhere on a row shows when it was stored and who uploaded it.
elements.body.addEventListener('mouseover', event => {
  const row = event.target.closest('tr');
  if (!row || row.classList.contains('empty-row')) {
    hideTooltip();
    return;
  }
  showTooltip(row, event.clientX, event.clientY);
});

elements.body.addEventListener('mousemove', event => {
  if (elements.tooltip.hidden) return;
  placeTooltip(event.clientX, event.clientY);
});

elements.body.addEventListener('mouseleave', hideTooltip);
elements.tableScroll.addEventListener('scroll', hideTooltip, {passive: true});

updateSortHeaders();
applyDefaultRange();
readRange();
connectLiveFeed();
loadMessages();
