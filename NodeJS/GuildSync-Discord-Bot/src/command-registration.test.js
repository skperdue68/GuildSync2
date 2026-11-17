import test from 'node:test';
import assert from 'node:assert/strict';
import { subcommandNames, staleTraderReasons } from './command-registration.js';
import { data as traderData } from './commands/trader.js';

const current = traderData.toJSON();

test('the /trader definition registers receipt and status and no longer offers test', () => {
  const names = subcommandNames(current);

  assert.deepEqual(names, ['on', 'register', 'off', 'unregister', 'sales', 'receipt', 'status']);
  assert.ok(names.includes('receipt'), '/trader receipt has to be registered');
  assert.ok(names.includes('status'), '/trader status has to be registered');
  assert.equal(names.includes('test'), false, '/trader test must not be registered again');
  assert.deepEqual(staleTraderReasons(current, names), [], 'this build reads back clean');
});

test('subcommand names ignore string options like the sales item', () => {
  const names = subcommandNames({
    options: [
      { type: 1, name: 'sales', options: [{ type: 3, name: 'item' }] },
      { type: 1, name: 'receipt' },
      { type: 3, name: 'item' }
    ]
  });

  assert.deepEqual(names, ['sales', 'receipt'], 'the item option is an argument, not a subcommand');
});

test('a registration that still offers test is reported as stale', () => {
  const old = {
    name: 'trader',
    options: ['on', 'register', 'off', 'unregister', 'sales', 'test'].map((name) => ({ type: 1, name }))
  };

  const reasons = staleTraderReasons(old, subcommandNames(current));

  assert.equal(reasons.length, 2, 'both the leftover and the missing subcommands are named');
  assert.match(reasons[0], /still offers the retired \/trader test/);
  assert.match(reasons[1], /missing \/trader receipt, \/trader status/);
});

test('a missing registration and a missing receipt are both caught', () => {
  assert.deepEqual(staleTraderReasons(undefined, ['receipt']), ['it is not registered']);

  const withoutReceipt = {
    name: 'trader',
    options: ['on', 'off', 'sales'].map((name) => ({ type: 1, name }))
  };
  assert.deepEqual(staleTraderReasons(withoutReceipt, ['on', 'off', 'sales', 'receipt']), [
    'it is missing /trader receipt'
  ]);
});
