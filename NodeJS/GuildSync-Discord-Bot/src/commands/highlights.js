import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requestCommunityHighlights, formatCommunityHighlights } from '../community-highlights.js';
import { Log } from '../helper.js';

export const data = new SlashCommandBuilder()
  .setName('highlights')
  .setDescription('Show Community Highlights: raffle regulars, trader leaders, and Discord activity.')
  .addBooleanOption(option => option.setName('public').setDescription('Show the response publicly instead of privately.'))
  .setDMPermission(false);

export async function execute(interaction, guildSyncSocket, log = Log) {
  if (!interaction.guildId || (process.env.DISCORD_GUILD_ID && interaction.guildId !== process.env.DISCORD_GUILD_ID)) {
    await interaction.reply({ content: 'Use this command in the configured GuildSync server.', flags: MessageFlags.Ephemeral });
    return;
  }
  const isPublic = interaction.options?.getBoolean?.('public') === true;
  const flags = isPublic ? undefined : MessageFlags.Ephemeral;
  await interaction.deferReply(flags ? { flags } : {});
  try {
    // The bot has no member identity, so the report is read-only and never includes gold.
    const report = await requestCommunityHighlights(guildSyncSocket);
    await interaction.editReply({ content: formatCommunityHighlights(report), allowedMentions: { parse: [] } });
  } catch (error) {
    log(`Community highlights failed: ${error.message}`);
    await interaction.editReply({ content: error.message, allowedMentions: { parse: [] } });
  }
}
