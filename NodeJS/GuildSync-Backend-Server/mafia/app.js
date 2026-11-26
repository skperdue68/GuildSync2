// Alphabet Mafia guild chat archive. Vanilla JS on purpose: this page is served
// as plain files by the GuildSync backend, with no build step.
const PAGE_SIZE = 500;
// The archive is always read oldest first: that is what makes scrolling for more
// feel like following a conversation.
const SORT_COLUMN = 'time';
const SORT_DIRECTION = 'asc';
// Start fetching the next batch before the last row is anywhere near the screen.
const PREFETCH_PX = 480;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const HASH_MESSAGE = /^#msg-(\d{1,15})$/;

const state = {
  search: '',
  start: null,
  end: null,
  total: 0,
  latest: 0,
  offset: 0,
  loaded: 0,
  loading: false,
  pendingAbove: 0,
  ids: new Set()
};

const elements = {
  body: document.getElementById('chat-body'),
  summary: document.getElementById('table-summary'),
  latestData: document.getElementById('latest-data'),
  lastUpdate: document.getElementById('last-update'),
  error: document.getElementById('table-error'),
  tableScroll: document.getElementById('table-scroll'),
  search: document.getElementById('search-input'),
  rangeStart: document.getElementById('range-start'),
  rangeEnd: document.getElementById('range-end'),
  rangeClear: document.getElementById('range-clear'),
  pill: document.getElementById('new-messages-pill'),
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

// The page opens on today's messages, starting at midnight.
function applyDefaultRange() {
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

  elements.rangeStart.value = dateInputValue(today);
  elements.rangeEnd.value = dateInputValue(tomorrow);
}

// A date alone means the whole day: 00:00:00 on the from date and 23:59:59 on
// the to date, in the reader's own time zone.
function dayBoundary(dateValue, endOfDay) {
  const [year, month, day] = String(dateValue).split('-').map(Number);
  if (!year || !month || !day) return null;

  const date = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59)
    : new Date(year, month - 1, day, 0, 0, 0);

  return Number.isNaN(date.getTime()) ? null : Math.floor(date.getTime() / 1000);
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
  elements.lastUpdate.textContent = `LAST SCREEN REFRESH: ${formatLocalDate(new Date())}`;
}

function ageingLabel(milliseconds) {
  const hours = Math.floor(milliseconds / 3600000);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

// The newest message stored in the archive, independent of the filters on
// screen. It turns amber once nothing new has arrived for a day.
function refreshLatestText() {
  if (!state.latest) {
    elements.latestData.textContent = 'MOST RECENT DATA: —';
    elements.latestData.dataset.stale = 'false';
    return;
  }

  const age = Date.now() - state.latest * 1000;
  const stale = age > STALE_AFTER_MS;
  elements.latestData.dataset.stale = stale ? 'true' : 'false';
  elements.latestData.textContent =
    `MOST RECENT DATA: ${formatLocalTimestamp(state.latest)}` +
    (stale ? ` · no new data for ${ageingLabel(age)}` : '');
}

function markLatest(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0 || value <= state.latest) return;

  state.latest = value;
  refreshLatestText();
}

function showUpdateBanner(message, {action = true} = {}) {
  elements.bannerText.textContent = message;
  elements.banner.hidden = false;
  elements.bannerRefresh.hidden = !action;
  elements.refresh.classList.add('refresh-button-attention');

  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(clearUpdateBanner, 6000);
}

function clearUpdateBanner() {
  clearTimeout(bannerTimer);
  elements.banner.hidden = true;
  elements.refresh.classList.remove('refresh-button-attention');
}

function readRange() {
  const startValue = elements.rangeStart.value.trim();
  const endValue = elements.rangeEnd.value.trim();

  state.start = startValue ? dayBoundary(startValue, false) : null;
  state.end = endValue ? dayBoundary(endValue, true) : null;

  if (state.start != null && state.end != null && state.start > state.end) {
    setError('The start of the range must be before the end.');
    return false;
  }

  return true;
}

function updateSummary() {
  const total = Number(state.total) || 0;
  const loaded = state.loaded;

  if (total === 0) {
    elements.summary.textContent = 'No messages';
    return;
  }

  const noun = total === 1 ? 'message' : 'messages';
  const parts = [`${total.toLocaleString()} ${noun}`];
  if (loaded < total) parts.push(`showing ${loaded.toLocaleString()}`);
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
  state.loaded = 0;
  updateSummary();
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
  row.id = `msg-${message.id}`;
  row.dataset.id = String(message.id ?? '');
  row.dataset.time = String(Number(message.message_timestamp) || 0);
  row.dataset.receivedAt = message.received_at || '';
  row.dataset.uploadedBy = message.uploaded_by || '';
  row.title = 'Click to copy a link to this message';

  row.append(cell('cell-time', formatLocalTimestamp(message.message_timestamp)));
  row.append(cell('cell-sender', message.sender || 'unknown'));
  row.append(cell('cell-message', message.message_text || ''));

  return row;
}

