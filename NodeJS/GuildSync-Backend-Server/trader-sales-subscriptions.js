import { loadEsoAccountAliases } from './eso-account-identity.js';

const TABLE = 'guildsync_trader_sales_subscriptions';

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
  if (!id) return { enabled: false, subscribed_at: null };

  const [rows] = await db.execute(
    `SELECT enabled, subscribed_at FROM ${TABLE} WHERE discord_user_id = ? LIMIT 1`,
    [id]
  );

  if (!rows.length) return { enabled: false, subscribed_at: null };
  return { enabled: Number(rows[0].enabled) === 1, subscribed_at: Number(rows[0].subscribed_at) || 0 };
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

export async function planTraderSaleNotices(db, sales = []) {
  const bySeller = new Map();

  for (const entry of sales) {
    const seller = String(entry?.seller ?? '').trim();
    const key = seller.toLowerCase();
    if (!seller || bySeller.has(key)) continue;
    bySeller.set(key, await findTraderSaleSubscribers(db, seller));
  }

  return groupTraderSaleNotices(sales, (seller) => bySeller.get(String(seller || '').trim().toLowerCase()) || []);
}

export function registerTraderSalesSubscriptionSocket(socket, { db } = {}) {
  socket.on('guildsync:trader-sales-subscription', async (payload = {}, callback) => {
    const reply = (response) => {
      if (typeof callback === 'function') callback(response);
    };

    if (socket.guildSyncAuthType !== 'discord-bot') {
      reply({ ok: false, message: 'Discord bot authentication is required.' });
      return;
    }

    try {
      const action = String(payload?.action || '').trim().toLowerCase();
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

      if (action !== 'on' && action !== 'off') {
        reply({ ok: false, message: 'Use /sales on or /sales off.' });
        return;
      }

      reply(await setTraderSalesSubscription(db, discordUserId, action === 'on'));
    } catch (error) {
      reply({ ok: false, message: error.message || 'Could not update trader sale notifications.' });
    }
  });
}
