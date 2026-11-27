// The live path, executed for real: this file boots mafia/app.js in a vm with a
// small fake page (elements, a scrolling table with a simple layout, the chat
// API, and a socket.io stand-in) and pushes chat-updated payloads through the
// handler the page registers. It covers the three things a throwaway harness
// found: a pushed row above the window moving the window start, a bulk upload
// counting its rows, and a refresh taking in the tail that arrived.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));

// A Windows checkout can hand these files over with CRLF line endings (the
// repository stores LF, and core.autocrlf rewrites them on the way out), so the
// page source is read with one line ending whatever the working copy looks like.
const readSource = file => fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
const client = readSource(path.join(directory, 'mafia', 'app.js'));

const DAY = 86400;
const ROW_HEIGHT = 40;
const BAND_HEIGHT = 30;
const HEADER_HEIGHT = 38;
const TAB_HEIGHT = 24;
const VIEWPORT_HEIGHT = 600;

// The page chooses its opening window from the clock: the first line of today,
// then up to a page of rows. A minute-by-minute archive has more than a page in
// today by late morning, and the window would then stop short of the end of the
// archive — pushed rows near the bottom would be kept for a later load, and the
// checks below would fail depending on the hour the suite ran. So the clock is
// pinned to a fixed hour of the local day and every check uses NOW.
const NOW = (() => {
  const date = new Date();
  date.setHours(3, 0, 0, 0);
  return date;
})();
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

// --- a page just large enough to run the client -----------------------------

function matches(element, selector) {
  const tag = selector.match(/^([a-z]+)/i);
  const className = selector.match(/\.([a-z-]+)/i);
  const attribute = selector.match(/\[data-([a-z]+)="([^"]*)"\]/i);

  if (tag && element.tagName !== tag[1].toUpperCase()) return false;
  if (className && !element.classList.contains(className[1])) return false;
  if (attribute && String(element.dataset[attribute[1]] ?? '') !== attribute[2]) return false;

  return true;
}

