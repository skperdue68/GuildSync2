import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';

const directory = path.dirname(fileURLToPath(import.meta.url));
const mafiaDirectory = path.join(directory, 'mafia');
const html = fs.readFileSync(path.join(mafiaDirectory, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(mafiaDirectory, 'styles.css'), 'utf8');
const client = fs.readFileSync(path.join(mafiaDirectory, 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(directory, 'guildsync-backend-server.js'), 'utf8');
const chatApi = fs.readFileSync(path.join(directory, 'mafia-chat-api.js'), 'utf8');

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : '';
}

test('the table has three fixed columns and no sort controls', () => {
  assert.equal((html.match(/<th scope="col"/g) || []).length, 3);
  assert.doesNotMatch(html, /data-sort=|sort-button|sort-indicator|aria-sort/);
  assert.match(html, />Local time</);
  assert.match(html, />Sender</);
  assert.match(html, />Message</);

  // Oldest first, always: the archive reads like a conversation.
  assert.match(client, /const SORT_COLUMN = 'time';/);
  assert.match(client, /const SORT_DIRECTION = 'asc';/);
  assert.match(client, /sort: SORT_COLUMN,\n    dir: SORT_DIRECTION,/);
  assert.doesNotMatch(client, /applySort|SORT_LABELS|updateSortHeaders/);
});

test('the table header sticks while the rows scroll under it', () => {
  assert.match(ruleBody('.chat-table thead th'), /position:\s*sticky/);
  assert.match(ruleBody('.chat-table thead th'), /top:\s*0/);
  assert.match(ruleBody('.table-scroll'), /overflow:\s*auto/);
  assert.match(ruleBody('.table-scroll'), /max-height:/);
});

test('times render as mm/dd/yyyy hh:ii:ss in the reader time zone', () => {
  assert.match(
    client,
    /`\$\{pad\(date\.getMonth\(\) \+ 1\)\}\/\$\{pad\(date\.getDate\(\)\)\}\/\$\{date\.getFullYear\(\)\} ` \+/
  );
  assert.match(client, /`\$\{pad\(date\.getHours\(\)\)\}:\$\{pad\(date\.getMinutes\(\)\)\}:\$\{pad\(date\.getSeconds\(\)\)\}`/);
  assert.match(client, /new Date\(value \* 1000\)/);
  assert.doesNotMatch(client, /toLocaleDateString\(|toLocaleTimeString\(/);
});

test('the time and sender columns right justify with their headers', () => {
  assert.match(ruleBody('.cell-time'), /text-align:\s*right/);
  assert.match(ruleBody('.chat-table thead th.align-right'), /text-align:\s*right/);
  assert.match(html, /<th scope="col" class="align-right">Local time</);
  assert.match(ruleBody('.cell-sender'), /text-align:\s*right/);
  assert.match(html, /<th scope="col" class="align-right">Sender</);
});

test('officer chat rows are marked as officer chat', () => {
  assert.match(client, /const channel = String\(message\.channel \|\| ''\)\.toLowerCase\(\) === 'officer' \? 'officer' : 'guild';/);
  assert.match(client, /row\.classList\.toggle\('chat-row-officer', channel === 'officer'\)/);
  assert.match(client, /tag\.textContent = 'OFFICER'/);
  assert.match(ruleBody('.chat-table tbody tr.chat-row-officer td'), /background:/);
  assert.match(ruleBody('.chat-table tbody tr.chat-row-officer td:first-child'), /inset 3px 0 0/);
  assert.match(ruleBody('.officer-tag'), /letter-spacing:\s*0\.8px/);
  assert.match(client, /tooltipLine\('Channel'/);
});

test('every row carries the provenance tooltip', () => {
  assert.match(client, /const row = event\.target\.closest\('tr'\)/);
  assert.match(client, /tooltipLine\('Received'/);
  assert.match(client, /tooltipLine\('Uploaded by'/);
  assert.doesNotMatch(client, /tooltipLine\('Data source'/);
  assert.match(ruleBody('.chat-table tbody tr'), /cursor:\s*help/);

  // The provenance tooltip is the row's only hover text: a native title would
  // draw a second box over it, and the copy hint lives at the bottom instead.
  assert.doesNotMatch(client, /row\.title/);
});

test('rows are striped so a message is easy to follow across', () => {
  assert.match(ruleBody('.chat-table tbody tr:nth-child(even) td'), /background:\s*rgba\(/);

  const stripeAt = css.indexOf('.chat-table tbody tr:nth-child(even) td');
  const hoverAt = css.indexOf('.chat-table tbody tr:hover td');
  assert.ok(stripeAt > 0 && hoverAt > stripeAt, 'the hover rule must follow the zebra stripe');
});

test('the range covers whole days and has no clock controls', () => {
  assert.equal((html.match(/type="date"/g) || []).length, 2);
  assert.doesNotMatch(html, /datetime-local|type="time"|time-select|hh:mm/);
  assert.match(html, /placeholder="Message text…"/);
  assert.match(html, /id="range-start"/);
  assert.match(html, /id="range-end"/);
  assert.doesNotMatch(html, /field-hint|24-hour/);

  // From is midnight, To is the last second of its day.
  assert.match(client, /new Date\(year, month - 1, day, 0, 0, 0\)/);
  assert.match(client, /new Date\(year, month - 1, day, 23, 59, 59\)/);
  assert.match(client, /params\.set\('start', String\(state\.start\)\)/);
  assert.match(client, /params\.set\('end', String\(state\.end\)\)/);
});

test('the to date can never be earlier than the from date', () => {
  assert.match(client, /function syncRangeBounds\(\) \{/);
  assert.match(client, /elements\.rangeEnd\.min = start;/);
  assert.match(client, /if \(start && end && end < start\) elements\.rangeEnd\.value = start;/);
  assert.match(client, /elements\.rangeEnd\.removeAttribute\('min'\)/);

  // Both date fields clamp the to date before the range is read.
  const handler = client.slice(client.indexOf("for (const input of [elements.rangeStart, elements.rangeEnd])"), client.indexOf("elements.rangeClear.addEventListener"));
  assert.match(handler, /syncRangeBounds\(\);/);
  assert.ok(handler.indexOf('syncRangeBounds();') < handler.indexOf('readRange()'));

  // A single day is a whole day: 00:00:00 to 23:59:59.
  assert.match(client, /dayBoundary\(startValue, false\)/);
  assert.match(client, /dayBoundary\(endValue, true\)/);

  // The from date may still move later; only the to date is bounded.
  assert.doesNotMatch(html, /id="range-start"[^>]*min=|id="range-start"[^>]*max=/);
});

test('the range label is centred and the buttons read CLEAR and REFRESH', () => {
  assert.match(ruleBody('.range-field'), /align-items:\s*center/);
  assert.match(html, />CLEAR</);
  assert.equal((html.match(/>REFRESH</g) || []).length, 1);
  assert.match(ruleBody('.clear-button'), /text-transform:\s*uppercase/);
  assert.match(ruleBody('.refresh-button'), /text-transform:\s*uppercase/);
});

test('Refresh reloads the window on screen instead of jumping to the first page', () => {
  assert.match(client, /async function refreshCurrent\(/);
  assert.match(client, /const start = state\.offset;/);
  assert.match(client, /limit: String\(limit\)/);
  assert.match(
    client,
    /await loadPage\(\{offset: start \+ \(first \? 0 : state\.loaded\), limit, append: !first, background: true\}\);/
  );
  assert.match(client, /elements\.refresh\.addEventListener\('click', refreshCurrent\)/);
  assert.match(client, /elements\.pill\.addEventListener\('click', refreshCurrent\)/);
  assert.doesNotMatch(client, /showUpdateBanner|bannerRefresh|update-banner/);

  // The refresh itself never scrolls the page or rewrites the URL.
  const refreshBody = client.slice(
    client.indexOf('async function refreshCurrent'),
    client.indexOf('function hideTooltip')
  );
  assert.match(refreshBody, /do \{/);
  assert.match(refreshBody, /elements\.tableScroll\.scrollTop = scrollTop;/);
  assert.doesNotMatch(refreshBody, /scrollTop = 0/);
  assert.doesNotMatch(client, /history\.(pushState|replaceState)|location\.hash =|location\.assign/);
});

test('the footer centres MOST RECENT DATA and right-aligns LAST SCREEN REFRESH', () => {
  const footerStart = html.indexOf('<div class="table-footer">');
  const footer = html.slice(footerStart, html.indexOf('</div>', footerStart));
  const latestAt = footer.indexOf('id="latest-data"');
  const refreshedAt = footer.indexOf('id="last-update"');

  assert.ok(latestAt > 0 && refreshedAt > latestAt, 'most recent data must come first');
  assert.match(footer, /MOST RECENT DATA: —/);
  assert.match(footer, /LAST SCREEN REFRESH: —/);

  // The stamp is pinned to the footer's midpoint, so it stays centred whatever
  // the summary and refresh text are doing.
  assert.match(ruleBody('.table-footer'), /position:\s*relative/);
  assert.match(ruleBody('.latest-data'), /position:\s*absolute/);
  assert.match(ruleBody('.latest-data'), /left:\s*50%/);
  assert.match(ruleBody('.latest-data'), /transform:\s*translateX\(-50%\)/);
  assert.match(ruleBody('.last-update'), /font-weight:\s*700/);
  assert.match(ruleBody('.footer-right'), /justify-content:\s*flex-end/);

  // Both stamps are styled the same; only their placement differs.
  assert.match(ruleBody('.latest-data'), /font-weight:\s*700/);
  assert.match(ruleBody('.latest-data'), /color:\s*#e0f2fe/i);
  for (const property of ['font-variant-numeric', 'text-transform', 'letter-spacing', 'white-space', 'font-weight', 'color']) {
    const value = new RegExp(`${property}:\\s*([^;]+);`);
    assert.equal(
      ruleBody('.latest-data').match(value)?.[1],
      ruleBody('.last-update').match(value)?.[1],
      `${property} must match the refresh stamp`
    );
  }

  // Every load and every insert restamps the screen refresh.
  assert.match(client, /LAST SCREEN REFRESH: \$\{formatLocalDate\(new Date\(\)\)\}/);
  assert.match(client, /markLatest\(payload\.latest\);\n\n    if \(append\)|\n    markUpdated\(\);/);
});

test('stale data turns amber instead of passing silently', () => {
  assert.match(client, /const STALE_AFTER_MS = 24 \* 60 \* 60 \* 1000;/);
  assert.match(client, /elements\.latestData\.dataset\.stale = stale \? 'true' : 'false';/);
  assert.match(client, /no new data for \$\{ageingLabel\(age\)\}/);
  assert.match(client, /setInterval\(refreshLatestText, 60000\)/);
  assert.match(ruleBody('.latest-data[data-stale="true"]'), /#fbbf24/i);
});

test('background batches leave the Refresh button and the summary alone', () => {
  // Only the reader's own load may dim the button: a permalink fetches the
  // focused page and then the rows above it, and toggling both twice in a
  // moment looked like the button was being pressed repeatedly.
  assert.match(client, /async function loadPage\(\{offset = 0, limit = PAGE_SIZE, append = false, prepend = false, focus = null, background = append \|\| prepend\} = \{\}\)/);
  assert.match(client, /function beginLoading\(background\) \{\n  state\.loading = true;\n  if \(background\) return;/);
  assert.match(client, /function endLoading\(background\) \{\n  state\.loading = false;\n  if \(background\) return;/);
  assert.match(client, /elements\.refresh\.disabled = true;\n\n  try \{/);
  assert.doesNotMatch(client, /function setLoading\(/);
});

test('more rows stream in before the reader reaches the bottom', () => {
  assert.doesNotMatch(html, /id="load-older"|Load older/);
  assert.match(client, /const PREFETCH_PX = 480;/);
  assert.match(client, /function maybeLoadMore\(\) \{/);
  assert.match(client, /const remaining = scroller\.scrollHeight - scroller\.scrollTop - scroller\.clientHeight;/);
  assert.match(client, /if \(remaining > PREFETCH_PX\) return;/);
  assert.match(client, /loadPage\(\{offset: state\.offset \+ state\.loaded, append: true\}\);/);
  assert.match(client, /elements\.tableScroll\.addEventListener\('scroll', maybeLoadMore, \{passive: true\}\)/);
  assert.match(client, /setTimeout\(maybeLoadMore, 0\)/);
  assert.match(client, /if \(!append\) state\.offset = Number\(payload\.offset\) \|\| 0;/);

  const loader = client.slice(client.indexOf('async function loadPage'), client.indexOf('// Scrolling toward the end'));
  assert.match(loader, /markUpdated\(\)/);
  assert.match(loader, /else if \(append\) \{\n      appendMessages\(payload\.messages\);/);
});

test('pushed rows join only the page they belong to', () => {
  assert.match(client, /async function fetchPositions\(/);
  assert.match(client, /\/api\/mafia\/chat\/position\?/);
  assert.match(client, /const windowStart = state\.offset;/);
  assert.match(client, /const atEndOfResults = state\.atEnd;/);
  assert.match(client, /const index = before - windowStart;/);
  assert.match(client, /if \(index > state\.loaded \|\| \(index === state\.loaded && !atEndOfResults\)\) \{/);
  assert.match(client, /elements\.body\.insertBefore\(row, target\)/);
});

test('a bulk upload only asks the page to refresh', () => {
  assert.match(server, /MAFIA_CHAT_BULK_LIMIT/);
  const helperAt = server.indexOf('function broadcastMafiaChatUpdate');
  const helper = server.slice(helperAt, helperAt + 2000);

  assert.match(helper, /ids\.length > MAFIA_CHAT_BULK_LIMIT/);
  assert.match(helper, /bulk: true/);
  assert.match(helper, /mapMafiaChatRow/);
  assert.match(helper, /WHERE id IN \(\$\{placeholders\}\)/);

  assert.match(client, /if \(detail\?\.bulk\)/);
  assert.match(client, /showPill\(`\$\{count\} new message/);
  assert.match(client, /showToast\(/);
});

test('the message pill refreshes while the edge control handles jumping to the top', () => {
  assert.match(html, /id="new-messages-pill"/);
  const showPill = client.slice(client.indexOf('function showPill('), client.indexOf('function hidePill('));
  assert.match(showPill, /elements\.pill\.textContent = text;/);
  assert.match(showPill, /elements\.pill\.hidden = false;/);
  assert.doesNotMatch(showPill, /dataset\.mode|scrollTop/);
  assert.match(client, /elements\.pill\.addEventListener\('click', refreshCurrent\)/);
  assert.match(client, /elements\.edgeTop\.addEventListener\('click', \(\) => \{\s+readerMoved = true;\s+elements\.tableScroll\.scrollTop = 0;/);
  assert.match(ruleBody('.new-pill'), /position:\s*absolute/);
});

test('rows are permalinks that open, mark and keep their context', () => {
  assert.match(client, /const HASH_MESSAGE = \/\^#msg-\(\\d\{1,15\}\)\$\/;/);
  assert.match(client, /row\.id = `msg-\$\{message\.id\}`;/);
  assert.match(client, /navigator\.clipboard\.writeText\(link\)/);
  assert.match(client, /params\.set\('focus', String\(focus\)\)/);
  assert.match(client, /function revealFocusedRow\(id\)/);
  assert.match(client, /row\.classList\.add\('row-target'\)/);
  assert.match(css, /\.chat-table tbody tr\.row-target td/);

  // The mark stays for as long as the page is open: no timer takes it away.
  assert.doesNotMatch(client, /TARGET_HIGHLIGHT_MS|highlightTimer/);
  // And the message is guaranteed to be on screen after the batch above it has
  // been laid out, however that changes the scroll position.
  assert.match(client, /function ensureFocusedMessage\(id\)/);
  // The row is centred in the space under the sticky header, not left behind it.
  assert.match(client, /function scrollRowIntoView\(row\)/);
  assert.match(client, /const headerHeight = thead \? thead\.offsetHeight : 0;/);
  assert.match(client, /const insideTable = rect\.top >= viewport\.top \+ headerHeight && rect\.bottom <= viewport\.bottom;/);

  // The linked line is not the top of the page: the rows above it load too, and
  // scrolling up keeps walking the archive backwards.
  assert.match(client, /async function landOnMessage\(id\)/);
  assert.match(client, /async function loadEarlier\(\)/);
  assert.match(client, /await loadPage\(\{offset, limit, prepend: true\}\)/);
  assert.match(client, /scroller\.scrollTop <= PREFETCH_PX && state\.offset > 0/);
  assert.match(client, /function prependMessages\(messages\)/);
  assert.match(client, /window\.addEventListener\('hashchange'/);

  // A single click reads; a double-click copies and says so.
  assert.match(client, /elements\.body\.addEventListener\('dblclick'/);
  assert.match(html, /Double-click a line to copy a link to it/);
  assert.match(html, /id="toast-stack"/);
  assert.match(client, /showToast\('Link copied to clipboard'\)/);
  assert.match(ruleBody('.row-hint'), /position:\s*fixed/);
});

test('the backend runs the site on its own listener at port 3018', () => {
  assert.match(server, /const MAFIA_PORT = Number\(process\.env\.MAFIA_PORT \|\| 3018\)/);
  assert.match(server, /const mafiaApp = express\(\)/);
  assert.match(server, /mafiaApp\.use\('\/api\/mafia\/chat', createMafiaChatRouter\(/);
  assert.match(server, /const mafiaServer = http\.createServer\(mafiaApp\)/);
  assert.match(server, /const mafiaIo = new Server\(mafiaServer/);
  assert.match(server, /mafiaServer\.listen\(MAFIA_PORT, HOST/);
  assert.match(server, /const mafiaChatNamespace = mafiaIo\.of\('\/mafia'\);/);

  const namespaceAt = server.indexOf("const mafiaChatNamespace = mafiaIo.of('/mafia');");
  const helperAt = server.indexOf('function broadcastMafiaChatUpdate');
  assert.ok(namespaceAt > 0 && namespaceAt < helperAt, 'the namespace must be created at startup');

  assert.match(server, /mafiaChatNamespace\.emit\(MAFIA_CHAT_UPDATED_EVENT/);
  assert.doesNotMatch(server, /app\.use\('\/mafia', mafiaWebApp\)/);

  const guardAt = server.indexOf('if (insertedIds.length > 0) {');
  const callAt = server.indexOf('broadcastMafiaChatUpdate({inserted: insertedIds.length, ids: insertedIds});');
  assert.ok(guardAt > 0, 'the inserted-rows guard was not found');
  assert.ok(callAt > guardAt, 'the broadcast must sit behind the inserted-rows guard');
});

test('a pushed row above the window moves the window start with it', () => {
  const live = client.slice(client.indexOf('async function applyLiveMessages'), client.indexOf('// The pill only ever asks for a refresh'));

  assert.match(live, /if \(index < 0\) \{/);
  assert.match(live, /addedAbove \+= 1;/);

  const shiftAt = live.indexOf('state.offset += addedAbove;');
  assert.ok(shiftAt > 0, 'the window start must move with rows pushed above it');
  assert.ok(shiftAt < live.indexOf('syncBands();'), 'the shift belongs to the same update as the rows');
});

test('a bulk upload counts its rows, and a refresh takes in the tail that arrived', () => {
  assert.match(client, /state\.total \+= count;/);

  // Whether the window reached the end is remembered, because the total moves
  // under it when rows arrive.
  assert.match(client, /state\.atEnd = state\.offset \+ state\.loaded >= state\.total;/);

  const refresh = client.slice(client.indexOf('async function refreshCurrent'), client.indexOf('function hideTooltip'));
  assert.match(refresh, /state\.atEnd \? state\.total - start : 0/);
});

test('the date boxes start empty and the page opens on today unless following', () => {
  assert.doesNotMatch(html, /id="range-start"[^>]*value=/);
  assert.doesNotMatch(html, /id="range-end"[^>]*value=/);
  assert.doesNotMatch(client, /applyDefaultRange/);

  // Not following: find today's first message and open the window there.
  assert.match(client, /function todayStart\(\)/);
  assert.match(client, /async function fetchTodayAnchor\(\)/);
  assert.match(client, /start: String\(todayStart\(\)\)/);
  assert.match(client, /await loadPage\(\{focus: Number\(anchor\)\}\);/);

  // Following: the last page, scrolled to its bottom.
  assert.match(client, /async function openAtNewest\(\)/);
  assert.match(client, /const total = await fetchFilteredTotal\(\);/);
  assert.match(client, /await loadPage\(\{offset: Math\.max\(0, total - PAGE_SIZE\)\}\);\n  scrollToNewest\(\);/);
  assert.match(client, /if \(state\.follow\) \{\n    await openAtNewest\(\);/);

  // And the choice is remembered between visits.
  assert.match(client, /const FOLLOW_STORAGE_KEY = 'mafia-follow-newest';/);
  assert.match(client, /state\.follow = readFollowPreference\(\);/);
});

test('a follow-on load pins the newest message once, with rows and header in place', () => {
  const loadBody = client.slice(client.indexOf('async function loadPage('), client.indexOf('async function loadEarlier('));

  // One scroll after the render, the bands and the header: no retry timers.
  assert.doesNotMatch(loadBody, /for \(const delay of \[/);
  assert.equal(loadBody.split('scrollToNewest();').length - 1, 1);

  const edgeAt = loadBody.indexOf('updateEdgeStrips();');
  const pinAt = loadBody.indexOf('if (followFromBottom) scrollToNewest();');
  assert.ok(pinAt > edgeAt, 'the single pin must come after the rows and header are updated');
});

test('date bands mark each day that has rows, and only those', () => {
  assert.match(client, /function buildDateBand\(seconds\)/);
  assert.match(client, /cell\.colSpan = 3;/);
  assert.match(client, /function syncBands\(\)/);
  assert.match(client, /row\.before\(buildDateBand\(time\)\)/);
  assert.match(client, /band\.remove\(\)/);

  assert.match(ruleBody('.chat-table tbody tr.date-row td'), /text-align:\s*center/);
  assert.match(ruleBody('.chat-table tbody tr.date-row td'), /linear-gradient/);
  assert.match(ruleBody('.chat-table tbody tr.date-row'), /cursor:\s*default/);

  // Every way rows can change re-derives the bands from the rows themselves.
  assert.match(client, /elements\.body\.replaceChildren\(\.\.\.rows\);\n  syncBands\(\);/);
  assert.match(client, /elements\.body\.append\(\.\.\.rows\);\n  syncBands\(\);/);
  assert.match(client, /elements\.body\.prepend\(\.\.\.rows\);\n  syncBands\(\);/);
});

test('the sticky header carries a tab naming the day on screen', () => {
  assert.match(html, /id="date-tab-row"/);
  assert.match(html, /id="date-tab"/);
  assert.match(ruleBody('.chat-table thead tr.date-tab-row th'), /position:\s*sticky/);
  assert.match(ruleBody('.chat-table thead tr.date-tab-row th'), /top:\s*38px/);
  assert.match(ruleBody('.date-tab'), /border-radius:\s*0 0 10px 10px/);

  // The strip under the header follows the height the header really has.
  assert.match(ruleBody('.edge-strip-top'), /top:\s*var\(--mafia-header-height/);
  assert.match(client, /setProperty\('--mafia-header-height'/);

  assert.match(client, /function updateDateTab\(\)/);
  assert.match(client, /elements\.dateTabText\.textContent = label/);
  assert.match(client, /elements\.dateTab\.hidden = true;/);

  // The tab follows the rows, so it is refreshed with the edge strips.
  const edges = client.slice(client.indexOf('function updateEdgeStrips()'), client.indexOf('let edgeFrame'));
  assert.match(edges, /updateDateTab\(\);/);
});

test('rows show only the clock time; the day comes from the band and the tab', () => {
  assert.match(client, /function formatLocalClock\(seconds\)/);
  assert.match(client, /timeText\.textContent = formatLocalClock\(message\.message_timestamp\);/);
  assert.doesNotMatch(client, /timeText\.textContent = formatLocalTimestamp/);

  // The full timestamp stays on the row, where sorting and the bands read it.
  assert.match(client, /row\.dataset\.time = String\(Number\(message\.message_timestamp\) \|\| 0\);/);
});

test('clearing the search returns to the window the reader came from', () => {
  assert.match(client, /function captureView\(\)/);
  assert.match(client, /async function restoreView\(view\)/);
  assert.match(client, /if \(!wasActive && value\) state\.savedView = captureView\(\);/);
  assert.match(client, /if \(!value && wasActive && state\.savedView\)/);
  assert.match(client, /scroller\.scrollTop \+= \(row\.getBoundingClientRect\(\)\.top - viewport\.top\) - view\.anchorOffset;/);

  // Search runs in the database across the whole archive, bounded by the dates.
  assert.match(client, /if \(state\.search\) params\.set\('q', state\.search\);/);
  assert.match(chatApi, /message_text LIKE \?/);
  assert.match(chatApi, /message_timestamp >= \?/);
  assert.match(chatApi, /message_timestamp <= \?/);
});

test('the site files are served as a plain static app', async () => {
  const app = express();
  app.use(express.static(mafiaDirectory, {index: 'index.html'}));

  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise(done => httpServer.once('listening', done));

  try {
    const base = `http://127.0.0.1:${httpServer.address().port}`;

    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="chat-body"/);

    const sheet = await fetch(base + '/styles.css');
    assert.equal(sheet.status, 200);
    assert.match(sheet.headers.get('content-type') || '', /text\/css/);

    const script = await fetch(base + '/app.js');
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') || '', /javascript/);
  } finally {
    await new Promise(done => httpServer.close(done));
  }
});
