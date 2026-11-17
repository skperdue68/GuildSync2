import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { bankingSource } from './banking-source.js';
process.env.MARIADB_USER ||= 'test';
process.env.MARIADB_PASSWORD ||= 'test';
const { parseGuildSyncTraderSavedVarsLua } = await import('./guildsync-database-actions.js');

const tradeBody = `["trades"] = { ["guild_761817_event_123"] = {
  ["eventId"] = 123, ["guildId"] = "761817", ["guildName"] = "Example Guild", ["time"] = 1780000000,
  ["seller"] = "@Seller", ["buyer"] = "@Buyer",
  ["itemLink"] = "|H1:item:12345:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0|h|h",
  ["itemId"] = 12345, ["itemName"] = "Dreugh Wax", ["quantity"] = 10,
  ["price"] = 100000, ["unitPrice"] = 10000, ["tax"] = 7000, ["net"] = 93000
} }`;

function loadTraderInsertContext({ aliases = {} } = {}) {
  const source = fs.readFileSync(new URL('./guildsync-database-actions.js', import.meta.url), 'utf8');
  const start = source.indexOf('export async function insertTraderEntries(');
  const end = source.indexOf('function findEsoSavedVarsProfile(', start);
  const functionSource = source.slice(start, end).replaceAll('export ', '');

  const saved = new Set();
  const calls = [];
  const resolved = [];
  const resolveLockDepth = [];
  const insertLockDepth = [];
  const lockState = { depth: 0, max: 0 };

  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql, params) {
      if (sql.includes('INSERT IGNORE INTO guildsync_trader_entries')) {
        calls.push(params);
        insertLockDepth.push(lockState.depth);
        const key = `${params[0]}|${params[1]}`;
        if (saved.has(key)) return [{ affectedRows: 0 }];
        saved.add(key);
        return [{ affectedRows: 1 }];
      }
      return [{}];
    }
  };

  const context = vm.createContext({
    validateEsoGuildImport() {},
    safeRollback: async (target) => target.rollback(),
    bankingSource,
    console,
    resolveEsoAccountName: async (_db, name) => {
      resolved.push(name);
      resolveLockDepth.push(lockState.depth);
      return aliases[name] || name;
    },
    withEsoIdentityLock: async (db, fn) => {
      lockState.depth += 1;
      lockState.max = Math.max(lockState.max, lockState.depth);
      try {
        return await fn(db);
      } finally {
        lockState.depth -= 1;
      }
    }
  });
  vm.runInContext(functionSource, context);

  return { context, connection, calls, resolved, resolveLockDepth, insertLockDepth, lockState };
}

test('trader SavedVars parser reads the world profile and legacy Default', () => {
  const worldText = `GuildSyncTrader = { ["EU Megaserver"] = { ["@Example"] = { ["$AccountWide"] = {
    ["guildId"] = "761817", ["guildName"] = "Example Guild", ${tradeBody}
  } } } }`;
  const world = parseGuildSyncTraderSavedVarsLua(worldText);
  assert.equal(world.world, 'EU Megaserver');
  assert.equal(world.guildId, '761817');
  assert.equal(world.entries_count, 1);
  assert.equal(world.entries[0].itemId, 12345);
  assert.equal(world.entries[0].seller, '@Seller');
  assert.equal(world.entries[0].net, 93000);

  const legacy = parseGuildSyncTraderSavedVarsLua(worldText.replace('EU Megaserver', 'Default'));
  assert.equal(legacy.world, null);
  assert.equal(legacy.entries_count, 1);
});

