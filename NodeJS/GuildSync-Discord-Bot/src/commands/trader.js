import { AttachmentBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Log } from '../helper.js';
import { renderTraderInvoiceImages, traderReceiptFileNames } from '../trader-invoice-image.js';

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
  .addSubcommand((subcommand) => subcommand
    .setName('sales')
    .setDescription('Show every trader sale of an item.')
    .addStringOption((option) => option
      .setName('item')
      .setDescription('Any part of the item name, spaces allowed.')
      .setRequired(true)
      .setMaxLength(100)))
  .addSubcommand((subcommand) => subcommand
    .setName('test')
    .setDescription('Temporary: DM me a receipt for my newest stored trader sales.'))
  .setDMPermission(true);

// A search result is not a fresh sale, so its receipt opens with a neutral
// caption instead of the congratulations line.
export function searchReceiptCaption(sales = [], item = '') {
  const list = Array.isArray(sales) ? sales.filter(Boolean) : [];
  const term = String(item || '').trim();

  if (list.length === 1) {
    return list[0].itemName
      ? `Your sale of ${list[0].itemName}.`
      : `Your sale matching “${term}”.`;
  }

  return `Your ${list.length} sales matching “${term}”.`;
}

// register/unregister are aliases so either wording works.
const ACTION_BY_OPTION = { on: 'on', register: 'on', off: 'off', unregister: 'off', sales: 'sales', test: 'test' };

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
  const item = action === 'sales'
    ? String(interaction.options.getString('item') || '').trim()
    : '';

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    const response = await request(guildSyncSocket, {
      discord_user_id: interaction.user?.id,
      action,
      ...(item ? { item } : {})
    });

    if (!response?.ok) {
      const content = response?.linked === false
        ? LINK_REQUIRED_MESSAGE
        : response?.message || 'Could not update trader sale invoices.';
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
      return;
    }

    if (action === 'sales') {
      const sales = Array.isArray(response.sales) ? response.sales.filter(Boolean) : [];

      if (!sales.length) {
        await interaction.editReply({
          content: `There are no sales entries for an item named ${item}.`,
          allowedMentions: { parse: [] }
        });
        return;
      }

      const truncated = Boolean(response.truncated);
      const pages = await renderTraderInvoiceImages({
        sales,
        kind: sales.length === 1 ? 'sale' : 'invoice',
        caption: searchReceiptCaption(sales, item),
        footerNote: truncated
          ? `Only the newest ${sales.length} matching sales are searched; older ones are not included.`
          : ''
      });
      const names = traderReceiptFileNames(pages.length);
      await interaction.editReply({
        content: truncated
          ? `${sales.length} sales matching “${item}” — the newest ${sales.length} only, older sales exist.`
          : `${sales.length} sale${sales.length === 1 ? '' : 's'} matching “${item}”.`,
        files: pages.map((png, index) => new AttachmentBuilder(png, { name: names[index] })),
        allowedMentions: { parse: [] }
      });

      log(`Trader sales search for “${item}” returned ${sales.length} sale(s) for Discord user ${interaction.user?.id || 'unknown'}.`);
      return;
    }

    if (action === 'test') {
      const count = Number(response.sales) || 0;
      await interaction.editReply({
        content: `Sent a test receipt with ${count} sale${count === 1 ? '' : 's'} to your DMs.`,
        allowedMentions: { parse: [] }
      });

      log(`Trader test receipt sent to Discord user ${interaction.user?.id || 'unknown'} with ${count} sale(s).`);
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