function visibleRows() {
  return Array.from(elements.body.querySelectorAll('tr.chat-row'));
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
  state.loaded = rows.length;
  updateSummary();
}

function appendMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return;

  const rows = messages
    .filter(message => !state.ids.has(String(message.id)))
    .map(message => {
      const row = buildRow(message);
      state.ids.add(row.dataset.id);
      return row;
    });

  if (rows.length === 0) return;

  elements.body.querySelector('tr.empty-row')?.remove();
  elements.body.append(...rows);
  state.loaded = visibleRows().length;
  updateSummary();
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

// The server owns the collation, so it says how many matching rows sort before
// each pushed row.
async function fetchPositions(messages) {
  const params = new URLSearchParams({
    ids: messages.map(message => String(message.id)).join(','),
    sort: SORT_COLUMN,
    dir: SORT_DIRECTION
  });

  if (state.search) params.set('q', state.search);
  if (state.start != null) params.set('start', String(state.start));
  if (state.end != null) params.set('end', String(state.end));

  const response = await fetch(`/api/mafia/chat/position?${params}`, {
    headers: {Accept: 'application/json'}
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.ok) throw new Error(payload.error || 'Position lookup failed.');
  return Array.isArray(payload.positions) ? payload.positions : [];
}

// Applies pushed rows that belong inside the rows on screen. Rows that sort into
// a stretch that has not been loaded yet are left for that load.
async function applyLiveMessages(messages) {
  const fresh = messages.filter(message => {
    const id = String(message.id ?? '');
    return id && !state.ids.has(id) && matchesFilters(message);
  });

  if (fresh.length === 0) return 0;

  let positions;
  try {
    positions = await fetchPositions(fresh);
  } catch {
    showPill(`${fresh.length} new message${fresh.length === 1 ? '' : 's'} — refresh`, 'refresh');
    return 0;
  }

  const beforeById = new Map(positions.map(position => [String(position.id), position.before]));
  const windowStart = state.offset;
  const atEndOfResults = state.offset + state.loaded >= state.total;
  const anchor = captureScrollAnchor();
  const anchorIndex = anchor ? visibleRows().indexOf(anchor.row) : -1;

  const candidates = [];
  let matched = 0;

  for (const message of fresh) {
    const before = beforeById.get(String(message.id));
    if (before == null) continue;
    matched += 1;

    const index = before - windowStart;
    if (index < 0) continue;
    if (index > state.loaded) continue;
    if (index === state.loaded && !atEndOfResults) continue;

    candidates.push({message, index});
  }

  candidates.sort((a, b) => a.index - b.index || Number(a.message.id) - Number(b.message.id));

  const aboveViewport = anchorIndex >= 0 && candidates.some(candidate => candidate.index <= anchorIndex);

  let inserted = 0;
  for (const {message, index} of candidates) {
    const rows = visibleRows();
    const target = rows[index + inserted];
    const row = buildRow(message);

    elements.body.querySelector('tr.empty-row')?.remove();

    if (target) elements.body.insertBefore(row, target);
    else elements.body.append(row);

    state.ids.add(String(message.id));
    inserted += 1;
  }

  if (matched > 0) {
    state.total += matched;
    state.loaded = visibleRows().length;
    updateSummary();
  }

  if (inserted === 0) return 0;

  state.loaded = visibleRows().length;
  restoreScrollAnchor(anchor);
  updateSummary();

  if (aboveViewport) {
    state.pendingAbove += inserted;
    showPill(`${state.pendingAbove} new message${state.pendingAbove === 1 ? '' : 's'} ↑`, 'scroll');
  }

  return inserted;
}

function showPill(text, mode) {
  elements.pill.textContent = text;
  elements.pill.dataset.mode = mode;
  elements.pill.hidden = false;
}

function hidePill() {
  elements.pill.hidden = true;
  state.pendingAbove = 0;
}

function setLoading(loading) {
  state.loading = loading;
  elements.refresh.disabled = loading;
  if (loading) elements.summary.textContent = 'Loading…';
}

function revealFocusedRow(id) {
  const row = elements.body.querySelector(`tr.chat-row[data-id="${id}"]`);
  if (!row) return;

  row.classList.add('row-flash');
  row.scrollIntoView({block: 'center'});
  setTimeout(() => row.classList.remove('row-flash'), 2400);
}

async function loadPage({offset = 0, limit = PAGE_SIZE, append = false, focus = null} = {}) {
  const sequence = ++requestSequence;
  if (requestController) requestController.abort();
  requestController = new AbortController();

  const params = new URLSearchParams({
    sort: SORT_COLUMN,
    dir: SORT_DIRECTION,
    limit: String(limit),
    offset: String(offset)
  });

  if (state.search) params.set('q', state.search);
  if (state.start != null) params.set('start', String(state.start));
  if (state.end != null) params.set('end', String(state.end));
  if (focus != null) params.set('focus', String(focus));

  setLoading(true);
  if (!append) setError('');

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
    // On append the window start stays put; the payload offset is the start of
    // the batch just added.
    if (!append) state.offset = Number(payload.offset) || 0;
    markLatest(payload.latest);

    if (append) appendMessages(payload.messages);
    else renderMessages(payload.messages);

    markUpdated();

    if (focus != null && payload.messages?.[0]) revealFocusedRow(payload.messages[0].id);
  } catch (error) {
    if (error.name === 'AbortError' || sequence !== requestSequence) return;
    if (!append) {
      renderEmpty('Guild chat messages could not be loaded.');
      setError(error.message || 'Guild chat messages could not be loaded.');
    }
  } finally {
    if (sequence === requestSequence) {
      setLoading(false);
      setTimeout(maybeLoadMore, 0);
    }
  }
}

