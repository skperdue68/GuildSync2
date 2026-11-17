import test from 'node:test';
import assert from 'node:assert/strict';
import { data, execute, LINK_REQUIRED_MESSAGE } from './trader.js';

function fixture({ response, option = 'on', connected = true } = {}) {
  const replies = [];
  const calls = [];
  const interaction = {
    user: { id: '42' },
    guildId: null,
    options: { getSubcommand: () => option },
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

test('the global /trader command exposes on, register, off and unregister', () => {
  assert.equal(data.name, 'trader');
  assert.deepEqual(data.options.map((option) => option.name), ['on', 'register', 'off', 'unregister']);
  assert.equal(data.dm_permission, true);
  assert.ok(!JSON.stringify(data.toJSON()).includes('"sales"'), 'the retired /sales command is gone');
});

test('register and unregister map onto the on/off subscription actions', async () => {
  for (const [option, action] of [['on', 'on'], ['register', 'on'], ['off', 'off'], ['unregister', 'off']]) {
    const f = fixture({ response: { ok: true, linked: true, eso_account_name: '@Seller' }, option });
    await execute(f.interaction, f.socket);
    assert.equal(f.calls[0].event, 'guildsync:trader-sales-subscription');
    assert.deepEqual(f.calls[0].payload, { discord_user_id: '42', action });
  }
});

test('without a linked ESO account the user gets the setup guidance', async () => {
  const f = fixture({ response: { ok: false, linked: false }, option: 'on' });
  await execute(f.interaction, f.socket);

  assert.equal(f.replies[0].content, LINK_REQUIRED_MESSAGE);
  assert.match(f.replies[0].content, /@evainefaye/);
  assert.match(f.replies[0].content, /linked to an ESO account/);
});

test('turning invoices on and off reports the linked account', async () => {
  const on = fixture({ response: { ok: true, linked: true, eso_account_name: '@Seller' }, option: 'register' });
  await execute(on.interaction, on.socket);
  assert.match(on.replies[0].content, /registered for @Seller/);

  const off = fixture({ response: { ok: true, linked: true, eso_account_name: '@Seller' }, option: 'unregister' });
  await execute(off.interaction, off.socket);
  assert.match(off.replies[0].content, /invoices are off for @Seller/);
  assert.match(off.replies[0].content, /\/trader on/);
});

test('a disconnected GuildSync backend is reported instead of crashing', async () => {
  const f = fixture({ response: null, connected: false });
  await execute(f.interaction, f.socket);
  assert.match(f.replies[0].content, /temporarily unavailable/);
});
