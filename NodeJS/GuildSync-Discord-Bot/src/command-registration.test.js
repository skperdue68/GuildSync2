import test from 'node:test';
import assert from 'node:assert/strict';
import { subcommandNames, staleTraderReasons, optionDifferences } from './command-registration.js';
import { data as traderData } from './commands/trader.js';

const current = traderData.toJSON();
const clone = (value) => JSON.parse(JSON.stringify(value));
const salesOptions = (command) => command.options.find((option) => option.name === 'sales').options;

test('the /trader definition registers receipt and status and no longer offers test', () => {
  const names = subcommandNames(current);

  assert.deepEqual(names, ['on', 'register', 'off', 'unregister', 'sales', 'receipt', 'status']);
  assert.ok(names.includes('receipt'), '/trader receipt has to be registered');
  assert.ok(names.includes('status'), '/trader status has to be registered');
  assert.equal(names.includes('test'), false, '/trader test must not be registered again');
  assert.deepEqual(staleTraderReasons(clone(current), current), [], 'this build reads back clean');
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

test('a new option that Discord does not have yet fails verification', () => {
  const registered = clone(current);
  const sales = registered.options.find((option) => option.name === 'sales');
  sales.options = sales.options.filter((option) => option.name !== 'count');

  assert.deepEqual(staleTraderReasons(registered, current), [
    '/trader sales does not match: missing the count option'
  ]);
});

test('a changed limit, requirement or wording fails verification', () => {
  const registered = clone(current);
  salesOptions(registered).find((option) => option.name === 'count').max_value = 10;
  salesOptions(registered).find((option) => option.name === 'item').required = true;
  salesOptions(registered).find((option) => option.name === 'item').description = 'Old wording.';

  const [reason] = staleTraderReasons(registered, current);

  assert.match(reason, /^\/trader sales does not match: /);
  assert.match(reason, /item required is true here but false in this build/);
  assert.match(reason, /item description is “Old wording\.” here but “Any part of the item name, spaces allowed\.” in this build/);
  assert.match(reason, /count max_value is 10 here but 50 in this build/);
});

test('an option Discord still offers but this build does not is reported', () => {
  const registered = clone(current);
  salesOptions(registered).push({ type: 3, name: 'filter', description: 'Old filter.' });

  assert.match(staleTraderReasons(registered, current)[0], /has an unexpected filter option/);
});

test('option differences are empty for a definition that matches itself', () => {
  const sales = current.options.find((option) => option.name === 'sales');

  assert.deepEqual(optionDifferences(sales, clone(sales)), []);
  assert.deepEqual(optionDifferences(sales, sales), []);
});

test('a registration that still offers test is reported as stale', () => {
  const old = {
    name: 'trader',
    options: ['on', 'register', 'off', 'unregister', 'sales', 'test'].map((name) => ({
      type: 1,
      name,
      description: name
    }))
  };

  const reasons = staleTraderReasons(old, current);

  assert.ok(reasons.includes('it still offers the retired /trader test'));
  assert.ok(reasons.includes('it is missing /trader receipt'));
  assert.ok(reasons.includes('it is missing /trader status'));
  assert.ok(reasons.some((reason) => reason.includes('missing the item option')));
});

test('a missing registration and a missing receipt are both caught', () => {
  assert.deepEqual(staleTraderReasons(undefined, current), ['it is not registered']);

  const withoutReceipt = {
    name: 'trader',
    options: current.options.filter((option) => option.name !== 'receipt')
  };

  assert.deepEqual(staleTraderReasons(withoutReceipt, current), ['it is missing /trader receipt']);
});
