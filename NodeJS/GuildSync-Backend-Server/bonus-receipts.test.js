import {withIdentityTestDB} from './identity-test-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBonusTiers } from './raffle-bonus.js';
process.env.MARIADB_USER ||= 'test';
process.env.MARIADB_PASSWORD ||= 'test';
const { checkoutDepositMail } = await import('./guildsync-database-actions.js');

let lastCheckoutQueries = [];

async function receipt({ type = 'biweekly', enabled = true, time = '2026-09-14T12:00:00Z', source = 'GuildBank', override, template,
 tickets = 100, nudged = false, note = null } = {}) {
 lastCheckoutQueries = [];
 const oldTemplate = process.env.GUILDSYNC_DEPOSIT_MAIL_BODY_TEMPLATE;
 if (template) process.env.GUILDSYNC_DEPOSIT_MAIL_BODY_TEMPLATE = template;
 else delete process.env.GUILDSYNC_DEPOSIT_MAIL_BODY_TEMPLATE;
 const tiers = parseBonusTiers(type === 'biweekly' ? '120:20,120:10,72:5,24:0' : '168:40,168:20,168:10,144:5,24:0');
 const row = { event_id: '123', transaction_type: type, account_name: '@Member', event_timestamp: Date.parse(time)/1000, deposit_amount: 10001, ticket_quantity: tickets, data_source: source, note };
 const db = {
  async getConnection() { return db; }, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
  async query(sql, args = []) {
   lastCheckoutQueries.push({ sql, args });
   // By default no earlier receipt for this member/raffle has carried the nudge.
   if (sql.includes('bonus_nudge_sent = 1')) {
    return [nudged ? [{ account_name: '@Member', transaction_type: type, event_timestamp: row.event_timestamp }] : []];
   }
   if (sql.includes('SELECT event_id')) return [[{ event_id: '123' }]];
   if (sql.includes('SELECT')) return [[row]];
   return [{ affectedRows: 1 }];
  },
  async execute(sql) {
   if (sql.includes("mail_handoff_version = 1")) return [{affectedRows:0}];
   if (sql.includes('guildsync_raffle_bonus_versions')) return [[{ raffle_type: type, effective_from: 1, enabled: enabled ? 1 : 0, tiers_json: JSON.stringify(tiers) }]];
   if (sql.includes('guildsync_raffle_bonus_overrides')) return [override ? [{ raffle_type: type, sales_end: Date.parse('2026-09-26T23:00:00Z')/1000, enabled: 1, tiers_json: JSON.stringify(parseBonusTiers(override)) }] : []];
   throw Error(sql);
  }
 };
 withIdentityTestDB(db);
 try { return (await checkoutDepositMail(db, { checked_out_by: 'Tester' })).records[0]; }
 finally { if (oldTemplate === undefined) delete process.env.GUILDSYNC_DEPOSIT_MAIL_BODY_TEMPLATE; else process.env.GUILDSYNC_DEPOSIT_MAIL_BODY_TEMPLATE = oldTemplate; }
}

test('receipt includes purchased count, bonus percentage and Eastern deadline, bonus count and total', async () => {
 const record = await receipt();
 assert.match(record.body, /Ticket Credit Earned: 100/);
 assert.match(record.body, /20%.*before.*September 17, 2026.*7:00.*PM.*ET/);
 assert.match(record.body, /Bonus Tickets: 20/);
 assert.match(record.body, /Total Tickets: 120/);
 assert.equal(record.bonusTickets, 20);
});

test('the default body keeps one blank line above the transaction ID with or without bonus lines', async () => {
 for (const time of ['2026-09-14T12:00:00Z', '2026-09-20T12:00:00Z', '2026-09-26T12:00:00Z']) {
  const body = (await receipt({ time })).body;
  assert.match(body, /\n\nTransaction ID: 123/);
  assert.doesNotMatch(body, /\n\n\nTransaction ID/);
  assert.doesNotMatch(body, /\{bonus_note_block\}|\{bonus_block\}|\{note_block\}/);
 }
});

test('monthly receipt uses its own tiers and later purchases use the applicable lower rate', async () => {
 assert.match((await receipt({ type: 'monthly', time: '2026-08-31T12:00:00Z' })).body, /Bonus Tickets: 40/);
 assert.match((await receipt({ time: '2026-09-20T12:00:00Z' })).body, /10%.*before.*September 22, 2026/);
});

test('disabled, zero-percent and manual receipts omit the bonus block', async () => {
 for (const options of [{ enabled: false }, { time: '2026-09-26T12:00:00Z' }, { source: 'ManualBiweeklyTicket' }]) {
  assert.doesNotMatch((await receipt(options)).body, /Early Purchase Bonus|Bonus Tickets|Total Tickets|buying before/i);
 }
});

