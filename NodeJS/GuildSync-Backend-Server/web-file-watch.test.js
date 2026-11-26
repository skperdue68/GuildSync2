import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

test('the web profile menu lists every watched file as a read-only entry', () => {
  const api = read('./web/src/web-api.js');
  assert.match(api, /read_only:\s*true/);

  for (const [key, fileName] of [
    ['banking', 'GuildSyncBanking.lua'],
    ['roster', 'GuildSyncRoster.lua'],
    ['applications', 'GuildSyncApplications.lua'],
    ['trader', 'GuildSyncTrader.lua'],
    ['chat', 'GuildSyncChat.lua'],
    ['discord_reminders', 'GuildSyncDiscordReminder.lua']
  ]) {
    assert.match(api, new RegExp(`key: '${key}', fileName: '${fileName.replace('.', '\\.')}'`), `${fileName} is missing`);
  }

  const menu = read('./web/src/main.js');
  assert.match(menu, /status\?\.read_only === true/);
  assert.match(menu, /readOnly \? 'Desktop only'/);
  assert.match(menu, /readOnly \? '' : `<input/);
});

test('every watched SavedVariables file can be dropped on the web client', () => {
  const menu = read('./web/src/main.js');

  for (const fileName of [
    'GuildSyncBanking.lua',
    'GuildSyncRoster.lua',
    'GuildSyncApplications.lua',
    'GuildSyncTrader.lua',
    'GuildSyncChat.lua',
    'GuildSyncDiscordReminder.lua'
  ]) {
    assert.match(menu, new RegExp(`\\['${fileName.replace('.', '\\.')}', '[a-z_]+'\\]`), `${fileName} is not droppable`);
  }

  // The server accepts the same six files and has a branch for each of the new ones.
  const server = read('./guildsync-backend-server.js');
  const allowlist = server.slice(server.indexOf('const allowedFiles = new Set(['), server.indexOf('if (!allowedFiles.has(fileName))'));

  for (const fileName of ['GuildSyncChat.lua', 'GuildSyncDiscordReminder.lua', 'GuildSyncTrader.lua']) {
    assert.ok(allowlist.includes(fileName), `${fileName} is not allowed by the raw upload`);
  }

  assert.match(server, /if \(fileName === 'GuildSyncChat\.lua'\) \{\s+const data = parseGuildSyncChatSavedVarsLua\(rawLuaText\);/);
  assert.match(server, /if \(fileName === 'GuildSyncDiscordReminder\.lua'\) \{\s+const data = parseGuildSyncDiscordReminderSavedVarsLua\(rawLuaText\);/);
  assert.match(server, /ingestGuildChatMessages\(applicationDB, \{/);
  assert.match(server, /discordReminders\.acknowledge\(reminderUserId/);
});

test('the desktop watcher still registers Trader with an on/off toggle', () => {
  const paths = read('../../GO/GuildSync-Frontend-Client/paths.go');
  assert.match(paths, /Key:\s*"trader"/);
  assert.match(paths, /SAVED_VARS_TRADER_FILE_NAME/);

  const menu = read('../../GO/GuildSync-Frontend-Client/frontend/src/main.js');
  assert.match(menu, /profile-filewatch-toggle/);
  assert.doesNotMatch(menu, /read_only:\s*true/);
});
