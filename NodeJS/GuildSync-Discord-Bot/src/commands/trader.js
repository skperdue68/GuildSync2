import { AttachmentBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Log } from '../helper.js';
import { renderTraderInvoiceImages, traderReceiptFileNames } from '../trader-invoice-image.js';
import { traderInfoLine } from '../trader-info-line.js';
import { receiptSummary } from '../trader-receipt-summary.js';

// Must match TRADER_SOCKET_PROTOCOL in the backend's trader-sales-subscriptions.
export const TRADER_SOCKET_PROTOCOL = 2;

let warnedAboutBackend = false;

// The backend stamps every reply with its protocol, so a mismatch can be said out
// loud once instead of looking like receipts that lost their timestamps.
function warnIfBackendOutdated(response, log) {
  if (Number(response?.protocol) === TRADER_SOCKET_PROTOCOL || warnedAboutBackend) return;

  warnedAboutBackend = true;
  log(`GuildSync backend speaks trader protocol ${response?.protocol ?? 'none'}, this bot expects ${TRADER_SOCKET_PROTOCOL}. Restart the backend to date receipts and to enable /trader receipt.`);
}

export const LINK_REQUIRED_MESSAGE = [
  'I cannot send trader sale receipts until your Discord account is linked to an ESO account.',
  '',
  '1. Set your Discord username to match your @ESO name so GuildSync can link it automatically.',
  '2. If you believe it is already linked, or are otherwise having issues contact @evainefaye for support, she is your only support person for this system.'
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
    .setDescription('Show your latest trader sales, or every sale of one item.')
    .addStringOption((option) => option
      .setName('item')
      .setDescription('Any part of the item name, spaces allowed.')
      .setRequired(false)
      .setMaxLength(100))
    .addIntegerOption((option) => option
      .setName('count')
      // Works with or without an item, and a limited list is always the newest
      // sales first, so the wording says that instead of implying a plain list.
      .setDescription('How many sales, newest first (default 10, or 50 for an item search).')
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(50)))
  .addSubcommand((subcommand) => subcommand
    .setName('receipt')
    .setDescription('DM me a receipt for my most recent trader sale.'))
  .addSubcommand((subcommand) => subcommand
    .setName('status')
    .setDescription('Check whether trader sale receipts are on for me.'))
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

// Without an item the list is the newest sales of anything, so one sale is named
// after its item instead of congratulating on a sale that is not fresh.
export function recentReceiptCaption(sales = []) {
  const list = Array.isArray(sales) ? sales.filter(Boolean) : [];

  if (list.length === 1) {
    return list[0].itemName ? `Your most recent sale of ${list[0].itemName}.` : 'Your most recent sale.';
  }

  return `Your last ${list.length} sale${list.length === 1 ? '' : 's'}.`;
}

// register/unregister are aliases so either wording works.
const ACTION_BY_OPTION = {
  on: 'on',
  register: 'on',
  off: 'off',
  unregister: 'off',
  sales: 'sales',
  receipt: 'receipt',
  status: 'status'
};

