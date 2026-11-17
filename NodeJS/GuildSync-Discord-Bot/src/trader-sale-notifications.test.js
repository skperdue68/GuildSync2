import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTraderSaleEmbed, buildTraderInvoiceEmbed, startTraderSaleNotifications } from './trader-sale-notifications.js';

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

test('a sale DM reads like an invoice with a Discord-local timestamp', () => {
  const embed = buildTraderSaleEmbed(sale);
  assert.match(embed.title, /Dreugh Wax/);
  assert.match(embed.description, /10,000g × 10 = 100,000g − 7,000g tax = \*\*93,000g\*\* net/);
  assert.ok(embed.fields.some((field) => field.name === 'When' && field.value === '<t:1780000501:f>'));
  assert.ok(embed.fields.some((field) => field.name === 'Transaction' && field.value === '#501'));
  assert.ok(embed.fields.some((field) => field.name === 'Buyer' && field.value === '@Buyer'));
  assert.equal(embed.footer.text, 'Example Guild · EU Megaserver');
});

test('a combined invoice groups items by buyer, then by sale time, with column totals', () => {
  const embed = buildTraderInvoiceEmbed([
    { ...sale, eventId: 3, buyer: '@BuyerB', itemName: 'Sword', quantity: 1, price: 1000, unitPrice: 1000, tax: 70, net: 930, time: 1780000300 },
    { ...sale, eventId: 1, buyer: '@BuyerA', itemName: 'Dreugh Wax', quantity: 2, price: 20000, unitPrice: 10000, tax: 1400, net: 18600, time: 1780000100 },
    { ...sale, eventId: 2, buyer: '@BuyerA', itemName: 'Ruby', quantity: 1, price: 5000, unitPrice: 5000, tax: 350, net: 4650, time: 1780000200 }
  ]);

  assert.match(embed.title, /Trader sales invoice/);
  assert.match(embed.description, /\*\*3\*\* sales to \*\*2\*\* buyers/);

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
  assert.ok(embed.fields.some((field) => field.name === 'Net' && field.value === '24,180g'));
  assert.equal(embed.footer.text, 'Example Guild · EU Megaserver');
});

test('the socket listener sends the original invoice for one sale and a combined invoice for several', async () => {
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
  startTraderSaleNotifications(client, socket, (line) => logs.push(line));

  const handler = handlers.get('guildsync:trader-sale-notice');
  await handler({ discord_user_id: '42', kind: 'sale', sales: [sale] });
  await handler({ discord_user_id: '42', kind: 'invoice', sales: [sale, { ...sale, eventId: 502, buyer: '@Other' }] });
  await handler({ discord_user_id: 'broken', kind: 'sale', sales: [sale] });
  await handler({ discord_user_id: '', kind: 'sale', sales: [] });

  assert.equal(sent.length, 2);
  assert.equal(sent[0].message.embeds.length, 1);
  assert.match(sent[0].message.embeds[0].title, /Trader sale:/);
  assert.match(sent[1].message.embeds[0].title, /Trader sales invoice/);
  assert.ok(logs.some((line) => line.includes('DMs closed')));
});