test('trader insert dedupes by guild and event and derives unit price and net', async () => {
  const { context, connection, calls, resolved, insertLockDepth, lockState } = loadTraderInsertContext();
  const db = { getConnection: async () => connection };
  const payload = {
    uploadedBy: 'Tester',
    source: 'GuildSyncTrader',
    world: 'EU Megaserver',
    guildId: '761817',
    guildName: 'Example Guild',
    entries: [
      { eventId: 123, guildId: '761817', guildName: 'Example Guild', seller: '@Seller', buyer: '@Buyer', itemLink: 'link', itemId: 12345, itemName: 'Dreugh Wax', quantity: 10, price: 100000, tax: 7000, time: 1780000000 },
      { eventId: 124, guildId: '761817', guildName: 'Example Guild', seller: '@Seller', buyer: '@Buyer', quantity: 1, price: 500, tax: 35, time: 1780000001, catchUp: true }
    ]
  };

  const first = await context.insertTraderEntries(db, payload);
  const retry = await context.insertTraderEntries(db, payload);

  assert.equal(first.trader_entries_received, 2);
  assert.equal(first.trader_entries_inserted, 2);
  assert.equal(retry.trader_entries_inserted, 0);
  assert.equal(retry.trader_entries_ignored, 2);
  assert.equal(first.insertedEntries.length, 2);
  assert.equal(first.insertedEntries[0].catchUp, false);
  assert.equal(first.insertedEntries[1].catchUp, true);
  assert.equal(first.insertedEntries[0].net, 93000);
  assert.equal(retry.insertedEntries.length, 0);
  assert.equal(calls[0][3], 'EU Megaserver');
  assert.equal(calls[0][4], '@Seller', 'stored resolved seller');
  assert.equal(calls[0][5], '@Seller', 'stored seller original');
  assert.equal(calls[0][6], '@Buyer', 'stored resolved buyer');
  assert.equal(calls[0][7], '@Buyer', 'stored buyer original');
  assert.equal(calls[0][13], 10000, 'derived unit price');
  assert.equal(calls[0][15], 93000, 'derived net after tax');
  assert.equal(calls[1][15], 465, 'derived net for a small sale');
  assert.equal(calls[0][18], 'GuildSyncTrader (Tester)');
  assert.deepEqual(resolved.slice(0, 2), ['@Seller', '@Buyer'], 'resolves each distinct name once per import');
  assert.equal(resolved.length, 4, 'retry resolves again for a new import');
  assert.equal(lockState.max, 1, 'import holds the identity lock once');
  assert.deepEqual(insertLockDepth, [1, 1, 1, 1], 'every insert runs while the identity lock is held');
});

test('backfilled trader history resolves a renamed seller and buyer to current names', async () => {
  const aliases = { '@OldSeller': '@NewSeller', '@OldBuyer': '@NewBuyer' };
  const { context, connection, calls, resolveLockDepth, insertLockDepth, lockState } = loadTraderInsertContext({ aliases });
  const db = { getConnection: async () => connection };

  const result = await context.insertTraderEntries(db, {
    uploadedBy: 'Tester',
    source: 'GuildSyncTrader',
    world: 'EU Megaserver',
    guildId: '761817',
    guildName: 'Example Guild',
    entries: [{
      eventId: 9001,
      guildId: '761817',
      guildName: 'Example Guild',
      seller: '@OldSeller',
      buyer: '@OldBuyer',
      itemName: 'Dreugh Wax',
      quantity: 2,
      price: 20000,
      tax: 1400,
      time: 1780000000,
      catchUp: true
    }]
  });

  assert.equal(result.trader_entries_inserted, 1);
  assert.equal(calls[0][4], '@NewSeller', 'new seller name is stored for display');
  assert.equal(calls[0][5], '@OldSeller', 'renamed seller is kept as the original');
  assert.equal(calls[0][6], '@NewBuyer', 'new buyer name is stored for display');
  assert.equal(calls[0][7], '@OldBuyer', 'renamed buyer is kept as the original');
  assert.equal(result.insertedEntries[0].seller, '@NewSeller', 'notifications use the current seller name');
  assert.equal(result.insertedEntries[0].buyer, '@NewBuyer', 'notifications use the current buyer name');
  assert.equal(result.insertedEntries[0].catchUp, true, 'backfilled sale stays a catch-up row');
  assert.deepEqual(resolveLockDepth, [1, 1], 'name resolution happens under the identity lock');
  assert.deepEqual(insertLockDepth, [1], 'insert happens under the identity lock');
  assert.equal(lockState.max, 1);
});
