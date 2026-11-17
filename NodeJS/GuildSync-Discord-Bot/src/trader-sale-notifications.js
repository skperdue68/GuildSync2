const gold = (value) => `${Math.round(Number(value) || 0).toLocaleString('en-US')}g`;

const discordTimestamp = (value) => {
  const seconds = Math.round(Number(value) || 0);
  return seconds > 0 ? `<t:${seconds}:f>` : 'Unknown time';
};

const saleLine = (sale) => {
  const item = sale.itemName || 'Item';
  return `• ${discordTimestamp(sale.time)} ${item} — ${gold(sale.net)} net (${gold(sale.price)} − ${gold(sale.tax)} tax)`;
};

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

export function buildTraderDigestEmbed(sales = []) {
  const list = Array.isArray(sales) ? sales : [];
  const net = list.reduce((sum, sale) => sum + (Number(sale.net) || 0), 0);
  const tax = list.reduce((sum, sale) => sum + (Number(sale.tax) || 0), 0);
  const gross = list.reduce((sum, sale) => sum + (Number(sale.price) || 0), 0);

  const lines = list.slice(0, 10).map(saleLine);
  if (list.length > 10) lines.push(`…and ${list.length - 10} more sale${list.length - 10 === 1 ? '' : 's'}.`);

  return {
    color: 0x2b6cb0,
    title: 'Trader catch-up summary',
    description: `You had **${list.length}** trader sale${list.length === 1 ? '' : 's'} in this catch-up.\n\n${lines.join('\n') || 'No sales matched your subscription.'}`.slice(0, 4000),
    fields: [
      { name: 'Sales', value: String(list.length), inline: true },
      { name: 'Gross', value: gold(gross), inline: true },
      { name: 'Tax', value: gold(tax), inline: true },
      { name: 'Net', value: gold(net), inline: true }
    ],
    footer: { text: 'GuildSyncTrader catch-up' }
  };
}

export function startTraderSaleNotifications(client, socket, log = console.log) {
  const handler = async (notice = {}) => {
    try {
      const discordUserId = String(notice.discord_user_id || '').trim();
      const sales = Array.isArray(notice.sales) ? notice.sales : [];
      if (!discordUserId || !sales.length) return;

      const embed = notice.kind === 'digest' ? buildTraderDigestEmbed(sales) : buildTraderSaleEmbed(sales[0]);
      const user = await client.users.fetch(discordUserId);
      await user.send({ embeds: [embed] });
    } catch (error) {
      log(`Trader sale DM failed for ${notice?.discord_user_id || 'unknown user'}: ${error.message}`);
    }
  };

  socket.on('guildsync:trader-sale-notice', handler);
  return () => socket.off('guildsync:trader-sale-notice', handler);
}
