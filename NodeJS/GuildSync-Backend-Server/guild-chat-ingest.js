import crypto from 'node:crypto';

// One row per unique guild chat message. message_hash is the normalized
// guild/sender/text composite; the ±30 second window is enforced by the
// ingester, not a unique key, so a repeated message sent later is still stored.
export const GUILD_CHAT_SCHEMA = `CREATE TABLE IF NOT EXISTS guildsync_guild_chat_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_hash CHAR(64) NOT NULL,
  guild VARCHAR(64) NOT NULL,
  sender VARCHAR(255) NOT NULL,
  message_text TEXT NOT NULL,
  message_timestamp BIGINT NOT NULL,
  event_datetime DATETIME NOT NULL,
  data_source VARCHAR(255) NOT NULL DEFAULT '',
  uploaded_by VARCHAR(255) NOT NULL DEFAULT '',
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_guildsync_chat_hash_timestamp (message_hash, message_timestamp),
  INDEX idx_guildsync_chat_guild_timestamp (guild, message_timestamp)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`;

const DEDUPE_WINDOW_SECONDS = 30;

export function normalizeGuildChatSender(value) {
  return Array.from(String(value ?? '').trim().toLowerCase()).slice(0, 255).join('');
}

// ESO chat text can carry color codes and item/achievement links. Links become
// their visible label so two reporters of the same line hash identically.
export function normalizeGuildChatText(value) {
  let text = String(value ?? '');

  text = text.replace(/\|c[0-9a-fA-F]{6}/g, '');
  text = text.replace(/\|r/g, '');
  text = text.replace(/\|H[^|]*\|h([^|]*)\|h/g, (_match, label) => {
    const visible = String(label || '').trim();
    if (!visible) return '';
    // ESO item links usually carry the brackets in the label already.
    return visible.startsWith('[') && visible.endsWith(']') ? visible : `[${visible}]`;
  });
  text = text.replace(/\|t[^|]*\|t/g, '');

  return text.replace(/\s+/g, ' ').trim();
}

// The guild key is stable for the installation: the configured ESO guild ID
// when present, otherwise the configured guild name.
export function guildChatGuildKey(payload = {}, env = process.env) {
  const guildId = String(payload.guildId || payload.guild_id || env.GUILDSYNC_ESO_GUILD_ID || '').trim();
  if (guildId) return guildId.slice(0, 64);

  const guildName = String(payload.guildName || payload.guild_name || env.GUILDSYNC_ESO_GUILD_NAME || 'guild').trim().toLowerCase();
  return (guildName || 'guild').slice(0, 64);
}

export function guildChatMessageHash({ guild, sender, text }) {
  return crypto
    .createHash('sha256')
    .update(`${guild}:${normalizeGuildChatSender(sender)}:${normalizeGuildChatText(text)}`)
    .digest('hex');
}

export async function ensureGuildChatSchema(db) {
  await db.query(GUILD_CHAT_SCHEMA);
}

// Looks up and inserts every report inside one transaction, so two clients
// uploading at the same second cannot both pass the duplicate check.
export async function ingestGuildChatMessages(db, payload = {}) {
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];

  if (entries.length > 0) {
    await ensureGuildChatSchema(db);
  }

  const guild = guildChatGuildKey(payload);
  const uploadedBy = Array.from(String(payload?.uploadedBy || '').trim()).slice(0, 255).join('');
  const dataSource = Array.from(String(payload?.source || 'GuildSyncChat').trim()).slice(0, 255).join('');

  const result = {
    guild,
    chat_messages_received: entries.length,
    chat_messages_inserted: 0,
    chat_messages_duplicates: 0,
    chat_messages_skipped: 0,
    // Ids of the rows this report created, so the live site can be handed the
    // exact records instead of re-reading the table.
    inserted_ids: []
  };

  if (entries.length === 0) {
    return result;
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    for (const entry of entries) {
      const sender = normalizeGuildChatSender(entry?.sender);
      const text = normalizeGuildChatText(entry?.text);
      const timestamp = Number(entry?.timestamp ?? entry?.time);

      if (!sender || !text || !Number.isFinite(timestamp) || timestamp <= 0) {
        result.chat_messages_skipped += 1;
        continue;
      }

      const messageTimestamp = Math.floor(timestamp);
      const messageHash = guildChatMessageHash({ guild, sender, text });

      const [existingRows] = await connection.execute(
        `SELECT id FROM guildsync_guild_chat_messages
         WHERE message_hash = ?
           AND message_timestamp BETWEEN ? AND ?
         LIMIT 1
         FOR UPDATE`,
        [messageHash, messageTimestamp - DEDUPE_WINDOW_SECONDS, messageTimestamp + DEDUPE_WINDOW_SECONDS]
      );

      if (Array.isArray(existingRows) && existingRows.length > 0) {
        result.chat_messages_duplicates += 1;
        continue;
      }

      const [insertResult] = await connection.execute(
        `INSERT INTO guildsync_guild_chat_messages (
          message_hash,
          guild,
          sender,
          message_text,
          message_timestamp,
          event_datetime,
          data_source,
          uploaded_by
        )
        VALUES (?, ?, ?, ?, ?, FROM_UNIXTIME(?), ?, ?)`,
        [messageHash, guild, sender, text, messageTimestamp, messageTimestamp, dataSource, uploadedBy]
      );

      result.chat_messages_inserted += 1;
      if (Number(insertResult?.insertId) > 0) result.inserted_ids.push(Number(insertResult.insertId));
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return result;
}
