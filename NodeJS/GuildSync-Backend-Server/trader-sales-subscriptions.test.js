import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeTraderSalesSubscriptions,
  setTraderSalesSubscription,
  getTraderSalesSubscription,
  groupTraderSaleNotices,
  planTraderSaleNotices,
  loadTraderSalesForTest,
  searchTraderSales,
  newestTraderEntryTime,
  registerTraderSalesSubscriptionSocket
} from './trader-sales-subscriptions.js';

function database({ linkedNames = ['@Seller'], subscribers = [] } = {}) {
  const calls = [];
  const db = {
    calls,
    async query(sql) {
      calls.push({ sql, args: [] });
      return [{}];
    },
    async execute(sql, args = []) {
      calls.push({ sql, args });
      if (sql.includes('guildsync_eso_account_aliases')) return [[{ account_name: 'Seller' }]];
      if (sql.includes('FROM guildsync_member_links')) {
        return [linkedNames.map((eso_account_name) => ({ eso_account_name }))];
      }
      if (sql.includes('FROM guildsync_trader_sales_subscriptions AS subscriptions')) return [subscribers];
      if (sql.includes('FROM guildsync_trader_sales_subscriptions') && sql.includes('LIMIT 1')) return [[]];
      return [{}];
    }
  };
  return db;
}

const sale = (overrides = {}) => ({
  eventId: 501,
  guildId: '761817',
  guildName: 'Example Guild',
  world: 'EU Megaserver',
  seller: '@Seller',
  buyer: '@Buyer',
  itemName: 'Dreugh Wax',
  quantity: 10,
  price: 100000,
  unitPrice: 10000,
  tax: 7000,
  net: 93000,
  time: 2000,
  ...overrides
});

test('subscription table is created and on/off require a linked ESO account', async () => {
  const db = database();
  await initializeTraderSalesSubscriptions(db);
  assert.ok(db.calls.some((call) => call.sql.includes('CREATE TABLE IF NOT EXISTS guildsync_trader_sales_subscriptions')));

  const unlinked = database({ linkedNames: [] });
  const refused = await setTraderSalesSubscription(unlinked, '42', true, { now: 1234 });
  assert.equal(refused.ok, false);
  assert.equal(refused.linked, false);
  assert.equal(unlinked.calls.some((call) => call.sql.includes('INSERT INTO guildsync_trader_sales_subscriptions')), false);

  const linked = database();
  const enabled = await setTraderSalesSubscription(linked, '42', true, { now: 1234 });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.eso_account_name, '@Seller');
  const insert = linked.calls.find((call) => call.sql.includes('INSERT INTO guildsync_trader_sales_subscriptions'));
  assert.deepEqual(insert.args, ['42', 1234, 1234]);

  const disabled = await setTraderSalesSubscription(linked, '42', false, { now: 2000 });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.enabled, false);
  const off = linked.calls.filter((call) => call.sql.includes('INSERT INTO guildsync_trader_sales_subscriptions')).at(-1);
  assert.deepEqual(off.args, ['42', 2000]);

  const unlinkedOff = await setTraderSalesSubscription(unlinked, '42', false, { now: 2000 });
  assert.equal(unlinkedOff.ok, true);
  assert.equal(unlinkedOff.enabled, false);
  assert.equal(unlinkedOff.linked, false);
});

test('subscription status reads the stored flag', async () => {
  const db = database();
  const status = await getTraderSalesSubscription(db, '42');
  assert.deepEqual(status, { enabled: false, subscribed_at: null });
});

test('a live import with several sales becomes one invoice and keeps the age filter', () => {
  const notices = groupTraderSaleNotices([
    sale({ eventId: 1, time: 900 }),
    sale({ eventId: 2, buyer: '@OtherBuyer', time: 1000 }),
    sale({ eventId: 3, time: 1500 })
  ], () => [{ discord_user_id: '42', subscribed_at: 1000 }]);

  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'invoice');
  assert.equal(notices[0].discord_user_id, '42');
  assert.deepEqual(notices[0].sales.map((item) => item.eventId), [3, 2]);
});

