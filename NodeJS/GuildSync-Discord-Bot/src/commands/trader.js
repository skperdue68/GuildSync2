import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { Log } from '../helper.js';

export const LINK_REQUIRED_MESSAGE = [
  'I cannot send trader sale invoices until your Discord account is linked to an ESO account.',
  '',
  '1. Set your Discord username to match your @ESO name so GuildSync can link it automatically.',
  '2. Create the link in GuildSync if you can, or ask an officer to link it for you.',
  '3. If you cannot create the link, or you believe it is already linked, contact @evainefaye for help.'
].join('\n');

export const data = new SlashCommandBuilder()
  .setName('trader')
  .setDescription('Get a Discord invoice for each of your GuildSync trader sales.')
  .addSubcommand((subcommand) => subcommand
    .setName('on')
    .setDescription('Send me an invoice for each of my trader sales.'))
  .addSubcommand((subcommand) => subcommand
    .setName('register')
    .setDescription('Same as /trader on: register me for trader sale invoices.'))
  .addSubcommand((subcommand) => subcommand
    .setName('off')
    .setDescription('Stop sending me trader sale invoices.'))
  .addSubcommand((subcommand) => subcommand
    .setName('unregister')
    .setDescription('Same as /trader off: stop sending me trader sale invoices.'))
  .setDMPermission(true);

// register/unregister are aliases so either wording works.
const ACTION_BY_OPTION = { on: 'on', register: 'on', off: 'off', unregister: 'off' };

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
  const option = interaction.options.getSubcommand(true);
  const action = ACTION_BY_OPTION[option];

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    const response = await request(guildSyncSocket, {
      discord_user_id: interaction.user?.id,
      action
    });

    if (!response?.ok) {
      const content = response?.linked === false
        ? LINK_REQUIRED_MESSAGE
        : response?.message || 'Could not update trader sale invoices.';
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
      return;
    }

    const account = response.eso_account_name ? ` for ${response.eso_account_name}` : '';
    await interaction.editReply({
      content: action === 'on'
        ? `You are registered${account}. I will DM you an invoice when one of your trader sales comes in.`
        : `Trader sale invoices are off${account}. Use /trader on to turn them back on.`,
      allowedMentions: { parse: [] }
    });

    log(`Trader sale invoices ${action} for Discord user ${interaction.user?.id || 'unknown'} via /trader ${option}.`);
  } catch (error) {
    await interaction.editReply({
      content: error.message || 'Could not update trader sale invoices.',
      allowedMentions: { parse: [] }
    });
  }
}
