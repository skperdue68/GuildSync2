import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  MAFIA_CHAT_BULK_LIMIT,
  MAFIA_CHAT_SORT_COLUMNS,
  buildMafiaChatWhere,
  createMafiaChatRouter,
  mapMafiaChatRow,
  parseMafiaChatPositionQuery,
  parseMafiaChatQuery,
  queryMafiaChatMessages,
  resolveMafiaChatPositions
} from './mafia-chat-api.js';

function fakeDb({
  rows = [],
  total = 0,
  latestTimestamp = 1795636999,
  beforeCount = 3,
  sortValue = 1795636949,
  knownIds = null
} = {}) {
  const calls = [];
  return {
    calls,
    async execute(sql, params = []) {
      calls.push({sql: sql.replace(/\s+/g, ' ').trim(), params});
      if (/MAX\(message_timestamp\)/.test(sql)) return [[{latest: latestTimestamp}], []];
      if (/before_count/.test(sql)) return [[{before_count: beforeCount}], []];
      if (/COUNT\(\*\) AS total/.test(sql)) return [[{total}], []];
      if (/AS sort_value/.test(sql)) {
        if (knownIds && !knownIds.includes(Number(params[0]))) return [[], []];
        return [[{sort_value: sortValue}], []];
      }
      return [rows, []];
    }
  };
}

test('the default query shows the newest messages first', () => {
  const options = parseMafiaChatQuery({});

  assert.equal(options.sort, 'time');
  assert.equal(options.column, 'message_timestamp');
  assert.equal(options.dir, 'desc');
  assert.equal(options.dirSQL, 'DESC');
  assert.equal(options.limit, 500);
  assert.equal(options.offset, 0);
  assert.equal(options.search, '');
  assert.equal(options.start, null);
  assert.equal(options.end, null);
  assert.equal(options.focus, null);
});

test('every sortable column is whitelisted and unknown input is rejected', () => {
  for (const key of Object.keys(MAFIA_CHAT_SORT_COLUMNS)) {
    assert.equal(parseMafiaChatQuery({sort: key}).column, MAFIA_CHAT_SORT_COLUMNS[key]);
  }

  assert.throws(() => parseMafiaChatQuery({sort: 'message_hash'}), /Unknown sort column/);
  assert.throws(() => parseMafiaChatQuery({sort: 'id; DROP TABLE x'}), /Unknown sort column/);
  assert.throws(() => parseMafiaChatQuery({dir: 'sideways'}), /asc or desc/);
  assert.throws(() => parseMafiaChatQuery({focus: 'msg-1'}), /not valid/);
});

test('range bounds accept epoch seconds and ISO dates and must be in order', () => {
  assert.equal(parseMafiaChatQuery({start: '1795636949'}).start, 1795636949);
  assert.equal(parseMafiaChatQuery({end: '2026-11-25T21:00:00Z'}).end, 1795640400);

  assert.throws(() => parseMafiaChatQuery({start: 'not-a-date'}), /not a valid date/);
  assert.throws(
    () => parseMafiaChatQuery({start: '200', end: '100'}),
    /start of the range must be before the end/
  );
});

test('the limit is capped so one request cannot ask for the whole table', () => {
  assert.equal(parseMafiaChatQuery({limit: '5000'}).limit, 1000);
  assert.equal(parseMafiaChatQuery({limit: '25'}).limit, 25);
  assert.equal(parseMafiaChatQuery({limit: '-4'}).limit, 500);
  assert.equal(parseMafiaChatQuery({offset: '40'}).offset, 40);
});

