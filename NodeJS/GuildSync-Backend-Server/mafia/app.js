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
// How close to the end of the window still counts as being at the bottom.
const BOTTOM_SLACK = 24;
// How long the + stays on a row that arrived while the page was open, counted
// from the moment the row first becomes half visible.
const NEW_MARK_MS = 60000;
const FOLLOW_STORAGE_KEY = 'mafia-follow-newest';
// New rows settle for a moment after they land, so "am I still at the bottom?"
// is not settled either. This is how long that is ignored.
const FOLLOW_SETTLE_MS = 700;
// A toast lingers this long before it fades out.
const TOAST_MS = 3200;
// Day names are fixed rather than taken from the browser locale so the bands
// and the sticky tab read the same for everyone, like the timestamps do.
const WEEK_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const state = {
  search: '',
  start: null,
  end: null,
  total: 0,
  latest: 0,
  offset: 0,
  loaded: 0,
  loading: false,
  // Following the newest row: remembered between visits, off until pressed.
  follow: false,
  // Where the reader was before a search, so clearing it can go back.
  savedView: null,
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
  connection: document.getElementById('connection-status'),
  tooltip: document.getElementById('row-tooltip'),
  follow: document.getElementById('follow-button'),
  edgeTop: document.getElementById('edge-top'),
  edgeTopText: document.getElementById('edge-top-text'),
  edgeBottom: document.getElementById('edge-bottom'),
  edgeBottomText: document.getElementById('edge-bottom-text'),
  dateTab: document.getElementById('date-tab-row'),
  dateTabText: document.getElementById('date-tab'),
  toasts: document.getElementById('toast-stack')
};

let searchTimer = null;
let requestController = null;
let requestSequence = 0;
// Following: how long "not at the bottom" is ignored after we scrolled the
// window ourselves, and whether the reader has scrolled since we last pinned it.
let followSettleUntil = 0;
let readerMoved = false;
let settleTimer = null;
// A permalink is placed and then re-checked: the browser scrolls to a matching
// fragment by itself once the row exists, which lands it at the very top of the
// table after we have put it in view. A reader scrolling up stops the checks.
let focusCorrectionCancelled = false;
// Following only ever scrolls down, so a window that moved up was moved by the
// reader — by wheel, keys, or dragging the scrollbar, which fires no input
// events of its own.
let lastScrollTop = 0;

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

// The row itself shows only the clock: the day is named by the band above it and
// by the tab in the header.
function formatLocalClock(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value * 1000);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatLocalIso(isoString) {
  if (!isoString) return '—';
  return formatLocalDate(new Date(isoString)) || '—';
}

