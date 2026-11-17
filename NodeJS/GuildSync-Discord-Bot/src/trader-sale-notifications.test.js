import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
  buildTraderSaleEmbed,
  buildTraderSaleFallbackEmbed,
  buildTraderInvoiceEmbed,
  buildTraderInvoiceFallbackEmbed,
  createTraderSendQueue,
  startTraderSaleNotifications
} from './trader-sale-notifications.js';
import { renderTraderInvoiceImage } from './trader-invoice-image.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const sale = {
  eventId: 501,
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
  time: 1780000501
};

test('a sale DM is a short caption plus the math because the image carries the details', () => {
  const embed = buildTraderSaleEmbed(sale);

  assert.equal(embed.title, 'Trader sale complete');
  assert.match(embed.description, /Congratulations/);
  assert.match(embed.description, /\*\*Example Guild\*\* Trader/);
  assert.match(embed.description, /10 × 10,000g = 100,000g − 7,000g tax = \*\*93,000g\*\* net profit/);
  assert.equal(embed.description.split('\n').length, 2, 'the caption is two lines');
  assert.equal(embed.fields, undefined, 'details live in the attached invoice, not the embed');
  assert.equal(embed.footer.text, 'Example Guild · EU Megaserver');
});

test('the sale fallback keeps every detail in the embed', () => {
  const embed = buildTraderSaleFallbackEmbed(sale);

  assert.match(embed.description, /10 × 10,000g = 100,000g − 7,000g tax = \*\*93,000g\*\* net profit/);
  assert.deepEqual(embed.fields.map((field) => field.name), [
    'Date', 'Transaction ID', 'Buyer', 'Item', 'Quantity', 'Price per unit', 'Tax', 'Net profit'
  ]);
  assert.equal(embed.fields[0].value, '<t:1780000501:f>');
  assert.equal(embed.fields[1].value, '#501');
  assert.equal(embed.fields[2].value, '@Buyer');
  assert.equal(embed.fields[5].value, '10,000g');
  assert.equal(embed.fields[7].value, '93,000g');
});

test('a combined invoice DM is a short caption plus the totals math', () => {
  const embed = buildTraderInvoiceEmbed([
    { ...sale, eventId: 3, buyer: '@BuyerB', itemName: 'Sword', quantity: 1, price: 1000, unitPrice: 1000, tax: 70, net: 930, time: 1780000300 },
    { ...sale, eventId: 1, buyer: '@BuyerA', itemName: 'Ruby', quantity: 2, price: 20000, unitPrice: 10000, tax: 1400, net: 18600, time: 1780000100 }
  ]);

  assert.match(embed.title, /Trader sales invoice/);
  assert.match(embed.description, /You made \*\*2\*\* sales on your \*\*Example Guild\*\* Trader/);
  assert.match(embed.description, /3 items across 2 sales: 21,000g − 1,470g tax = \*\*19,530g\*\* net profit/);
  assert.equal(embed.fields, undefined);
  assert.equal(embed.footer.text, 'Example Guild · EU Megaserver');
});

test('the invoice fallback groups items by buyer, then by sale time, with column totals', () => {
  const embed = buildTraderInvoiceFallbackEmbed([
    { ...sale, eventId: 3, buyer: '@BuyerB', itemName: 'Sword', quantity: 1, price: 1000, unitPrice: 1000, tax: 70, net: 930, time: 1780000300 },
    { ...sale, eventId: 1, buyer: '@BuyerA', itemName: 'Dreugh Wax', quantity: 2, price: 20000, unitPrice: 10000, tax: 1400, net: 18600, time: 1780000100 },
    { ...sale, eventId: 2, buyer: '@BuyerA', itemName: 'Ruby', quantity: 1, price: 5000, unitPrice: 5000, tax: 350, net: 4650, time: 1780000200 }
  ]);

  assert.match(embed.title, /Trader sales invoice/);
  assert.match(embed.description, /\*\*3\*\* sales on your \*\*Example Guild\*\* Trader/);

  const buyerA = embed.description.indexOf('**@BuyerA**');
  const buyerB = embed.description.indexOf('**@BuyerB**');
  assert.ok(buyerA >= 0 && buyerB > buyerA, 'buyers are grouped in name order');

  const wax = embed.description.indexOf('Dreugh Wax');
  const ruby = embed.description.indexOf('Ruby');
  assert.ok(wax >= 0 && ruby > wax, 'BuyerA items are ordered by sale time');
  assert.ok(embed.description.indexOf('Sword') > buyerB, 'BuyerB follows BuyerA');

  assert.match(embed.description, /2 × 10,000g = 20,000g − 1,400g tax = 18,600g net/);
  assert.ok(embed.fields.some((field) => field.name === 'Sales' && field.value === '3'));
  assert.ok(embed.fields.some((field) => field.name === 'Quantity' && field.value === '4'));
  assert.ok(embed.fields.some((field) => field.name === 'Gross' && field.value === '26,000g'));
  assert.ok(embed.fields.some((field) => field.name === 'Tax' && field.value === '1,820g'));
  assert.ok(embed.fields.some((field) => field.name === 'Net profit' && field.value === '24,180g'));
});

test('the invoice graphic renders as a PNG for one sale and for many', async () => {
  const single = await renderTraderInvoiceImage({ sales: [sale], kind: 'sale' });
  assert.deepEqual(Buffer.from(single.subarray(0, 4)), PNG_SIGNATURE);
  assert.ok(single.length > 2000, 'the PNG carries a real page');

  const invoice = await renderTraderInvoiceImage({
    sales: [sale, { ...sale, eventId: 502, buyer: '@Other', time: 1780000600 }, { ...sale, eventId: 503, buyer: '@Third', time: 1780000700 }],
    kind: 'invoice'
  });
  assert.deepEqual(Buffer.from(invoice.subarray(0, 4)), PNG_SIGNATURE);
});