class FakeElement {
  constructor(tagName, page) {
    this.tagName = String(tagName).toUpperCase();
    this.page = page;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = {};
    this.style = {color: '', setProperty() {}};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.id = '';
    this.title = '';
    this.colSpan = 1;
    this._text = '';
    this._classes = new Set();
    this._scrollTop = 0;

    this.classList = {
      add: (...names) => names.forEach(name => this._classes.add(name)),
      remove: (...names) => names.forEach(name => this._classes.delete(name)),
      contains: name => this._classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !this._classes.has(name) : Boolean(force);
        if (on) this._classes.add(name);
        else this._classes.delete(name);
        return on;
      }
    };
  }

  get className() {
    return [...this._classes].join(' ');
  }

  set className(value) {
    this._classes.clear();
    String(value).split(/\s+/).filter(Boolean).forEach(name => this._classes.add(name));
  }

  get textContent() {
    return this.children.length ? this.children.map(child => child.textContent).join('') : this._text;
  }

  set textContent(value) {
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
    this._text = String(value);
  }

  append(...nodes) {
    nodes.forEach(node => this.insertBefore(node, null));
  }

  prepend(...nodes) {
    [...nodes].reverse().forEach(node => this.insertBefore(node, this.children[0] || null));
  }

  insertBefore(node, reference) {
    if (!node) return;
    if (node.parentNode) node.remove();
    node.parentNode = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
  }

  replaceChildren(...nodes) {
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }

  before(node) {
    if (this.parentNode) this.parentNode.insertBefore(node, this);
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentNode = null;
  }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.page.root;
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get previousElementSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    return index > 0 ? siblings[index - 1] : null;
  }

  get nextElementSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    return index >= 0 ? siblings[index + 1] || null : null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = node => {
      for (const child of node.children) {
        if (matches(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'hidden') this.hidden = true;
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'hidden') this.hidden = false;
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  addEventListener(type, handler) {
    (this.listeners[type] = this.listeners[type] || []).push(handler);
  }

  removeEventListener() {}

  click() {
    (this.listeners.click || []).forEach(handler => handler({type: 'click'}));
  }

  dispatch(type) {
    (this.listeners[type] || []).forEach(handler => handler({type, target: this}));
  }

  focus() {}
  blur() {}
  select() {}

  getBoundingClientRect() {
    return this.page.rectOf(this);
  }

  get offsetHeight() {
    return this.page.heightOf(this);
  }

  get offsetTop() {
    return this.getBoundingClientRect().top;
  }

  get scrollHeight() {
    return this.id === 'table-scroll' ? this.page.contentHeight() : 0;
  }

  get clientHeight() {
    return this.id === 'table-scroll' ? VIEWPORT_HEIGHT : 0;
  }

  get scrollTop() {
    return this._scrollTop;
  }

  set scrollTop(value) {
    const max = Math.max(0, this.page.contentHeight() - VIEWPORT_HEIGHT);
    this._scrollTop = Math.min(Math.max(0, Number(value) || 0), max);
  }
}

function createPage({messages, follow = false}) {
  const page = {archive: messages.slice(), elements: new Map(), socket: null};

  const add = (id, tagName = 'div') => {
    const element = new FakeElement(tagName, page);
    element.id = id;
    page.elements.set(id, element);
    return element;
  };

  // The table: a sticky header with the column labels and the date tab, then the
  // body the rows live in, all inside the scrolling element.
  const scroller = add('table-scroll', 'div');
  const table = new FakeElement('table', page);
  const thead = new FakeElement('thead', page);
  const labels = new FakeElement('tr', page);
  labels.append(new FakeElement('th', page));
  const tabRow = add('date-tab-row', 'tr');
  tabRow.hidden = true;
  const tabCell = new FakeElement('th', page);
  const tabText = add('date-tab', 'span');
  tabCell.append(tabText);
  tabRow.append(tabCell);
  thead.append(labels, tabRow);
  const body = add('chat-body', 'tbody');
  table.append(thead, body);
  scroller.append(table);
  page.root = scroller;

  for (const id of [
    'table-summary', 'latest-data', 'last-update', 'table-error', 'search-input',
    'range-start', 'range-end', 'range-clear', 'new-messages-pill', 'refresh-button',
    'connection-status', 'row-tooltip', 'follow-button', 'edge-top', 'edge-top-text',
    'edge-bottom', 'edge-bottom-text', 'toast-stack'
  ]) add(id);

  // A layout simple enough to reason about: rows are 40px, bands 30px, and the
  // header grows when the date tab is showing.
  let contentHeight = 0;
  let headerHeight = 0;

  page.layout = () => {
    headerHeight = HEADER_HEIGHT + (tabRow.hidden ? 0 : TAB_HEIGHT);
    let top = headerHeight;
    for (const child of body.children) {
      child._top = top;
      child._height = child.classList.contains('date-row') ? BAND_HEIGHT : ROW_HEIGHT;
      top += child._height;
    }
    contentHeight = top;
  };

  page.contentHeight = () => {
    page.layout();
    return contentHeight;
  };

  page.heightOf = element => {
    page.layout();
    return element === thead ? headerHeight : element._height || 0;
  };

  page.rectOf = element => {
    page.layout();
    if (element === scroller) {
      return {top: 0, bottom: VIEWPORT_HEIGHT, height: VIEWPORT_HEIGHT, left: 0, right: 800, width: 800};
    }
    if (element === thead) {
      return {top: 0, bottom: headerHeight, height: headerHeight, left: 0, right: 800, width: 800};
    }
    const top = (element._top || 0) - scroller._scrollTop;
    const height = element._height || 0;
    return {top, bottom: top + height, height, left: 0, right: 800, width: 800};
  };

  // --- the chat API -------------------------------------------------------
  page.sorted = () => [...page.archive].sort(
    (a, b) => a.message_timestamp - b.message_timestamp || Number(a.id) - Number(b.id)
  );

  page.filtered = params => {
    const search = String(params.get('q') || '').trim().toLowerCase();
    const start = params.get('start') != null && params.get('start') !== '' ? Number(params.get('start')) : null;
    const end = params.get('end') != null && params.get('end') !== '' ? Number(params.get('end')) : null;

    return page.sorted().filter(message => {
      if (start != null && message.message_timestamp < start) return false;
      if (end != null && message.message_timestamp > end) return false;
      if (search && !message.message_text.toLowerCase().includes(search)) return false;
      return true;
    });
  };

  const json = body => ({ok: true, status: 200, json: async () => body});

  page.calls = [];
  // Every id the page asked the server to place: a row the filters exclude
  // should never appear here.
  page.positionIds = [];

  page.fetch = async input => {
    const url = new URL(String(input), 'http://127.0.0.1:8796');
    const params = url.searchParams;
    page.calls.push(`${url.pathname}?${url.search}`);

    if (url.pathname === '/api/mafia/chat/messages') {
      const rows = page.filtered(params);
      let offset = Number(params.get('offset')) || 0;
      const focus = params.get('focus');

      if (focus != null) {
        const index = rows.findIndex(message => message.id === String(focus));
        if (index >= 0) offset = index;
      }

      const limit = Math.min(Math.max(Number(params.get('limit')) || 500, 1), 1000);
      return json({
        ok: true,
        total: rows.length,
        latest: page.archive.reduce((latest, message) => Math.max(latest, message.message_timestamp), 0),
        offset,
        limit,
        sort: 'time',
        dir: 'asc',
        messages: rows.slice(offset, offset + limit)
      });
    }

    if (url.pathname === '/api/mafia/chat/position') {
      const rows = page.filtered(params);
      const ids = String(params.get('ids') || '').split(',').map(id => id.trim()).filter(Boolean);
      page.positionIds.push(...ids);
      return json({
        ok: true,
        sort: 'time',
        dir: 'asc',
        positions: ids.map(id => {
          const index = rows.findIndex(message => message.id === id);
          return {id, before: index < 0 ? null : index};
        })
      });
    }

    throw new Error(`unexpected fetch: ${url.pathname}`);
  };

  // A message landing in the archive, as the backend would save it.
  let nextId = page.archive.length + 1;
  page.addMessage = ({at, text}) => {
    const message = {
      id: String(nextId),
      channel: 'guild',
      sender: '@amyrain',
      message_text: text,
      message_timestamp: at,
      data_source: 'discord-archive',
      uploaded_by: '@skperdue',
      received_at: new Date(at * 1000).toISOString()
    };
    nextId += 1;
    page.archive.push(message);
    return message;
  };

  // --- the socket ---------------------------------------------------------
  page.socket = {
    handlers: {},
    on(event, handler) {
      (this.handlers[event] = this.handlers[event] || []).push(handler);
      return this;
    },
    emit() {},
    disconnect() {},
    // What the server sends: the payload the page's own handler receives.
    push(event, payload) {
      (this.handlers[event] || []).forEach(handler => handler(payload));
    }
  };

  // --- what the client reaches for ---------------------------------------
  const storage = new Map();
  // The page reads this before it opens a window: following is a remembered
  // choice, and it opens on the newest line instead of today's first.
  if (follow) storage.set('mafia-follow-newest', 'true');
  const documentListeners = {};

  page.document = {
    documentElement: new FakeElement('html', page),
    body: new FakeElement('body', page),
    getElementById: id => page.elements.get(id) || null,
    createElement: tagName => new FakeElement(tagName, page),
    createTextNode: text => {
      const node = new FakeElement('#text', page);
      node.textContent = text;
      return node;
    },
    addEventListener(type, handler) {
      (documentListeners[type] = documentListeners[type] || []).push(handler);
    },
    execCommand: () => true
  };

  page.globals = {
    document: page.document,
    location: {origin: 'http://127.0.0.1:8796', pathname: '/mafia/', hash: ''},
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    navigator: {clipboard: {writeText: async () => {}}},
    // The page reads new Date() for "today" and Date.now() for staleness, so
    // both see the pinned clock; performance.now() stays real because it only
    // measures the follow settle window.
    Date: class extends Date {
      constructor(...args) {
        super(...(args.length === 0 ? [NOW.getTime()] : args));
      }

      static now() {
        return NOW.getTime();
      }
    },
    performance: {now: () => Date.now()},
    fetch: page.fetch,
    URLSearchParams,
    AbortController,
    console,
    // Timers the page uses to keep following or fade marks are not what this
    // test is about: only the short ones (a batch of rows, a frame, the search
    // debounce) run.
    setTimeout: (handler, delay, ...args) => (delay > 200 ? 0 : setTimeout(handler, delay, ...args)),
    clearTimeout: id => clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  };

  page.globals.window = {
    io: () => page.socket,
    innerWidth: 786,
    innerHeight: 900,
    scrollBy() {},
    addEventListener() {},
    requestAnimationFrame: handler => setTimeout(handler, 0),
    getSelection: () => ({removeAllRanges() {}}),
    localStorage: page.globals.localStorage,
    location: page.globals.location
  };

  return page;
}

// The archive the page opens on: three days of chatter, one line a minute.
function archiveFor(now) {
  const messages = [];
  const senders = ['@amyrain', '@skperdue', '@quietfen', '@goatsoap'];
  let id = 1;

  for (let at = now - 3 * DAY; at <= now; at += 60) {
    messages.push({
      id: String(id),
      channel: 'guild',
      sender: senders[id % senders.length],
      message_text: `line ${id}`,
      message_timestamp: at,
      data_source: 'discord-archive',
      uploaded_by: '@skperdue',
      received_at: new Date(at * 1000).toISOString()
    });
    id += 1;
  }

  return messages;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// A real pause, for the page's own 150 ms search debounce.
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// The client's own promises land over a few turns of the loop.
async function settle(turns = 12) {
  for (let i = 0; i < turns; i += 1) await tick();
}

async function bootPage({follow = false} = {}) {
  const now = NOW_SECONDS;
  const page = createPage({messages: archiveFor(now), follow});
  const context = vm.createContext(page.globals);

  // The appended line runs in the page's own scope, so the test can look at the
  // state and helpers the script closed over.
  vm.runInContext(`${client}\n;globalThis.__page = {state, elements, refreshCurrent};`, context, {
    filename: 'mafia/app.js'
  });

  page.api = context.__page;
  await settle(16);

  if (!page.api.state.total) {
    throw new Error(
      `the page did not load a window; it asked for: ${page.calls.join(' | ') || 'nothing'}; ` +
      `page error: ${page.api.elements.error.textContent || '(none)'}`
    );
  }

  if (!page.api.state.atEnd) {
    throw new Error(
      `the boot window does not reach the end: ${page.api.state.offset}+${page.api.state.loaded} of ${page.api.state.total}`
    );
  }

  if (follow) {
    // Following opens on the newest line, so the reader is already at the end.
    await settle(6);
  } else {
    // Park the reader away from the top so no earlier batch is still on its way.
    page.elements.get('table-scroll').scrollTop = 2000;
    await settle(4);
  }

  return page;
}

const rowsOf = page => page.api.elements.body.querySelectorAll('tr.chat-row');
const rowIds = page => rowsOf(page).map(row => row.dataset.id);
const bandsOf = page => page.api.elements.body.querySelectorAll('tr.date-row');

const dayOf = row => new Date(Number(row.dataset.time) * 1000).toDateString();

// The days the bands should name, in order: one where the window begins and one
// wherever the day changes between the rows on screen.
const expectedDays = rows => rows.reduce((days, row) => {
  const day = dayOf(row);
  if (days.at(-1) !== day) days.push(day);
  return days;
}, []);

const distanceFromBottom = page => {
  const scroller = page.elements.get('table-scroll');
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
};

// The date fields take and show a local calendar day, which is what the page
// turns into the first and last second of that day.
const localDateString = date =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const startOfLocalDay = date =>
  Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0).getTime() / 1000);

