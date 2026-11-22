import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits } from 'discord.js';
import { requestCommunityHighlights, formatCommunityHighlights } from './community-highlights.js';

// One week between digests unless the guild chooses otherwise.
export const DEFAULT_HIGHLIGHTS_INTERVAL_HOURS = 7 * 24;

// A digest is due once the configured interval has passed since the last successful post.
export function highlightsDigestDue({ lastPostedAt = 0, now = Date.now(), intervalHours = DEFAULT_HIGHLIGHTS_INTERVAL_HOURS } = {}) {
  const interval = Number(intervalHours);
  if (!Number.isFinite(interval) || interval <= 0) return false;
  return Number(now) - Number(lastPostedAt || 0) >= interval * 3600 * 1000;
}

// Opt-in: nothing runs until a channel is configured. The digest posts the viewer-safe
// report, so it never contains gold totals, and it records the post time so a restart
// does not repeat a digest that already went out.
export function startCommunityHighlightsAnnouncements(client, socket, log = console.warn, env = process.env) {
  const channelId = String(env.GUILDSYNC_HIGHLIGHTS_CHANNEL_ID || '').trim();
  if (!channelId || String(env.GUILDSYNC_HIGHLIGHTS_ENABLED || 'true').toLowerCase() === 'false') return async () => {};
  const botRoot = fileURLToPath(new URL('../', import.meta.url));
  const statePath = path.resolve(botRoot, env.GUILDSYNC_HIGHLIGHTS_STATE_FILE || 'data/community-highlights.json');
  const intervalHours = Number(env.GUILDSYNC_HIGHLIGHTS_INTERVAL_HOURS || DEFAULT_HIGHLIGHTS_INTERVAL_HOURS);
  let state = { channelId, lastPostedAt: 0 };
  let running = false, stopped = false;

  const loadState = async () => {
    try {
      const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
      if (saved && Number.isFinite(Number(saved.lastPostedAt))) state = { channelId, lastPostedAt: Number(saved.lastPostedAt) };
    } catch (error) {
      if (error.code !== 'ENOENT') log(`Community highlights digest state could not be read: ${error.message}`);
    }
  };
  const saveState = async () => {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(`${statePath}.tmp`, statePath);
  };
  const post = async () => {
    if (stopped || running || !client.isReady() || !socket.connected) return;
    if (!highlightsDigestDue({ lastPostedAt: state.lastPostedAt, now: Date.now(), intervalHours })) return;
    running = true;
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased() || typeof channel.send !== 'function'
        || (env.DISCORD_GUILD_ID && channel.guildId !== env.DISCORD_GUILD_ID)
        || !channel.permissionsFor(client.user)?.has(PermissionFlagsBits.SendMessages)) {
        throw new Error('GUILDSYNC_HIGHLIGHTS_CHANNEL_ID must be a writable text channel in the configured server.');
      }
      const report = await requestCommunityHighlights(socket);
      await channel.send({ content: formatCommunityHighlights(report), allowedMentions: { parse: [] } });
      state.lastPostedAt = Date.now();
      await saveState();
    } catch (error) {
      log(`Community highlights digest failed: ${error.message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(post, 15 * 60 * 1000);
  timer.unref();
  socket.on('connect', post);
  void loadState().then(post);
  return async () => {
    stopped = true;
    clearInterval(timer);
    socket.off('connect', post);
  };
}
