import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

test('the web profile menu lists Trader as a read-only file watch entry', () => {
  const api = read('./web/src/web-api.js');
  assert.match(api, /read_only:\s*true/);
  assert.match(api, /key:\s*'trader',\s*fileName:\s*'GuildSyncTrader\.lua'/);

  const menu = read('./web/src/main.js');
  assert.match(menu, /status\?\.read_only === true/);
  assert.match(menu, /readOnly \? 'Desktop only'/);
  assert.match(menu, /readOnly \? '' : `<input/);
});

test('the desktop watcher still registers Trader with an on/off toggle', () => {
  const paths = read('../../GO/GuildSync-Frontend-Client/paths.go');
  assert.match(paths, /Key:\s*"trader"/);
  assert.match(paths, /SAVED_VARS_TRADER_FILE_NAME/);

  const menu = read('../../GO/GuildSync-Frontend-Client/frontend/src/main.js');
  assert.match(menu, /profile-filewatch-toggle/);
  assert.doesNotMatch(menu, /read_only:\s*true/);
});