const endOfLocalDay = date =>
  Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59).getTime() / 1000);

test('a pushed row above the window moves the window start with it', async () => {
  const page = await bootPage();
  const state = page.api.state;
  const rowsBefore = rowsOf(page).length;
  const {offset, total} = state;

  // A line that belongs above everything on screen.
  const backdated = page.addMessage({at: page.archive[0].message_timestamp - 3600, text: 'backdated line'});
  page.socket.push('chat-updated', {messages: [backdated], inserted: 1});
  await settle();

  assert.equal(state.total, total + 1, 'the count includes the pushed row');
  assert.equal(state.offset, offset + 1, 'the window start moved past the row pushed above it');
  assert.equal(rowsOf(page).length, rowsBefore, 'a row above the window is not drawn');

  // Now one that belongs at the very end. With a stale window start this was
  // judged as past the loaded rows and dropped, even though the summary counted
  // it: the row has to arrive.
  const newest = page.addMessage({at: NOW_SECONDS + 5, text: 'newest line'});
  page.socket.push('chat-updated', {messages: [newest], inserted: 1});
  await settle();

  assert.ok(rowIds(page).includes(newest.id), 'the pushed row near the bottom is drawn');
  assert.equal(state.total, total + 2);
  assert.equal(state.offset, offset + 1, 'only the row above the window moves its start');
});

