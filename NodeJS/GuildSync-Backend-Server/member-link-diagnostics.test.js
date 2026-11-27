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

// The decision table is what officers read, so the matcher helpers are stubbed and the
// real function is fed the same inputs the matcher would see.
function loadContext({roster = [{account_name: 'Auleric', rank: 'Member'}], discord = [], links = [], esoOptOut = false, discordOptOuts = [], scores = {}} = {}) {
  const ctx = vm.createContext({
    resolveEsoAccountName: async (_db, name) => name,
    esoAccountKey: (name) => String(name ?? '').trim().replace(/^@+/, '').toLowerCase(),
    loadMemberLinkInputs: async () => ({rosterRows: roster, discordRows: discord, linkRows: links}),
    buildExistingLinkMaps: (rows) => ({rows}),
    loadMemberLinkOptOuts: async () => ({esoKeys: new Set(esoOptOut ? ['auleric'] : []), discordIds: new Set(discordOptOuts)}),
    getBestDiscordNameMatch: (_eso, member) => scores[member.discord_id] || null,
    isMemberLinkPairBlocked: (maps, _eso, id) => maps.rows.some((link) => String(link.discord_user_id) === String(id) && Number(link.auto_link_blocked || 0) === 1),
    isMemberLinkPairLinked: (maps, _eso, id) => maps.rows.some((link) => String(link.discord_user_id) === String(id) && String(link.link_status).toLowerCase() === 'linked'),
    isMemberLinkPairAutoUpgradeable: (maps, _eso, id) => !maps.rows.some((link) => String(link.discord_user_id) === String(id) && (String(link.link_status).toLowerCase() === 'linked' || Number(link.auto_link_blocked || 0) === 1))
  });
  vm.runInContext(fn('getMemberLinkMatchDiagnostics') + '\nconst MEMBER_LINK_CANDIDATE_THRESHOLD = 82;', ctx);
  return ctx;
}

const names = (result) => result.candidates.map((candidate) => [candidate.discord_user_id, candidate.decision]);

test('the diagnostics name what the matcher would do for each Discord member', async () => {
  const ctx = loadContext({
    discord: [
      {discord_id: '1', server_nickname: 'Auleric'},
      {discord_id: '2', username: 'auleric'},
      {discord_id: '3', global_name: 'Someone Else'},
      {discord_id: '4', username: 'auleric_alt'}
    ],
    scores: {
      1: {score: 100, field: 'discord_server_nickname'},
      2: {score: 88, field: 'discord_username'},
      3: {score: 12, field: 'discord_username'},
      4: {score: 84, field: 'discord_username'}
    }
  });

  const result = await ctx.getMemberLinkMatchDiagnostics({}, {esoAccountName: '@Auleric'});

  assert.equal(result.eso_account_name, 'Auleric');
  assert.equal(result.discord_members_evaluated, 4);
  assert.equal(result.candidate_threshold, 82);
  // Sorted by score, so the strongest offer is the first row an officer reads.
  assert.deepEqual(names(result), [
    ['1', 'auto_link'],
    ['2', 'candidate'],
    ['4', 'candidate'],
    ['3', 'below_threshold']
  ]);
  assert.equal(result.candidates[0].match_field, 'discord_server_nickname');
});

test('existing links, blocks and opt-outs are reported as the reason nothing is offered', async () => {
  const ctx = loadContext({
    discord: [{discord_id: '1'}, {discord_id: '2'}, {discord_id: '3'}],
    links: [
      {eso_account_name: 'Auleric', discord_user_id: '1', link_status: 'linked', link_method: 'manual', match_confidence: 88},
      {eso_account_name: 'Auleric', discord_user_id: '2', link_status: 'blocked', link_method: 'manual_unlink', auto_link_blocked: 1}
    ],
    discordOptOuts: ['3'],
    scores: {
      1: {score: 88, field: 'discord_username'},
      2: {score: 88, field: 'discord_username'},
      3: {score: 88, field: 'discord_username'}
    }
  });

  const result = await ctx.getMemberLinkMatchDiagnostics({}, {esoAccountName: 'Auleric'});
  const byId = Object.fromEntries(result.candidates.map((candidate) => [candidate.discord_user_id, candidate]));

  assert.equal(byId['1'].decision, 'already_linked');
  assert.equal(byId['1'].existing_link.link_method, 'manual');
  assert.equal(byId['2'].decision, 'blocked');
  assert.equal(byId['3'].decision, 'opted_out');
  assert.equal(byId['3'].discord_opt_out, 1);
});

test('a member marked as not using Discord is reported before any score is offered', async () => {
  const ctx = loadContext({
    discord: [{discord_id: '1'}],
    esoOptOut: true,
    scores: {1: {score: 100, field: 'discord_server_nickname'}}
  });

  const result = await ctx.getMemberLinkMatchDiagnostics({}, {esoAccountName: 'Auleric'});
  assert.equal(result.eso_opt_out, 1);
  assert.equal(result.candidates[0].decision, 'opted_out');
});

test('an unknown roster member and a missing account name are rejected', async () => {
  const ctx = loadContext();
  await assert.rejects(() => ctx.getMemberLinkMatchDiagnostics({}, {}), /ESO account name is required/);
  await assert.rejects(() => ctx.getMemberLinkMatchDiagnostics({}, {esoAccountName: 'Nobody'}), /not found in the roster/);
});
