import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AttachmentBuilder } from 'discord.js';
import {
  groupSalesByBuyer,
  renderTraderInvoiceImages,
  traderReceiptFileNames
} from './trader-invoice-image.js';
import { traderInfoLine } from './trader-info-line.js';
import { receiptSummary } from './trader-receipt-summary.js';

// Discord rate-limits DMs, so notices are queued instead of fired off in a
// burst: a short gap between messages, then a longer pause after every few.
const TRADER_SEND_DELAY_MS = 2000;
const TRADER_SEND_BATCH = 5;
const TRADER_SEND_PAUSE_MIN_MS = 60000;
const TRADER_SEND_PAUSE_MAX_MS = 120000;

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serial queue for trader DMs. Each task waits its turn, so a catch-up import
 * that produces many notices cannot be mistaken for spam.
 */
export function createTraderSendQueue({
  delayMs = TRADER_SEND_DELAY_MS,
  batchSize = TRADER_SEND_BATCH,
  pauseMinMs = TRADER_SEND_PAUSE_MIN_MS,
  pauseMaxMs = TRADER_SEND_PAUSE_MAX_MS,
  sleep = sleepFor,
  random = Math.random,
  now = Date.now,
  log = () => {}
} = {}) {
  let chain = Promise.resolve();
  let sentInBatch = 0;
  let lastSentAt = 0;

  async function waitTurn() {
    // After a long quiet spell the next send starts a fresh batch, so a single
    // import hours later is not held back by a stale pause.
    if (lastSentAt && now() - lastSentAt > pauseMaxMs) sentInBatch = 0;

    if (sentInBatch >= batchSize) {
      sentInBatch = 0;
      await sleep(pauseMinMs + Math.round(random() * (pauseMaxMs - pauseMinMs)));
    } else if (sentInBatch > 0) {
      await sleep(delayMs);
    }
  }

  return function enqueue(task) {
    chain = chain
      .then(async () => {
        await waitTurn();
        await task();
        sentInBatch += 1;
        lastSentAt = now();
      })
      .catch((error) => log(`Trader sale DM queue error: ${error.message}`));

    return chain;
  };
}

const gold = (value) => `${Math.round(Number(value) || 0).toLocaleString('en-US')}g`;

const discordTimestamp = (value) => {
  const seconds = Math.round(Number(value) || 0);
  return seconds > 0 ? `<t:${seconds}:f>` : 'Unknown time';
};

const total = (sales, field) => sales.reduce((sum, sale) => sum + (Number(sale[field]) || 0), 0);

const guildLabel = (sale = {}) => String(sale.guildName || '').trim() || 'GuildSync';

const footerFor = (sale = {}) => ({
  text: [sale.guildName, sale.world].filter(Boolean).join(' · ') || 'GuildSyncTrader'
});

/**
 * The image is written to the OS temp directory, uploaded with the DM, and
 * deleted straight away so no invoice files are left on disk.
 */
export async function writeTraderInvoiceTempImage(png) {
  const filePath = path.join(os.tmpdir(), `guildsync-trader-${randomUUID()}.png`);
  await fs.writeFile(filePath, png);

  return {
    path: filePath,
    async remove() {
      await fs.unlink(filePath).catch(() => {});
    }
  };
}

// The attached receipt image carries the details, so these embeds are only the
// fallback used when the image cannot be rendered.
export function buildTraderSaleEmbed(sale = {}) {
  const quantity = Number(sale.quantity) || 0;
  const gross = Number(sale.price) || 0;
  const tax = Number(sale.tax) || 0;
  const net = Number(sale.net) || 0;

  return {
    color: 0x2f855a,
    title: 'Trader sale receipt',
    description: [
      `**Congratulations!** You sold **${sale.itemName || 'an item'}** on your **${guildLabel(sale)}** Trader.`,
      `${quantity} × ${gold(sale.unitPrice)} = ${gold(gross)} − ${gold(tax)} tax = **${gold(net)}** net profit`
    ].join('\n'),
    footer: footerFor(sale)
  };
}

