import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { Log } from '../helper.js';

export const LINK_REQUIRED_MESSAGE = [
  'I cannot send trader sale DMs until your Discord account is linked to an ESO account.',
  '',
  '1. Set your Discord username to match your @ESO name so GuildSync can link it automatically.',
  '2. Create the link in GuildSync if you can, or ask an officer to link it for you.',
  '3. If you cannot create the link, or you believe it is already linked, contact @evainefaye for help.'
].join('\n');

export const data = new SlashCommandBuilder()
  .setName('sales')
  .setDescription('Get a Discord DM for each of your GuildSync trader sales.')
  .addSubcommand((subcommand) => subcommand
    .setName('on')
    .setDescription('Send me a DM for each of my trader sales.'))
  .addSubcommand((subcommand) => subcommand
    .setName('off')
    .setDescription('Stop sending me trader sale DMs.'))
  .setDMPermission(true);

function request(socket, payload) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      reject(new Error('GuildSync is temporarily unavailable. Please try again.'));
      return;
    }

    socket.timeout(15000).emit('guildsync:trader-sales-subscription', payload, (error, response) => {
      if (error) {
        reject(new Error('GuildSync did not respond. Please try again.'));
        return;
      }
      resolve(response || { ok: false, message: 'GuildSync did not return a response.' });
    });
  });
}

export async function execute(interaction, guildSyncSocket, log = Log) {
  const action = interaction.options.getSubcommand(true);

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    const response = await request(guildSyncSocket, {
      discord_user_id: interaction.user?.id,
      action
    });

    if (!response?.ok) {
      const content = response?.linked === false
        ? LINK_REQUIRED_MESSAGE
        : response?.message || 'Could not update trader sale DMs.';
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
      return;
    }

    const account = response.eso_account_name ? ` for ${response.eso_account_name}` : '';
    await interaction.editReply({
      content: action === 'on'
        ? `You are subscribed${account}. I will DM you when one of your trader sales comes in.`
        : `Trader sale DMs are off${account}. Use /sales on to turn them back on.`,
      allowedMentions: { parse: [] }
    });

    log(`Trader sale DMs ${action} for Discord user ${interaction.user?.id || 'unknown'}.`);
  } catch (error) {
    await interaction.editReply({
      content: error.message || 'Could not update trader sale DMs.',
      allowedMentions: { parse: [] }
    });
  }
}
