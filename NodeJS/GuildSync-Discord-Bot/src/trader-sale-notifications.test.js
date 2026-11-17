import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTraderSaleEmbed, buildTraderDigestEmbed, startTraderSaleNotifications } from './trader-sale-notifications.js';

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

test('a catch-up digest totals every sale exactly once', () => {
  const embed = buildTraderDigestEmbed([
    sale,
    { ...sale, eventId: 502, net: 465, price: 500, tax: 35, itemName: 'Item' }
  ]);
  assert.match(embed.title, /catch-up/i);
  assert.match(embed.description, /\*\*2\*\* trader sales/);
  assert.ok(embed.fields.some((field) => field.name === 'Net' && field.value === '93,465g'));
  assert.ok(embed.fields.some((field) => field.name === 'Tax' && field.value === '7,035g'));
});

test('the socket listener DMs subscribers and logs delivery failures', async () => {
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
  await handler({ discord_user_id: '42', kind: 'digest', sales: [sale, sale] });
  await handler({ discord_user_id: 'broken', kind: 'sale', sales: [sale] });
  await handler({ discord_user_id: '', kind: 'sale', sales: [] });

  assert.equal(sent.length, 2);
  assert.ok(sent[0].message.embeds[0].description.includes('93,000g'));
  assert.match(sent[1].message.embeds[0].title, /catch-up/i);
  assert.ok(logs.some((line) => line.includes('DMs closed')));
});
