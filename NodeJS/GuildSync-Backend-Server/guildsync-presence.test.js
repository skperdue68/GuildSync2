import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createGuildSyncPresence, registerGuildSyncPresenceSocket, normalizePresenceClientType, isTrackedPresenceSocket} from './guildsync-presence.js';
import {canPerformGuildSyncEvent} from './role-permissions.js';

function socket(id, overrides = {}) {
  return {
    id,
    guildSyncAuthenticated: true,
    guildSyncAuthType: 'GuildSync user',
    guildSyncUser: {discord_user_id: id, display_name: `Name ${id}`, username: `user${id}`},
    guildSyncClientType: 'wails',
    on() {},
    emit() {},
    ...overrides
  };
}

test('only approved user connections are tracked', () => {
  const presence = createGuildSyncPresence();

  assert.equal(presence.join(socket('1')), true);
  assert.equal(presence.join(socket('2', {guildSyncAuthenticated: false})), false);
  assert.equal(presence.join(socket('3', {guildSyncAuthType: 'discord-bot', guildSyncUser: null})), false);
  assert.equal(presence.join(socket('4', {guildSyncAuthType: 'voice-mute'})), false);
  assert.equal(presence.join(socket('5', {guildSyncUser: {}})), false);
  assert.equal(presence.join(socket('1')), false, 'the same socket is only counted once');
  assert.equal(presence.snapshot().total, 1);
});

test('a person drops off the list when their socket closes or signs out', () => {
  const presence = createGuildSyncPresence();
  presence.join(socket('1'));

  assert.equal(presence.leave('1'), true);
  assert.equal(presence.leave('1'), false);
  assert.deepEqual(presence.snapshot(), {users: [], total: 0, eso_running: 0});
  assert.equal(presence.connections(), 0);
});

test('one person on two clients counts once and keeps both client types', () => {
  const presence = createGuildSyncPresence();
  presence.join(socket('7', {guildSyncClientType: 'wails'}));
  presence.join(socket('7-desktop', {
    guildSyncClientType: 'web',
    guildSyncUser: {discord_user_id: '7', display_name: 'Name 7', username: 'user7'}
  }));
  presence.setEsoRunning('7-desktop', true);

  const snapshot = presence.snapshot();
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.eso_running, 1);
  assert.deepEqual(snapshot.users[0].client_types.sort(), ['desktop', 'web']);
  assert.equal(snapshot.users[0].eso_running, true);
  assert.equal(snapshot.users[0].login, '@user7');
});

test('ESO state is reported as a running count and only broadcasts on change', () => {
  const presence = createGuildSyncPresence();
  presence.join(socket('1'));
  presence.join(socket('2'));
  presence.setEsoRunning('2', true);

  assert.deepEqual(presence.snapshot().eso_running, 1);
  assert.equal(presence.setEsoRunning('2', true), false, 'unchanged state is not a new event');
  assert.equal(presence.setEsoRunning('2', false), true);
  assert.equal(presence.setEsoRunning('missing', true), false);
  assert.equal(presence.snapshot().eso_running, 0);
});

test('snapshots sort people by name and carry the client type label', () => {
  const presence = createGuildSyncPresence();
  presence.join(socket('2', {guildSyncUser: {discord_user_id: '2', display_name: 'Zed', username: 'zed'}}));
  presence.join(socket('1', {guildSyncUser: {discord_user_id: '1', display_name: 'Alice', username: 'alice'}, guildSyncClientType: 'web'}));

  assert.deepEqual(presence.snapshot().users.map(user => user.name), ['Alice', 'Zed']);
  assert.deepEqual(presence.snapshot().users.map(user => user.client_types), [['web'], ['desktop']]);
});

test('client type labels map the desktop handshake onto desktop', () => {
  assert.equal(normalizePresenceClientType('wails'), 'desktop');
  assert.equal(normalizePresenceClientType('WEB'), 'web');
  assert.equal(normalizePresenceClientType(''), 'desktop');
  assert.equal(normalizePresenceClientType(undefined), 'desktop');
});

test('socket handlers answer presence requests and forward ESO reports', () => {
  const handlers = new Map();
  const presence = createGuildSyncPresence();
  const client = socket('9', {on: (event, handler) => handlers.set(event, handler), emit: (event, payload) => client.emitted.push({event, payload})});
  client.emitted = [];
  presence.join(client);

  let broadcasts = 0;
  registerGuildSyncPresenceSocket(client, presence, {broadcast: () => broadcasts++});

  handlers.get('guildsync:presence-request')();
  assert.equal(client.emitted.length, 1);
  assert.equal(client.emitted[0].event, 'guildsync:presence');
  assert.equal(client.emitted[0].payload.total, 1);

  handlers.get('guildsync:report-eso-status')({running: true});
  assert.equal(broadcasts, 1);
  assert.equal(presence.snapshot().eso_running, 1);

  handlers.get('guildsync:report-eso-status')({running: true});
  assert.equal(broadcasts, 1, 'an unchanged report does not rebroadcast');

  const anonymous = {id: 'anon', guildSyncAuthenticated: false, guildSyncAuthType: 'anonymous', on: (event, handler) => handlers.set(`anon:${event}`, handler), emit: () => assert.fail('unauthenticated sockets get no presence')};
  registerGuildSyncPresenceSocket(anonymous, presence, {broadcast: () => assert.fail('unauthenticated sockets change nothing')});
  handlers.get('anon:guildsync:presence-request')();
  handlers.get('anon:guildsync:report-eso-status')({running: true});
});

test('viewers and users may read presence and report their own ESO state', () => {
  for (const role of ['viewer', 'user', 'admin']) {
    assert.equal(canPerformGuildSyncEvent(role, 'guildsync:presence-request'), true, role);
    assert.equal(canPerformGuildSyncEvent(role, 'guildsync:report-eso-status'), true, role);
  }
  assert.equal(isTrackedPresenceSocket({guildSyncAuthenticated: true, guildSyncAuthType: 'GuildSync user', guildSyncUser: {discord_user_id: '1'}}), true);
});

test('the server tracks presence on connect and drops it on disconnect', () => {
  const source = readFileSync(new URL('./guildsync-backend-server.js', import.meta.url), 'utf8');
  const connection = source.slice(source.indexOf('function registerGuildSyncConnection('));

  assert.match(connection, /guildSyncPresence\.join\(socket\)/);
  assert.match(connection, /registerGuildSyncPresenceSocket\(socket,guildSyncPresence,\{broadcast:broadcastGuildSyncPresence\}\)/);
  assert.match(connection, /socket\.on\('disconnect',\(\)=>\{if\(guildSyncPresence\.leave\(socket\.id\)\)broadcastGuildSyncPresence\(\);\}\);/);
  assert.match(source, /socket\.guildSyncClientType = normalizePresenceClientType\(auth\.client_type\);/);
});
