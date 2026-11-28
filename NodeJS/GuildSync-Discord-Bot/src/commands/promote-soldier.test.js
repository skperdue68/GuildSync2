import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';

import {
  RECRUIT_ROLES,
  SOLDIER_ROLE_ID,
  SOLDIER_DM,
  data,
  planPromotion,
  promotionSummary
} from './promote-soldier.js';

const [associate, gangster, neighbor] = RECRUIT_ROLES;

function fakeMember(roleIds, { bot = false, manageable = true } = {}) {
  const cache = new Collection(roleIds.map((id) => [id, { id }]));
  return {
    id: '42',
    user: { bot },
    manageable,
    roles: { cache }
  };
}

test('the context menu command is a user command requiring Manage Roles', () => {
  const json = data.toJSON();
  assert.equal(json.name, 'Promote - Soldier');
  assert.equal(json.type, 2);
});

test('a recruit plan queues every recruit role held plus Soldier', () => {
  const plan = planPromotion(fakeMember([associate.id, neighbor.id]));

  assert.equal(plan.status, 'queued');
  assert.deepEqual(plan.removeRoleIds, [associate.id, neighbor.id]);
  assert.equal(plan.addRoleId, SOLDIER_ROLE_ID);
});

test('only the recruit roles actually held are queued for removal', () => {
  const plan = planPromotion(fakeMember([gangster.id, 'other-role']));

  assert.deepEqual(plan.removeRoleIds, [gangster.id]);
});

test('a member without a recruit role is not queued', () => {
  const member = fakeMember(['other-role']);

  const plan = planPromotion(member);

  assert.equal(plan.status, 'not-recruit');
  assert.deepEqual(plan.removeRoleIds, []);
  assert.match(promotionSummary(member, plan), /does not have Associate, Gangster or Neighbor/);
});

test('an existing Soldier is not queued again', () => {
  const member = fakeMember([SOLDIER_ROLE_ID, gangster.id]);

  const plan = planPromotion(member);

  assert.equal(plan.status, 'already-soldier');
  assert.deepEqual(plan.removeRoleIds, []);
  assert.match(promotionSummary(member, plan), /already a Soldier/);
});

test('bots and unmanageable members are refused', () => {
  assert.throws(() => planPromotion(fakeMember([associate.id], { bot: true })), /Bots cannot be promoted/);
  assert.throws(() => planPromotion(fakeMember([associate.id], { manageable: false })), /highest role/);
});

test('the promotion DM matches the approved wording', () => {
  assert.equal(
    SOLDIER_DM,
    'Hello! You may have noticed that you’ve been promoted in guild and on Discord to Soldier in Alphabet Mafia. Congratulations! This means that you can now deposit items in the guild bank if you’d like, but please check our guidelines on what sort of items we need before you do. We hope you continue to enjoy your time in Alphabet Mafia!'
  );
});
