import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('./guild-tools.js', import.meta.url), 'utf8');
const tools = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
test('catalog contains all four HTTPS tools', () => {
  assert.deepEqual(tools.GUILD_TOOLS.map(t => new URL(t.url).hostname), ['scm.perdues.me', 'guildsbounty.perdues.me', 'gsa.perdues.me', 'mafia.perdues.me']);
  assert.ok(tools.GUILD_TOOLS.every(t => new URL(t.url).protocol === 'https:'));
});
test('external links are safe and describe their destination', () => {
  const html = tools.renderGuildTools();
  for (const tool of tools.GUILD_TOOLS) assert.ok(html.includes(tool.url));
  assert.equal((html.match(/rel="noopener noreferrer"/g)||[]).length, 4);
  assert.equal((html.match(/target="_blank"/g)||[]).length, 4);
});
test('web and desktop share the same tools implementation', async () => {
  const web = await readFile(new URL('../../../../NodeJS/GuildSync-Backend-Server/web/src/guild-tools.js', import.meta.url), 'utf8');
  assert.equal(web, source);
});