// Midnight today in the reader's own time zone: where a fresh page starts when
// it is not following the newest line.
function todayStart() {
  const now = new Date();
  return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
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

// What just happened — a copied link, rows that arrived live — reported as a
// toast above the hint, so nothing the reader is looking at moves.
function showToast(text) {
  if (!elements.toasts) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = text;
  elements.toasts.append(toast);

  // Three is enough to say the same thing twice without covering the table.
  while (elements.toasts.children.length > 3) elements.toasts.firstElementChild.remove();

  setTimeout(() => {
    toast.classList.add('toast-leaving');
    setTimeout(() => toast.remove(), 240);
  }, TOAST_MS);
}

// The to date may equal the from date (that day still runs to 23:59:59) but it
// may never be earlier. Moving the from date past the to date pulls the end
// date onto it instead of leaving an impossible range behind.
function syncRangeBounds() {
  const start = elements.rangeStart.value.trim();
  const end = elements.rangeEnd.value.trim();

  elements.rangeEnd.min = start;

  if (start && end && end < start) elements.rangeEnd.value = start;
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
  markObserver?.disconnect();
  const row = document.createElement('tr');
  row.className = 'empty-row';
  const cell = document.createElement('td');
  cell.colSpan = 3;
  cell.textContent = message;
  row.append(cell);
  elements.body.replaceChildren(row);
  state.ids = new Set();
  state.loaded = 0;
  updateDateTab();
  updateSummary();
}

function cell(className, text) {
  const element = document.createElement('td');
  element.className = className;
  element.textContent = text;
  return element;
}

// Deterministic colour per sender: FNV-1a over the name, hue = |hash| % 360,
// saturation locked at 70%. Lightness is 74% rather than 60% because this page
// is navy: 60% put the blue-violet hues under 2:1 on a hovered row and below
// 3:1 even on the plain background, so they could not be read at all.
function senderHash(name) {
  const text = String(name ?? '').trim().toLowerCase();
  let hash = 0x811c9dc5;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash | 0;
}

function senderColor(name) {
  return `hsl(${Math.abs(senderHash(name)) % 360}, 70%, 74%)`;
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

  // Officer chat belongs to the same guild but is a private conversation, so
  // the row is marked instead of being mixed in silently.
  const channel = String(message.channel || '').toLowerCase() === 'officer' ? 'officer' : 'guild';
  row.dataset.channel = channel;
  row.classList.toggle('chat-row-officer', channel === 'officer');

  const messageCell = cell('cell-message', message.message_text || '');

  if (channel === 'officer') {
    const tag = document.createElement('span');
    tag.className = 'officer-tag';
    tag.textContent = 'OFFICER';
    messageCell.prepend(tag);
  }

  const timeCell = document.createElement('td');
  timeCell.className = 'cell-time';

  const timeLine = document.createElement('span');
  timeLine.className = 'cell-time-line';

  // The slot is reserved on every row so a fading mark never moves a timestamp.
  const mark = document.createElement('span');
  mark.className = 'row-new-mark';
  mark.dataset.mark = 'none';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = '+';

  const timeText = document.createElement('span');
  timeText.textContent = formatLocalClock(message.message_timestamp);

  timeLine.append(mark, timeText);
  timeCell.append(timeLine);

  const color = senderColor(message.sender);
  const senderCell = cell('cell-sender', message.sender || 'unknown');
  senderCell.style.color = color;
  messageCell.style.color = color;

  row.append(timeCell, senderCell, messageCell);

  return row;
}

function visibleRows() {
  return Array.from(elements.body.querySelectorAll('tr.chat-row'));
}

// One name per calendar day, in the reader's own time zone.
function dayKey(seconds) {
  return new Date(seconds * 1000).toDateString();
}

function dayLabel(seconds) {
  const date = new Date(seconds * 1000);
  return `${WEEK_DAYS[date.getDay()]}, ${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

function buildDateBand(seconds) {
  const row = document.createElement('tr');
  row.className = 'date-row';
  row.dataset.day = dayKey(seconds);

  const cell = document.createElement('td');
  cell.colSpan = 3;
  cell.textContent = dayLabel(seconds);

  row.append(cell);
  return row;
}

// Bands are derived from the rows that are actually on screen: one where the
// loaded window begins and one wherever the day changes, so a band never stands
// above rows that are not there. Running this after any change keeps them right
// when rows arrive in the middle of the list.
function syncBands() {
  let previousDay = null;

  for (const row of visibleRows()) {
    const time = Number(row.dataset.time) || 0;
    const day = dayKey(time);
    const previous = row.previousElementSibling;
    const band = previous && previous.classList.contains('date-row') ? previous : null;

    if (previousDay === null || day !== previousDay) {
      if (!band) {
        row.before(buildDateBand(time));
      } else if (band.dataset.day !== day) {
        band.dataset.day = day;
        band.firstElementChild.textContent = dayLabel(time);
      }
    } else if (band) {
      // The window grew upwards inside the same day, so what used to be the top
      // of the window is no longer a day change.
      band.remove();
    }

    previousDay = day;
  }

  updateDateTab();
}

function renderMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    renderEmpty('No guild chat messages match these filters.');
    return;
  }

  markObserver?.disconnect();
  state.ids = new Set();
  const rows = messages.map(message => {
    const row = buildRow(message);
    state.ids.add(row.dataset.id);
    return row;
  });

  elements.body.replaceChildren(...rows);
  syncBands();
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
  syncBands();
  state.loaded = visibleRows().length;
  updateSummary();
}

// Rows from before the current window: a permalink lands mid-archive, so the
// conversation above the linked line is loaded rather than missing.
function prependMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  const rows = messages
    .filter(message => !state.ids.has(String(message.id)))
    .map(message => {
      const row = buildRow(message);
      state.ids.add(row.dataset.id);
      return row;
    });

  if (rows.length === 0) return 0;

  elements.body.prepend(...rows);
  syncBands();
  state.loaded = visibleRows().length;
  updateSummary();

  return rows.length;
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
    showPill(`${fresh.length} new message${fresh.length === 1 ? '' : 's'} — refresh`);
    return 0;
  }

  const beforeById = new Map(positions.map(position => [String(position.id), position.before]));
  const windowStart = state.offset;
  const atEndOfResults = state.offset + state.loaded >= state.total;
  const followFromBottom = isFollowingBottom();
  const anchor = captureScrollAnchor();

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

  let inserted = 0;
  for (const {message, index} of candidates) {
    const rows = visibleRows();
    const target = rows[index + inserted];
    const row = buildRow(message);

    elements.body.querySelector('tr.empty-row')?.remove();

    if (target) elements.body.insertBefore(row, target);
    else elements.body.append(row);

    markRowAsNew(row);
    state.ids.add(String(message.id));
    inserted += 1;
  }

  syncBands();

  if (matched > 0) {
    state.total += matched;
    state.loaded = visibleRows().length;
    updateSummary();
  }

  if (inserted === 0) return 0;

  state.loaded = visibleRows().length;

  // Following only ever moves the window down. A row that landed above the
  // window keeps the reader exactly where they were; one that landed at the
  // bottom carries them with it.
  if (followFromBottom) scrollToNewest();
  else restoreScrollAnchor(anchor);

  updateSummary();
  updateEdgeStrips();

  return inserted;
}

// The pill only ever asks for a refresh: rows that arrived while the socket was
// down, or a bulk upload whose size is all it announced.
function showPill(text) {
  elements.pill.textContent = text;
  elements.pill.hidden = false;
}

function hidePill() {
  elements.pill.hidden = true;
}

// A background batch — the next stretch of rows, or the rows above a permalink
// — is not something the reader asked for, so it neither disables Refresh nor
// takes the summary over: flipping both twice within a moment reads as a
// flicker on the header button.
function beginLoading(background) {
  state.loading = true;
  if (background) return;

  elements.refresh.disabled = true;
  elements.summary.textContent = 'Loading…';
}

function endLoading(background) {
  state.loading = false;
  if (background) return;

  elements.refresh.disabled = false;
}

// --- Following the newest row -------------------------------------------

function readFollowPreference() {
  try {
    return localStorage.getItem(FOLLOW_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveFollowPreference(following) {
  try {
    localStorage.setItem(FOLLOW_STORAGE_KEY, following ? 'true' : 'false');
  } catch {
    // Blocked storage is not worth breaking the page over; the choice just
    // does not survive the reload.
  }
}

function isAtBottom() {
  const scroller = elements.tableScroll;
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= BOTTOM_SLACK;
}

// True while following, including the moment right after a programmatic scroll
// to the bottom, when the browser is still settling the new rows.
function isFollowingBottom() {
  return state.follow && (isAtBottom() || performance.now() < followSettleUntil);
}

function scrollToNewest() {
  const scroller = elements.tableScroll;

  readerMoved = false;
  followSettleUntil = performance.now() + FOLLOW_SETTLE_MS;
  scroller.scrollTop = scroller.scrollHeight;

  // Once the new rows have settled, say so even if nothing scrolls again.
  clearTimeout(settleTimer);
  settleTimer = setTimeout(updateEdgeStrips, FOLLOW_SETTLE_MS + 50);
}

// The button is where following says it is on, and where it says it stopped
// keeping up because the reader scrolled away from the bottom.
function updateFollowControls() {
  const paused = state.follow && !isFollowingBottom();
  const label = !state.follow ? 'Follow newest' : paused ? 'Following paused' : 'Following';

  const following = state.follow ? 'true' : 'false';
  if (elements.follow.dataset.following !== following) {
    elements.follow.dataset.following = following;
    elements.follow.setAttribute('aria-pressed', following);
  }
  elements.follow.dataset.paused = paused ? 'true' : 'false';

  if (elements.follow.textContent !== label) elements.follow.textContent = label;

  elements.follow.title = !state.follow
    ? 'Keep the newest message in view as rows arrive'
    : paused
      ? 'You scrolled away — click to jump back to the newest message'
      : 'Stop following the newest message';
}

async function toggleFollow() {
  if (!state.follow) {
    state.follow = true;
    saveFollowPreference(true);
    hidePill();

    // Pressing it is asking to see the newest row now, even when the window is
    // still parked on today's first message.
    if (state.offset + state.loaded >= state.total) scrollToNewest();
    else await openAtNewest();
  } else if (!isFollowingBottom()) {
    // Pressed while paused: take me back down rather than stop following.
    scrollToNewest();
  } else {
    state.follow = false;
    saveFollowPreference(false);
  }

  updateFollowControls();
  updateEdgeStrips();
}

// --- The + on rows that arrive while the page is open --------------------

// A row's minute only starts once the row is at least half on screen, so a row
// that lands off-screen keeps its mark until the reader scrolls to it.
const markObserver = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver(
    entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.5) continue;

        markObserver.unobserve(entry.target);

        const mark = entry.target.querySelector('.row-new-mark');
        if (!mark || mark.dataset.mark !== 'new') continue;

        setTimeout(() => {
          if (mark.dataset.mark === 'new') mark.dataset.mark = 'expired';
        }, NEW_MARK_MS);
      }
    },
    {root: elements.tableScroll, threshold: 0.5}
  )
  : null;

function markRowAsNew(row) {
  const mark = row.querySelector('.row-new-mark');
  if (!mark) return;

  mark.dataset.mark = 'new';
  mark.title = 'Arrived while you were watching';
  mark.removeAttribute('aria-hidden');
  mark.setAttribute('aria-label', 'new message');

  if (markObserver) {
    markObserver.observe(row);
    return;
  }

  // No IntersectionObserver: fall back to timing from insertion.
  setTimeout(() => {
    if (mark.dataset.mark === 'new') mark.dataset.mark = 'expired';
  }, NEW_MARK_MS);
}

// A refresh that pulled in rows the reader had not seen marks them too.
function markRowsArrivedDuringRefresh(knownIds) {
  for (const row of visibleRows()) {
    if (knownIds.has(row.dataset.id)) continue;
    if (row.querySelector('.row-new-mark')?.dataset.mark === 'new') continue;
    markRowAsNew(row);
  }
}

// --- Edge indicators ----------------------------------------------------

function messages(count, word = 'message') {
  return `${count.toLocaleString()} ${count === 1 ? word : `${word}s`}`;
}

// The tab under the column labels names the day of the first row the reader can
// actually see, so a window that starts mid-day still says which day it is.
function updateDateTab() {
  const rows = visibleRows();
  if (rows.length === 0) {
    elements.dateTab.hidden = true;
    return;
  }

  // Unhide first: the tab row is part of the header, so the header is only its
  // full 60px once the row is displayed.
  elements.dateTab.hidden = false;

  const scroller = elements.tableScroll;
  const thead = scroller.querySelector('thead');
  const edge = scroller.getBoundingClientRect().top + (thead ? thead.offsetHeight : 0);

  let low = 0;
  let high = rows.length - 1;
  let current = rows[rows.length - 1];

  while (low <= high) {
    const middle = (low + high) >> 1;
    if (rows[middle].getBoundingClientRect().bottom > edge + 1) {
      current = rows[middle];
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  const label = dayLabel(Number(current.dataset.time) || 0);
  if (elements.dateTabText.textContent !== label) elements.dateTabText.textContent = label;
}

function updateEdgeStrips() {
  // The header grows when the date tab is showing; the top strip has to sit
  // under whatever height it actually has, not an assumed 38px.
  const head = elements.tableScroll.querySelector('thead');
  document.documentElement.style.setProperty('--mafia-header-height', `${head ? head.offsetHeight : 0}px`);

  const viewport = elements.tableScroll.getBoundingClientRect();
  let above = 0;
  let below = 0;
  let freshAbove = false;
  let freshBelow = false;

  for (const row of visibleRows()) {
    const rect = row.getBoundingClientRect();
    const fresh = Boolean(row.querySelector('.row-new-mark[data-mark="new"]'));

    if (rect.bottom <= viewport.top + 1) {
      above += 1;
      if (fresh) freshAbove = true;
    } else if (rect.top >= viewport.bottom - 1) {
      below += 1;
      if (fresh) freshBelow = true;
    }
  }

  updateFollowControls();
  updateDateTab();

  if (above === 0) {
    elements.edgeTop.hidden = true;
  } else {
    elements.edgeTop.hidden = false;
    elements.edgeTopText.textContent = `↑ ${messages(above, freshAbove ? 'new message' : 'earlier message')} above`;
  }

  const unloaded = Math.max(0, Number(state.total) - state.offset - state.loaded);
  const paused = state.follow && !isFollowingBottom();

  if (below === 0 && unloaded === 0) {
    elements.edgeBottom.hidden = true;
    elements.edgeBottom.dataset.paused = 'false';
    return;
  }

  let label;
  if (freshBelow) label = `↓ ${messages(below, 'new message')} below`;
  else if (below > 0) label = `↓ ${messages(below)} below`;
  else label = `↓ ${messages(unloaded, 'more message')} below`;

  if (paused) label = `${label} · following paused`;

  elements.edgeBottom.hidden = false;
  elements.edgeBottom.dataset.paused = paused ? 'true' : 'false';
  if (elements.edgeBottomText.textContent !== label) elements.edgeBottomText.textContent = label;
}

let edgeFrame = 0;

// Scrolling fires far faster than the strips need to be recalculated.
function scheduleEdgeUpdate() {
  if (edgeFrame) return;
  edgeFrame = window.requestAnimationFrame(() => {
    edgeFrame = 0;

    // Following stays pinned while the freshly inserted rows settle. Any scroll
    // the page did not make itself stops that, and the button says it is paused.
    if (state.follow) {
      if (isAtBottom()) readerMoved = false;
      else if (!readerMoved) {
        scrollToNewest();
        return;
      }
    }

    updateEdgeStrips();
  });
}

// The row a link pointed at stays marked until another link is followed, so it
// never becomes a guess which line the page was opened for.
function highlightRow(row) {
  for (const previous of elements.body.querySelectorAll('tr.row-target')) {
    if (previous !== row) previous.classList.remove('row-target');
  }

  row.classList.add('row-target');
}

// Where the row has to sit: inside the part of the table the sticky column
// headers do not cover, and inside the browser window. The browser's own
// centring clamps a row that is first in the loaded window to the very top,
// which leaves it behind the headers.
function scrollRowIntoView(row) {
  const scroller = elements.tableScroll;
  const thead = scroller.querySelector('thead');
  const headerHeight = thead ? thead.offsetHeight : 0;
  const viewport = scroller.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  const rowOffset = rect.top - viewport.top + scroller.scrollTop;
  const freeHeight = Math.max(0, scroller.clientHeight - headerHeight);

  scroller.scrollTop = Math.max(0, rowOffset - headerHeight - Math.max(0, (freeHeight - rect.height) / 2));

  // The table itself has to be on screen too, not just the row inside it.
  const placed = row.getBoundingClientRect();
  if (placed.top < 8) window.scrollBy(0, placed.top - 8);
  else if (placed.bottom > window.innerHeight - 8) window.scrollBy(0, placed.bottom - (window.innerHeight - 8));
}

function revealFocusedRow(id) {
  const row = elements.body.querySelector(`tr.chat-row[data-id="${id}"]`);
  if (!row) return false;

  // A permalink is about one line, so it is not following the newest row.
  readerMoved = true;
  scrollRowIntoView(row);
  highlightRow(row);

  return true;
}

// A permalink has to leave its message on screen. The batch above it is laid out
// after the first scroll, and row heights can settle again on the next frame, so
// the position is checked once more and corrected if the row ended up outside
// the window.
function ensureFocusedMessage(id) {
  const row = elements.body.querySelector(`tr.chat-row[data-id="${id}"]`);
  if (!row) return;

  focusCorrectionCancelled = false;

  const keepVisible = () => {
    if (focusCorrectionCancelled || !row.isConnected) return;

    const scroller = elements.tableScroll;
    const thead = scroller.querySelector('thead');
    const headerHeight = thead ? thead.offsetHeight : 0;
    const viewport = scroller.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    const insideTable = rect.top >= viewport.top + headerHeight && rect.bottom <= viewport.bottom;
    const insideWindow = rect.bottom > 0 && rect.top < window.innerHeight;
    if (insideTable && insideWindow) return;

    readerMoved = true;
    scrollRowIntoView(row);
  };

  keepVisible();
  window.requestAnimationFrame(keepVisible);
  for (const delay of [120, 350, 700, 1200, 1800]) setTimeout(keepVisible, delay);
}

// Land on the message a permalink asks for, with the rows above it in place and
// the message itself on screen.
async function landOnMessage(id) {
  revealFocusedRow(id);
  await loadEarlier();
  ensureFocusedMessage(id);
  updateEdgeStrips();
}

// A fresh page and a permalink both start with no search and no dates. Going
// through the fields also undoes values a browser restored on reload.
function clearFilters() {
  elements.search.value = '';
  elements.rangeStart.value = '';
  elements.rangeEnd.value = '';
  elements.rangeEnd.removeAttribute('min');
  state.search = '';
  state.start = null;
  state.end = null;
  state.savedView = null;
  hidePill();
}

// The totals for the filters on screen, without loading a page of rows.
async function fetchFilteredTotal() {
  const params = new URLSearchParams({sort: SORT_COLUMN, dir: SORT_DIRECTION, limit: '1', offset: '0'});
  if (state.search) params.set('q', state.search);
  if (state.start != null) params.set('start', String(state.start));
  if (state.end != null) params.set('end', String(state.end));

  try {
    const response = await fetch(`/api/mafia/chat/messages?${params}`, {headers: {Accept: 'application/json'}});
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) return null;

    markLatest(payload.latest);
    return Number(payload.total) || 0;
  } catch {
    return null;
  }
}

// The first message at or after midnight today, so a page that is not following
// can open on the start of today rather than on the oldest row in the archive.
async function fetchTodayAnchor() {
  const params = new URLSearchParams({
    sort: SORT_COLUMN,
    dir: SORT_DIRECTION,
    limit: '1',
    offset: '0',
    start: String(todayStart())
  });

  try {
    const response = await fetch(`/api/mafia/chat/messages?${params}`, {headers: {Accept: 'application/json'}});
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) return null;

    markLatest(payload.latest);
    const first = Array.isArray(payload.messages) ? payload.messages[0] : null;
    return first && first.id != null ? String(first.id) : null;
  } catch {
    return null;
  }
}

// The last page of whatever the filters allow, shown from the bottom.
async function openAtNewest() {
  const total = await fetchFilteredTotal();

  if (!total) {
    await loadPage({offset: 0});
    return;
  }

  await loadPage({offset: Math.max(0, total - PAGE_SIZE)});
  scrollToNewest();
}

// Where a fresh look at the archive begins: the newest line while following,
// the first line of today otherwise, and the start of a range or a search when
// those are set.
async function openWindow() {
  if (state.follow) {
    await openAtNewest();
    return;
  }

  if (state.search || state.start != null || state.end != null) {
    await loadPage({offset: 0});
    elements.tableScroll.scrollTop = 0;
    return;
  }

  const anchor = await fetchTodayAnchor();
  if (anchor == null) {
    await openAtNewest();
    return;
  }

  await loadPage({focus: Number(anchor)});
  elements.tableScroll.scrollTop = 0;
  readerMoved = true;
  updateEdgeStrips();
}

async function loadPage({offset = 0, limit = PAGE_SIZE, append = false, prepend = false, focus = null, background = append || prepend} = {}) {
  const sequence = ++requestSequence;
  // Read before the fetch: whether the reader was watching the bottom.
  const followFromBottom = isFollowingBottom();
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

  beginLoading(background);
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
    // Appending keeps the window start where it is; every other load starts the
    // window at the offset the server answered with, which is also where a
    // permalink-focused or an earlier batch begins.
    if (!append) state.offset = Number(payload.offset) || 0;
    markLatest(payload.latest);

    if (prepend) prependMessages(payload.messages);
    else if (append) {
      appendMessages(payload.messages);
      // An empty batch means the window already reaches the end of the results,
      // even if the rows above it are still unloaded; without this the page
      // would keep asking for that same empty page.
      if (payload.messages.length === 0) state.total = state.offset + state.loaded;
    } else renderMessages(payload.messages);

    markUpdated();

    if (followFromBottom) {
      scrollToNewest();

      // Rows and the date tab can still settle a frame or two after the first
      // scroll, which leaves the window short of the bottom; pin it again unless
      // the reader has taken over in the meantime.
      for (const delay of [60, 240, 700]) {
        setTimeout(() => {
          if (state.follow && !readerMoved && !isAtBottom()) scrollToNewest();
        }, delay);
      }
    }

    updateEdgeStrips();
  } catch (error) {
    if (error.name === 'AbortError' || sequence !== requestSequence) return;
    if (!append) {
      renderEmpty('Guild chat messages could not be loaded.');
      setError(error.message || 'Guild chat messages could not be loaded.');
    }
  } finally {
    if (sequence === requestSequence) {
      endLoading(background);
      setTimeout(maybeLoadMore, 0);
    }
  }
}

// The rows before the current window, fetched with the reading position kept:
// a permalink can land in the middle of the archive, and scrolling up from
// there has to keep walking the conversation backwards.
async function loadEarlier() {
  if (state.loading || state.offset <= 0) return;

  const scroller = elements.tableScroll;
  const scrollTop = scroller.scrollTop;
  const scrollHeight = scroller.scrollHeight;
  const offset = Math.max(0, state.offset - PAGE_SIZE);
  const limit = state.offset - offset;

  await loadPage({offset, limit, prepend: true});

  // Only rows above the viewport were added, so shifting down by exactly the
  // height that was added keeps the reader on the same line. Measuring the rows
  // themselves is unreliable here: the browser's own scroll anchoring may have
  // moved the window already.
  scroller.scrollTop = scrollTop + (scroller.scrollHeight - scrollHeight);
}

// Scrolling quietly fetches the next stretch of rows, in either direction.
function maybeLoadMore() {
  if (state.loading) return;

  const scroller = elements.tableScroll;

  if (scroller.scrollTop <= PREFETCH_PX && state.offset > 0) {
    loadEarlier();
    return;
  }

  // The window can start anywhere, so it is the end of the window that counts.
  if (state.offset + state.loaded >= state.total) return;

  const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  if (remaining > PREFETCH_PX) return;

  loadPage({offset: state.offset + state.loaded, append: true});
}

// Refresh in place: the same rows are fetched again, so scrolling through the
// archive is never undone by pressing Refresh.
async function refreshCurrent() {
  hidePill();

  const scrollTop = elements.tableScroll.scrollTop;
  const followFromBottom = isFollowingBottom();
  // Rows that were not on screen before this refresh arrived just now.
  const knownIds = new Set(state.ids);
  const start = state.offset;
  const target = Math.max(PAGE_SIZE, state.loaded);
  let first = true;

  // The refresh keeps the button for as long as it runs, so pressing it again
  // part-way through cannot start a second one; its batches load quietly.
  elements.refresh.disabled = true;

  try {
    do {
      const limit = Math.min(PAGE_SIZE, Math.max(1, target - (first ? 0 : state.loaded)));
      const before = state.loaded;

      await loadPage({offset: start + (first ? 0 : state.loaded), limit, append: !first, background: true});

      const added = first ? state.loaded : state.loaded - before;
      first = false;
      if (added <= 0) break;
    } while (state.loaded < target);
  } finally {
    elements.refresh.disabled = false;
  }

  if (followFromBottom) scrollToNewest();
  else elements.tableScroll.scrollTop = scrollTop;

  markRowsArrivedDuringRefresh(knownIds);
  updateEdgeStrips();
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
    tooltipLine('Channel', row.dataset.channel === 'officer' ? 'Officer chat' : 'Guild chat'),
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

  // A double-click leaves the word under the pointer selected; that is noise
  // once the link is on the clipboard.
  window.getSelection()?.removeAllRanges();
  showToast('Link copied to clipboard');
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
      showPill('Reconnected — refresh for missed messages');
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
      showPill(`${count} new message${count === 1 ? '' : 's'} — refresh`);
      showToast(`${count} new message${count === 1 ? '' : 's'} arrived — refresh to show them`);
      return;
    }

    if (messages.length === 0) return;

    const inserted = await applyLiveMessages(messages);

    if (inserted > 0) {
      markUpdated();
      showToast(`${inserted} new message${inserted === 1 ? '' : 's'} added`);
    }
  });
}

// Where the reader was before a search, kept so clearing the box goes back there
// instead of dropping them at the top of the archive.
function captureView() {
  const viewport = elements.tableScroll.getBoundingClientRect();
  const rows = visibleRows();
  const anchor = rows.find(row => row.getBoundingClientRect().bottom > viewport.top + 1) || rows[0] || null;

  return {
    offset: state.offset,
    loaded: state.loaded,
    scrollTop: elements.tableScroll.scrollTop,
    anchorId: anchor ? anchor.dataset.id : null,
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - viewport.top : 0
  };
}

async function restoreView(view) {
  await loadPage({
    offset: view.offset,
    limit: Math.min(1000, Math.max(PAGE_SIZE, view.loaded || PAGE_SIZE))
  });

  if (state.loaded === 0) {
    await loadPage({offset: 0});
    return;
  }

  const scroller = elements.tableScroll;
  const row = view.anchorId
    ? elements.body.querySelector(`tr.chat-row[data-id="${view.anchorId}"]`)
    : null;

  if (row) {
    const viewport = scroller.getBoundingClientRect();
    scroller.scrollTop += (row.getBoundingClientRect().top - viewport.top) - view.anchorOffset;
  } else {
    scroller.scrollTop = view.scrollTop;
  }

  updateEdgeStrips();
}

elements.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const value = elements.search.value.trim();
    const wasActive = Boolean(state.search);

    if (!wasActive && value) state.savedView = captureView();
    state.search = value;
    hidePill();

    if (!value && wasActive && state.savedView) {
      const view = state.savedView;
      state.savedView = null;
      await restoreView(view);
      return;
    }

    await openWindow();
  }, 150);
});

for (const input of [elements.rangeStart, elements.rangeEnd]) {
  input.addEventListener('change', () => {
    syncRangeBounds();

    if (!readRange()) return;
    hidePill();
    openWindow();
  });
}

elements.rangeClear.addEventListener('click', () => {
  elements.rangeStart.value = '';
  elements.rangeEnd.value = '';
  elements.rangeEnd.removeAttribute('min');
  state.start = null;
  state.end = null;
  setError('');
  hidePill();
  openWindow();
});

elements.pill.addEventListener('click', refreshCurrent);

elements.refresh.addEventListener('click', refreshCurrent);
elements.follow.addEventListener('click', toggleFollow);
elements.edgeTop.addEventListener('click', () => {
  readerMoved = true;
  elements.tableScroll.scrollTop = 0;
});
elements.edgeBottom.addEventListener('click', scrollToNewest);

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
// A scrollbar drag dispatches no wheel, key or pointer event we could listen
// for, so the direction of travel is what tells us the reader took over.
elements.tableScroll.addEventListener('scroll', () => {
  const top = elements.tableScroll.scrollTop;

  if (top < lastScrollTop - 2) {
    readerMoved = true;
    // The reader took over, so the grace period after our own scroll no longer
    // applies; the paused state has to be visible straight away.
    followSettleUntil = 0;
    clearTimeout(settleTimer);
    // Scrolling up from a permalink means the reader is looking elsewhere, so
    // stop re-placing the linked row under them.
    focusCorrectionCancelled = true;
  }

  lastScrollTop = top;
}, {passive: true});

elements.tableScroll.addEventListener('scroll', hideTooltip, {passive: true});
elements.tableScroll.addEventListener('scroll', maybeLoadMore, {passive: true});
elements.tableScroll.addEventListener('scroll', scheduleEdgeUpdate, {passive: true});
window.addEventListener('resize', scheduleEdgeUpdate);

// Double-clicking a row copies a permalink to that message; a single click is
// left alone for reading and selecting text.
elements.body.addEventListener('dblclick', event => {
  const row = event.target.closest('tr.chat-row');
  if (!row) return;
  copyMessageLink(row);
});

// A link pasted into the address bar of the page already open has to land on
// its message too, with the same rows above it.
window.addEventListener('hashchange', async () => {
  const id = hashFocusId();
  if (id == null) return;

  if (elements.body.querySelector(`tr.chat-row[data-id="${id}"]`)) {
    revealFocusedRow(id);
    ensureFocusedMessage(id);
    updateEdgeStrips();
    return;
  }

  clearFilters();
  await loadPage({focus: id});
  await landOnMessage(id);
});

refreshLatestText();

state.follow = readFollowPreference();
updateFollowControls();

const focusId = hashFocusId();

if (focusId != null) {
  // A permalink is about that message, not today's anchor or the last search.
  clearFilters();
  updateEdgeStrips();

  loadPage({focus: focusId}).then(async () => {
    await landOnMessage(focusId);
    updateEdgeStrips();
  });
} else {
  // The date boxes and the search start empty, so the page opens on today's
  // first message, or on the newest line when following was remembered.
  clearFilters();
  syncRangeBounds();
  updateEdgeStrips();
  openWindow().then(updateEdgeStrips);
}

connectLiveFeed();

setInterval(refreshLatestText, 60000);
