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
  const source = fs.readFileSync(new URL('./guildsync-database-actions.js', import.meta.url), 'utf8');
  const start = source.indexOf('export async function insertTraderEntries(');
  const end = source.indexOf('function findEsoSavedVarsProfile(', start);
  const functionSource = source.slice(start, end).replaceAll('export ', '');

  const saved = new Set();
  const calls = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql, params) {
      if (sql.includes('INSERT IGNORE INTO guildsync_trader_entries')) {
        calls.push(params);
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
    console
  });
  vm.runInContext(functionSource, context);

  const db = { getConnection: async () => connection };
  const payload = {
    uploadedBy: 'Tester',
    source: 'GuildSyncTrader',
    world: 'EU Megaserver',
    guildId: '761817',
    guildName: 'Example Guild',
    entries: [
      { eventId: 123, guildId: '761817', guildName: 'Example Guild', seller: '@Seller', buyer: '@Buyer', itemLink: 'link', itemId: 12345, itemName: 'Dreugh Wax', quantity: 10, price: 100000, tax: 7000, time: 1780000000 },
      { eventId: 124, guildId: '761817', guildName: 'Example Guild', seller: '@Seller', buyer: '@Buyer', quantity: 1, price: 500, tax: 35, time: 1780000001 }
    ]
  };

  const first = await context.insertTraderEntries(db, payload);
  const retry = await context.insertTraderEntries(db, payload);

  assert.equal(first.trader_entries_received, 2);
  assert.equal(first.trader_entries_inserted, 2);
  assert.equal(retry.trader_entries_inserted, 0);
  assert.equal(retry.trader_entries_ignored, 2);
  assert.equal(calls[0][3], 'EU Megaserver');
  assert.equal(calls[0][11], 10000, 'derived unit price');
  assert.equal(calls[0][13], 93000, 'derived net after tax');
  assert.equal(calls[1][13], 465, 'derived net for a small sale');
  assert.equal(calls[0][16], 'GuildSyncTrader (Tester)');
});
