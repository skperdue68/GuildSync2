import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { data, execute, searchReceiptCaption, LINK_REQUIRED_MESSAGE } from './trader.js';
import { renderTraderInvoiceImages } from '../trader-invoice-image.js';

function fixture({ response, option = 'on', connected = true, item = null, guildId = null } = {}) {
  const replies = [];
  const calls = [];
  const defers = [];
  const interaction = {
    user: { id: '42' },
    guildId,
    options: {
      getSubcommand: () => option,
      getString: (name) => (name === 'item' ? item : null)
    },
    async deferReply(payload) { defers.push(payload); },
    async editReply(payload) { replies.push(payload); }
  };
  const socket = {
    connected,
    timeout() { return this; },
    emit(event, payload, callback) {
      calls.push({ event, payload });
      // A current backend stamps its protocol on every reply.
      callback(null, response && typeof response === 'object' ? { protocol: 2, ...response } : response);
    }
  };
  return { interaction, socket, replies, defers, calls };
}

test('the global /trader command exposes on, register, off, unregister, sales, receipt and status', () => {
  assert.equal(data.name, 'trader');
  assert.deepEqual(
    data.options.map((option) => option.name),
    ['on', 'register', 'off', 'unregister', 'sales', 'receipt', 'status']
  );
  assert.equal(data.options.some((option) => option.name === 'test'), false, '/trader test is gone');
  assert.equal(data.dm_permission, true);
  assert.ok(
    JSON.stringify(data.toJSON()).includes('"name":"sales"'),
    'the retired /sales command survives only as a /trader subcommand'
  );
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

test('/trader receipt asks for the newest sale and confirms the DM', async () => {
  const f = fixture({
    option: 'receipt',
    guildId: '761817',
    response: { ok: true, linked: true, eso_account_name: '@Seller', sales: [soldSale], latest_entry_time: 1794900000 }
  });
  await execute(f.interaction, f.socket);

  assert.equal(f.calls[0].event, 'guildsync:trader-sales-subscription');
  assert.deepEqual(f.calls[0].payload, { discord_user_id: '42', action: 'receipt' });
  assert.deepEqual(f.defers[0].flags, [MessageFlags.Ephemeral], 'a channel answer stays private to the caller');

  const [freshness, confirmation, summary] = f.replies[0].content.split('\n');
  assert.match(freshness, /^As of <t:\d+:f> — most recent GuildSync info at <t:1794900000:f>\.$/);
  assert.equal(confirmation, 'Sent your newest sale receipt to your DMs.');
  assert.equal(summary, '1 sale · 15g gross · 0g tax · 15g net', 'the numbers are repeated as text');

  assert.equal(f.replies[0].files, undefined, 'the receipt is DMd, not attached to the reply');
});

test('/trader status says whether receipts are on, and whether a DM failed', async () => {
  const on = fixture({
    option: 'status',
    response: { ok: true, linked: true, eso_account_name: '@Seller', enabled: true, subscribed_at: 1794000000 }
  });
  await execute(on.interaction, on.socket);

  assert.deepEqual(on.calls[0].payload, { discord_user_id: '42', action: 'status' });
  assert.match(on.replies[0].content, /^Trader sale receipts are on for @Seller since <t:1794000000:f>\./);
  assert.doesNotMatch(on.replies[0].content, /failed/);

  const broken = fixture({
    option: 'status',
    response: { ok: true, linked: true, eso_account_name: '@Seller', enabled: false, dm_failed_at: 1794900000 }
  });
  await execute(broken.interaction, broken.socket);

  assert.match(broken.replies[0].content, /are off for @Seller/);
  assert.match(broken.replies[0].content, /\/trader on/);
  assert.match(broken.replies[0].content, /last receipt DM to you failed on <t:1794900000:f>/);
});

test('a receipt with nothing stored or no link explains why there is nothing to show', async () => {
  const empty = fixture({
    response: { ok: false, linked: true, message: 'No trader sales are stored for your linked ESO account yet.' },
    option: 'receipt'
  });
  await execute(empty.interaction, empty.socket);
  assert.match(empty.replies[0].content, /No trader sales are stored/);

  const unlinked = fixture({ response: { ok: false, linked: false }, option: 'receipt' });
  await execute(unlinked.interaction, unlinked.socket);
  assert.equal(unlinked.replies[0].content, LINK_REQUIRED_MESSAGE);
});

const soldSale = {
  eventId: 501,
  guildName: 'Alphabet Mafia',
  world: 'NA Megaserver',
  seller: '@Seller',
  buyer: 'random8642',
  itemName: 'Soul Gem',
  quantity: 1,
  price: 15,
  unitPrice: 15,
  tax: 0,
  net: 15,
  time: 1794910515
};

test('/trader sales sends the partial item name and returns a receipt image', async () => {
  const f = fixture({
    option: 'sales',
    item: 'soul gem',
    response: { ok: true, linked: true, eso_account_name: '@Seller', sales: [soldSale] }
  });
  await execute(f.interaction, f.socket);

  assert.deepEqual(f.calls[0].payload, { discord_user_id: '42', action: 'sales', item: 'soul gem' });
  assert.match(f.replies[0].content, /1 sale matching “soul gem”/);
  assert.equal(f.replies[0].files.length, 1);
  assert.equal(f.replies[0].files[0].name, 'trader-sales-receipt.png');
});

test('/trader sales admits when only the newest matches were searched', async () => {
  const f = fixture({
    option: 'sales',
    item: 'soul',
    response: { ok: true, linked: true, eso_account_name: '@Seller', sales: [soldSale], truncated: true, limit: 50 }
  });
  await execute(f.interaction, f.socket);

  assert.match(f.replies[0].content, /the newest 1 only, older sales exist/);
  assert.equal(f.replies[0].files.length, 1);
});

test('a search receipt opens with a neutral caption, not a congratulations', () => {
  assert.equal(searchReceiptCaption([soldSale], 'soul gem'), 'Your sale of Soul Gem.');
  assert.equal(
    searchReceiptCaption([soldSale, soldSale], 'blueprint'),
    'Your 2 sales matching “blueprint”.'
  );
  assert.equal(searchReceiptCaption([], 'soul gem'), 'Your 0 sales matching “soul gem”.');

  for (const caption of [searchReceiptCaption([soldSale], 'soul gem'), searchReceiptCaption([soldSale, soldSale], 'x')]) {
    assert.ok(!/congratulations/i.test(caption), 'a search result is not a fresh sale');
  }
});

test('/trader sales reports an item that has no entries', async () => {
  const f = fixture({
    option: 'sales',
    item: 'dreugh wax',
    response: { ok: true, linked: true, eso_account_name: '@Seller', sales: [] }
  });
  await execute(f.interaction, f.socket);

  assert.equal(f.replies[0].content.split('\n').at(-1), 'There are no sales entries for an item named dreugh wax.');
  assert.match(f.replies[0].content, /^As of <t:\d+:f> — the GuildSync backend did not report when its trader data was last updated\./);
  assert.equal(f.replies[0].files, undefined);
});

test('/trader answers a channel ephemerally and a DM normally', async () => {
  const channel = fixture({
    option: 'sales',
    item: 'soul',
    guildId: '761817',
    response: { ok: true, linked: true, sales: [soldSale] }
  });
  await execute(channel.interaction, channel.socket);
  assert.deepEqual(channel.defers[0].flags, [MessageFlags.Ephemeral]);

  const direct = fixture({ option: 'sales', item: 'soul', response: { ok: true, linked: true, sales: [soldSale] } });
  await execute(direct.interaction, direct.socket);
  assert.equal(direct.defers[0].flags, undefined, 'a DM is private already');
});

test('sales answers lead with how fresh the data is', async () => {
  const f = fixture({
    option: 'sales',
    item: 'soul gem',
    response: { ok: true, linked: true, sales: [soldSale], latest_entry_time: 1794900000 }
  });
  await execute(f.interaction, f.socket);

  const [first, second] = f.replies[0].content.split('\n');
  assert.match(first, /^As of <t:\d+:f> — most recent GuildSync info at <t:1794900000:f>\.$/);
  assert.match(second, /1 sale matching “soul gem”/);
});

test('/trader receipt and an empty search both lead with the freshness line', async () => {
  const receipt = fixture({
    option: 'receipt',
    response: { ok: true, linked: true, sales: [soldSale], latest_entry_time: 1794000000 }
  });
  await execute(receipt.interaction, receipt.socket);

  const [freshness, confirmation] = receipt.replies[0].content.split('\n');
  assert.match(freshness, /^As of <t:\d+:f> — most recent GuildSync info at <t:1794000000:f>\.$/);
  assert.equal(confirmation, 'Sent your newest sale receipt to your DMs.');

  const none = fixture({
    option: 'sales',
    item: 'dreugh wax',
    response: { ok: true, linked: true, sales: [], latest_entry_time: 1794000000 }
  });
  await execute(none.interaction, none.socket);
  assert.match(
    none.replies[0].content,
    /^As of <t:\d+:f> — most recent GuildSync info at <t:1794000000:f>\.\nThere are no sales entries for an item named dreugh wax\.$/
  );
});

test('an older backend is named once instead of looking like missing data', async () => {
  const logs = [];

  for (let call = 0; call < 2; call += 1) {
    const f = fixture({ option: 'status' });
    f.socket.emit = (event, payload, callback) => callback(null, { ok: true, enabled: false, protocol: 1 });
    await execute(f.interaction, f.socket, (line) => logs.push(line));
  }

  assert.equal(
    logs.filter((line) => line.includes('speaks trader protocol 1')).length,
    1,
    'the mismatch is logged once per process, not on every command'
  );
});

test('a disconnected GuildSync backend is reported instead of crashing', async () => {
  const f = fixture({ response: null, connected: false });
  await execute(f.interaction, f.socket);
  assert.match(f.replies[0].content, /temporarily unavailable/);
});