// Scrolling toward the end quietly fetches the next stretch of rows.
function maybeLoadMore() {
  if (state.loading || state.loaded >= state.total) return;

  const scroller = elements.tableScroll;
  const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  if (remaining > PREFETCH_PX) return;

  loadPage({offset: state.offset + state.loaded, append: true});
}

// Refresh in place: the same rows are fetched again, so scrolling through the
// archive is never undone by pressing Refresh.
async function refreshCurrent() {
  hidePill();
  clearUpdateBanner();

  const scrollTop = elements.tableScroll.scrollTop;
  const start = state.offset;
  const target = Math.max(PAGE_SIZE, state.loaded);
  let first = true;

  do {
    const limit = Math.min(PAGE_SIZE, Math.max(1, target - (first ? 0 : state.loaded)));
    const before = state.loaded;

    await loadPage({offset: start + (first ? 0 : state.loaded), limit, append: !first});

    const added = first ? state.loaded : state.loaded - before;
    first = false;
    if (added <= 0) break;
  } while (state.loaded < target);

  elements.tableScroll.scrollTop = scrollTop;
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

async function copyMessageLink(row) {
  const link = `${location.origin}${location.pathname}#msg-${row.dataset.id}`;

  try {
    await navigator.clipboard.writeText(link);
  } catch {
    const area = document.createElement('textarea');
    area.value = link;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();

    try {
      document.execCommand('copy');
    } finally {
      area.remove();
    }
  }

  showUpdateBanner(`Link copied: ${link}`, {action: false});
}

function hashFocusId() {
  const match = HASH_MESSAGE.exec(String(location.hash || ''));
  return match ? Number(match[1]) : null;
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
      // Rows saved while the socket was down were never delivered.
      showPill('Reconnected — refresh for missed messages', 'refresh');
    }
    connectedBefore = true;
  });

  socket.on('disconnect', () => setConnection('offline', 'Disconnected'));

  socket.on('connect_error', () => setConnection('offline', 'Live updates unavailable'));

  socket.on('chat-updated', async detail => {
    const messages = Array.isArray(detail?.messages) ? detail.messages : [];

    if (messages.length > 0) {
      markLatest(Math.max(...messages.map(message => Number(message.message_timestamp) || 0)));
    }

    // A bulk upload only announces its size; the page reloads on request.
    if (detail?.bulk) {
      const count = Number(detail.inserted) || messages.length;
      showPill(`${count} new message${count === 1 ? '' : 's'} — refresh`, 'refresh');
      showUpdateBanner(`${count} messages were saved. Refresh to show them.`);
      return;
    }

    if (messages.length === 0) return;

    const inserted = await applyLiveMessages(messages);

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
    hidePill();
    loadPage({offset: 0});
  }, 150);
});

for (const input of [elements.rangeStart, elements.rangeEnd]) {
  input.addEventListener('change', () => {
    if (readRange()) {
      hidePill();
      loadPage({offset: 0});
    }
  });
}

elements.rangeClear.addEventListener('click', () => {
  elements.rangeStart.value = '';
  elements.rangeEnd.value = '';
  state.start = null;
  state.end = null;
  setError('');
  hidePill();
  loadPage({offset: 0});
});

elements.pill.addEventListener('click', () => {
  if (elements.pill.dataset.mode === 'refresh') {
    refreshCurrent();
    return;
  }

  elements.tableScroll.scrollTop = 0;
  hidePill();
});

elements.refresh.addEventListener('click', refreshCurrent);
elements.bannerRefresh.addEventListener('click', refreshCurrent);

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
elements.tableScroll.addEventListener('scroll', maybeLoadMore, {passive: true});

// Clicking a row copies a permalink to that message.
elements.body.addEventListener('click', event => {
  const row = event.target.closest('tr.chat-row');
  if (!row) return;
  if (String(window.getSelection() || '').trim()) return;
  copyMessageLink(row);
});

refreshLatestText();

const focusId = hashFocusId();
if (focusId != null) {
  // A permalink is about that message, not today's range, so show the archive.
  elements.rangeStart.value = '';
  elements.rangeEnd.value = '';
  state.start = null;
  state.end = null;
} else {
  applyDefaultRange();
  readRange();
}

connectLiveFeed();
loadPage({focus: focusId});
setInterval(refreshLatestText, 60000);
