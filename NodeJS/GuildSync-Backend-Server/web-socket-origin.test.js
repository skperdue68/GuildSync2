import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./web/src/main.js', import.meta.url), 'utf8');
const pick = name => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?(?=\\n(?:async )?function |$)`))?.[0] || '';
const functions = `${pick('isGuildSyncWebRuntime')}\n${pick('connectSocket')}`;

function connect({ webOrigin, session = {} } = {}) {
  const opened = [];
  const connection = { connected: true, on() {}, disconnect() {} };
  const context = vm.createContext({
    guildSyncSession: { token: 'test-token', ...session },
    GUILDSYNC_APP_VERSION: '2.1.7-beta',
    getGuildSyncClientPlatform: () => 'windows',
    activeGuildSyncTab: 'discord-members',
    socket: null,
    disconnectSocket() {},
    handleMemberLinksUpdated() {},
    io(url, options) {
      opened.push({ url, options });
      return connection;
    }
  });
  // The desktop client has no page origin at all, so it omits window entirely.
  if (webOrigin) context.window = { GUILDSYNC_WEB: true, location: { origin: webOrigin } };
  vm.runInContext(functions, context);
  vm.runInContext('connectSocket()', context);
  return opened;
}

test('the browser build connects to the origin that served it', () => {
  for (const origin of ['http://127.0.0.1:3011', 'https://staging.example.test', 'https://guildsync.perdues.me']) {
    const opened = connect({ webOrigin: origin });
    assert.equal(opened.length, 1);
    assert.equal(opened[0].url, origin);
    assert.equal(opened[0].options.auth.client_type, 'web');
  }
});

test('the desktop client still falls back to the public production host', () => {
  const opened = connect();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].url, 'https://guildsync.perdues.me');
});

test('a session socket_url still wins over the origin fallback', () => {
  const opened = connect({ webOrigin: 'https://guildsync.perdues.me', session: { socket_url: 'https://socket.example.test' } });
  assert.equal(opened[0].url, 'https://socket.example.test');
});
