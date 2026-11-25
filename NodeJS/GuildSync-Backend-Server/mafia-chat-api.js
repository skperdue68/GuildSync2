import express from 'express';

// The mafia.perdues.me site is a read-only view over the guild chat rows the
// desktop client uploads. Sorting is restricted to a whitelist because the
// column name is interpolated into the query; everything else is a parameter.
export const MAFIA_CHAT_SORT_COLUMNS = Object.freeze({
  time: 'message_timestamp',
  sender: 'sender',
  message: 'message_text',
  source: 'data_source',
  uploaded_by: 'uploaded_by',
  received: 'received_at'
});

// The live update event the mafia page listens for. It only says that new rows
// exist; the page fetches on its own when the reader asks it to.
export const MAFIA_CHAT_UPDATED_EVENT = 'chat-updated';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;
const MAX_SEARCH_LENGTH = 200;
const LIKE_ESCAPE_PATTERN = /([\\%_])/g;

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function parseBoundary(value, label) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  if (/^\d{1,15}$/.test(raw)) return Number(raw);

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw badRequest(`The ${label} of the range is not a valid date.`);
  }

  return Math.floor(parsed / 1000);
}

function clampInteger(value, fallback, maximum) {
  const number = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(number, maximum);
}

export function parseMafiaChatQuery(query = {}) {
  const sort = String(query.sort ?? '').trim().toLowerCase() || 'time';
  if (!Object.hasOwn(MAFIA_CHAT_SORT_COLUMNS, sort)) {
    throw badRequest(`Unknown sort column: ${sort}.`);
  }

  const dir = String(query.dir ?? '').trim().toLowerCase() || 'desc';
  if (dir !== 'asc' && dir !== 'desc') {
    throw badRequest('Sort direction must be asc or desc.');
  }

  const search = String(query.q ?? '').trim().slice(0, MAX_SEARCH_LENGTH);
  const start = parseBoundary(query.start, 'start');
  const end = parseBoundary(query.end, 'end');

  if (start != null && end != null && start > end) {
    throw badRequest('The start of the range must be before the end.');
  }

  return {
    sort,
    column: MAFIA_CHAT_SORT_COLUMNS[sort],
    dir,
    dirSQL: dir.toUpperCase(),
    search,
    start,
    end,
    limit: clampInteger(query.limit, DEFAULT_LIMIT, MAX_LIMIT),
    offset: clampInteger(query.offset, 0, Number.MAX_SAFE_INTEGER)
  };
}

// A literal search: '%' and '_' typed by the reader must match themselves, so
// they are escaped and the query names the escape character explicitly.
export function buildMafiaChatWhere(options = {}) {
  const clauses = [];
  const params = [];

  if (options.start != null) {
    clauses.push('message_timestamp >= ?');
    params.push(options.start);
  }

  if (options.end != null) {
    clauses.push('message_timestamp <= ?');
    params.push(options.end);
  }

  if (options.search) {
    const pattern = `%${String(options.search).replace(LIKE_ESCAPE_PATTERN, '\\$1')}%`;
    clauses.push(
      "(sender LIKE ? ESCAPE '\\\\' OR message_text LIKE ? ESCAPE '\\\\'" +
        " OR uploaded_by LIKE ? ESCAPE '\\\\' OR data_source LIKE ? ESCAPE '\\\\')"
    );
    params.push(pattern, pattern, pattern, pattern);
  }

  return {clause: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params};
}

function toIsoString(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function mapMafiaChatRow(row = {}) {
  return {
    id: String(row.id ?? ''),
    sender: String(row.sender ?? ''),
    message_text: String(row.message_text ?? ''),
    message_timestamp: Number(row.message_timestamp ?? 0),
    data_source: String(row.data_source ?? ''),
    uploaded_by: String(row.uploaded_by ?? ''),
    received_at: toIsoString(row.received_at)
  };
}

// One page of rows plus the total for the same filters, so the page can say
// how many messages exist without asking for all of them.
export async function queryMafiaChatMessages(db, options) {
  const {clause, params} = buildMafiaChatWhere(options);

  const [countRows] = await db.execute(
    `SELECT COUNT(*) AS total FROM guildsync_guild_chat_messages ${clause}`,
    params
  );
  const total = Number(countRows?.[0]?.total ?? 0);

  const [rows] = await db.execute(
    `SELECT id, sender, message_text, message_timestamp, data_source, uploaded_by, received_at
     FROM guildsync_guild_chat_messages
     ${clause}
     ORDER BY ${options.column} ${options.dirSQL}, id ${options.dirSQL}
     LIMIT ? OFFSET ?`,
    [...params, options.limit, options.offset]
  );

  return {total, messages: (Array.isArray(rows) ? rows : []).map(mapMafiaChatRow)};
}

export function createMafiaChatRouter({getDb, log = () => {}} = {}) {
  const router = express.Router();

  router.get('/messages', async (req, res) => {
    try {
      const options = parseMafiaChatQuery(req.query || {});
      const db = await getDb();
      const {total, messages} = await queryMafiaChatMessages(db, options);

      res.set('Cache-Control', 'no-store');
      res.json({
        ok: true,
        total,
        limit: options.limit,
        offset: options.offset,
        sort: options.sort,
        dir: options.dir,
        messages
      });
    } catch (error) {
      const status = Number(error?.status) === 400 ? 400 : 500;
      if (status === 500) log('Mafia guild chat query failed:', error);

      res.status(status).json({
        ok: false,
        error: status === 500 ? 'Could not load guild chat messages.' : error.message
      });
    }
  });

  return router;
}