test('a search is matched literally instead of as a LIKE pattern', () => {
  const search = '50%_done\\x';
  const expectedPattern = `%${search.replace(/[\\%_]/g, character => `\\${character}`)}%`;
  const where = buildMafiaChatWhere({search, start: 10, end: 20});

  assert.equal(where.params[0], 10);
  assert.equal(where.params[1], 20);
  assert.deepEqual(where.params.slice(2), [expectedPattern]);
  assert.match(where.clause, /ESCAPE '\\\\'/);
  assert.match(where.clause, /message_text LIKE \?/);
  // Only the message body is searched; sender and uploader are not.
  assert.doesNotMatch(where.clause, /sender LIKE \?/);
  assert.doesNotMatch(where.clause, /uploaded_by LIKE \?/);
});

test('the query orders by the whitelisted column and keeps the filters as parameters', async () => {
  const db = fakeDb({
    total: 3,
    rows: [
      {
        id: 12,
        sender: '@evainefaye',
        message_text: 'Howdy Mafia!',
        message_timestamp: 1795636949,
        data_source: 'GuildSyncChat',
        uploaded_by: 'Evaine',
        received_at: new Date('2026-11-25T21:18:14.000Z')
      }
    ]
  });

  const options = parseMafiaChatQuery({sort: 'sender', dir: 'asc', q: 'mafia', start: '1', end: '2'});
  const {total, latest, offset, messages} = await queryMafiaChatMessages(db, options);

  assert.equal(total, 3);
  assert.equal(latest, 1795636999);
  assert.equal(offset, 0);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    id: '12',
    sender: '@evainefaye',
    message_text: 'Howdy Mafia!',
    message_timestamp: 1795636949,
    data_source: 'GuildSyncChat',
    uploaded_by: 'Evaine',
    received_at: '2026-11-25T21:18:14.000Z'
  });

  // The newest stored message is reported unfiltered, for the footer stamp.
  assert.equal(db.calls[1].sql, 'SELECT MAX(message_timestamp) AS latest FROM guildsync_guild_chat_messages');
  assert.deepEqual(db.calls[1].params, []);

  const select = db.calls.at(-1);
  assert.match(select.sql, /ORDER BY sender ASC, id ASC/);
  assert.match(select.sql, /LIMIT \? OFFSET \?/);
  assert.deepEqual(select.params.slice(-2), [500, 0]);
});

test('a focus id lands the page on that message, wherever it sorts', async () => {
  const db = fakeDb({total: 40, beforeCount: 17});
  const options = parseMafiaChatQuery({focus: '12', sort: 'sender', dir: 'asc'});
  const {offset} = await queryMafiaChatMessages(db, options);

  assert.equal(offset, 17);
  assert.match(db.calls[2].sql, /AS sort_value/);
  assert.match(db.calls[3].sql, /before_count/);
  assert.match(db.calls[3].sql, /sender < \? OR \(sender = \? AND id < \?\)/);
  assert.deepEqual(db.calls.at(-1).params.slice(-2), [500, 17]);
});

test('a focus id the filters exclude leaves the page at the top', async () => {
  const db = fakeDb({total: 40, knownIds: []});
  const {offset} = await queryMafiaChatMessages(db, parseMafiaChatQuery({focus: '99'}));

  assert.equal(offset, 0);
  assert.doesNotMatch(db.calls.at(-1).sql, /sort_value/);
});

test('positions count the matching rows that sort before each pushed row', async () => {
  const db = fakeDb({beforeCount: 8});
  const options = parseMafiaChatQuery({sort: 'message', dir: 'desc', q: 'raid'});
  const positions = await resolveMafiaChatPositions(db, options, [12, 13]);

  assert.deepEqual(positions, [
    {id: '12', before: 8},
    {id: '13', before: 8}
  ]);
  assert.equal(db.calls.filter(call => /AS sort_value/.test(call.sql)).length, 2);
  assert.equal(db.calls.filter(call => /before_count/.test(call.sql)).length, 2);
});

test('a pushed row outside the filters has no position', async () => {
  const db = fakeDb({knownIds: []});
  const positions = await resolveMafiaChatPositions(db, parseMafiaChatQuery({}), [5]);

  assert.deepEqual(positions, [{id: '5', before: null}]);
});

