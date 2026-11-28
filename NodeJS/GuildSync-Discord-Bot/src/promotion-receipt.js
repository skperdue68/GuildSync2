import { EmbedBuilder } from 'discord.js';

const colors = { sent: 0x57f287, skipped: 0xfee75c, uncertain: 0xfee75c, failed: 0xed4245 };
const titles = {
  sent: 'Soldier promotion sent',
  skipped: 'Soldier promotion skipped',
  uncertain: 'Soldier promotion needs review',
  failed: 'Soldier promotion failed'
};
const descriptions = {
  sent: (id) => `<@${id}> is now a Soldier and was sent the reminder DM.`,
  skipped: (id) => `<@${id}> was not promoted.`,
  uncertain: (id) => `The reminder DM to <@${id}> was not confirmed, but the role change was applied.`,
  failed: (id, roleChanged) => roleChanged
    ? `<@${id}> was promoted, but the reminder DM was not sent.`
    : `<@${id}> was not promoted.`
};

const joinedDate = (value) => {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? `<t:${Math.floor(time / 1000)}:d>` : null;
};

// The officer who queued a promotion gets this in their DMs when the queue
// reaches it, so a delayed promotion does not go unnoticed.
export function promotionReceiptMessage({
  userId,
  name = '',
  joinedAt = null,
  status = 'sent',
  detail = '',
  removed = [],
  added = '',
  roleChanged = false,
  at = Date.now()
} = {}) {
  const tone = colors[status] ? status : 'failed';
  const failedAfterRoles = tone === 'failed' && roleChanged;
  const embed = new EmbedBuilder()
    .setColor(colors[tone])
    .setTitle(failedAfterRoles ? 'Promotion applied, reminder not sent' : titles[tone])
    .setDescription(descriptions[tone](userId, roleChanged))
    .addFields(
      { name: 'Member', value: `${name ? `${name}\n` : ''}ID: ${userId}`, inline: false },
      { name: 'Removed', value: removed.length ? removed.join(', ') : 'None', inline: true },
      { name: 'Added', value: added || 'None', inline: true }
    );

  const since = joinedDate(joinedAt);
  if (since) embed.addFields({ name: 'In server since', value: since, inline: true });
  if (detail) embed.addFields({ name: 'Outcome', value: String(detail).slice(0, 1024), inline: false });

  return { embeds: [embed.setFooter({ text: 'GuildSync' }).setTimestamp(new Date(at))], allowedMentions: { parse: [] } };
}