test('a purchase that missed the highest bonus is told the higher percentage and how many tickets buying early cost', async () => {
 const record = await receipt({ time: '2026-09-20T12:00:00Z' });
 assert.equal(record.bonusUpsellPercent, 20);
 assert.equal(record.bonusUpsellTickets, 10);
 assert.match(record.body, /If you had bought your tickets by September 17, 2026 at 7:00 PM ET you could have earned 10 more tickets with the 20% bonus!! Buy Early!!$/);
 assert.doesNotMatch(record.body, /even more if bought earlier/);
});

test('a purchase below the next bonus period is nudged to that percentage and told more was possible earlier', async () => {
 const record = await receipt({ time: '2026-09-24T12:00:00Z' });
 assert.equal(record.bonusUpsellPercent, 10);
 assert.equal(record.bonusUpsellTickets, 5);
 assert.match(record.body, /If you had bought your tickets by September 22, 2026 at 7:00 PM ET you could have earned 5 more tickets with the 10% bonus, and even more if bought earlier than that!! Buy Early!!$/);
});

test('the best bonus period, a disabled bonus and manual entries get no early-purchase nudge', async () => {
 for (const options of [{ time: '2026-09-14T12:00:00Z' }, { enabled: false }, { source: 'ManualBiweeklyTicket' }]) {
  const record = await receipt(options);
  assert.equal(record.bonusUpsellTickets, 0);
  assert.doesNotMatch(record.body, /Buy Early|bought your tickets/);
 }
});

test('custom templates place the early-purchase nudge once and never leave the placeholder', async () => {
 const placed = await receipt({ time: '2026-09-20T12:00:00Z', template: 'Purchased {tickets}.\n{bonus_upsell}' });
 assert.equal(placed.body.match(/Buy Early/g).length, 1);
 assert.doesNotMatch(placed.body, /\{bonus_upsell\}/);
 const appended = await receipt({ time: '2026-09-20T12:00:00Z', template: 'Purchased {tickets}.' });
 assert.equal(appended.body.match(/Buy Early/g).length, 1);
});

test('raffle override is used and custom templates get one bonus block', async () => {
 const options = { override: '120:30,192:10,24:0' };
 const record = await receipt({ ...options, template: 'Purchased {tickets}.' });
 assert.match(record.body, /Bonus Tickets: 30/);
 assert.match(record.body, /Total Tickets: 130/);
 const placed = await receipt({ ...options, template: 'Purchased {tickets}.\n{bonus_block}' });
 assert.equal(placed.body.match(/Bonus Tickets:/g).length, 1);
 assert.doesNotMatch(placed.body, /\{bonus_block\}/);
});

test('a receipt lists the rest of the bonus schedule after this purchase', async () => {
 const body = (await receipt({ time: '2026-09-14T12:00:00Z' })).body;
 assert.match(body, /Bonus schedule: 10% until September 22, 2026 at 7:00 PM ET, then 5% until September 25, 2026 at 7:00 PM ET\./);
 const later = (await receipt({ time: '2026-09-21T12:00:00Z' })).body;
 assert.match(later, /Bonus schedule: 5% until September 25, 2026 at 7:00 PM ET\./);
});

test('a small purchase explains rounding and is still nudged toward the better percentage', async () => {
 const record = await receipt({ time: '2026-09-20T12:00:00Z', tickets: 2 });
 assert.equal(record.bonusPercent, 10);
 assert.equal(record.bonusTickets, 0);
 assert.match(record.body, /Bonuses round down, so this purchase was too small to earn bonus tickets\./);
 assert.equal(record.bonusUpsellPercent, 20);
 assert.equal(record.bonusUpsellTickets, 0);
 assert.match(record.body, /you could have earned the 20% bonus instead of 10%!! Buy Early!!$/);
});

test('each member is nudged at most once per raffle', async () => {
 assert.match((await receipt({ time: '2026-09-20T12:00:00Z' })).body, /Buy Early/);
 const second = await receipt({ time: '2026-09-21T12:00:00Z', nudged: true });
 assert.equal(second.bonusUpsellTickets, 0);
 assert.equal(second.bonusUpsellPercent, 0);
 assert.doesNotMatch(second.body, /Buy Early|bought your tickets/);
});

test('checkout stores the mailed bonus numbers and the nudge flag with each entry', async () => {
 await receipt({ time: '2026-09-20T12:00:00Z' });
 const write = lastCheckoutQueries.find(({ sql }) => sql.includes('mailed_bonus_json'));
 assert.ok(write, 'checkout must persist the mailed snapshot');
 assert.equal(write.args[2], '123');
 assert.equal(write.args[1], 1);
 const snapshot = JSON.parse(write.args[0]);
 assert.equal(snapshot.bonusPercent, 10);
 assert.equal(snapshot.bonusTickets, 10);
 assert.equal(snapshot.totalTickets, 110);
 assert.equal(snapshot.bonusUpsellPercent, 20);
 assert.equal(snapshot.bonusLadder.length, 1);
});

