import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('./guildsync-database-actions.js', import.meta.url), 'utf8');

function fn(name) {
  const start = source.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `${name} is missing from guildsync-database-actions.js`);
  const tail = source.slice(start);
  const end = tail.slice(1).search(/^(?:export )?(?:async )?function /m);
  return (end < 0 ? tail : tail.slice(0, end + 1)).replace(/^export /, '');
}

function loadContext({links = [], onMatcherRun = () => {}} = {}) {
  const state = {links: links.map((link) => ({...link})), history: [], statements: []};
  const matchesPair = (link, params) => {
    const name = String(params[0] ?? '').toLowerCase();
    const discordId = String(params[1] ?? '');
    return String(link.eso_account_name).toLowerCase() === name && String(link.discord_user_id) === discordId;
  };
  const db = {
    execute: async (sql, params = []) => {
      const statement = sql.trim();
      state.statements.push({sql: statement, params});
      if (/^INSERT INTO guildsync_member_link_history/i.test(statement)) {
        state.history.push(params);
        return [{affectedRows: 1}];
      }
      if (/^INSERT INTO guildsync_member_links/i.test(statement)) {
        state.links = state.links.filter((link) => !matchesPair(link, params));
        state.links.push({
          eso_account_name: params[0],
          discord_user_id: params[1],
          discord_username: params[2],
          discord_display_name: params[3],
          discord_server_nickname: params[4],
          link_status: params[5],
          link_method: params[6],
          match_confidence: params[7],
          match_reason: params[8],
          match_field: params[9],
          auto_link_blocked: params[10]
        });
        return [{affectedRows: 1}];
      }
      if (/^UPDATE guildsync_member_links/i.test(statement)) {
        for (const link of state.links) {
          if (!matchesPair(link, params)) continue;
          link.link_status = 'blocked';
          link.link_method = 'manual_unlink';
          link.match_confidence = 0;
          link.auto_link_blocked = 1;
        }
        return [{affectedRows: 1}];
      }
      if (/^DELETE FROM guildsync_member_links/i.test(statement)) {
        const before = state.links.length;
        state.links = state.links.filter((link) => !matchesPair(link, params));
        return [{affectedRows: before - state.links.length}];
      }
      if (/FROM guildsync_member_links/i.test(statement)) {
        // Real MySQL returns row snapshots, so hand back copies: a later UPDATE must
        // not rewrite the "previous" row the history recorder already captured.
        return [state.links.filter((link) => matchesPair(link, params)).map((link) => ({...link}))];
      }
      return [[]];
    }
  };
  const ctx = vm.createContext({
    resolveEsoAccountName: async (_db, name) => name,
    // Real helper lives in membership-dms.js; only its linked/not-linked meaning matters here.
    isConfirmedMemberLink: (status) => String(status).toLowerCase() === 'linked',
    notifyDiscordConfirmedLink: async () => {},
    clearMembershipContactForConfirmedLink: async () => {},
    runMemberAutoLinking: async () => onMatcherRun(state)
  });
  const pageLimit = source.match(/const MEMBER_LINK_HISTORY_PAGE_LIMIT = (\d+);/)?.[1];
  assert.ok(pageLimit, 'MEMBER_LINK_HISTORY_PAGE_LIMIT is missing from guildsync-database-actions.js');
  vm.runInContext(
    [`const MEMBER_LINK_HISTORY_PAGE_LIMIT = ${pageLimit};`, ...['describeMemberLinkChange', 'recordMemberLinkChange', 'upsertMemberLinkUnlocked'].map(fn)].join('\n'),
    ctx
  );
  return {ctx, db, state};
}

test('the member link history table is created with the fields the report needs', () => {
  assert.match(source, /CREATE TABLE IF NOT EXISTS guildsync_member_link_history/);
  for (const column of [
    'eso_account_name',
    'discord_user_id',
    'action',
    'previous_status',
    'link_status',
    'link_method',
    'match_confidence',
    'actor_name',
    'recorded_at'
  ]) {
    assert.match(source, new RegExp(`\\b${column}\\b`), `history table is missing ${column}`);
  }
  assert.match(source, /INDEX idx_guildsync_member_link_history_pair \(eso_account_name, discord_user_id\)/);
});

test('describeMemberLinkChange names each transition and ignores confidence-only churn', () => {
  const {ctx} = loadContext();
  const cases = [
    [null, {status: 'linked', method: 'exact'}, 'auto_linked'],
    [null, {status: 'linked', method: 'manual'}, 'linked'],
    [null, {status: 'candidate', method: 'fuzzy'}, 'candidate_found'],
    [null, {status: 'blocked', method: 'manual_unlink'}, 'blocked'],
    [{link_status: 'candidate', link_method: 'fuzzy'}, {status: 'linked', method: 'manual'}, 'candidate_accepted'],
    [{link_status: 'linked', link_method: 'manual'}, {status: 'candidate', method: 'fuzzy'}, 'unlinked_to_candidate'],
    [{link_status: 'linked', link_method: 'exact'}, {status: 'blocked', method: 'manual_unlink'}, 'unlinked_to_block'],
    [{link_status: 'blocked', link_method: 'manual_unlink'}, {status: 'linked', method: 'manual'}, 'block_removed'],
    [{link_status: 'candidate', link_method: 'fuzzy'}, {status: 'candidate', method: 'fuzzy'}, null],
    [{link_status: 'linked', link_method: 'manual'}, {status: 'linked', method: 'manual'}, null]
  ];
  for (const [previous, next, expected] of cases) {
    assert.equal(ctx.describeMemberLinkChange(previous, next), expected, `${JSON.stringify(previous)} → ${JSON.stringify(next)}`);
  }
});

