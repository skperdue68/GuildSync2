import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

// The desktop client and the web client are separate frontends that share most
// of their code. Only main.js is expected to differ, and only in the places
// where the runtime differs: the desktop owns local ESO file watching, autostart
// and the Wails bridge, while the web client owns the SavedVariables drop zone
// and download links. Guild Chat is the clearest example: both clients render the
// same panel from guild-chat-panel.js, but the desktop opens the chat in the
// system browser while the web client embeds it in an iframe inside the page.
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const desktopDir = path.join(repo, 'GO', 'GuildSync-Frontend-Client', 'frontend', 'src');
const webDir = path.join(repo, 'NodeJS', 'GuildSync-Backend-Server', 'web', 'src');

const normalise = (text) => text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
const readNormalised = (file) => normalise(readFileSync(file, 'utf8'));

// Modules that exist on one side only, with the reason the other side has no use
// for them.
const ONE_SIDED_DESKTOP_MODULES = new Map([
  ['chat-upload.js', 'desktop uploads the local GuildSyncChat export; the web client has no local files'],
  ['desktop-support.js', 'the blocked-desktop screen for an out-of-date desktop build'],
  ['profile-menu-shell.js', 'desktop profile menu chrome wired to the Wails window'],
  ['shortcut-capture.js', 'captures the desktop global mute shortcut'],
  ['voice-hotkey.js', 'Wails global hotkey controller for voice mute']
]);
const ONE_SIDED_WEB_MODULES = new Map([
  ['web-api.js', 'browser transport that replaces the Wails bindings'],
  ['web-events.js', 'browser event plumbing that replaces the Wails event bridge']
]);

// Modules that must stay identical in both clients.
const SHARED_MODULES = readdirSync(desktopDir)
  .filter((file) => file.endsWith('.js') && file !== 'main.js')
  .filter((file) => !ONE_SIDED_DESKTOP_MODULES.has(file));

// Functions inside main.js that must not drift. Everything the member-link,
// presence and profile presentation layers use lives here, so a fix applied to
// one client cannot be forgotten in the other.
const SHARED_FUNCTION_PATTERNS = [
  /^renderMemberLink/,
  /^memberLink/,
  /^guildSyncPresence/,
  /^profileStartAtLogin/,
  /^refreshStartAtLogin/,
  /^saveStartAtLogin/,
  /^canManageGuildSyncLinks$/,
  /^formatMemberLinkMethodForDisplay$/
];

function collectFunctions(source) {
  const pattern = /^(?:export )?(?:async )?function ([A-Za-z0-9_$]+)\s*\(/gm;
  const starts = [];
  let match;
  while ((match = pattern.exec(source))) starts.push({name: match[1], start: match.index});
  const functions = new Map();
  starts.forEach((entry, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].start : source.length;
    functions.set(entry.name, normalise(source.slice(entry.start, end)));
  });
  return functions;
}

test('every shared frontend module is identical in the desktop and web clients', () => {
  const missing = SHARED_MODULES.filter(
    (file) => !readdirSync(webDir).includes(file) && !ONE_SIDED_WEB_MODULES.has(file)
  );
  assert.deepEqual(missing, [], `modules missing from the web client: ${missing.join(', ')}`);
  const drifted = SHARED_MODULES.filter(
    (file) => readNormalised(path.join(desktopDir, file)) !== readNormalised(path.join(webDir, file))
  );
  assert.deepEqual(
    drifted,
    [],
    `these shared modules drifted between the two clients: ${drifted.join(', ')}. ` +
      'Edit both copies (they are meant to be identical) or list the file as one-sided with a reason.'
  );
});

test('one-sided modules are declared with a reason on both sides', () => {
  const desktopOnly = readdirSync(desktopDir)
    .filter((file) => file.endsWith('.js') && !readdirSync(webDir).includes(file))
    .sort();
  assert.deepEqual(desktopOnly, [...ONE_SIDED_DESKTOP_MODULES.keys()].sort());
  const webOnly = readdirSync(webDir)
    .filter((file) => file.endsWith('.js') && !readdirSync(desktopDir).includes(file))
    .sort();
  assert.deepEqual(webOnly, [...ONE_SIDED_WEB_MODULES.keys()].sort());
});

test('the shared presentation functions in main.js stay in step', () => {
  const desktop = collectFunctions(readNormalised(path.join(desktopDir, 'main.js')));
  const web = collectFunctions(readNormalised(path.join(webDir, 'main.js')));
  const shared = [...desktop.keys()].filter((name) => web.has(name));
  const watched = shared.filter((name) => SHARED_FUNCTION_PATTERNS.some((pattern) => pattern.test(name)));
  assert.ok(watched.length >= 8, `expected the member-link/presence helpers to be shared, saw ${watched.length}`);
  const drifted = watched.filter((name) => desktop.get(name) !== web.get(name));
  assert.deepEqual(drifted, [], `these main.js functions drifted: ${drifted.join(', ')}`);
});

test('guild chat is the documented main.js difference: iframe on the web, browser on the desktop', () => {
  const desktop = readNormalised(path.join(desktopDir, 'main.js'));
  const web = readNormalised(path.join(webDir, 'main.js'));
  assert.match(
    desktop,
    /createGuildChatPanel\(\{openExternal: BrowserOpenURL/,
    'the desktop client opens Guild Chat in the system browser'
  );
  assert.match(
    web,
    /createGuildChatPanel\(\{web: true\}\)/,
    'the web client asks the shared panel for its in-page mode instead of opening a browser'
  );
  // The panel itself is shared byte for byte, so the iframe lives behind that
  // web flag rather than in a second copy of the panel.
  const panel = readNormalised(path.join(desktopDir, 'guild-chat-panel.js'));
  assert.match(panel, /iframe/i, 'the shared panel should own the embedded chat frame');
});

test('the report action buttons keep one shared icon rule and no per-button duplicate', () => {
  for (const file of [
    path.join(desktopDir, 'style.css'),
    path.join(webDir, 'style.css')
  ]) {
    const css = normalise(readFileSync(file, 'utf8'));
    assert.ok(
      css.includes('.member-link-report-action svg,'),
      `${path.relative(repo, file)} lost the shared action icon rule`
    );
    assert.ok(
      !/\.member-link-report-trash\s+\.member-link-unlink-icon/.test(css),
      `${path.relative(repo, file)} reintroduced the superseded trash-button icon rule`
    );
  }
});
