import test from 'node:test';
import assert from 'node:assert/strict';
import { data, execute, LINK_REQUIRED_MESSAGE } from './sales.js';

function fixture({ response, action = 'on', connected = true } = {}) {
  const replies = [];
  const calls = [];
  const interaction = {
    user: { id: '42' },
    guildId: null,
    options: { getSubcommand: () => action },
    async deferReply() {},
    async editReply(payload) { replies.push(payload); }
  };
  const socket = {
    connected,
    timeout() { return this; },
    emit(event, payload, callback) {
      calls.push({ event, payload });
      callback(null, response);
    }
  };
  return { interaction, socket, replies, calls };
}

test('the global /sales command exposes on and off subcommands', () => {
  assert.equal(data.name, 'sales');
  assert.deepEqual(data.options.map((option) => option.name), ['on', 'off']);
  assert.equal(data.dm_permission, true);
});

test('without a linked ESO account the user gets the setup guidance', async () => {
  const f = fixture({ response: { ok: false, linked: false }, action: 'on' });
  await execute(f.interaction, f.socket);

  assert.equal(f.calls[0].event, 'guildsync:trader-sales-subscription');
  assert.deepEqual(f.calls[0].payload, { discord_user_id: '42', action: 'on' });
  assert.equal(f.replies[0].content, LINK_REQUIRED_MESSAGE);
  assert.match(f.replies[0].content, /@evainefaye/);
  assert.match(f.replies[0].content, /linked to an ESO account/);
});

test('turning notifications on and off reports the linked account', async () => {
  const on = fixture({ response: { ok: true, linked: true, eso_account_name: '@Seller' }, action: 'on' });
  await execute(on.interaction, on.socket);
  assert.match(on.replies[0].content, /subscribed for @Seller/);

  const off = fixture({ response: { ok: true, linked: true, eso_account_name: '@Seller' }, action: 'off' });
  await execute(off.interaction, off.socket);
  assert.match(off.replies[0].content, /DMs are off for @Seller/);
});

test('a disconnected GuildSync backend is reported instead of crashing', async () => {
  const f = fixture({ response: null, connected: false });
  await execute(f.interaction, f.socket);
  assert.match(f.replies[0].content, /temporarily unavailable/);
});