test('a row pushed above the window keeps the reader on the same line', async () => {
  const page = await bootPage();
  const scroller = page.elements.get('table-scroll');
  const before = rowsOf(page);
  const anchor = before[6];
  const anchorOffset = Math.round(anchor.getBoundingClientRect().top);

  const middle = before[2];
  const pushed = page.addMessage({
    at: Number(middle.dataset.time) - 30,
    text: 'a line that sorts above the reader'
  });

  page.socket.push('chat-updated', {messages: [pushed], inserted: 1});
  await settle();

  assert.equal(rowsOf(page).length, before.length + 1);
  assert.equal(
    Math.round(anchor.getBoundingClientRect().top),
    anchorOffset,
    'the row the reader was looking at stays where it was'
  );
  assert.equal(scroller.scrollTop, 2000 + ROW_HEIGHT, 'the scroll moved down by the row that was added');
});

test('a bulk upload counts its rows straight away', async () => {
  const page = await bootPage();
  const state = page.api.state;
  const {total} = state;

  page.socket.push('chat-updated', {bulk: true, inserted: 3, messages: []});
  await settle();

  assert.equal(state.total, total + 3, 'a bulk announcement adds its rows to the count');
  assert.match(page.api.elements.summary.textContent, new RegExp(`${(total + 3).toLocaleString()} messages`));
  assert.equal(rowsOf(page).length, state.loaded, 'the rows themselves wait for the refresh');

  const pill = page.elements.get('new-messages-pill');
  assert.equal(pill.hidden, false);
  assert.equal(pill.textContent, '3 new messages — refresh');
});