// Used when the invoice image cannot be produced: the DM keeps every detail.
export function buildTraderSaleFallbackEmbed(sale = {}) {
  return {
    ...buildTraderSaleEmbed(sale),
    fields: [
      { name: 'Date', value: discordTimestamp(sale.time), inline: true },
      { name: 'Transaction ID', value: `#${sale.eventId || 'unknown'}`, inline: true },
      { name: 'Buyer', value: sale.buyer || 'Unknown', inline: true },
      { name: 'Item', value: sale.itemName || 'Unknown', inline: true },
      { name: 'Quantity', value: String(Number(sale.quantity) || 0), inline: true },
      { name: 'Price per unit', value: gold(sale.unitPrice), inline: true },
      { name: 'Tax', value: gold(sale.tax), inline: true },
      { name: 'Net profit', value: gold(sale.net), inline: true }
    ]
  };
}

const invoiceRow = (sale) =>
  `• ${discordTimestamp(sale.time)} · ${sale.itemName || 'Item'} — ${Number(sale.quantity) || 0} × ${gold(sale.unitPrice)} = ${gold(sale.price)} − ${gold(sale.tax)} tax = ${gold(sale.net)} net`;

export function buildTraderInvoiceEmbed(sales = []) {
  const list = Array.isArray(sales) ? sales.filter(Boolean) : [];
  const gross = total(list, 'price');
  const tax = total(list, 'tax');
  const net = total(list, 'net');
  const quantity = total(list, 'quantity');

  return {
    color: 0x2f855a,
    title: 'Trader sales receipt',
    description: [
      `**Congratulations!** You made **${list.length}** sale${list.length === 1 ? '' : 's'} on your **${guildLabel(list[0])}** Trader.`,
      `${quantity} item${quantity === 1 ? '' : 's'} across ${list.length} sale${list.length === 1 ? '' : 's'}: ${gold(gross)} − ${gold(tax)} tax = **${gold(net)}** net profit`
    ].join('\n'),
    footer: footerFor(list[0])
  };
}

// Discord caps an embed description at 4096 characters. Keep a small margin
// and state how many sales were left out; totals always cover the whole import.
const INVOICE_DESCRIPTION_LIMIT = 3300;

export function buildTraderInvoiceFallbackEmbed(sales = []) {
  const list = Array.isArray(sales) ? sales.filter(Boolean) : [];
  const groups = groupSalesByBuyer(list);
  const base = buildTraderInvoiceEmbed(list);

  let body = '';
  let included = 0;

  for (const group of groups) {
    let section = `**${group.name}**\n`;
    let stopped = false;

    for (const sale of group.sales) {
      const row = `${invoiceRow(sale)}\n`;
      if (body.length + section.length + row.length + 2 > INVOICE_DESCRIPTION_LIMIT) {
        stopped = true;
        break;
      }
      section += row;
      included += 1;
    }

    if (section !== `**${group.name}**\n`) body += `${section}\n`;
    if (stopped) break;
  }

  if (included < list.length) {
    body += `…and ${list.length - included} more sale${list.length - included === 1 ? '' : 's'} not shown.\n`;
  }

  return {
    ...base,
    description: `${base.description}\n\n${body}`.trim().slice(0, 4000),
    fields: [
      { name: 'Sales', value: String(list.length), inline: true },
      { name: 'Quantity', value: String(total(list, 'quantity')), inline: true },
      { name: 'Gross', value: gold(total(list, 'price')), inline: true },
      { name: 'Tax', value: gold(total(list, 'tax')), inline: true },
      { name: 'Net profit', value: gold(total(list, 'net')), inline: true }
    ]
  };
}