test('a single matching sale keeps the original invoice notice', () => {
  const notices = groupTraderSaleNotices([
    sale({ eventId: 7, time: 1500 })
  ], () => [{ discord_user_id: '42', subscribed_at: 1000 }]);

  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'sale');
  assert.deepEqual(notices[0].sales.map((item) => item.eventId), [7]);
  assert.equal(notices[0].sales[0].net, 93000);
});

test('catch-up sales become one invoice per subscriber and keep the age filter', () => {
  const notices = groupTraderSaleNotices([
    sale({ eventId: 10, time: 1200, catchUp: true }),
    sale({ eventId: 11, time: 1100, catchUp: true }),
    sale({ eventId: 12, time: 800, catchUp: true })
  ], () => [{ discord_user_id: '42', subscribed_at: 1000 }]);

  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'invoice');
  assert.deepEqual(notices[0].sales.map((item) => item.eventId), [11, 10]);
});

test('invoice sales group by buyer and then by sale time', () => {
  const notices = groupTraderSaleNotices([
    sale({ eventId: 1, buyer: '@Zed', time: 300 }),
    sale({ eventId: 2, buyer: '@Amy', time: 200 }),
    sale({ eventId: 3, buyer: '@Amy', time: 100 }),
    sale({ eventId: 4, buyer: '@Zed', time: 50 })
  ], () => [{ discord_user_id: '42', subscribed_at: 0 }]);

  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'invoice');
  assert.deepEqual(notices[0].sales.map((item) => item.buyer), ['@Amy', '@Amy', '@Zed', '@Zed']);
  assert.deepEqual(notices[0].sales.map((item) => item.eventId), [3, 2, 4, 1]);
});

test('notices are grouped per Discord user and sellers resolve through identity aliases', async () => {
  const db = database({
    subscribers: [
      { discord_user_id: '42', subscribed_at: 1000 },
      { discord_user_id: '43', subscribed_at: 1000 }
    ]
  });

  const notices = await planTraderSaleNotices(db, [sale({ eventId: 20, seller: '@OldSeller', catchUp: true })]);
  assert.deepEqual(notices.map((notice) => notice.discord_user_id).sort(), ['42', '43']);
  assert.ok(notices.every((notice) => notice.kind === 'sale' && notice.sales.length === 1));
  assert.ok(db.calls.some((call) => call.sql.includes("link_status = 'linked'")));
});

test('the socket handler is bot-only and toggles subscriptions', async () => {
  const handlers = new Map();
  const socket = {
    guildSyncAuthType: 'discord-bot',
    on(event, handler) { handlers.set(event, handler); }
  };
  const db = database();
  registerTraderSalesSubscriptionSocket(socket, { db });

  const invoke = (payload) => new Promise((resolve) => handlers.get('guildsync:trader-sales-subscription')(payload, resolve));

  const result = await invoke({ action: 'on', discord_user_id: '42' });
  assert.equal(result.ok, true);
  assert.equal(result.eso_account_name, '@Seller');

  const denied = new Map();
  registerTraderSalesSubscriptionSocket({ guildSyncAuthType: 'GuildSync user', on: (event, handler) => denied.set(event, handler) }, { db });
  const deniedResult = await new Promise((resolve) => denied.get('guildsync:trader-sales-subscription')({ action: 'on', discord_user_id: '42' }, resolve));
  assert.equal(deniedResult.ok, false);
});

