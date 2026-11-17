const gold = (value) => `${Math.round(Number(value) || 0).toLocaleString('en-US')}g`;

const discordTimestamp = (value) => {
  const seconds = Math.round(Number(value) || 0);
  return seconds > 0 ? `<t:${seconds}:f>` : 'Unknown time';
};

const total = (sales, field) => sales.reduce((sum, sale) => sum + (Number(sale[field]) || 0), 0);

export function buildTraderSaleEmbed(sale = {}) {
  return {
    color: 0x2f855a,
    title: `Trader sale: ${sale.itemName || 'Item'}`,
    description: `${gold(sale.unitPrice)} × ${sale.quantity || 0} = ${gold(sale.price)} − ${gold(sale.tax)} tax = **${gold(sale.net)}** net`,
    fields: [
      { name: 'When', value: discordTimestamp(sale.time), inline: true },
      { name: 'Transaction', value: `#${sale.eventId || 'unknown'}`, inline: true },
      { name: 'Buyer', value: sale.buyer || 'Unknown', inline: true },
      { name: 'Item', value: sale.itemName || 'Unknown', inline: true },
      { name: 'Quantity', value: String(sale.quantity || 0), inline: true },
      { name: 'Net', value: gold(sale.net), inline: true }
    ],
    footer: { text: [sale.guildName, sale.world].filter(Boolean).join(' · ') || 'GuildSyncTrader' }
  };
}

const invoiceRow = (sale) =>
  `• ${discordTimestamp(sale.time)} · ${sale.itemName || 'Item'} — ${Number(sale.quantity) || 0} × ${gold(sale.unitPrice)} = ${gold(sale.price)} − ${gold(sale.tax)} tax = ${gold(sale.net)} net`;

function invoiceBuyerGroups(sales = []) {
  const groups = new Map();

  for (const sale of sales) {
    const name = String(sale.buyer || '').trim() || 'Unknown buyer';
    const key = name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name, sales: [] });
    groups.get(key).sales.push(sale);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      sales: [...group.sales].sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0) || (Number(a.eventId) || 0) - (Number(b.eventId) || 0))
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.sales[0].time - b.sales[0].time);
}

// Discord caps an embed description at 4096 characters. Keep a small margin
// and state how many sales were left out; totals always cover the whole import.
const INVOICE_DESCRIPTION_LIMIT = 3900;

export function buildTraderInvoiceEmbed(sales = []) {
  const list = Array.isArray(sales) ? sales : [];
  const groups = invoiceBuyerGroups(list);
  const header = `**${list.length}** sale${list.length === 1 ? '' : 's'} to **${groups.length}** buyer${groups.length === 1 ? '' : 's'}.\n\n`;

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
    color: 0x2f855a,
    title: 'Trader sales invoice',
    description: `${header}${body}`.trim().slice(0, 4000),
    fields: [
      { name: 'Sales', value: String(list.length), inline: true },
      { name: 'Quantity', value: String(total(list, 'quantity')), inline: true },
      { name: 'Gross', value: gold(total(list, 'price')), inline: true },
      { name: 'Tax', value: gold(total(list, 'tax')), inline: true },
      { name: 'Net', value: gold(total(list, 'net')), inline: true }
    ],
    footer: { text: [list[0]?.guildName, list[0]?.world].filter(Boolean).join(' · ') || 'GuildSyncTrader' }
  };
}

export function startTraderSaleNotifications(client, socket, log = console.log) {
  const handler = async (notice = {}) => {
    try {
      const discordUserId = String(notice.discord_user_id || '').trim();
      const sales = Array.isArray(notice.sales) ? notice.sales : [];
      if (!discordUserId || !sales.length) return;

      const embed = notice.kind === 'invoice' ? buildTraderInvoiceEmbed(sales) : buildTraderSaleEmbed(sales[0]);
      const user = await client.users.fetch(discordUserId);
      await user.send({ embeds: [embed] });
    } catch (error) {
      log(`Trader sale DM failed for ${notice?.discord_user_id || 'unknown user'}: ${error.message}`);
    }
  };

  socket.on('guildsync:trader-sale-notice', handler);
  return () => socket.off('guildsync:trader-sale-notice', handler);
}
