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
  for (const key of ['time', 'sender', 'message', 'source', 'uploaded_by']) {
    assert.match(html, new RegExp(`data-sort="${key}"`), `${key} has no sort header`);
  }
  assert.equal((html.match(/data-sort="/g) || []).length, 5);

  // Clicking a header re-queries and keeps the newest-first default.
  assert.match(client, /header\.addEventListener\('click', \(\) => applySort\(header\.dataset\.sort\)\)/);
  assert.match(client, /state\.dir = 'desc';/);
  assert.match(client, /string:\s*state\.sort|sort: state\.sort/);
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

test('the sender column is right justified and the message carries the tooltip', () => {
  assert.match(ruleBody('.cell-sender'), /text-align:\s*right/);
  assert.match(html, /data-sort="sender" class="align-right"/);
  assert.match(ruleBody('.align-right .sort-button'), /justify-content:\s*flex-end/);
  assert.match(client, /closest\('td\.cell-message'\)/);
  assert.match(client, /tooltipLine\('Received'/);
  assert.match(client, /tooltipLine\('Uploaded by'/);
});

test('the search box and the calendar range drive the query and update immediately', () => {
  assert.match(html, /id="search-input"/);
  assert.equal((html.match(/type="datetime-local"/g) || []).length, 2);
  assert.match(html, /id="range-start"/);
  assert.match(html, /id="range-end"/);
  assert.match(client, /setTimeout\(\(\) => \{[\s\S]*?state\.search = elements\.search\.value\.trim\(\);/);
  assert.match(client, /params\.set\('q', state\.search\)/);
  assert.match(client, /params\.set\('start', String\(state\.start\)\)/);
  assert.match(client, /params\.set\('end', String\(state\.end\)\)/);
  assert.match(client, /elements\.rangeClear\.addEventListener\('click'/);
});

test('live updates only raise a notice and wait for the refresh button', () => {
  assert.match(client, /window\.io\('\/mafia'/);
  const handler = client.match(/socket\.on\('chat-updated'[\s\S]*?\n  \}\);/);
  assert.ok(handler, 'the chat-updated listener was not found');
  assert.match(handler[0], /showUpdateBanner/);
  assert.doesNotMatch(handler[0], /loadMessages\(/);
  assert.match(client, /elements\.refresh\.addEventListener\('click', refreshMessages\)/);
  assert.match(client, /elements\.bannerRefresh\.addEventListener\('click', refreshMessages\)/);
});

test('the backend runs the site on its own listener at port 3018', () => {
  assert.match(server, /const MAFIA_PORT = Number\(process\.env\.MAFIA_PORT \|\| 3018\)/);
  assert.match(server, /const mafiaApp = express\(\)/);
  assert.match(server, /mafiaApp\.use\('\/api\/mafia\/chat', createMafiaChatRouter\(/);
  assert.match(server, /mafiaApp\.use\(mafiaWebApp\)/);
  assert.match(server, /const mafiaServer = http\.createServer\(mafiaApp\)/);
  assert.match(server, /const mafiaIo = new Server\(mafiaServer/);
  assert.match(server, /mafiaServer\.listen\(MAFIA_PORT, HOST/);

  // The GuildSync listener must not take over the mafia routes any more.
  assert.doesNotMatch(server, /app\.use\('\/mafia', mafiaWebApp\)/);
});

test('stored chat rows notify the mafia listener only, and only when rows were inserted', () => {
  const helperAt = server.indexOf('function broadcastMafiaChatUpdate');
  assert.ok(helperAt > 0, 'the mafia broadcast helper was not found');
  const helper = server.slice(helperAt, helperAt + 600);

  assert.match(helper, /mafiaIo\.of\('\/mafia'\)\.emit\(MAFIA_CHAT_UPDATED_EVENT/);
  // GuildSync's own Socket.IO server must not receive mafia traffic.
  assert.doesNotMatch(helper, /for \(const socketServer of \[io, mafiaIo\]\)/);
  assert.doesNotMatch(helper, /(^|[^a-zA-Z])io\.of\(/m);

  const guardAt = server.indexOf('if (result.chat_messages_inserted > 0) {');
  const callAt = server.indexOf('broadcastMafiaChatUpdate({inserted: result.chat_messages_inserted});');
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
