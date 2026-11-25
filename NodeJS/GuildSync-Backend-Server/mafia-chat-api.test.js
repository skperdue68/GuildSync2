import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  MAFIA_CHAT_SORT_COLUMNS,
  buildMafiaChatWhere,
  createMafiaChatRouter,
  mapMafiaChatRow,
  parseMafiaChatQuery,
  queryMafiaChatMessages
} from './mafia-chat-api.js';

function fakeDb({rows = [], total = 0} = {}) {
  const calls = [];
  return {
    calls,
    async execute(sql, params = []) {
      calls.push({sql: sql.replace(/\s+/g, ' ').trim(), params});
      if (/COUNT\(\*\)/.test(sql)) return [[{total}], []];
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
});

test('every sortable column is whitelisted and unknown input is rejected', () => {
  for (const key of Object.keys(MAFIA_CHAT_SORT_COLUMNS)) {
    assert.equal(parseMafiaChatQuery({sort: key}).column, MAFIA_CHAT_SORT_COLUMNS[key]);
  }

  assert.throws(() => parseMafiaChatQuery({sort: 'message_hash'}), /Unknown sort column/);
  assert.throws(() => parseMafiaChatQuery({sort: 'id; DROP TABLE x'}), /Unknown sort column/);
  assert.throws(() => parseMafiaChatQuery({dir: 'sideways'}), /asc or desc/);
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
  assert.deepEqual(where.params.slice(2), [expectedPattern, expectedPattern, expectedPattern, expectedPattern]);
  assert.match(where.clause, /ESCAPE '\\\\'/);
  assert.match(where.clause, /sender LIKE \?/);
  assert.match(where.clause, /uploaded_by LIKE \?/);
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
  const {total, messages} = await queryMafiaChatMessages(db, options);

  assert.equal(total, 3);
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

  const select = db.calls.at(-1);
  assert.match(select.sql, /ORDER BY sender ASC, id ASC/);
  assert.match(select.sql, /LIMIT \? OFFSET \?/);
  assert.deepEqual(select.params.slice(-2), [500, 0]);
});

test('rows without a usable received_at do not break the payload', () => {
  assert.equal(mapMafiaChatRow({id: 1}).received_at, null);
  assert.equal(mapMafiaChatRow({id: 1, received_at: 'not a date'}).received_at, null);
});

test('the messages route answers with the filtered page', async () => {
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
    assert.equal(payload.sort, 'sender');
    assert.equal(payload.dir, 'asc');
    assert.equal(payload.messages[0].sender, '@thelamb_sauce');
    assert.match(db.calls[0].sql, /message_timestamp >= \?/);
    assert.match(db.calls.at(-1).sql, /ORDER BY sender ASC/);
  } finally {
    await new Promise(done => server.close(done));
  }
});

test('the messages route reports bad filters and database failures separately', async () => {
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

    const broken = await fetch(`${base}/api/mafia/chat/messages`);
    assert.equal(broken.status, 500);
    assert.deepEqual(await broken.json(), {ok: false, error: 'Could not load guild chat messages.'});
    assert.equal(logs.length, 1);
  } finally {
    await new Promise(done => server.close(done));
  }
});
