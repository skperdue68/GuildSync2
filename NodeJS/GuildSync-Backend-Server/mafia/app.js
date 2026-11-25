// Alphabet Mafia guild chat archive. Vanilla JS on purpose: this page is served
// as plain files by the GuildSync backend, with no build step.
const SORT_LABELS = {
  time: 'Local time',
  sender: 'Sender',
  message: 'Message'
};
const PAGE_LIMIT = 500;
const DEFAULT_CLOCK = '00';

const state = {
  sort: 'time',
  dir: 'desc',
  search: '',
  start: null,
  end: null,
  total: 0,
  ids: new Set()
};

const elements = {
  body: document.getElementById('chat-body'),
  summary: document.getElementById('table-summary'),
  lastUpdate: document.getElementById('last-update'),
  error: document.getElementById('table-error'),
  tableScroll: document.getElementById('table-scroll'),
  search: document.getElementById('search-input'),
  rangeStart: document.getElementById('range-start'),
  rangeStartHour: document.getElementById('range-start-hour'),
  rangeStartMinute: document.getElementById('range-start-minute'),
  rangeEnd: document.getElementById('range-end'),
  rangeEndHour: document.getElementById('range-end-hour'),
  rangeEndMinute: document.getElementById('range-end-minute'),
  rangeClear: document.getElementById('range-clear'),
  refresh: document.getElementById('refresh-button'),
  banner: document.getElementById('update-banner'),
  bannerText: document.getElementById('update-banner-text'),
  bannerRefresh: document.getElementById('update-banner-refresh'),
  connection: document.getElementById('connection-status'),
  tooltip: document.getElementById('row-tooltip')
};

let searchTimer = null;
let bannerTimer = null;
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

// The clock is a picker, not a typed field: 00-23 hours and 00-59 minutes, so it
// can never fall back to the reader's locale AM/PM rendering.
function fillTimeOptions() {
  const hours = Array.from({length: 24}, (_value, index) => pad(index));
  const minutes = Array.from({length: 60}, (_value, index) => pad(index));

  for (const select of [elements.rangeStartHour, elements.rangeEndHour]) {
    select.replaceChildren(...hours.map(value => new Option(value, value)));
  }

  for (const select of [elements.rangeStartMinute, elements.rangeEndMinute]) {
    select.replaceChildren(...minutes.map(value => new Option(value, value)));
  }
}

// The page opens on today's messages: from today 00:00 to tomorrow 00:00.
function applyDefaultRange() {
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

  elements.rangeStart.value = dateInputValue(today);
  elements.rangeEnd.value = dateInputValue(tomorrow);
  elements.rangeStartHour.value = DEFAULT_CLOCK;
  elements.rangeStartMinute.value = DEFAULT_CLOCK;
  elements.rangeEndHour.value = DEFAULT_CLOCK;
  elements.rangeEndMinute.value = DEFAULT_CLOCK;
}

function setConnection(stateName, label) {
  elements.connection.dataset.state = stateName;
  elements.connection.textContent = label;
}

function setError(message) {
  elements.error.textContent = message || '';
  elements.error.hidden = !message;
}

function markUpdated() {
  elements.lastUpdate.textContent = `Last update: ${formatLocalDate(new Date())}`;
}

function showUpdateBanner(message) {
  elements.bannerText.textContent = message;
  elements.banner.hidden = false;
  elements.refresh.classList.add('refresh-button-attention');

  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(clearUpdateBanner, 6000);
}

function clearUpdateBanner() {
  clearTimeout(bannerTimer);
  elements.banner.hidden = true;
  elements.refresh.classList.remove('refresh-button-attention');
}

// A date plus an hour and a minute picked from the 24-hour clock, read in the
// reader's own time zone.
function parseBoundary(dateInput, hourSelect, minuteSelect) {
  const dateValue = dateInput.value.trim();
  if (!dateValue) return {seconds: null};

  const [year, month, day] = dateValue.split('-').map(Number);
  const hour = Number(hourSelect.value || DEFAULT_CLOCK);
  const minute = Number(minuteSelect.value || DEFAULT_CLOCK);
  const parsed = new Date(year, month - 1, day, hour, minute, 0);

  if (Number.isNaN(parsed.getTime())) return {error: 'The date range is not a valid date.'};

  return {seconds: Math.floor(parsed.getTime() / 1000)};
}

function readRange() {
  const start = parseBoundary(elements.rangeStart, elements.rangeStartHour, elements.rangeStartMinute);
  const end = parseBoundary(elements.rangeEnd, elements.rangeEndHour, elements.rangeEndMinute);

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
  state.ids = new Set();
  elements.summary.textContent = 'No messages';
}

function cell(className, text) {
  const element = document.createElement('td');
  element.className = className;
  element.textContent = text;
  return element;
}

// One row, with everything the client needs to place and de-duplicate it kept
// on the element itself.
function buildRow(message) {
  const row = document.createElement('tr');
  row.className = 'chat-row';
  row.dataset.id = String(message.id ?? '');
  row.dataset.time = String(Number(message.message_timestamp) || 0);
  row.dataset.sender = String(message.sender ?? '');
  row.dataset.message = String(message.message_text ?? '');
  row.dataset.receivedAt = message.received_at || '';
  row.dataset.uploadedBy = message.uploaded_by || '';

  row.append(cell('cell-time', formatLocalTimestamp(message.message_timestamp)));
  row.append(cell('cell-sender', message.sender || 'unknown'));
  row.append(cell('cell-message', message.message_text || ''));

  return row;
}

