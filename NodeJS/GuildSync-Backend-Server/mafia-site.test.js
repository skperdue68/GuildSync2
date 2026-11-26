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

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : '';
}

test('every visible value has a sortable column header', () => {
  for (const key of ['time', 'sender', 'message']) {
    assert.match(html, new RegExp(`data-sort="${key}"`), `${key} has no sort header`);
  }
  assert.equal((html.match(/data-sort="/g) || []).length, 3);
  assert.doesNotMatch(html, /data-sort="source"/);
  assert.doesNotMatch(html, /data-sort="uploaded_by"/);

  assert.match(client, /header\.addEventListener\('click', \(\) => applySort\(header\.dataset\.sort\)\)/);
  assert.match(client, /state\.dir = 'desc';/);
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
  assert.match(html, /data-sort="time" class="align-right"/);
  assert.match(ruleBody('.cell-sender'), /text-align:\s*right/);
  assert.match(html, /data-sort="sender" class="align-right"/);
  assert.match(ruleBody('.align-right .sort-button'), /justify-content:\s*flex-end/);
});

test('every row carries the provenance tooltip', () => {
  assert.match(client, /const row = event\.target\.closest\('tr'\)/);
  assert.match(client, /tooltipLine\('Received'/);
  assert.match(client, /tooltipLine\('Uploaded by'/);
  assert.doesNotMatch(client, /tooltipLine\('Data source'/);
  assert.match(ruleBody('.chat-table tbody tr'), /cursor:\s*help/);
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

  // From is midnight, To is the last second of its day.
  assert.match(client, /new Date\(year, month - 1, day, 0, 0, 0\)/);
  assert.match(client, /new Date\(year, month - 1, day, 23, 59, 59\)/);
  assert.match(client, /params\.set\('start', String\(state\.start\)\)/);
  assert.match(client, /params\.set\('end', String\(state\.end\)\)/);
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

test('results page with a Load older button and a restamped footer', () => {
  assert.match(html, /id="load-older"/);
  assert.match(client, /const PAGE_SIZE = 500;/);
  assert.match(client, /offset: String\(offset\)/);
  assert.match(client, /elements\.loadOlder\.addEventListener\('click', \(\) => \{\n  loadPage\(\{offset: state\.offset \+ state\.loaded, append: true\}\);\n\}\);/);
  assert.match(client, /elements\.loadOlder\.hidden = total === 0 \|\| loaded >= total;/);
  assert.match(client, /state\.offset = Number\(payload\.offset\) \|\| 0;/);

  const loader = client.slice(client.indexOf('async function loadPage'), client.indexOf('async function refreshAll'));
  assert.match(loader, /markUpdated\(\)/);
  assert.match(loader, /if \(append\) appendMessages\(payload\.messages\);/);
});

test('pushed rows join only the page they belong to', () => {
  assert.match(client, /async function fetchPositions\(/);
  assert.match(client, /\/api\/mafia\/chat\/position\?/);
  assert.match(client, /const windowStart = state\.offset;/);
  assert.match(client, /const atEndOfResults = state\.offset \+ state\.loaded >= state\.total;/);
  assert.match(client, /const index = before - windowStart;/);
  assert.match(client, /if \(index < 0\) continue;/);
  assert.match(client, /if \(index > state\.loaded\) continue;/);
  assert.match(client, /if \(index === state\.loaded && !atEndOfResults\) continue;/);
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
});

test('new rows above the viewport raise a jump pill', () => {
  assert.match(html, /id="new-messages-pill"/);
  assert.match(client, /elements\.pill\.dataset\.mode = mode;/);
  assert.match(client, /elements\.tableScroll\.scrollTop = 0;/);
  assert.match(client, /if \(elements\.pill\.dataset\.mode === 'refresh'\)/);
  assert.match(client, /state\.pendingAbove \+= inserted;/);
  assert.match(ruleBody('.new-pill'), /position:\s*absolute/);
});

test('rows are permalinks that open and highlight the message', () => {
  assert.match(client, /const HASH_MESSAGE = \/\^#msg-\(\\d\{1,15\}\)\$\/;/);
  assert.match(client, /row\.id = `msg-\$\{message\.id\}`;/);
  assert.match(client, /navigator\.clipboard\.writeText\(link\)/);
  assert.match(client, /params\.set\('focus', String\(focus\)\)/);
  assert.match(client, /function revealFocusedRow\(id\)/);
  assert.match(client, /row\.classList\.add\('row-flash'\)/);
  assert.match(css, /\.chat-row\.row-flash td/);
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
