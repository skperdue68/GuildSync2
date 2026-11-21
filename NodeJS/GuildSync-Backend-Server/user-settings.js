// Per-user preferences that belong to the GuildSync account rather than one computer.
// The SavedVariables folder is the source of authority for the desktop client, so a
// moved Documents folder or a Proton prefix follows the account instead of a local file.
export const SAVED_VARS_DIR_MAX_LENGTH = 1024;

export function normalizeSavedVarsDir(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length > SAVED_VARS_DIR_MAX_LENGTH) {
    throw Error('The SavedVariables folder path is too long.');
  }
  if (/[\x00-\x1f\x7f]/.test(text)) {
    throw Error('The SavedVariables folder path contains characters that cannot be used in a path.');
  }
  return text;
}

export async function initializeUserSettingsSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS guildsync_user_settings (
      discord_user_id VARCHAR(32) PRIMARY KEY,
      saved_vars_dir VARCHAR(${SAVED_VARS_DIR_MAX_LENGTH}) NOT NULL DEFAULT '',
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
}

export async function loadUserSettings(db, discordUserId) {
  const [rows] = await db.execute(
    'SELECT saved_vars_dir FROM guildsync_user_settings WHERE discord_user_id = ? LIMIT 1',
    [String(discordUserId)]
  );
  return { savedVarsDir: String(rows[0]?.saved_vars_dir || '') };
}

export async function saveUserSettings(db, discordUserId, input = {}) {
  const savedVarsDir = normalizeSavedVarsDir(input?.savedVarsDir);
  await db.execute(
    `INSERT INTO guildsync_user_settings (discord_user_id, saved_vars_dir) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE saved_vars_dir = VALUES(saved_vars_dir)`,
    [String(discordUserId), savedVarsDir]
  );
  return { savedVarsDir };
}

export function registerUserSettingsSocket(socket, { db, authorizeUser } = {}) {
  // The owner is always the signed-in identity; a payload cannot name another user.
  const caller = async () => {
    if (!socket.guildSyncAuthenticated || socket.guildSyncAuthType === 'discord-bot'
      || !socket.guildSyncUser?.discord_user_id) {
      throw Error('Sign in to GuildSync to change your settings.');
    }
    if (!['viewer', 'user', 'admin'].includes(socket.guildSyncUser.role)) {
      throw Error('Approved GuildSync access is required.');
    }
    const discordUserId = String(socket.guildSyncUser.discord_user_id);
    if (authorizeUser && !await authorizeUser(discordUserId, socket)) {
      throw Error('Approved GuildSync access is required.');
    }
    return discordUserId;
  };
  const handler = (event, action) => socket.on(event, async (payload = {}, callback) => {
    if (typeof payload === 'function') { callback = payload; payload = {}; }
    try {
      const discordUserId = await caller();
      const result = await action(discordUserId, payload && typeof payload === 'object' ? payload : {});
      if (typeof callback === 'function') callback({ ok: true, ...result });
    } catch (error) {
      if (typeof callback === 'function') callback({ ok: false, message: error.message });
    }
  });
  handler('guildsync:request-user-settings', async discordUserId => ({
    settings: await loadUserSettings(db, discordUserId)
  }));
  handler('guildsync:save-user-settings', async (discordUserId, payload) => ({
    settings: await saveUserSettings(db, discordUserId, payload)
  }));
}