export function startTraderSaleNotifications(client, socket, log = console.log, {
  renderInvoiceImage = renderTraderInvoiceImages,
  enqueue = createTraderSendQueue({ log })
} = {}) {
  const handler = async (notice = {}) => {
    try {
      const discordUserId = String(notice.discord_user_id || '').trim();
      const sales = Array.isArray(notice.sales) ? notice.sales.filter(Boolean) : [];
      if (!discordUserId || !sales.length) return;

      const kind = notice.kind === 'invoice' ? 'invoice' : 'sale';
      const user = await client.users.fetch(discordUserId);

      // How fresh the data is comes before the receipt, then the same numbers as
      // text: the stamps localise per reader and the summary stays searchable.
      const message = {
        content: [
          traderInfoLine({ latestEntryTime: notice.latest_entry_time }),
          receiptSummary(sales)
        ].filter(Boolean).join('\n')
      };
      const tempImages = [];

      try {
        const rendered = await renderInvoiceImage({ sales, kind });
        const pages = Array.isArray(rendered) ? rendered : [rendered];
        const names = traderReceiptFileNames(pages.length);

        // The receipt carries every detail, so the DM itself is just the images.
        // A long list arrives as several pages in one message.
        message.files = [];
        for (const [index, png] of pages.entries()) {
          const temp = await writeTraderInvoiceTempImage(png);
          tempImages.push(temp);
          message.files.push(new AttachmentBuilder(temp.path, {
            name: names[index],
            description: 'GuildSync trader sales receipt'
          }));
        }
      } catch (imageError) {
        for (const temp of tempImages.splice(0)) await temp.remove();
        log(`Trader invoice image failed for ${discordUserId}: ${imageError.message}. Sending the details embed instead.`);
        message.embeds = [
          kind === 'invoice' ? buildTraderInvoiceFallbackEmbed(sales) : buildTraderSaleFallbackEmbed(sales[0])
        ];
      }

      try {
        await user.send(message);
      } finally {
        for (const temp of tempImages.splice(0)) await temp.remove();
      }

      reportDmFailure(discordUserId, false);
    } catch (error) {
      // A closed DM and a failed fetch both mean the receipt never arrived, and
      // /trader status should be able to say so.
      reportDmFailure(String(notice?.discord_user_id || '').trim(), true);
      log(`Trader sale DM failed for ${notice?.discord_user_id || 'unknown user'}: ${error.message}`);
    }
  };

  // Whether the DM actually went through is the backend's to remember, so
  // /trader status can say so instead of leaving a member believing they are
  // subscribed while every receipt quietly fails.
  const reportDmFailure = (discordUserId, failed) => {
    try {
      if (!socket.connected) return;
      socket.emit('guildsync:trader-sales-subscription', {
        discord_user_id: String(discordUserId || ''),
        action: 'dm-failed',
        failed
      });
    } catch {
      // Best effort: the receipt itself has already been sent or has failed.
    }
  };

  // The backend keeps a notice it could not hand over while the bot was offline;
  // ask for those as soon as the socket connects, so a receipt is late, not lost.
  const replayNotices = async (notices = []) => {
    const list = Array.isArray(notices) ? notices.filter(Boolean) : [];
    if (!list.length) return;

    for (const notice of list) await enqueue(() => handler(notice));

    socket.emit('guildsync:trader-sales-subscription', {
      action: 'delivered',
      ids: list.flatMap((notice) => notice.notice_ids || [])
    });

    log(`Trader sales: replayed ${list.length} receipt(s) that arrived while the bot was offline.`);
  };

  const replayPending = () => {
    if (!socket.connected) return;

    socket.timeout(15000).emit('guildsync:trader-sales-subscription', { action: 'pending' }, (error, response) => {
      if (error || !response?.ok) return;
      replayNotices(response.notices).catch((replayError) => log(`Trader sales: replay failed: ${replayError.message}`));
    });
  };

  // The acknowledgement is what lets the backend mark the notice delivered.
  const listener = (notice, ack) => {
    const done = () => {
      try {
        ack?.();
      } catch {
        // The delivery mark is best effort.
      }
    };

    return enqueue(() => handler(notice)).then(done, done);
  };

  socket.on('guildsync:trader-sale-notice', listener);
  socket.on('connect', replayPending);

  return () => {
    socket.off('guildsync:trader-sale-notice', listener);
    socket.off('connect', replayPending);
  };
}