test('accepting a candidate records who confirmed it and what it was', async () => {
  const {ctx, db, state} = loadContext({
    links: [{eso_account_name: 'Auleric', discord_user_id: '42', link_status: 'candidate', link_method: 'fuzzy', match_confidence: 88}]
  });
  await ctx.upsertMemberLinkUnlocked(db, {
    esoAccountName: 'Auleric',
    discordUserId: '42',
    discordServerNickname: 'Auleric (Joey)',
    linkStatus: 'linked',
    linkMethod: 'manual',
    matchConfidence: 88,
    actorName: 'evainefaye',
    actorUserId: '7'
  });
  assert.equal(state.history.length, 1);
  const [eso, discord, label, action, previousStatus, previousMethod, status, method, confidence, actor, actorId] = state.history[0];
  assert.equal(action, 'candidate_accepted');
  assert.equal(eso, 'Auleric');
  assert.equal(discord, '42');
  assert.equal(label, 'Auleric (Joey)');
  assert.equal(previousStatus, 'candidate');
  assert.equal(previousMethod, 'fuzzy');
  assert.equal(status, 'linked');
  assert.equal(method, 'manual');
  assert.equal(confidence, 88);
  assert.equal(actor, 'evainefaye');
  assert.equal(actorId, '7');
});

test('an exact auto-link is recorded once, even if the matcher runs again', async () => {
  const {ctx, db, state} = loadContext();
  const link = {esoAccountName: 'AarsQuale', discordUserId: '7', linkStatus: 'linked', linkMethod: 'exact', matchConfidence: 100};
  await ctx.upsertMemberLinkUnlocked(db, link);
  await ctx.upsertMemberLinkUnlocked(db, link);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0][3], 'auto_linked');
});

test('removing an exact link records the block it becomes', async () => {
  const {ctx, db, state} = loadContext({
    links: [{eso_account_name: 'Auleric', discord_user_id: '42', link_status: 'linked', link_method: 'exact', match_confidence: 100}]
  });
  vm.runInContext([fn('manualUnlinkMemberUnlocked')].join('\n'), ctx);
  const result = await ctx.manualUnlinkMemberUnlocked(db, {esoAccountName: 'Auleric', discordUserId: '42', actorName: 'officer'});
  // The result object comes from the vm realm, so compare fields after copying.
  assert.deepEqual({...result}, {unlinked: 1, blocked: true});
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0][3], 'unlinked_to_block');
  assert.equal(state.history[0][6], 'blocked');
  assert.equal(state.history[0][9], 'officer');
});

test('removing an approved link records the candidate the pair becomes', async () => {
  const {ctx, db, state} = loadContext({
    links: [{eso_account_name: 'Auleric', discord_user_id: '42', link_status: 'linked', link_method: 'manual', match_confidence: 88}]
  });
  vm.runInContext([fn('manualUnlinkMemberUnlocked')].join('\n'), ctx);
  const result = await ctx.manualUnlinkMemberUnlocked(db, {esoAccountName: 'Auleric', discordUserId: '42'});
  assert.deepEqual({...result}, {unlinked: 1, blocked: false});
  assert.equal(state.history[0][3], 'unlinked_to_candidate');
  assert.equal(state.history[0][6], 'candidate');
});

test('removing a block records it, and doing it twice records nothing extra', async () => {
  const {ctx, db, state} = loadContext({
    links: [{eso_account_name: 'Auleric', discord_user_id: '42', link_status: 'blocked', link_method: 'manual_unlink', match_confidence: 0, auto_link_blocked: 1}]
  });
  vm.runInContext(fn('unblockMemberAutoLinkUnlocked'), ctx);
  assert.deepEqual({...await ctx.unblockMemberAutoLinkUnlocked(db, {esoAccountName: 'Auleric', discordUserId: '42'})}, {removed: 1});
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0][3], 'block_removed');
  assert.deepEqual({...await ctx.unblockMemberAutoLinkUnlocked(db, {esoAccountName: 'Auleric', discordUserId: '42'})}, {removed: 0});
  assert.equal(state.history.length, 1);
});

test('the history query filters by pair, clamps the limit and needs one side', async () => {
  const {ctx} = loadContext();
  vm.runInContext(fn('getMemberLinkHistory'), ctx);
  const statements = [];
  const db = {execute: async (sql, params) => { statements.push({sql: sql.replace(/\s+/g, ' ').trim(), params}); return [[{history_id: 3}]]; }};

  const rows = await ctx.getMemberLinkHistory(db, {esoAccountName: '@Auleric', discordUserId: '42', limit: 5000});
  assert.deepEqual(rows.map((row) => row.history_id), [3]);
  assert.match(statements[0].sql, /WHERE LOWER\(eso_account_name\) = LOWER\(\?\) AND discord_user_id = \?/);
  assert.match(statements[0].sql, /ORDER BY history_id DESC LIMIT 200$/);
  assert.deepEqual([...statements[0].params], ['Auleric', '42']);

  await ctx.getMemberLinkHistory(db, {discordUserId: '42', limit: 0});
  assert.match(statements[1].sql, /WHERE discord_user_id = \?/);
  assert.match(statements[1].sql, /LIMIT 1$/);

  await assert.rejects(() => ctx.getMemberLinkHistory(db, {}), /ESO account or Discord user/);
});