test('the nudge can be switched off for every receipt', async () => {
 process.env.GUILDSYNC_DEPOSIT_MAIL_BONUS_NUDGE_ENABLED = 'false';
 try {
  const record = await receipt({ time: '2026-09-20T12:00:00Z' });
  assert.equal(record.bonusUpsellTickets, 0);
  assert.doesNotMatch(record.body, /Buy Early/);
 } finally {
  delete process.env.GUILDSYNC_DEPOSIT_MAIL_BONUS_NUDGE_ENABLED;
 }
});

test('banking data shows the numbers that were mailed instead of recalculating', async () => {
 process.env.MARIADB_USER ||= 'test';
 process.env.MARIADB_PASSWORD ||= 'test';
 const { getBankingDataJSON } = await import('./guildsync-database-actions.js');
 const entry = { type: 'biweekly', eventId: '1', time: 1, displayName: '@Member', amount: 10001,
  ticketAmount: 100, dataSource: 'GuildBank',
  mailedBonusJson: JSON.stringify({ purchasedTickets: 100, bonusPercent: 20, bonusTickets: 20,
   totalTickets: 120, bonusEnabled: true, bonusUpsellPercent: 0, bonusUpsellTickets: 0,
   bonusLadder: [{ percent: 10, expiresAt: 2 }] }) };
 const db = { execute: async sql => {
  if (sql.includes('guildsync_raffle_bonus_overrides')) return [[]];
  if (sql.includes('guildsync_raffle_bonus_versions')) return [[]];
  return [[{ banking_json: JSON.stringify([entry]) }]];
 } };
 const [result] = await getBankingDataJSON(db);
 assert.equal(result.bonusPercent, 20);
 assert.equal(result.bonusTickets, 20);
 assert.equal(result.totalTickets, 120);
 assert.equal(result.bonusSource, 'mailed');
 assert.equal('mailedBonusJson' in result, false);
});

test('real receipt previews use recent purchases and keep their real bonus numbers', async () => {
 process.env.MARIADB_USER ||= 'test';
 process.env.MARIADB_PASSWORD ||= 'test';
 const { getDepositMailPreviewExamples } = await import('./guildsync-database-actions.js');
 const tiers = parseBonusTiers('120:20,120:10,72:5,24:0');
 const rows = [
  { event_id: '1', transaction_type: 'biweekly', account_name: '@Member', event_timestamp: Date.parse('2026-09-20T12:00:00Z') / 1000,
   deposit_amount: 5001, ticket_quantity: 2, data_source: 'GuildBank', note: null },
  { event_id: '2', transaction_type: 'biweekly', account_name: '@Member', event_timestamp: Date.parse('2026-09-14T12:00:00Z') / 1000,
   deposit_amount: 200001, ticket_quantity: 100, data_source: 'GuildBank', note: null }
 ];
 const db = { execute: async sql => {
  if (sql.includes('guildsync_raffle_bonus_overrides')) return [[]];
  if (sql.includes('guildsync_raffle_bonus_versions')) return [[{ raffle_type: 'biweekly', effective_from: 1, enabled: 1, tiers_json: JSON.stringify(tiers) }]];
  return [rows];
 } };
 const { examples } = await getDepositMailPreviewExamples(db);
 assert.ok(examples.length >= 1);
 const small = examples.find(example => example.values.ticket_quantity === '2');
 assert.ok(small, 'a small purchase should be available as a real preview');
 assert.equal(small.values.bonus_tickets, '0');
 assert.match(small.values.bonus_block, /10%/);
 assert.match(small.values.bonus_block, /Bonuses round down/);
 assert.match(small.label, /Bi-Weekly/);
});

test('moved entries expose the other side of the move as a related transaction ID', async () => {
 const moved = await receipt({ note: 'Moved from 50/50 to Bi-Weekly by Officer.\nRef 987654', time: '2026-09-20T12:00:00Z',
  template: 'Tickets {tickets}. Ref {related_transaction_id}' });
 assert.match(moved.body, /Ref 987654/);
 assert.doesNotMatch(moved.body, /\{related_transaction_id\}/);
 const original = await receipt({ note: 'Moved to 50/50. Replacement ManualMove123', time: '2026-09-20T12:00:00Z',
  template: 'Ref {related_transaction_id}' });
 assert.match(original.body, /Ref ManualMove123/);
 const ordinary = await receipt({ time: '2026-09-20T12:00:00Z', template: 'Ref[{related_transaction_id}]' });
 assert.match(ordinary.body, /Ref\[\]/);
});
