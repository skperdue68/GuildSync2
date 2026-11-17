import { loadEsoAccountAliases } from './eso-account-identity.js';

const TABLE = 'guildsync_trader_sales_subscriptions';
const NOTICES = 'guildsync_trader_sale_notices';

// The bot and the backend ride the same socket, so the backend stamps every
// reply with its protocol. A bot can then say plainly that it is talking to an
// older backend instead of inferring it from a missing field.
export const TRADER_SOCKET_PROTOCOL = 2;

const normalizeUserId = (value) => String(value ?? '').trim().slice(0, 32);

export async function initializeTraderSalesSubscriptions(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      discord_user_id VARCHAR(32) NOT NULL PRIMARY KEY,
      enabled TINYINT(1) NOT NULL DEFAULT 0,
      subscribed_at BIGINT UNSIGNED NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await db.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS last_dm_failed_at DATETIME DEFAULT NULL`);

  // One row per sale per recipient. The unique key is what stops a retried import
  // from DMing the same sale twice; delivered_at stays NULL until the bot takes
  // the notice, so a receipt whose bot is offline is sent when it comes back.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${NOTICES} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      discord_user_id VARCHAR(32) NOT NULL,
      guild_id VARCHAR(32) NOT NULL DEFAULT '',
      event_id BIGINT UNSIGNED NOT NULL,
      sale_json LONGTEXT NOT NULL,
      latest_entry_time BIGINT UNSIGNED NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      delivered_at DATETIME DEFAULT NULL,
      UNIQUE KEY uniq_trader_sale_notice (discord_user_id, guild_id, event_id),
      KEY idx_trader_sale_notice_delivery (delivered_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`DELETE FROM ${NOTICES} WHERE delivered_at IS NOT NULL AND delivered_at < NOW() - INTERVAL 90 DAY`);
}

export async function getLinkedEsoNames(db, discordUserId) {
  const id = normalizeUserId(discordUserId);
  if (!id) return [];

  const [rows] = await db.execute(
    `SELECT eso_account_name FROM guildsync_member_links
     WHERE discord_user_id = ? AND link_status = 'linked'
     ORDER BY eso_account_name`,
    [id]
  );

  return rows.map((row) => String(row.eso_account_name || '').trim()).filter(Boolean);
}

export async function getTraderSalesSubscription(db, discordUserId) {
  const id = normalizeUserId(discordUserId);
  const empty = { enabled: false, subscribed_at: null, dm_failed_at: null };
  if (!id) return empty;

  const [rows] = await db.execute(
    `SELECT enabled, subscribed_at, UNIX_TIMESTAMP(last_dm_failed_at) AS dm_failed_at
       FROM ${TABLE} WHERE discord_user_id = ? LIMIT 1`,
    [id]
  );

  if (!rows.length) return empty;
  return {
    enabled: Number(rows[0].enabled) === 1,
    subscribed_at: Number(rows[0].subscribed_at) || 0,
    dm_failed_at: Number(rows[0].dm_failed_at) || null
  };
}

// Remember whether the bot's last receipt DM to this user failed, so /trader
// status can tell them instead of leaving every receipt silently undelivered.
export async function setTraderDmFailure(db, discordUserId, failed) {
  const id = normalizeUserId(discordUserId);
  if (!id) return false;

  await db.execute(
    failed
      ? `UPDATE ${TABLE} SET last_dm_failed_at = NOW() WHERE discord_user_id = ?`
      : `UPDATE ${TABLE} SET last_dm_failed_at = NULL WHERE discord_user_id = ?`,
    [id]
  );

  return true;
}

export async function setTraderSalesSubscription(db, discordUserId, enabled, { now = Math.floor(Date.now() / 1000) } = {}) {
  const id = normalizeUserId(discordUserId);
  if (!id) return { ok: false, linked: false, message: 'Missing Discord user.' };

  const linkedNames = await getLinkedEsoNames(db, id);

  // Turning DMs off must work even after the link was removed.
  if (!enabled) {
    await db.execute(
      `INSERT INTO ${TABLE} (discord_user_id, enabled, subscribed_at) VALUES (?, 0, ?)
       ON DUPLICATE KEY UPDATE enabled = 0, updated_at = CURRENT_TIMESTAMP`,
      [id, now]
    );

    return {
      ok: true,
      linked: linkedNames.length > 0,
      enabled: false,
      subscribed_at: null,
      eso_account_name: linkedNames[0] || null,
      eso_account_names: linkedNames
    };
  }

  if (!linkedNames.length) {
    return { ok: false, linked: false, eso_account_names: [], message: 'No linked ESO account was found.' };
  }

  // Re-enabling keeps the first subscription time so sales announced while
  // notifications were on are not announced again.
  await db.execute(
    `INSERT INTO ${TABLE} (discord_user_id, enabled, subscribed_at) VALUES (?, 1, ?)
     ON DUPLICATE KEY UPDATE enabled = 1,
       subscribed_at = IF(enabled = 1, subscribed_at, ?),
       updated_at = CURRENT_TIMESTAMP`,
    [id, now, now]
  );

  const stored = await getTraderSalesSubscription(db, id);

  return {
    ok: true,
    linked: true,
    enabled: true,
    subscribed_at: stored.subscribed_at,
    eso_account_name: linkedNames[0],
    eso_account_names: linkedNames
  };
}

// A subscription is stored by Discord user; the linked ESO name is resolved at
// send time, so a rename or re-link never leaves a stale subscription behind.
export async function findTraderSaleSubscribers(db, seller) {
  const aliases = await loadEsoAccountAliases(db, seller);
  const keys = [...new Set(aliases
    .map((name) => String(name || '').trim().replace(/^@+/, '').toLowerCase())
    .filter(Boolean))];

  if (!keys.length) return [];

  const placeholders = keys.map(() => '?').join(',');
  const [rows] = await db.execute(
    `SELECT DISTINCT subscriptions.discord_user_id, subscriptions.subscribed_at
     FROM ${TABLE} AS subscriptions
     JOIN guildsync_member_links AS links
       ON links.discord_user_id = subscriptions.discord_user_id
      AND links.link_status = 'linked'
     WHERE subscriptions.enabled = 1
       AND LOWER(TRIM(LEADING '@' FROM links.eso_account_name)) IN (${placeholders})`,
    keys
  );

  return rows.map((row) => ({
    discord_user_id: String(row.discord_user_id || '').trim(),
    subscribed_at: Number(row.subscribed_at) || 0
  })).filter((row) => row.discord_user_id);
}

const saleTime = (entry) => Number(entry.time ?? entry.eventTimestamp ?? entry.event_timestamp) || 0;

export function saleForNotice(entry = {}) {
  return {
    eventId: Number(entry.eventId ?? entry.event_id) || 0,
    guildName: String(entry.guildName ?? entry.guild_name ?? '').trim(),
    world: String(entry.world ?? '').trim(),
    seller: String(entry.seller ?? '').trim(),
    buyer: String(entry.buyer ?? '').trim(),
    itemName: String(entry.itemName ?? entry.item_name ?? '').trim(),
    quantity: Number(entry.quantity) || 0,
    price: Number(entry.price) || 0,
    unitPrice: Number(entry.unitPrice ?? entry.unit_price) || 0,
    tax: Number(entry.tax) || 0,
    net: Number(entry.net) || 0,
    time: saleTime(entry)
  };
}

// An import is one batch of SavedVars, so each subscriber gets at most one DM
// for it: the original single-sale invoice when one sale matched, or one
// combined invoice grouped by buyer and sale time when several did. Sales that
// predate the subscription are never announced.
export function groupTraderSaleNotices(sales = [], subscribersFor = () => []) {
  const byUser = new Map();

  for (const entry of sales) {
    const subscribers = subscribersFor(entry?.seller) || [];
    if (!subscribers.length) continue;

    const sale = saleForNotice(entry);

    for (const subscriber of subscribers) {
      const subscribedAt = Number(subscriber.subscribed_at ?? subscriber.subscribedAt) || 0;
      if (subscribedAt && sale.time && sale.time < subscribedAt) continue;

      const discordUserId = String(subscriber.discord_user_id ?? subscriber.discordUserId ?? '').trim();
      if (!discordUserId) continue;

      let notice = byUser.get(discordUserId);
      if (!notice) {
        notice = { discord_user_id: discordUserId, kind: 'sale', sales: [] };
        byUser.set(discordUserId, notice);
      }
      notice.sales.push(sale);
    }
  }

  for (const notice of byUser.values()) {
    notice.sales.sort((a, b) =>
      String(a.buyer || '').localeCompare(String(b.buyer || ''), 'en', { sensitivity: 'base' }) ||
      a.time - b.time ||
      a.eventId - b.eventId
    );
    notice.kind = notice.sales.length === 1 ? 'sale' : 'invoice';
  }

  return [...byUser.values()];
}

// The newest trader sale GuildSync has stored. Every receipt carries it so the
// reader can tell how old the sales they are being shown are; the Discord bot
// turns it into the reader's own local time when it sends the message.
export async function newestTraderEntryTime(db) {
  const [rows] = await db.execute('SELECT MAX(event_timestamp) AS latest FROM guildsync_trader_entries');
  return Array.isArray(rows) ? Number(rows[0]?.latest) || 0 : 0;
}

// Record each sale against each recipient before it is sent. insert-ignore makes
// this the de-duplication point: a sale already announced to that user is not
// announced again, and the surviving rows are what a reconnect replays.
export async function announceTraderSaleNotices(db, notices = []) {
  const announced = [];

  for (const notice of notices) {
    const kept = [];
    const ids = [];

    for (const sale of notice.sales || []) {
      const [result] = await db.execute(
        `INSERT IGNORE INTO ${NOTICES} (discord_user_id, guild_id, event_id, sale_json, latest_entry_time)
         VALUES (?, ?, ?, ?, ?)`,
        [
          notice.discord_user_id,
          String(sale.guildId || ''),
          Number(sale.eventId) || 0,
          JSON.stringify(sale),
          Number(notice.latest_entry_time) || 0
        ]
      );

      if (Number(result?.affectedRows) !== 1) continue;
      kept.push(sale);
      if (Number(result.insertId)) ids.push(Number(result.insertId));
    }

    if (!kept.length) continue;
    announced.push({
      ...notice,
      sales: kept,
      kind: kept.length === 1 ? 'sale' : 'invoice',
      notice_ids: ids
    });
  }

  return announced;
}

export async function markTraderSaleNoticesDelivered(db, ids = []) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((id) => id > 0);
  if (!list.length) return 0;

  await db.execute(
    `UPDATE ${NOTICES} SET delivered_at = NOW() WHERE id IN (${list.map(() => '?').join(',')})`,
    list
  );

  return list.length;
}

// Everything the bot never took, grouped back into one notice per recipient so
// a reconnect keeps the same one-message-per-import shape.
export async function loadPendingTraderSaleNotices(db) {
  const [rows] = await db.execute(
    `SELECT id, discord_user_id, sale_json, latest_entry_time
       FROM ${NOTICES}
      WHERE delivered_at IS NULL
      ORDER BY id`
  );

  const byUser = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const userId = String(row.discord_user_id || '').trim();
    if (!userId) continue;

    let sale;
    try {
      sale = JSON.parse(row.sale_json);
    } catch {
      continue;
    }
    if (!sale) continue;

    let notice = byUser.get(userId);
    if (!notice) {
      notice = {
        discord_user_id: userId,
        sales: [],
        notice_ids: [],
        latest_entry_time: Number(row.latest_entry_time) || 0
      };
      byUser.set(userId, notice);
    }

    notice.sales.push(sale);
    notice.notice_ids.push(Number(row.id));
  }

  for (const notice of byUser.values()) {
    notice.sales.sort((a, b) =>
      String(a.buyer || '').localeCompare(String(b.buyer || ''), 'en', { sensitivity: 'base' }) ||
      a.time - b.time ||
      a.eventId - b.eventId
    );
    notice.kind = notice.sales.length === 1 ? 'sale' : 'invoice';
  }

  return [...byUser.values()];
}

export async function planTraderSaleNotices(db, sales = []) {
  const bySeller = new Map();

  for (const entry of sales) {
    const seller = String(entry?.seller ?? '').trim();
    const key = seller.toLowerCase();
    if (!seller || bySeller.has(key)) continue;
    bySeller.set(key, await findTraderSaleSubscribers(db, seller));
  }

  const notices = groupTraderSaleNotices(sales, (seller) => bySeller.get(String(seller || '').trim().toLowerCase()) || []);
  if (!notices.length) return notices;

  const latestEntryTime = await newestTraderEntryTime(db);
  for (const notice of notices) notice.latest_entry_time = latestEntryTime;

  return notices;
}

// How many matching sales /trader sales searches, and how many recent sales
// /trader receipt looks at (it only ever sends the newest one).
const SALE_SEARCH_LIMIT = 50;
const RECEIPT_SALE_LIMIT = 1;

// /trader receipt replays the newest sale already stored for the linked account
// as if it had just happened, so the DM can be checked without waiting for a
// live sale. It deliberately skips the subscription cutoff that hides sales
// older than /trader on.
const saleColumns = 'event_id, guild_name, world, seller, buyer, item_name, quantity, price, unit_price, tax, net, event_timestamp';

// Every name and rename the linked account is known by, so a sale recorded
// before a rename still matches.
async function linkedSaleKeys(db, linkedNames) {
  const keys = new Set();

  for (const name of linkedNames) {
    for (const alias of await loadEsoAccountAliases(db, name)) {
      const key = String(alias || '').trim().replace(/^@+/, '').toLowerCase();
      if (key) keys.add(key);
    }
  }

  return [...keys];
}

const escapeLike = (value) => String(value ?? '').replace(/[\\%_]/g, (char) => `\\${char}`);

export async function loadTraderSalesForReceipt(db, discordUserId, { limit = RECEIPT_SALE_LIMIT } = {}) {
  const id = normalizeUserId(discordUserId);
  if (!id) return { sales: [], names: [] };

  const linkedNames = await getLinkedEsoNames(db, id);
  if (!linkedNames.length) return { sales: [], names: [] };

  const list = await linkedSaleKeys(db, linkedNames);
  if (!list.length) return { sales: [], names: linkedNames };

  const placeholders = list.map(() => '?').join(',');
  const [rows] = await db.execute(
    `SELECT event_id, guild_name, world, seller, buyer, item_name, quantity, price, unit_price, tax, net, event_timestamp
       FROM guildsync_trader_entries
      WHERE LOWER(TRIM(LEADING '@' FROM seller)) IN (${placeholders})
         OR LOWER(TRIM(LEADING '@' FROM seller_original)) IN (${placeholders})
      ORDER BY event_timestamp DESC
      LIMIT ${Number(limit) || RECEIPT_SALE_LIMIT}`,
    [...list, ...list]
  );

  return { names: linkedNames, sales: (Array.isArray(rows) ? rows : []).map((row) => saleForNotice(row)) };
}

// /trader sales <part of an item name> returns the linked account's own sales of
// every matching item, newest first, for a receipt of that item's history.
export async function searchTraderSales(db, discordUserId, itemQuery, { limit = SALE_SEARCH_LIMIT } = {}) {
  const id = normalizeUserId(discordUserId);
  const term = String(itemQuery ?? '').trim();
  if (!id || !term) return { sales: [], names: [] };

  const linkedNames = await getLinkedEsoNames(db, id);
  if (!linkedNames.length) return { sales: [], names: [] };

  const list = await linkedSaleKeys(db, linkedNames);
  if (!list.length) return { sales: [], names: linkedNames };

  const placeholders = list.map(() => '?').join(',');
  const capped = Number(limit) || SALE_SEARCH_LIMIT;
  // One extra row tells us the list was cut off, so the reply can say so.
  const [rows] = await db.execute(
    `SELECT ${saleColumns}
       FROM guildsync_trader_entries
      WHERE (LOWER(TRIM(LEADING '@' FROM seller)) IN (${placeholders})
          OR LOWER(TRIM(LEADING '@' FROM seller_original)) IN (${placeholders}))
        AND LOWER(item_name) LIKE LOWER(?)
      ORDER BY event_timestamp DESC
      LIMIT ${capped + 1}`,
    [...list, ...list, `%${escapeLike(term)}%`]
  );

  const found = Array.isArray(rows) ? rows : [];

  return {
    names: linkedNames,
    sales: found.slice(0, capped).map((row) => saleForNotice(row)),
    truncated: found.length > capped,
    limit: capped
  };
}

export function registerTraderSalesSubscriptionSocket(socket, { db } = {}) {
  socket.on('guildsync:trader-sales-subscription', async (payload = {}, callback) => {
    // Every reply carries the protocol so the bot can report an older backend.
    const reply = (response) => {
      if (typeof callback === 'function') callback({ protocol: TRADER_SOCKET_PROTOCOL, ...response });
    };

    if (socket.guildSyncAuthType !== 'discord-bot') {
      reply({ ok: false, message: 'Discord bot authentication is required.' });
      return;
    }

    try {
      let action = String(payload?.action || '').trim().toLowerCase();

      // Bot-level actions; they are not about one member.
      if (action === 'pending') {
        reply({ ok: true, notices: await loadPendingTraderSaleNotices(db) });
        return;
      }

      if (action === 'delivered') {
        reply({ ok: true, delivered: await markTraderSaleNoticesDelivered(db, payload?.ids) });
        return;
      }

      if (action === 'dm-failed') {
        reply({ ok: true, stored: await setTraderDmFailure(db, payload?.discord_user_id, Boolean(payload?.failed)) });
        return;
      }

      const discordUserId = normalizeUserId(payload?.discord_user_id);

      if (!discordUserId) {
        reply({ ok: false, message: 'Missing Discord user.' });
        return;
      }

      if (action === 'status') {
        const linked = await getLinkedEsoNames(db, discordUserId);
        reply({
          ok: true,
          linked: linked.length > 0,
          eso_account_name: linked[0] || null,
          ...(await getTraderSalesSubscription(db, discordUserId))
        });
        return;
      }

      if (action === 'sales') {
        const item = String(payload?.item || '').trim();
        if (!item) {
          reply({ ok: false, message: 'Include part of an item name.' });
          return;
        }

        const { sales, names, truncated, limit } = await searchTraderSales(db, discordUserId, item);
        if (!names.length) {
          reply({ ok: false, linked: false });
          return;
        }

        reply({
          ok: true,
          linked: true,
          eso_account_name: names[0],
          item,
          sales,
          truncated,
          limit,
          latest_entry_time: await newestTraderEntryTime(db)
        });
        return;
      }

      if (action === 'receipt') {
        const { sales, names } = await loadTraderSalesForReceipt(db, discordUserId);
        if (!names.length) {
          reply({ ok: false, linked: false });
          return;
        }

        const sale = sales[0];
        if (!sale) {
          reply({
            ok: false,
            linked: true,
            eso_account_name: names[0],
            message: 'No trader sales are stored for your linked ESO account yet.'
          });
          return;
        }

        // /trader receipt DMs the newest sale through the same notice path a live
        // sale takes, so it arrives looking like it just happened. It is a
        // replay, not an announcement, so it skips the announced-sales table.
        const notice = {
          discord_user_id: discordUserId,
          kind: 'sale',
          sales: [sale],
          latest_entry_time: await newestTraderEntryTime(db)
        };
        socket.emit('guildsync:trader-sale-notice', notice);

        reply({
          ok: true,
          linked: true,
          eso_account_name: names[0],
          sales: [sale],
          latest_entry_time: notice.latest_entry_time
        });
        return;
      }

      // /trader register and /trader unregister are aliases for on and off.
      if (action === 'register') action = 'on';
      if (action === 'unregister') action = 'off';

      if (action !== 'on' && action !== 'off') {
        reply({ ok: false, message: 'Use /trader on (or /trader register) or /trader off (or /trader unregister).' });
        return;
      }

      reply(await setTraderSalesSubscription(db, discordUserId, action === 'on'));
    } catch (error) {
      reply({ ok: false, message: error.message || 'Could not update trader sale notifications.' });
    }
  });
}
