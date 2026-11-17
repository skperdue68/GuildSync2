import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeTraderSalesSubscriptions,
  setTraderSalesSubscription,
  getTraderSalesSubscription,
  groupTraderSaleNotices,
  planTraderSaleNotices,
  saleForNotice,
  loadTraderSalesForReceipt,
  recentTraderSales,
  searchTraderSales,
  newestTraderEntryTime,
  announceTraderSaleNotices,
  markTraderSaleNoticesDelivered,
  loadPendingTraderSaleNotices,
  TRADER_SOCKET_PROTOCOL,
  registerTraderSalesSubscriptionSocket
} from './trader-sales-subscriptions.js';

function database({ linkedNames = ['@Seller'], subscribers = [], pending = [], subscription = null } = {}) {
  const calls = [];
  const inserted = new Set();
  let nextId = 1;

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
      if (sql.includes('INSERT IGNORE INTO guildsync_trader_sale_notices')) {
        const key = `${args[0]}:${args[1]}:${args[2]}`;
        if (inserted.has(key)) return [{ affectedRows: 0, insertId: 0 }];
        inserted.add(key);
        return [{ affectedRows: 1, insertId: nextId++ }];
      }
      if (sql.includes('SELECT id, discord_user_id, sale_json')) return [pending];
      if (sql.includes('FROM guildsync_trader_sales_subscriptions') && sql.includes('LIMIT 1')) {
        return [subscription ? [subscription] : []];
      }
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
  assert.ok(db.calls.some((call) => call.sql.includes('ADD COLUMN IF NOT EXISTS last_dm_failed_at')));
  assert.ok(db.calls.some((call) => call.sql.includes('CREATE TABLE IF NOT EXISTS guildsync_trader_sale_notices')));
  assert.ok(
    db.calls.some((call) => call.sql.includes('UNIQUE KEY uniq_trader_sale_notice')),
    'the unique key is what stops a sale being announced twice'
  );
  assert.ok(db.calls.some((call) => call.sql.includes('delivered_at < NOW() - INTERVAL 90 DAY')), 'old notices are pruned');

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
  assert.deepEqual(status, { enabled: false, subscribed_at: null, dm_failed_at: null });
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

test('/trader receipt loads the newest stored sale for the linked account', async () => {
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

  const { sales, names } = await loadTraderSalesForReceipt(db, '42', { limit: 5 });
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

test('/trader sales without an item lists the newest sales of anything', async () => {
  const db = database();
  const execute = db.execute;
  db.execute = async (sql, args = []) => {
    if (sql.includes('MAX(event_timestamp)')) return [[{ latest: 901 }]];
    if (sql.includes('FROM guildsync_trader_entries')) {
      db.calls.push({ sql, args });
      return [[
        { event_id: 9, guild_id: '761817', item_name: 'Soul Gem', seller: '@Seller', buyer: '@Buyer', quantity: 1, price: 15, unit_price: 15, tax: 0, net: 15, event_timestamp: 900 },
        { event_id: 8, guild_id: '761817', item_name: 'Ruby', seller: '@Seller', buyer: '@Buyer', quantity: 2, price: 20000, unit_price: 10000, tax: 1400, net: 18600, event_timestamp: 800 }
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
  const ask = (payload) => new Promise((resolve) => handlers.get('guildsync:trader-sales-subscription')(payload, resolve));

  const result = await ask({ action: 'sales', discord_user_id: '42' });

  assert.equal(result.ok, true);
  assert.equal(result.item, undefined, 'no item filter is applied');
  assert.deepEqual(result.sales.map((sale) => sale.eventId), [9, 8]);
  assert.equal(result.sales[0].itemName, 'Soul Gem');
  assert.equal(result.sales[0].guildId, '761817');
  assert.equal(result.limit, 10, 'ten sales by default');
  assert.equal(result.truncated, false);
  assert.equal(result.latest_entry_time, 901);
  assert.deepEqual(emitted, [], 'a list never sends a DM');

  const query = db.calls.find((call) => call.sql.includes('FROM guildsync_trader_entries'));
  assert.equal(query.sql.includes('LIKE'), false, 'nothing is filtered by an item name');
  assert.match(query.sql, /ORDER BY event_timestamp DESC/);
  assert.match(query.sql, /LIMIT 11/, 'one extra row detects the cut');
  assert.ok(query.sql.includes('guild_id'), 'the guild travels with every sale');
});

test('/trader sales clamps the requested count and defaults to ten', async () => {
  const db = database();
  const execute = db.execute;
  const rows = Array.from({ length: 12 }, (_, index) => ({
    event_id: 100 - index,
    guild_id: '761817',
    item_name: `Item ${index}`,
    seller: '@Seller',
    buyer: '@Buyer',
    quantity: 1,
    price: 10,
    unit_price: 10,
    tax: 0,
    net: 10,
    event_timestamp: 900 - index
  }));
  db.execute = async (sql, args = []) => {
    if (sql.includes('MAX(event_timestamp)')) return [[{ latest: 900 }]];
    if (sql.includes('FROM guildsync_trader_entries')) {
      db.calls.push({ sql, args });
      return [rows];
    }
    return execute.call(db, sql, args);
  };

  const handlers = new Map();
  const socket = { guildSyncAuthType: 'discord-bot', on: (event, handler) => handlers.set(event, handler) };
  registerTraderSalesSubscriptionSocket(socket, { db });
  const ask = (payload) => new Promise((resolve) => handlers.get('guildsync:trader-sales-subscription')(payload, resolve));

  const five = await ask({ action: 'sales', discord_user_id: '42', limit: 5 });
  assert.equal(five.limit, 5);
  assert.equal(five.sales.length, 5, 'only the requested number is returned');
  assert.equal(five.truncated, true);

  const huge = await ask({ action: 'sales', discord_user_id: '42', limit: 500 });
  assert.equal(huge.limit, 50, 'the ceiling is 50');

  const zero = await ask({ action: 'sales', discord_user_id: '42', limit: 0 });
  assert.equal(zero.limit, 10, 'a missing or zero count falls back to ten');

  const itemLimited = await ask({ action: 'sales', item: 'item', discord_user_id: '42', limit: 3 });
  assert.equal(itemLimited.limit, 3, 'an item search honours the count too');
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

test('/trader receipt DMs the newest sale and returns it for the reply', async () => {
  const db = database();
  const execute = db.execute;
  db.execute = async (sql, args = []) => {
    if (sql.includes('MAX(event_timestamp)')) return [[{ latest: 901 }]];
    if (sql.includes('FROM guildsync_trader_entries')) {
      db.calls.push({ sql, args });
      return [[
        { event_id: 9, guild_id: '761817', guild_name: 'Example Guild', world: 'EU Megaserver', seller: '@Seller', buyer: '@Buyer', item_name: 'Soul Gem', quantity: 1, price: 15, unit_price: 15, tax: 0, net: 15, event_timestamp: 900 },
        { event_id: 8, guild_id: '761817', guild_name: 'Example Guild', world: 'EU Megaserver', seller: '@Seller', buyer: '@Buyer', item_name: 'Ruby', quantity: 2, price: 20000, unit_price: 10000, tax: 1400, net: 18600, event_timestamp: 800 }
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

  const result = await new Promise((resolve) => handlers.get('guildsync:trader-sales-subscription')({ action: 'receipt', discord_user_id: '42' }, resolve));

  assert.equal(result.ok, true);
  assert.equal(result.sales.length, 1, 'only the most recent sale is replayed');
  assert.equal(result.sales[0].itemName, 'Soul Gem');
  assert.equal(result.sales[0].guildId, '761817', 'the guild travels with the sale for the notice key');
  assert.equal(result.latest_entry_time, 901, 'the reply is dated like every other receipt');

  const query = db.calls.find((call) => call.sql.includes('FROM guildsync_trader_entries'));
  assert.match(query.sql, /LIMIT 1/, 'the receipt only asks for the newest sale');
  assert.match(query.sql, /SELECT event_id, guild_id,/, 'the query has to select the guild id it keys on');

  assert.equal(emitted.length, 1, 'the receipt itself leaves as a DM');
  assert.equal(emitted[0].event, 'guildsync:trader-sale-notice');
  assert.equal(emitted[0].payload.kind, 'sale', 'it is presented as a sale that just happened');
  assert.deepEqual(emitted[0].payload.sales.map((sale) => sale.eventId), [9]);
  assert.equal(emitted[0].payload.latest_entry_time, 901);

  assert.equal(db.calls.some((call) => call.sql.includes('INSERT INTO guildsync_trader_sales_subscriptions')), false, 'receipt never changes the subscription');
  assert.equal(
    db.calls.some((call) => call.sql.includes('INSERT IGNORE INTO guildsync_trader_sale_notices')),
    false,
    'a replay is not an announcement, so it is not recorded as one'
  );
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

test('/trader sales and /trader receipt both report the newest stored entry time', async () => {
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

  const receiptReply = await ask({ action: 'receipt', discord_user_id: '42' });
  assert.equal(receiptReply.sales.length, 1);
  assert.equal(receiptReply.latest_entry_time, 4321, 'the receipt DM is dated too');
  assert.equal(emitted.length, 1, 'the receipt leaves as a notice so it arrives by DM');
  assert.equal(emitted[0].payload.latest_entry_time, 4321);
});

test('every reply is stamped with the protocol, and status reports a failed DM', async () => {
  const db = database({ subscription: { enabled: 1, subscribed_at: 1234, dm_failed_at: 555 } });
  const handlers = new Map();
  const socket = { guildSyncAuthType: 'discord-bot', on: (event, handler) => handlers.set(event, handler) };
  registerTraderSalesSubscriptionSocket(socket, { db });
  const ask = (payload) => new Promise((resolve) => handlers.get('guildsync:trader-sales-subscription')(payload, resolve));

  const result = await ask({ action: 'status', discord_user_id: '42' });
  assert.equal(result.ok, true);
  assert.equal(result.protocol, TRADER_SOCKET_PROTOCOL, 'the bot can compare protocols instead of guessing');
  assert.equal(result.enabled, true);
  assert.equal(result.subscribed_at, 1234);
  assert.equal(result.dm_failed_at, 555);

  const unknown = await ask({ action: 'later', discord_user_id: '42' });
  assert.equal(unknown.protocol, TRADER_SOCKET_PROTOCOL, 'refusals carry it too');
});

test('a stored sale keeps its guild id so the notice key is complete', () => {
  assert.equal(
    saleForNotice({ event_id: 501, guild_id: '761817', guild_name: 'Example Guild' }).guildId,
    '761817',
    'a row without the guild would collapse every guild into one key'
  );
  assert.equal(saleForNotice({ eventId: 501, guildId: '900001' }).guildId, '900001');
  assert.equal(saleForNotice({ event_id: 501 }).guildId, '', 'a missing guild stays empty rather than undefined');
});

test('the same event id from two guilds is not collapsed for one member', async () => {
  const db = database();
  const notice = {
    discord_user_id: '42',
    kind: 'invoice',
    latest_entry_time: 2100,
    // Trader entries are keyed by (guild_id, event_id), so the same event id in
    // another guild is a different sale and must arrive as its own row.
    sales: [
      saleForNotice({ event_id: 501, guild_id: '761817', guild_name: 'Example Guild', item_name: 'Soul Gem', event_timestamp: 2000 }),
      saleForNotice({ event_id: 501, guild_id: '900001', guild_name: 'Other Guild', item_name: 'Soul Gem', event_timestamp: 2100 })
    ]
  };

  const announced = await announceTraderSaleNotices(db, [notice]);
  assert.equal(announced.length, 1);
  assert.equal(announced[0].sales.length, 2, 'both guilds keep their sale');
  assert.deepEqual(announced[0].sales.map((item) => item.guildId), ['761817', '900001']);

  const inserts = db.calls.filter((call) => call.sql.includes('INSERT IGNORE INTO guildsync_trader_sale_notices'));
  assert.deepEqual(inserts.map((call) => call.args[1]), ['761817', '900001'], 'the guild reaches the key column');
  assert.deepEqual(inserts.map((call) => call.args[2]), [501, 501], 'the event id is the same in both rows');

  const replay = await announceTraderSaleNotices(db, [notice]);
  assert.deepEqual(replay, [], 'replaying the same pair is still deduplicated per guild');
});

test('a snake_cased notice still keys on its guild instead of collapsing event ids', async () => {
  const db = database();

  const announced = await announceTraderSaleNotices(db, [{
    discord_user_id: '42',
    kind: 'invoice',
    latest_entry_time: 2100,
    sales: [
      { event_id: 501, guild_id: '761817', guild_name: 'Example Guild', item_name: 'Soul Gem', time: 2000 },
      { event_id: 501, guild_id: '900001', guild_name: 'Other Guild', item_name: 'Soul Gem', time: 2100 }
    ]
  }]);

  assert.equal(announced.length, 1);
  assert.equal(announced[0].sales.length, 2, 'both guilds keep their sale');

  const inserts = db.calls.filter((call) => call.sql.includes('INSERT IGNORE INTO guildsync_trader_sale_notices'));
  assert.deepEqual(
    inserts.map((call) => [call.args[1], call.args[2]]),
    [['761817', 501], ['900001', 501]],
    'guild_id and event_id reach the key columns'
  );
});

test('a sale is announced once per recipient and stays pending until it is delivered', async () => {
  const db = database();
  const notice = { discord_user_id: '42', kind: 'sale', sales: [sale()], latest_entry_time: 900 };

  const first = await announceTraderSaleNotices(db, [notice]);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].notice_ids, [1]);
  assert.equal(first[0].kind, 'sale');
  assert.equal(first[0].latest_entry_time, 900);

  const again = await announceTraderSaleNotices(db, [notice]);
  assert.deepEqual(again, [], 'the same sale is never announced twice');

  const other = await announceTraderSaleNotices(db, [{ ...notice, discord_user_id: '43' }]);
  assert.deepEqual(other[0].notice_ids, [2], 'another member still gets theirs');

  const otherGuild = await announceTraderSaleNotices(db, [{ ...notice, sales: [sale({ guildId: '999' })] }]);
  assert.equal(otherGuild.length, 1, 'the same event id in another guild is a different sale');

  assert.equal(await markTraderSaleNoticesDelivered(db, first[0].notice_ids), 1);
  const update = db.calls.find((call) => call.sql.includes('SET delivered_at = NOW()'));
  assert.deepEqual(update.args, [1]);

  const pendingDb = database({
    pending: [
      { id: 7, discord_user_id: '42', sale_json: JSON.stringify(sale({ eventId: 501 })), latest_entry_time: 900 },
      { id: 8, discord_user_id: '42', sale_json: JSON.stringify(sale({ eventId: 502 })), latest_entry_time: 900 }
    ]
  });
  const pending = await loadPendingTraderSaleNotices(pendingDb);
  assert.equal(pending.length, 1, 'undelivered sales for one member come back as one notice');
  assert.equal(pending[0].kind, 'invoice');
  assert.deepEqual(pending[0].notice_ids, [7, 8]);
  assert.equal(pending[0].sales.length, 2);
});

test('the bot can ask for pending receipts and say they were delivered', async () => {
  const db = database({
    pending: [{ id: 7, discord_user_id: '42', sale_json: JSON.stringify(sale()), latest_entry_time: 900 }]
  });
  const handlers = new Map();
  const socket = { guildSyncAuthType: 'discord-bot', on: (event, handler) => handlers.set(event, handler) };
  registerTraderSalesSubscriptionSocket(socket, { db });
  const ask = (payload) => new Promise((resolve) => handlers.get('guildsync:trader-sales-subscription')(payload, resolve));

  const pending = await ask({ action: 'pending' });
  assert.equal(pending.ok, true);
  assert.equal(pending.protocol, TRADER_SOCKET_PROTOCOL);
  assert.equal(pending.notices.length, 1);
  assert.deepEqual(pending.notices[0].notice_ids, [7]);

  const delivered = await ask({ action: 'delivered', ids: [7] });
  assert.equal(delivered.ok, true);
  assert.equal(delivered.delivered, 1);
});

test('the bot can record and clear a failed receipt DM', async () => {
  const db = database();
  const handlers = new Map();
  const socket = { guildSyncAuthType: 'discord-bot', on: (event, handler) => handlers.set(event, handler) };
  registerTraderSalesSubscriptionSocket(socket, { db });
  const ask = (payload) => new Promise((resolve) => handlers.get('guildsync:trader-sales-subscription')(payload, resolve));

  const failed = await ask({ action: 'dm-failed', discord_user_id: '42', failed: true });
  assert.equal(failed.ok, true);
  assert.equal(failed.stored, true);
  assert.deepEqual(
    db.calls.find((call) => call.sql.includes('SET last_dm_failed_at = NOW()')).args,
    ['42']
  );

  await ask({ action: 'dm-failed', discord_user_id: '42', failed: false });
  assert.ok(db.calls.some((call) => call.sql.includes('SET last_dm_failed_at = NULL')));
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