test('the DM queue spaces sends out and pauses every fifth', async () => {
  const waits = [];
  const enqueue = createTraderSendQueue({ sleep: async (ms) => waits.push(ms), random: () => 0 });
  const sent = [];

  for (let index = 0; index < 7; index += 1) await enqueue(async () => sent.push(index));

  assert.deepEqual(sent, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(
    waits,
    [2000, 2000, 2000, 2000, 60000, 2000],
    'a gap between each DM, then a full pause after the fifth'
  );
});

test('the queue resets its batch after a long idle and survives a failed task', async () => {
  let clock = 0;
  const waits = [];
  const logs = [];
  const enqueue = createTraderSendQueue({
    sleep: async (ms) => waits.push(ms),
    random: () => 0,
    now: () => clock,
    log: (line) => logs.push(line)
  });

  for (let index = 0; index < 5; index += 1) await enqueue(async () => { clock += 10; });
  clock += 10 * 60 * 1000;

  const sent = [];
  await enqueue(async () => sent.push('after idle'));
  await enqueue(async () => { throw new Error('boom'); });
  await enqueue(async () => sent.push('after failure'));

  assert.deepEqual(waits, [2000, 2000, 2000, 2000, 2000, 2000], 'no 60-120s pause after an idle gap');
  assert.deepEqual(sent, ['after idle', 'after failure'], 'a failing DM does not stall the queue');
  assert.ok(logs.some((line) => line.includes('boom')));
});

test('a failed invoice render falls back to the details embed', async () => {
  const sent = [];
  const handlers = new Map();
  const socket = { on: (event, handler) => handlers.set(event, handler), off() {} };
  const client = { users: { async fetch() { return { async send(message) { sent.push(message); } }; } } };
  const logs = [];

  startTraderSaleNotifications(client, socket, (line) => logs.push(line), {
    renderInvoiceImage: () => { throw new Error('canvas unavailable'); },
    enqueue: (task) => task()
  });

  const handler = handlers.get('guildsync:trader-sale-notice');
  await handler({ discord_user_id: '42', kind: 'sale', sales: [sale] });
  await handler({ discord_user_id: '42', kind: 'invoice', sales: [sale, { ...sale, eventId: 502, buyer: '@Other' }] });

  assert.equal(sent.length, 2, 'both DMs still go out');

  const single = sent[0];
  assert.equal(single.files, undefined, 'nothing is attached when rendering failed');
  assert.equal(single.embeds[0].image, undefined);
  assert.ok(single.embeds[0].fields.some((field) => field.name === 'Transaction ID' && field.value === '#501'));
  assert.ok(single.embeds[0].fields.some((field) => field.name === 'Buyer' && field.value === '@Buyer'));
  assert.ok(single.embeds[0].fields.some((field) => field.name === 'Net profit' && field.value === '93,000g'));

  const invoice = sent[1];
  assert.equal(invoice.files, undefined);
  assert.ok(invoice.embeds[0].fields.some((field) => field.name === 'Sales' && field.value === '2'));
  assert.match(invoice.embeds[0].description, /@Other/, 'the buyer-grouped item list survives');
  assert.match(invoice.embeds[0].description, /Dreugh Wax/);

  assert.equal(logs.filter((line) => line.includes('canvas unavailable')).length, 2, 'each failure is logged');
});

test('the socket listener sends the trimmed embed with the image and deletes the temp file', async () => {
  const before = new Set(await fs.readdir(os.tmpdir()));
  const sent = [];
  const handlers = new Map();
  const socket = { on: (event, handler) => handlers.set(event, handler), off() {} };
  const client = {
    users: {
      async fetch(id) {
        if (id === 'broken') throw new Error('DMs closed');
        return { async send(message) { sent.push({ id, message }); } };
      }
    }
  };
  const logs = [];
  startTraderSaleNotifications(client, socket, (line) => logs.push(line), { enqueue: (task) => task() });

  const handler = handlers.get('guildsync:trader-sale-notice');
  await handler({ discord_user_id: '42', kind: 'sale', sales: [sale] });
  await handler({ discord_user_id: '42', kind: 'invoice', sales: [sale, { ...sale, eventId: 502, buyer: '@Other' }] });
  await handler({ discord_user_id: 'broken', kind: 'sale', sales: [sale] });
  await handler({ discord_user_id: '', kind: 'sale', sales: [] });

  assert.equal(sent.length, 2);
  assert.match(sent[0].message.embeds[0].title, /Trader sale complete/);
  assert.match(sent[1].message.embeds[0].title, /Trader sales invoice/);

  for (const { message } of sent) {
    assert.equal(message.embeds[0].fields, undefined, 'the DM body stays short');
    assert.equal(message.files.length, 1);
    assert.equal(message.files[0].name, 'trader-invoice.png');
    assert.equal(message.embeds[0].image.url, 'attachment://trader-invoice.png');
  }

  const leftovers = (await fs.readdir(os.tmpdir()))
    .filter((name) => name.startsWith('guildsync-trader-') && !before.has(name));
  assert.deepEqual(leftovers, [], 'rendered invoice files are deleted after sending');
  assert.ok(logs.some((line) => line.includes('DMs closed')));
});