test('/trader test loads the newest stored sales for the linked account', async () => {
  const db = database();
  const execute = db.execute;
  db.execute = async (sql, args = []) => {
    if (sql.includes('FROM guildsync_trader_entries')) {
      db.calls.push({ sql, args });
      return [[
        { event_id: 9, guild_name: 'Example Guild', world: 'EU Megaserver', seller: '@Seller', buyer: '@Buyer', item_name: 'Soul Gem', quantity: 1, price: 15, unit_price: 15, tax: 0, net: 15, event_timestamp: 900 },
        { event_id: 8, guild_name: 'Example Guild', world: 'EU Megaserver', seller: '@OldSeller', buyer: '@Buyer', item_name: 'Ruby', quantity: 2, price: 20000, unit_price: 10000, tax: 1400, net: 18600, event_timestamp: 800 }
      ]];
    }
    return execute.call(db, sql, args);
  };

  const { sales, names } = await loadTraderSalesForTest(db, '42', { limit: 5 });
  assert.deepEqual(names, ['@Seller']);
  assert.deepEqual(sales.map((sale) => sale.eventId), [9, 8]);
  assert.equal(sales[0].time, 900, 'rows are normalised through saleForNotice');

  const query = db.calls.find((call) => call.sql.includes('FROM guildsync_trader_entries'));
  assert.match(query.sql, /ORDER BY event_timestamp DESC/);
  assert.match(query.sql, /LIMIT 5/);
  assert.ok(query.sql.includes('seller_original'), 'renamed sellers still match');
});

test('/trader sales matches part of an item name for the linked account', async () => {
  const db = database();
  const execute = db.execute;
  db.execute = async (sql, args = []) => {
    if (sql.includes('FROM guildsync_trader_entries')) {
      db.calls.push({ sql, args });
      return [[{ event_id: 5, guild_name: 'Example Guild', world: 'EU Megaserver', seller: '@Seller', buyer: '@Buyer', item_name: 'Soul Gem', quantity: 1, price: 15, unit_price: 15, tax: 0, net: 15, event_timestamp: 700 }]];
    }
    return execute.call(db, sql, args);
  };

  const { sales, truncated, limit } = await searchTraderSales(db, '42', '  Soul  ');
  assert.equal(sales.length, 1);
  assert.equal(sales[0].itemName, 'Soul Gem');
  assert.equal(sales[0].time, 700, 'rows are normalised through saleForNotice');
  assert.equal(truncated, false);
  assert.equal(limit, 50);

  const call = db.calls.find((entry) => entry.sql.includes('FROM guildsync_trader_entries'));
  assert.ok(call.sql.includes('LOWER(item_name) LIKE LOWER(?)'));
  assert.ok(call.sql.includes('seller_original'), 'renamed sellers still match');
  assert.equal(call.args.at(-1), '%Soul%');
});

test('/trader sales finds Soul Gem when the query is SOUL', async () => {
  const db = database();
  const execute = db.execute;
  db.execute = async (sql, args = []) => {
    if (sql.includes('FROM guildsync_trader_entries')) {
      db.calls.push({ sql, args });
      // A case-insensitive collation is not guaranteed, so the match must come
      // from LOWER() on both sides rather than from the column definition.
      assert.match(sql, /LOWER\(item_name\) LIKE LOWER\(\?\)/);
      return [[{ event_id: 9, guild_name: 'Example Guild', world: 'EU Megaserver', seller: '@Seller', buyer: '@Buyer', item_name: 'Soul Gem', quantity: 1, price: 15, unit_price: 15, tax: 0, net: 15, event_timestamp: 700 }]];
    }
    return execute.call(db, sql, args);
  };

  const { sales } = await searchTraderSales(db, '42', 'SOUL');
  assert.equal(sales.length, 1);
  assert.equal(sales[0].itemName, 'Soul Gem');

  const call = db.calls.find((entry) => entry.sql.includes('FROM guildsync_trader_entries'));
  assert.equal(call.args.at(-1), '%SOUL%', 'the raw query is passed and LOWER() does the folding');
});

