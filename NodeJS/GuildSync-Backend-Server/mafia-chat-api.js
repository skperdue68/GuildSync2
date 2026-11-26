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

// The live update event the mafia page listens for. It carries the stored rows
// themselves so the page can place each one without reloading.
export const MAFIA_CHAT_UPDATED_EVENT = 'chat-updated';

// A first upload can insert thousands of rows at once. Above this many, the
// socket only announces the count and every open page reloads on request
// instead of receiving the whole batch.
export const MAFIA_CHAT_BULK_LIMIT = 100;

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;
const MAX_SEARCH_LENGTH = 200;
const MAX_POSITION_IDS = 50;
const ID_PATTERN = /^\d{1,15}$/;
const LIKE_ESCAPE_PATTERN = /([\\%_])/g;

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function parseBoundary(value, label) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  if (ID_PATTERN.test(raw)) return Number(raw);

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw badRequest(`The ${label} of the range is not a valid date.`);
  }

  return Math.floor(parsed / 1000);
}

function parseOptionalId(value, label) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!ID_PATTERN.test(raw)) throw badRequest(`The ${label} message id is not valid.`);
  return Number(raw);
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
    focus: parseOptionalId(query.focus, 'focus'),
    limit: clampInteger(query.limit, DEFAULT_LIMIT, MAX_LIMIT),
    offset: clampInteger(query.offset, 0, Number.MAX_SAFE_INTEGER)
  };
}

// A literal search: '%' and '_' typed by the reader must match themselves, so
// they are escaped and the query names the escape character explicitly. Only
// the message body is searched, so a sender or uploader name does not bury the
// lines the reader is looking for.
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
    clauses.push("(message_text LIKE ? ESCAPE '\\\\')");
    params.push(pattern);
  }

  return {clause: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params};
}

// Rows that sort before the given value/id pair, using the database collation
// for text columns so a live insert lands exactly where a reload would put it.
function comparisonClause(column, dirSQL) {
  const operator = dirSQL === 'ASC' ? '<' : '>';
  return `(${column} ${operator} ? OR (${column} = ? AND id ${operator} ?))`;
}

async function countRowsBefore(db, options, sortValue, id) {
  const {clause, params} = buildMafiaChatWhere(options);
  const comparison = comparisonClause(options.column, options.dirSQL);
  const where = clause ? `${clause} AND ${comparison}` : `WHERE ${comparison}`;

  const [rows] = await db.execute(
    `SELECT COUNT(*) AS before_count FROM guildsync_guild_chat_messages ${where}`,
    [...params, sortValue, sortValue, id]
  );

  return Number(rows?.[0]?.before_count ?? 0);
}

async function findSortValue(db, column, id) {
  const [rows] = await db.execute(
    `SELECT ${column} AS sort_value FROM guildsync_guild_chat_messages WHERE id = ?`,
    [id]
  );

  const row = Array.isArray(rows) ? rows[0] : null;
  return row && row.sort_value != null ? {sortValue: row.sort_value} : null;
}

function toIsoString(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function mapMafiaChatRow(row = {}) {
  return {
    id: String(row.id ?? ''),
    // Officer chat is the same guild's private channel; the page marks those
    // rows so a reader can tell the two conversations apart.
    channel: String(row.channel ?? '').trim().toLowerCase() === 'officer' ? 'officer' : 'guild',
    sender: String(row.sender ?? ''),
    message_text: String(row.message_text ?? ''),
    message_timestamp: Number(row.message_timestamp ?? 0),
    data_source: String(row.data_source ?? ''),
    uploaded_by: String(row.uploaded_by ?? ''),
    received_at: toIsoString(row.received_at)
  };
}

// Where each pushed row belongs in the current sort, as a count of the matching
// rows that come before it. The page turns that into an index in its own window.
export async function resolveMafiaChatPositions(db, options, ids) {
  const positions = [];

  for (const id of ids) {
    const found = await findSortValue(db, options.column, id);

    if (!found) {
      positions.push({id: String(id), before: null});
      continue;
    }

    positions.push({id: String(id), before: await countRowsBefore(db, options, found.sortValue, id)});
  }

  return positions;
}

export function parseMafiaChatPositionQuery(query = {}) {
  const options = parseMafiaChatQuery(query);
  const ids = String(query.ids ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  if (ids.length === 0 || ids.length > MAX_POSITION_IDS) {
    throw badRequest(`Provide between 1 and ${MAX_POSITION_IDS} message ids.`);
  }

  for (const id of ids) {
    if (!ID_PATTERN.test(id)) throw badRequest(`Unknown message id: ${id}.`);
  }

  return {options, ids: ids.map(Number)};
}

// One page of rows plus the totals for the same filters, so the page can say
// how many messages exist without asking for all of them. A focus id lands the
// page on the message itself, wherever it sorts.
export async function queryMafiaChatMessages(db, options) {
  const {clause, params} = buildMafiaChatWhere(options);

  const [countRows] = await db.execute(
    `SELECT COUNT(*) AS total FROM guildsync_guild_chat_messages ${clause}`,
    params
  );
  const total = Number(countRows?.[0]?.total ?? 0);

  // Newest message stored overall, not just the filtered page, so the page can
  // say how current the archive is even while a range is applied.
  const [latestRows] = await db.execute(
    'SELECT MAX(message_timestamp) AS latest FROM guildsync_guild_chat_messages'
  );
  const latestSeconds = Number(latestRows?.[0]?.latest ?? 0);
  const latest = Number.isFinite(latestSeconds) && latestSeconds > 0 ? latestSeconds : null;

  let offset = options.offset;

  if (options.focus != null) {
    const focused = await findSortValue(db, options.column, options.focus);
    if (focused) offset = await countRowsBefore(db, options, focused.sortValue, options.focus);
  }

  const [rows] = await db.execute(
    `SELECT id, channel, sender, message_text, message_timestamp, data_source, uploaded_by, received_at
     FROM guildsync_guild_chat_messages
     ${clause}
     ORDER BY ${options.column} ${options.dirSQL}, id ${options.dirSQL}
     LIMIT ? OFFSET ?`,
    [...params, options.limit, offset]
  );

  return {total, latest, offset, messages: (Array.isArray(rows) ? rows : []).map(mapMafiaChatRow)};
}

export function createMafiaChatRouter({getDb, log = () => {}} = {}) {
  const router = express.Router();

  async function answer(res, work) {
    try {
      const payload = await work();
      res.set('Cache-Control', 'no-store');
      res.json({ok: true, ...payload});
    } catch (error) {
      const status = Number(error?.status) === 400 ? 400 : 500;
      if (status === 500) log('Mafia guild chat query failed:', error);

      res.status(status).json({
        ok: false,
        error: status === 500 ? 'Could not load guild chat messages.' : error.message
      });
    }
  }

  router.get('/messages', (req, res) => answer(res, async () => {
    const options = parseMafiaChatQuery(req.query || {});
    const db = await getDb();
    const {total, latest, offset, messages} = await queryMafiaChatMessages(db, options);

    return {
      total,
      latest,
      offset,
      limit: options.limit,
      sort: options.sort,
      dir: options.dir,
      messages
    };
  }));

  router.get('/position', (req, res) => answer(res, async () => {
    const {options, ids} = parseMafiaChatPositionQuery(req.query || {});
    const db = await getDb();
    const positions = await resolveMafiaChatPositions(db, options, ids);

    return {sort: options.sort, dir: options.dir, positions};
  }));

  return router;
}