// Both receipt answers are built the same way: render the pages, name the files,
// and put the freshness line above the reply line. The options and the wording
// differ, so they are arguments instead of a second copy of this code.
async function receiptReply({ infoLine, line, sales, caption = '', footerNote = '' }) {
  // The renderer already shows the detailed single-sale receipt for exactly one
  // sale and pages for a list, so no kind has to be chosen here.
  const pages = await renderTraderInvoiceImages({ sales, caption, footerNote });
  const names = traderReceiptFileNames(pages.length);

  return {
    content: [infoLine, line, receiptSummary(sales)].filter(Boolean).join('\n'),
    files: pages.map((png, index) => new AttachmentBuilder(png, { name: names[index] })),
    allowedMentions: { parse: [] }
  };
}

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
  const count = action === 'sales' ? interaction.options.getInteger('count') : null;

  // In a channel the answer is for the person who asked, receipts included; a
  // DM is already private and ignores the ephemeral flag.
  const inChannel = Boolean(interaction.guildId);
  await interaction.deferReply(inChannel ? { flags: [MessageFlags.Ephemeral] } : {});

  try {
    const response = await request(guildSyncSocket, {
      discord_user_id: interaction.user?.id,
      action,
      ...(item ? { item } : {}),
      ...(count ? { limit: count } : {})
    });

    warnIfBackendOutdated(response, log);

    if (!response?.ok) {
      const content = response?.linked === false
        ? LINK_REQUIRED_MESSAGE
        : response?.message || 'Could not update trader sale invoices.';
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
      return;
    }

    if (action === 'status') {
      if (response.linked === false) {
        await interaction.editReply({ content: LINK_REQUIRED_MESSAGE, allowedMentions: { parse: [] } });
        return;
      }

      const account = response.eso_account_name ? ` for ${response.eso_account_name}` : '';
      const lines = [];

      if (response.enabled) {
        const since = response.subscribed_at ? ` since <t:${response.subscribed_at}:f>` : '';
        lines.push(`Trader sale receipts are on${account}${since}. Each sale I see for you arrives as a DM receipt.`);
      } else {
        lines.push(`Trader sale receipts are off${account}. Use /trader on to turn them on.`);
      }

      // The backend records a failed DM, so a member whose DMs are closed finds out
      // here instead of assuming the receipts are simply not being sent.
      if (response.dm_failed_at) {
        lines.push(`My last receipt DM to you failed on <t:${response.dm_failed_at}:f>. Check that this bot is allowed to DM you, then run /trader on again.`);
      }

      await interaction.editReply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
      log(`Trader status for Discord user ${interaction.user?.id || 'unknown'}: ${response.enabled ? 'on' : 'off'}${response.dm_failed_at ? ', last receipt DM failed' : ''}.`);
      return;
    }

    // Everything below is sales data, so it opens with how fresh that data is.
    const infoLine = traderInfoLine({ latestEntryTime: response.latest_entry_time });

    if (action === 'sales') {
      const sales = Array.isArray(response.sales) ? response.sales.filter(Boolean) : [];

      if (!sales.length) {
        await interaction.editReply({
          content: `${infoLine}\n${item
            ? `There are no sales entries for an item named ${item}.`
            : 'There are no trader sales stored for your linked ESO account yet.'}`,
          allowedMentions: { parse: [] }
        });
        return;
      }

      const truncated = Boolean(response.truncated);
      const plural = sales.length === 1 ? '' : 's';

      // With an item the reply is its history; without one it is the newest sales
      // of anything, and the caption names the item when there is only one.
      await interaction.editReply(await receiptReply({
        infoLine,
        line: item
          ? (truncated
            ? `${sales.length} sales matching “${item}” — the newest ${sales.length} only, older sales exist.`
            : `${sales.length} sale${plural} matching “${item}”.`)
          : (truncated
            ? `Your ${sales.length} most recent sale${plural} — older sales exist.`
            : `Your ${sales.length} most recent sale${plural}.`),
        sales,
        caption: item ? searchReceiptCaption(sales, item) : recentReceiptCaption(sales),
        footerNote: truncated
          ? (item
            ? `Only the newest ${sales.length} matching sales are searched; older ones are not included.`
            : `Only the newest ${sales.length} sales are shown; older ones are not included.`)
          : ''
      }));

      log(`Trader sales ${item ? `search for “${item}”` : 'list'} returned ${sales.length} sale(s) for Discord user ${interaction.user?.id || 'unknown'}.`);
      return;
    }

    if (action === 'receipt') {
      const sale = (Array.isArray(response.sales) ? response.sales : []).filter(Boolean)[0];

      // The backend DMs the receipt through the same path a live sale takes, so it
      // looks like a sale that just happened. This reply only confirms it, in the
      // channel or DM the command was typed in, and repeats the numbers as text.
      await interaction.editReply({
        content: [
          infoLine,
          'Sent your newest sale receipt to your DMs.',
          sale ? receiptSummary([sale]) : ''
        ].filter(Boolean).join('\n'),
        allowedMentions: { parse: [] }
      });

      log(`Trader receipt DM requested for Discord user ${interaction.user?.id || 'unknown'}${sale ? ` (sale #${sale.eventId})` : ''}.`);
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