test('/trader sales escapes LIKE wildcards in the item query', async () => {
  const db = database();
  const execute = db.execute;
  db.execute = async (sql, args = []) => {
    if (sql.includes('FROM guildsync_trader_entries')) {
      db.calls.push({ sql, args });
      return [[]];
    }
    return execute.call(db, sql, args);
  };

  const { sales } = await searchTraderSales(db, '42', '50%_off');
  assert.deepEqual(sales, []);

  const call = db.calls.find((entry) => entry.sql.includes('FROM guildsync_trader_entries'));
  assert.equal(call.args.at(-1), '%50\\%\\_off%');
});

test('/trader sales says when only the newest matches were searched', async () => {
  const db = database();
  const execute = db.execute;
  const row = (id) => ({
    event_id: id, guild_name: 'Example Guild', world: 'EU Megaserver', seller: '@Seller',
    buyer: '@Buyer', item_name: 'Soul Gem', quantity: 1, price: 15, unit_price: 15,
    tax: 0, net: 15, event_timestamp: 700 + id
  });
  db.execute = async (sql, args = []) => {
    if (sql.includes('FROM guildsync_trader_entries')) {
      db.calls.push({ sql, args });
      return [[row(1), row(2)]];
    }
    return execute.call(db, sql, args);
  };

  const capped = await searchTraderSales(db, '42', 'soul', { limit: 1 });
  assert.equal(capped.sales.length, 1);
  assert.equal(capped.truncated, true);
  assert.equal(capped.limit, 1);

  const call = db.calls.find((entry) => entry.sql.includes('FROM guildsync_trader_entries'));
  assert.ok(call.sql.includes('LIMIT 2'), 'one extra row is fetched to detect the cut');
});

test('/trader sales returns the matches without sending a DM', async () => {
  const db = database();
  const execute = db.execute;
  db.execute = async (sql, args = []) => {
    if (sql.includes('FROM guildsync_trader_entries')) {
      return [[{ event_id: 5, guild_name: 'Example Guild', world: 'EU Megaserver', seller: '@Seller', buyer: '@Buyer', item_name: 'Soul Gem', quantity: 1, price: 15, unit_price: 15, tax: 0, net: 15, event_timestamp: 700 }]];
    }
    return execute.call(db, sql, args);
  };

  const handlers = new Map();
  const emitted = [];
  const socket = {
    guildSyncAuthType: 'discord-bot',
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { emitted.push({ event, payload }); }
  };
  registerTraderSalesSubscriptionSocket(socket, { db });

  const result = await new Promise((resolve) => handlers.get('guildsync:trader-sales-subscription')({ action: 'sales', item: 'soul', discord_user_id: '42' }, resolve));

  assert.equal(result.ok, true);
  assert.equal(result.item, 'soul');
  assert.equal(result.sales.length, 1);
  assert.equal(result.sales[0].itemName, 'Soul Gem');
  assert.equal(result.truncated, false);
  assert.equal(result.limit, 50);
  assert.deepEqual(emitted, [], 'a search never sends a DM');
});

test('/trader test returns the sales instead of sending a DM', async () => {
  const db = database();
  const execute = db.execute;
  db.execute = async (sql, args = []) => {
    if (sql.includes('MAX(event_timestamp)')) return [[{ latest: 901 }]];
    if (sql.includes('FROM guildsync_trader_entries')) {
      return [[
        { event_id: 9, guild_name: 'Example Guild', world: 'EU Megaserver', seller: '@Seller', buyer: '@Buyer', item_name: 'Soul Gem', quantity: 1, price: 15, unit_price: 15, tax: 0, net: 15, event_timestamp: 900 }
      ]];
    }
    return execute.call(db, sql, args);
  };

  const handlers = new Map();
  const emitted = [];
  const socket = {
    guildSyncAuthType: 'discord-bot',
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { emitted.push({ event, payload }); }
  };
  registerTraderSalesSubscriptionSocket(socket, { db });

  const result = await new Promise((resolve) => handlers.get('guildsync:trader-sales-subscription')({ action: 'test', discord_user_id: '42' }, resolve));

  assert.equal(result.ok, true);
  assert.equal(result.sales.length, 1, 'the bot renders these itself, where the command was typed');
  assert.equal(result.sales[0].itemName, 'Soul Gem');
  assert.equal(result.latest_entry_time, 901, 'the reply is dated like every other receipt');
  assert.deepEqual(emitted, [], 'a test receipt no longer leaves as a notice');
  assert.equal(db.calls.some((call) => call.sql.includes('INSERT INTO guildsync_trader_sales_subscriptions')), false, 'test never changes the subscription');
});

