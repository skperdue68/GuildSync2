import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { reconcileOffRosterMemberMarks } from './membership-dms.js';

// The audit query reads a fake row per linked Discord member: how many ESO accounts
// are linked and how many of those are currently on the roster.
function fixture({ state = { preferences: {}, events: [] }, linked = [], guildId = '1' } = {}) {
  let json = JSON.stringify(state);
  const queries = [];
  const history = [];
  const connection = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release() {},
    async execute(sql, args = []) {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
      if (sql.includes("setting_key='discord_guild_id'")) return [[{ value: guildId }]];
      if (sql.includes('COUNT(DISTINCT roster.account_name)')) return [linked];
      if (sql.startsWith('INSERT IGNORE INTO guildsync_membership_dm_state')) return [{ affectedRows: 0 }];
      if (sql.startsWith('SELECT state_json')) return [[{ state_json: json }]];
      if (sql.startsWith('UPDATE guildsync_membership_dm_state')) {
        json = args[0];
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('SELECT username,global_name,server_nickname FROM discord_members')) return [[]];
      if (sql.startsWith('INSERT INTO discord_member_history')) {
        history.push(args);
        return [{ affectedRows: 1 }];
      }
      throw Error('Unexpected query: ' + sql);
    }
  };
  const db = { getConnection: async () => connection, execute: (...args) => connection.execute(...args) };
  return {
    db,
    state: () => JSON.parse(json),
    history: () => history,
    queries: () => queries
  };
}

test('a linked ESO account that left the roster marks its Discord member as not playing ESO', async () => {
  const f = fixture({
    linked: [
      { discord_user_id: '10', linked_accounts: 1, roster_accounts: 0 },
      { discord_user_id: '11', linked_accounts: 2, roster_accounts: 1 }
    ]
  });

  assert.deepEqual(await reconcileOffRosterMemberMarks(f.db, { now: () => 1800000000 }), { marked: 1, cleared: 0 });
  assert.equal(f.state().preferences['10'], 'opt_out');
  assert.equal(f.state().offRosterMarks['10'], 1800000000);
  // One current roster link is enough: that member still has a rank to audit.
  assert.equal(f.state().preferences['11'], undefined);
  assert.match(String(f.history()[0][7]), /does not play ESO/);
  // The link has to survive, or the member would come back as "no linked ESO account".
  assert.ok(!f.queries().some((query) => /DELETE FROM guildsync_member_links/.test(query)));
});

test('a mark clears itself when the ESO account is back on the roster', async () => {
  const f = fixture({
    state: { preferences: { '10': 'opt_out', '20': 'not_playing' }, events: [], offRosterMarks: { '10': 1, '20': 2 } },
    linked: [
      { discord_user_id: '10', linked_accounts: 1, roster_accounts: 1 },
      { discord_user_id: '20', linked_accounts: 1, roster_accounts: 1 }
    ]
  });

  assert.deepEqual(await reconcileOffRosterMemberMarks(f.db), { marked: 0, cleared: 2 });
  assert.deepEqual(f.state().preferences, { '20': 'not_playing' });
  assert.deepEqual(f.state().offRosterMarks, {});
  assert.match(String(f.history()[0][7]), /back on the roster/);
});

test('an officer preference already set for an off-roster member is left alone', async () => {
  const f = fixture({
    state: { preferences: { '30': 'not_playing' }, events: [] },
    linked: [{ discord_user_id: '30', linked_accounts: 1, roster_accounts: 0 }]
  });

  assert.deepEqual(await reconcileOffRosterMemberMarks(f.db), { marked: 0, cleared: 0 });
  assert.deepEqual(f.state().preferences, { '30': 'not_playing' });
  assert.ok(!f.queries().some((query) => query.startsWith('UPDATE guildsync_membership_dm_state')));
});

test('an officer clearing the tick for a departed member keeps it cleared', async () => {
  const f = fixture({
    state: { preferences: {}, events: [], offRosterCleared: { '40': 1 } },
    linked: [{ discord_user_id: '40', linked_accounts: 1, roster_accounts: 0 }]
  });

  assert.deepEqual(await reconcileOffRosterMemberMarks(f.db), { marked: 0, cleared: 0 });
  assert.equal(f.state().preferences['40'], undefined);
  assert.ok(!f.queries().some((query) => query.startsWith('UPDATE guildsync_membership_dm_state')));
});

test('a cleared tick is forgotten once the account is back on the roster', async () => {
  const f = fixture({
    state: { preferences: {}, events: [], offRosterCleared: { '40': 1 } },
    linked: [{ discord_user_id: '40', linked_accounts: 1, roster_accounts: 1 }]
  });

  assert.deepEqual(await reconcileOffRosterMemberMarks(f.db), { marked: 0, cleared: 0 });
  assert.deepEqual(f.state().offRosterCleared, {});
  assert.ok(f.queries().some((query) => query.startsWith('UPDATE guildsync_membership_dm_state')));
});

test('a roster import marks departures without waiting for the report', async () => {
  const source = fs.readFileSync(new URL('./guildsync-database-actions.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('async function processRosterDataUnlocked(');
  const end = source.indexOf('\nasync function ', start + 10);
  const body = source.slice(start, end > start ? end : start + 20000);
  const autoLink = body.indexOf('await runMemberAutoLinking(applicationDB);');
  const reconcile = body.indexOf('await reconcileOffRosterMemberMarks(applicationDB);');
  assert.ok(autoLink >= 0, 'the import still runs auto-linking');
  assert.ok(reconcile > autoLink, 'the mark is settled as soon as the roster is saved');
});

test('without a configured Discord server nothing is read or written', async () => {
  const f = fixture({ guildId: '' });

  assert.deepEqual(await reconcileOffRosterMemberMarks(f.db), { marked: 0, cleared: 0 });
  // The lock is taken and released; the settings lookup is the only read.
  assert.equal(f.queries().length, 3);
});

test('rank audit leaves out a member whose only linked ESO account left the roster', async () => {
  const source = fs.readFileSync(new URL('./guildsync-database-actions.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('export async function getDiscordRankAuditReport(');
  assert.ok(start >= 0);
  const ctx = vm.createContext({});
  const fn = source.slice(start, source.indexOf('\n}\n', start) + 2).replace('export async function', 'function');
  vm.runInContext('async ' + fn, ctx);
  let query = '';
  await ctx.getDiscordRankAuditReport({ execute: async (sql) => { query = sql; return [[]]; } });

  assert.match(query, /WHEN COALESCE\(linked_roster.active_roster_count, 0\) = 0 THEN NULL/);
  assert.doesNotMatch(query, /linked_eso_not_on_roster/);
  assert.match(query, /WHERE issue_type IS NOT NULL/);
});
