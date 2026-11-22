import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAVED_VARS_DIR_MAX_LENGTH, initializeUserSettingsSchema, loadUserSettings,
  normalizeSavedVarsDir, registerUserSettingsSocket, saveUserSettings
} from './user-settings.js';

function memoryDB(initial = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    calls: [],
    async query(sql) { this.calls.push(sql); },
    async execute(sql, args) {
      this.calls.push(sql);
      if (sql.startsWith('SELECT')) {
        const value = rows.get(String(args[0]));
        return [value === undefined ? [] : [{ saved_vars_dir: value }]];
      }
      rows.set(String(args[0]), String(args[1]));
      return [{}];
    }
  };
}

test('the SavedVariables folder schema is created once and stores one row per account', async () => {
  const db = memoryDB();
  await initializeUserSettingsSchema(db);
  assert.match(db.calls[0], /CREATE TABLE IF NOT EXISTS guildsync_user_settings/);
  assert.match(db.calls[0], /discord_user_id VARCHAR\(32\) PRIMARY KEY/);
  assert.match(db.calls[0], /saved_vars_dir VARCHAR\(1024\)/);
});

test('a stored folder is trimmed, survives updates and can be cleared back to the default', async () => {
  const db = memoryDB();
  assert.deepEqual(await loadUserSettings(db, '123'), { savedVarsDir: '' });
  assert.deepEqual(await saveUserSettings(db, '123', { savedVarsDir: '  ~/Documents/ESO/live/SavedVariables  ' }), {
    savedVarsDir: '~/Documents/ESO/live/SavedVariables'
  });
  assert.deepEqual(await loadUserSettings(db, '123'), { savedVarsDir: '~/Documents/ESO/live/SavedVariables' });
  assert.deepEqual(await loadUserSettings(db, '999'), { savedVarsDir: '' }, 'another account keeps the default');
  assert.ok(db.calls.some(sql => /ON DUPLICATE KEY UPDATE/.test(sql)), 'saving updates the existing row');
  assert.deepEqual(await saveUserSettings(db, '123', { savedVarsDir: '   ' }), { savedVarsDir: '' });
  assert.deepEqual(await loadUserSettings(db, '123'), { savedVarsDir: '' });
});

test('paths longer than the column and control characters are rejected', () => {
  assert.equal(normalizeSavedVarsDir('C:\\ESO\\SavedVariables'), 'C:\\ESO\\SavedVariables');
  assert.throws(() => normalizeSavedVarsDir('x'.repeat(SAVED_VARS_DIR_MAX_LENGTH + 1)), /too long/);
  assert.throws(() => normalizeSavedVarsDir('C:\\ESO\nSavedVariables'), /cannot be used in a path/);
});

test('only a signed-in approved account can read or change its own settings', async () => {
  const db = memoryDB();
  const handlers = new Map();
  const socket = {
    guildSyncAuthenticated: true,
    guildSyncAuthType: 'GuildSync user',
    guildSyncUser: { discord_user_id: '123', role: 'viewer' },
    on: (event, handler) => handlers.set(event, handler)
  };
  registerUserSettingsSocket(socket, { db });
  const call = async (event, payload = {}) => {
    let response;
    await handlers.get(event)(payload, result => { response = result; });
    return response;
  };
  // The payload cannot choose another account.
  assert.equal((await call('guildsync:save-user-settings', { discord_user_id: '999', savedVarsDir: 'C:\\ESO\\SV' })).ok, true);
  assert.deepEqual([...db.rows.keys()], ['123']);
  assert.equal((await call('guildsync:request-user-settings')).settings.savedVarsDir, 'C:\\ESO\\SV');

  socket.guildSyncAuthenticated = false;
  const signedOut = await call('guildsync:request-user-settings');
  assert.equal(signedOut.ok, false);
  assert.match(signedOut.message, /Sign in/);

  socket.guildSyncAuthenticated = true;
  socket.guildSyncAuthType = 'discord-bot';
  assert.equal((await call('guildsync:save-user-settings', { savedVarsDir: 'C:\\Other' })).ok, false);
  socket.guildSyncAuthType = 'GuildSync user';
  socket.guildSyncUser = { discord_user_id: '123' };
  assert.equal((await call('guildsync:request-user-settings')).ok, false);
});

test('a revoked account is rejected even with a valid socket identity', async () => {
  const db = memoryDB();
  const handlers = new Map();
  const socket = {
    guildSyncAuthenticated: true,
    guildSyncAuthType: 'GuildSync user',
    guildSyncUser: { discord_user_id: '123', role: 'admin' },
    on: (event, handler) => handlers.set(event, handler)
  };
  let allowed = false;
  registerUserSettingsSocket(socket, { db, authorizeUser: async () => allowed });
  let response;
  await handlers.get('guildsync:save-user-settings')({ savedVarsDir: 'C:\\ESO\\SV' }, result => { response = result; });
  assert.equal(response.ok, false);
  assert.match(response.message, /Approved/);
  assert.equal(db.rows.size, 0);
  allowed = true;
  await handlers.get('guildsync:save-user-settings')({ savedVarsDir: 'C:\\ESO\\SV' }, result => { response = result; });
  assert.equal(response.ok, true);
});