test('the newest stored entry time comes from the trader entries table', async () => {
  const db = database();
  const execute = db.execute;
  const sqls = [];
  db.execute = async (sql, args = []) => {
    sqls.push(sql);
    if (sql.includes('MAX(event_timestamp)')) return [[{ latest: 4321 }]];
    return execute.call(db, sql, args);
  };

  assert.equal(await newestTraderEntryTime(db), 4321);
  assert.ok(sqls.some((sql) => sql.includes('MAX(event_timestamp)') && sql.includes('FROM guildsync_trader_entries')));

  const empty = database();
  assert.equal(await newestTraderEntryTime(empty), 0, 'an empty table reads as no known time');
});

test('/trader sales and /trader test both report the newest stored entry time', async () => {
  const db = database();
  const execute = db.execute;
  db.execute = async (sql, args = []) => {
    if (sql.includes('MAX(event_timestamp)')) return [[{ latest: 4321 }]];
    if (sql.includes('FROM guildsync_trader_entries')) {
      return [[{ event_id: 9, guild_name: 'Example Guild', world: 'EU Megaserver', seller: '@Seller', buyer: '@Buyer', item_name: 'Soul Gem', quantity: 1, price: 15, unit_price: 15, tax: 0, net: 15, event_timestamp: 700 }]];
    }
    return execute.call(db, sql, args);
  };

  const handlers = new Map();
  const emitted = [];
  const socket = {
    guildSyncAuthType: 'discord-bot',
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { emitted.push({ event, payload }); }
  };
  registerTraderSalesSubscriptionSocket(socket, { db });
  const ask = (payload) => new Promise((resolve) => handlers.get('guildsync:trader-sales-subscription')(payload, resolve));

  const found = await ask({ action: 'sales', item: 'soul', discord_user_id: '42' });
  assert.equal(found.ok, true);
  assert.equal(found.latest_entry_time, 4321);

  const testReply = await ask({ action: 'test', discord_user_id: '42' });
  assert.equal(testReply.sales.length, 1);
  assert.equal(testReply.latest_entry_time, 4321, 'the test receipt is dated too');
  assert.deepEqual(emitted, [], 'the test receipt is rendered where the command was typed');
});

test('a live sale notice carries the newest stored entry time', async () => {
  const db = database({ subscribers: [{ discord_user_id: '42', subscribed_at: 0 }] });
  const execute = db.execute;
  db.execute = async (sql, args = []) => {
    if (sql.includes('MAX(event_timestamp)')) return [[{ latest: 999 }]];
    return execute.call(db, sql, args);
  };

  const notices = await planTraderSaleNotices(db, [sale({ seller: '@Seller' })]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].latest_entry_time, 999);
});

test('subscription rows are not created for an unknown action', async () => {
  const db = database();
  const handler = new Map();
  registerTraderSalesSubscriptionSocket({ guildSyncAuthType: 'discord-bot', on: (event, fn) => handler.set(event, fn) }, { db });
  const result = await new Promise((resolve) => handler.get('guildsync:trader-sales-subscription')({ action: 'later', discord_user_id: '42' }, resolve));
  assert.equal(result.ok, false);
  assert.equal(db.calls.some((call) => call.sql.includes('INSERT INTO guildsync_trader_sales_subscriptions')), false);
});
