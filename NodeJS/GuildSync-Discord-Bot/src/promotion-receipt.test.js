import test from 'node:test';
import assert from 'node:assert/strict';

import { promotionReceiptMessage } from './promotion-receipt.js';

const embedOf = (payload) => payload.embeds[0].toJSON();
const fieldsOf = (payload) => Object.fromEntries(embedOf(payload).fields.map((field) => [field.name, field.value]));

test('the receipt names the member, the role swap and the outcome', () => {
  const payload = promotionReceiptMessage({
    userId: '42',
    name: 'Member',
    joinedAt: 1000000000000,
    status: 'sent',
    removed: ['Associate', 'Neighbor'],
    added: 'Soldier'
  });
  const embed = embedOf(payload);
  const fields = fieldsOf(payload);

  assert.match(embed.title, /sent/i);
  assert.match(embed.description, /<@42>/);
  assert.match(fields.Member, /Member/);
  assert.match(fields.Member, /42/);
  assert.equal(fields.Removed, 'Associate, Neighbor');
  assert.equal(fields.Added, 'Soldier');
  assert.ok(fields['In server since'].startsWith('<t:'));
  assert.deepEqual(payload.allowedMentions.parse, []);
});

test('a failed receipt carries the reason and no mentions', () => {
  const payload = promotionReceiptMessage({ userId: '42', status: 'failed', detail: 'Missing Manage Roles.' });
  const fields = fieldsOf(payload);

  assert.match(embedOf(payload).title, /failed/i);
  assert.equal(fields.Outcome, 'Missing Manage Roles.');
  assert.equal(fields.Removed, 'None');
  assert.equal(fields.Added, 'None');
});

test('a failed DM after the roles changed says the promotion was applied', () => {
  const payload = promotionReceiptMessage({ userId: '42', status: 'failed', detail: 'DMs are closed.', roleChanged: true });

  assert.match(embedOf(payload).title, /Promotion applied/i);
  assert.match(embedOf(payload).description, /was promoted, but the reminder DM was not sent/);
});

test('an uncertain delivery is a review, not a success', () => {
  const payload = promotionReceiptMessage({ userId: '42', status: 'uncertain', detail: 'Discord did not confirm.' });

  assert.match(embedOf(payload).title, /review/i);
});