test('a refresh takes in the tail that arrived, keeping the end of the archive', async () => {
  const page = await bootPage();
  const state = page.api.state;
  const before = rowsOf(page).length;

  // Three lines land at the end of the archive, announced the way a bulk upload
  // is: the page knows the size but has not been sent the rows.
  const added = [0, 1, 2].map(i => page.addMessage({
    at: NOW_SECONDS + 10 + i,
    text: `bulk line ${i}`
  }));

  page.socket.push('chat-updated', {bulk: true, inserted: added.length, messages: []});
  await settle();

  page.elements.get('new-messages-pill').click();
  await settle(24);

  const ids = rowIds(page);
  assert.equal(ids.at(-1), added[2].id, 'the refresh brings in the rows that arrived at the end');
  assert.ok(ids.includes(added[0].id), 'every announced row is in the window');
  assert.equal(rowsOf(page).length, before + added.length);
  assert.equal(state.total, page.archive.length, 'the count matches the archive after the refresh');
  assert.equal(state.offset + state.loaded, state.total, 'the window still reaches the last message');
});

test('a pushed row that starts a new day brings exactly one band with it', async () => {
  const page = await bootPage();
  const state = page.api.state;
  const {total} = state;
  const rowsBefore = rowsOf(page).length;

  // Later than everything on screen and on the next day: it lands at the end and
  // has to bring its own day band, without leaving a band above no row.
  const pushed = page.addMessage({
    at: NOW_SECONDS + DAY,
    text: 'the first line of tomorrow'
  });

  page.socket.push('chat-updated', {messages: [pushed], inserted: 1});
  await settle();

  const rows = rowsOf(page);
  const bands = bandsOf(page);

  assert.equal(rows.length, rowsBefore + 1, 'the new-day row is drawn');
  assert.equal(rows.at(-1).dataset.id, pushed.id, 'it sorts last');
  assert.equal(state.total, total + 1);

  const above = bands.filter(band => band.nextElementSibling === rows.at(-1));
  assert.equal(above.length, 1, 'exactly one band sits above the new-day row');
  assert.equal(above[0].dataset.day, dayOf(rows.at(-1)), 'the band belongs to that day');
  assert.equal(
    above[0].textContent,
    new Intl.DateTimeFormat('en-US', {weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'})
      .format(new Date(Number(rows.at(-1).dataset.time) * 1000)),
    'the band names that day'
  );

  assert.deepEqual(
    bands.map(band => band.dataset.day),
    expectedDays(rows),
    'one band where the window begins and wherever the day changes, and none anywhere else'
  );
  assert.equal(
    bands.filter(band => band.previousElementSibling && band.previousElementSibling.classList.contains('date-row')).length,
    0,
    'no doubled bands'
  );

  for (const band of bands) {
    const next = band.nextElementSibling;
    assert.ok(next && next.classList.contains('chat-row'), 'every band has a row under it');
    assert.equal(band.dataset.day, dayOf(next), 'a band only stands above rows of its own day');
  }
});

test('a reader following at the bottom stays pinned through pushes', async () => {
  const page = await bootPage({follow: true});
  const state = page.api.state;
  const scroller = page.elements.get('table-scroll');

  assert.equal(state.follow, true, 'the remembered follow is in effect');
  assert.equal(distanceFromBottom(page), 0, 'following opens on the newest row');

  const now = NOW_SECONDS;
  const pushed = [
    page.addMessage({at: now + 5, text: 'a line while following'}),
    page.addMessage({at: now + DAY, text: 'a new day while following'})
  ];

  for (const message of pushed) {
    const rowsBefore = rowsOf(page).length;
    page.socket.push('chat-updated', {messages: [message], inserted: 1});
    await settle();

    assert.equal(rowsOf(page).length, rowsBefore + 1, 'the pushed row is drawn');
    assert.equal(rowsOf(page).at(-1).dataset.id, message.id, 'it is the last row');
    assert.equal(distanceFromBottom(page), 0, 'the newest row stays at the bottom of the view');
  }

  assert.equal(scroller.scrollTop, scroller.scrollHeight - VIEWPORT_HEIGHT);
  assert.equal(page.api.elements.follow.dataset.following, 'true');
  assert.equal(page.api.elements.follow.dataset.paused, 'false');
  assert.equal(state.total, page.archive.length, 'both pushes are counted');
});

test('a pushed row under an active search is placed only when it matches', async () => {
  const page = await bootPage();
  const state = page.api.state;
  const search = page.elements.get('search-input');

  // Typed the way a reader types: the page debounces, then reloads on the match.
  search.value = 'line 42';
  search.dispatch('input');
  await wait(220);
  await settle(12);

  assert.equal(state.search, 'line 42', 'the search is in effect');
  const total = state.total;
  assert.ok(total > 0 && total < page.archive.length, 'the window holds the matching rows only');

  const now = NOW_SECONDS;
  const matching = page.addMessage({at: now + 30, text: 'line 42 walks in while the search is on'});
  page.socket.push('chat-updated', {messages: [matching], inserted: 1});
  await settle();

  assert.ok(rowIds(page).includes(matching.id), 'a matching line is placed in the table');
  assert.equal(state.total, total + 1, 'and counted');
  assert.ok(
    page.api.elements.summary.textContent.startsWith(`${(total + 1).toLocaleString()} `),
    'the summary includes it'
  );

  const other = page.addMessage({at: now + 60, text: 'a line about something else entirely'});
  page.socket.push('chat-updated', {messages: [other], inserted: 1});
  await settle();

  assert.ok(!rowIds(page).includes(other.id), 'a line the search does not match is not placed');
  assert.equal(state.total, total + 1, 'and is not counted');
  assert.ok(
    !page.positionIds.includes(other.id),
    'and is filtered out before the page even asks where it would go'
  );
});

test('a pushed row inside an active date range is placed, one outside is ignored', async () => {
  const page = await bootPage();
  const state = page.api.state;
  const today = new Date(NOW.getTime());
  const field = localDateString(today);

  page.elements.get('range-start').value = field;
  page.elements.get('range-end').value = field;
  page.elements.get('range-end').dispatch('change');
  await settle(12);

  assert.equal(state.start, startOfLocalDay(today), 'the range starts at the first second of the day');
  assert.equal(state.end, endOfLocalDay(today), 'and ends at the last');

  const total = state.total;
  assert.ok(total > 0, 'the window holds the rows inside the range');

  const insideAt = Math.min(NOW_SECONDS + 30, endOfLocalDay(today));
  const inside = page.addMessage({at: insideAt, text: 'a line inside the range'});
  page.socket.push('chat-updated', {messages: [inside], inserted: 1});
  await settle();

  assert.ok(rowIds(page).includes(inside.id), 'a line inside the range is placed in the table');
  assert.equal(state.total, total + 1, 'and counted');
  assert.ok(
    page.api.elements.summary.textContent.startsWith(`${(total + 1).toLocaleString()} `),
    'the summary includes it'
  );

  const outside = page.addMessage({at: endOfLocalDay(today) + 7200, text: 'a line past the range'});
  page.socket.push('chat-updated', {messages: [outside], inserted: 1});
  await settle();

  assert.ok(!rowIds(page).includes(outside.id), 'a line outside the range is not placed');
  assert.equal(state.total, total + 1, 'and is not counted');
  assert.ok(
    !page.positionIds.includes(outside.id),
    'and is filtered out before the page even asks where it would go'
  );
});