test('position requests take a bounded list of numeric ids', () => {
  const parsed = parseMafiaChatPositionQuery({ids: '12, 13', sort: 'sender', dir: 'asc'});
  assert.deepEqual(parsed.ids, [12, 13]);
  assert.equal(parsed.options.sort, 'sender');

  assert.throws(() => parseMafiaChatPositionQuery({ids: ''}), /between 1 and/);
  assert.throws(() => parseMafiaChatPositionQuery({ids: 'abc'}), /Unknown message id/);
  assert.throws(() => parseMafiaChatPositionQuery({sort: 'nope', ids: '1'}), /Unknown sort column/);
});

test('bulk uploads are announced by count rather than by row', () => {
  assert.equal(typeof MAFIA_CHAT_BULK_LIMIT, 'number');
  assert.ok(MAFIA_CHAT_BULK_LIMIT > 0 && MAFIA_CHAT_BULK_LIMIT <= 1000);
});

test('rows without a usable received_at do not break the payload', () => {
  assert.equal(mapMafiaChatRow({id: 1}).received_at, null);
  assert.equal(mapMafiaChatRow({id: 1, received_at: 'not a date'}).received_at, null);
});

test('the messages route answers with the filtered page and its offset', async () => {
  const db = fakeDb({
    total: 1,
    rows: [
      {
        id: '7',
        sender: '@thelamb_sauce',
        message_text: 'Hi Lamb!!',
        message_timestamp: 1795636954,
        data_source: 'GuildSyncChat',
        uploaded_by: 'Evaine',
        received_at: new Date('2026-11-25T21:18:14.000Z')
      }
    ]
  });
  const app = express();
  app.use('/api/mafia/chat', createMafiaChatRouter({getDb: async () => db}));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(done => server.once('listening', done));

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/mafia/chat/messages?sort=sender&dir=asc&q=lamb&start=1&end=2`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(payload.ok, true);
    assert.equal(payload.total, 1);
    assert.equal(payload.latest, 1795636999);
    assert.equal(payload.offset, 0);
    assert.equal(payload.sort, 'sender');
    assert.equal(payload.dir, 'asc');
    assert.equal(payload.messages[0].sender, '@thelamb_sauce');
    assert.match(db.calls[0].sql, /message_timestamp >= \?/);
  } finally {
    await new Promise(done => server.close(done));
  }
});

test('the position route answers with one count per requested row', async () => {
  const db = fakeDb({beforeCount: 4});
  const app = express();
  app.use('/api/mafia/chat', createMafiaChatRouter({getDb: async () => db}));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(done => server.once('listening', done));

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/mafia/chat/position?ids=12,13&sort=sender&dir=asc`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.positions, [
      {id: '12', before: 4},
      {id: '13', before: 4}
    ]);
  } finally {
    await new Promise(done => server.close(done));
  }
});

test('the routes report bad filters and database failures separately', async () => {
  const logs = [];
  const failingDb = {
    async execute() {
      throw new Error('database is down');
    }
  };
  const app = express();
  app.use('/api/mafia/chat', createMafiaChatRouter({getDb: async () => failingDb, log: (...args) => logs.push(args)}));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(done => server.once('listening', done));

  try {
    const base = `http://127.0.0.1:${server.address().port}`;

    const invalid = await fetch(`${base}/api/mafia/chat/messages?sort=id`);
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /Unknown sort column/);

    const invalidPositions = await fetch(`${base}/api/mafia/chat/position?ids=abc`);
    assert.equal(invalidPositions.status, 400);

    const broken = await fetch(`${base}/api/mafia/chat/messages`);
    assert.equal(broken.status, 500);
    assert.deepEqual(await broken.json(), {ok: false, error: 'Could not load guild chat messages.'});
    assert.ok(logs.length >= 1);
  } finally {
    await new Promise(done => server.close(done));
  }
});