function rowMessage(row) {
  return {
    id: row.dataset.id,
    message_timestamp: Number(row.dataset.time) || 0,
    sender: row.dataset.sender || '',
    message_text: row.dataset.message || ''
  };
}

function renderMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    renderEmpty('No guild chat messages match these filters.');
    return;
  }

  state.ids = new Set();
  const rows = messages.map(message => {
    const row = buildRow(message);
    state.ids.add(row.dataset.id);
    return row;
  });

  elements.body.replaceChildren(...rows);
  renderSummary(messages.length);
}

// The column the table is sorted by, compared the way the server orders it:
// text is case-insensitive and ties fall back to the id, in the same direction.
function compareText(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, {sensitivity: 'base'});
}

function compareMessage(a, b) {
  const direction = state.dir === 'asc' ? 1 : -1;
  let order;

  if (state.sort === 'time') order = Number(a.message_timestamp) - Number(b.message_timestamp);
  else if (state.sort === 'sender') order = compareText(a.sender, b.sender);
  else order = compareText(a.message_text, b.message_text);

  if (order === 0) order = Number(a.id) - Number(b.id);
  return order * direction;
}

function visibleRows() {
  return Array.from(elements.body.querySelectorAll('tr.chat-row'));
}

// A live row is only shown when it would survive the filters the reader set.
// Free text looks at the message body only.
function matchesFilters(message) {
  const timestamp = Number(message.message_timestamp) || 0;
  if (state.start != null && timestamp < state.start) return false;
  if (state.end != null && timestamp > state.end) return false;

  if (state.search) {
    const needle = state.search.toLowerCase();
    if (!String(message.message_text ?? '').toLowerCase().includes(needle)) return false;
  }

  return true;
}

function insertMessage(message) {
  const id = String(message.id ?? '');
  if (!id || state.ids.has(id) || !matchesFilters(message)) return false;

  const row = buildRow(message);
  const before = visibleRows().find(existing => compareMessage(rowMessage(existing), message) > 0);

  elements.body.querySelector('tr.empty-row')?.remove();

  if (before) elements.body.insertBefore(row, before);
  else elements.body.append(row);

  state.ids.add(id);
  return true;
}

function trimRows() {
  const rows = visibleRows();
  for (let index = rows.length - 1; index >= PAGE_LIMIT; index -= 1) rows[index].remove();
}

// Scrolling stays where the reader left it: rows inserted above the viewport
// would otherwise push everything down.
function captureScrollAnchor() {
  const viewport = elements.tableScroll.getBoundingClientRect();

  for (const row of visibleRows()) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > viewport.top + 1) {
      return {row, offset: rect.top - viewport.top};
    }
  }

  return null;
}

function restoreScrollAnchor(anchor) {
  if (!anchor || !anchor.row.isConnected) return;

  const viewport = elements.tableScroll.getBoundingClientRect();
  const offset = anchor.row.getBoundingClientRect().top - viewport.top;
  if (offset !== anchor.offset) elements.tableScroll.scrollTop += offset - anchor.offset;
}

// Applies the rows the socket delivered and reports how many became visible.
function applyLiveMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  const anchor = captureScrollAnchor();
  let inserted = 0;

  for (const message of messages) {
    if (insertMessage(message)) inserted += 1;
  }

  if (inserted > 0) {
    trimRows();
    restoreScrollAnchor(anchor);
    state.total += inserted;
    renderSummary(visibleRows().length);
  }

  return inserted;
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
    markUpdated();
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
      // Rows saved while the socket was down were never delivered, so pull the
      // page again; the refresh itself keeps the columns in the same order.
      refreshMessages();
    }
    connectedBefore = true;
  });

  socket.on('disconnect', () => setConnection('offline', 'Disconnected'));

  socket.on('connect_error', () => setConnection('offline', 'Live updates unavailable'));

  // The server sends the stored rows themselves. Each one is placed where the
  // current sort puts it, and the reader's scroll position is preserved.
  socket.on('chat-updated', detail => {
    const messages = Array.isArray(detail?.messages) ? detail.messages : [];
    const inserted = applyLiveMessages(messages);

    if (inserted > 0) {
      markUpdated();
      showUpdateBanner(`${inserted} new message${inserted === 1 ? '' : 's'} added.`);
    }
  });
}

elements.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = elements.search.value.trim();
    loadMessages();
  }, 150);
});

for (const input of [
  elements.rangeStart,
  elements.rangeStartHour,
  elements.rangeStartMinute,
  elements.rangeEnd,
  elements.rangeEndHour,
  elements.rangeEndMinute
]) {
  input.addEventListener('change', () => {
    if (readRange()) loadMessages();
  });
}

elements.rangeClear.addEventListener('click', () => {
  elements.rangeStart.value = '';
  elements.rangeEnd.value = '';
  elements.rangeStartHour.value = DEFAULT_CLOCK;
  elements.rangeStartMinute.value = DEFAULT_CLOCK;
  elements.rangeEndHour.value = DEFAULT_CLOCK;
  elements.rangeEndMinute.value = DEFAULT_CLOCK;
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
fillTimeOptions();
applyDefaultRange();
readRange();
connectLiveFeed();
loadMessages();
