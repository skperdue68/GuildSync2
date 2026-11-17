import { createCanvas } from '@napi-rs/canvas';

// The DM receipt is rendered as a PNG so Discord shows a single, tidy document
// instead of a wall of embed fields.
export const TRADER_INVOICE_FILE_NAME = 'trader-sales-receipt.png';

// Drawn at 2x so the receipt stays sharp when opened full size. Discord still
// shows its own modest preview inline; the extra pixels are for the zoomed view.
const SCALE = 2;
const WIDTH = 960;
const CARD_X = 24;
const CARD_W = WIDTH - CARD_X * 2;
const INNER_X = CARD_X + 32;
const INNER_W = CARD_W - 64;
const RIGHT = INNER_X + INNER_W;

const BAND_H = 120;
const HEADLINE_LINE_H = 24;
const META_H = 62;
const TABLE_HEADER_H = 34;
const SECTION_H = 26;
const TIME_COLUMN_W = 150;
const MAX_INVOICE_ROWS = 16;

const C = {
  backdrop: '#11151b',
  card: '#fbfaf7',
  band: '#1d3a2f',
  gold: '#c9a54b',
  ink: '#181c22',
  muted: '#6d7580',
  rule: '#e4dfd3',
  stripe: '#f3efe5',
  white: '#ffffff'
};

// Trader times are shown in Eastern Time with the current EST/EDT label, since
// the receipt is a picture and cannot follow each viewer's own timezone.
const EASTERN = 'America/New_York';

const font = (weight, size) => `${weight} ${size}px "Segoe UI", "DejaVu Sans", Arial, sans-serif`;
const gold = (value) => `${Math.round(Number(value) || 0).toLocaleString('en-US')}g`;
const num = (value) => Number(value) || 0;
const sum = (list, field) => list.reduce((total, item) => total + num(item[field]), 0);

function clipLine(ctx, text, maxWidth) {
  const value = String(text ?? '');
  if (!value || ctx.measureText(value).width <= maxWidth) return value;

  let trimmed = value;
  while (trimmed.length > 1 && ctx.measureText(`${trimmed}…`).width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}…`;
}

function wrapLines(ctx, text, maxWidth) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }

  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function traderSaleDate(seconds) {
  const value = num(seconds);
  if (value <= 0) return 'Unknown';

  const when = new Date(value * 1000);
  const date = when.toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: '2-digit', timeZone: EASTERN
  });
  const time = when.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: EASTERN, timeZoneName: 'short'
  });
  return `${date}, ${time}`;
}

// A row-sized stamp for multi-sale receipts, in Eastern Time like the full
// date above so both layouts read the same way.
function shortSaleDate(seconds) {
  const value = num(seconds);
  if (value <= 0) return '';

  const when = new Date(value * 1000);
  const date = when.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: EASTERN });
  const time = when.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: EASTERN, timeZoneName: 'short'
  });
  return `${date} · ${time}`;
}

// Buyers are grouped alphabetically and each buyer's sales are ordered by time,
// so a catch-up import reads like one invoice per buyer.
export function groupSalesByBuyer(sales = []) {
  const groups = new Map();

  for (const sale of Array.isArray(sales) ? sales : []) {
    if (!sale) continue;
    const name = String(sale.buyer || '').trim() || 'Unknown buyer';
    const key = name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name, sales: [] });
    groups.get(key).sales.push(sale);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      sales: [...group.sales].sort((a, b) =>
        num(a.time) - num(b.time) || num(a.eventId) - num(b.eventId))
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

function rowPlan(groups, single) {
  if (single) return { body: [{ type: 'item', sale: groups[0].sales[0] }], hidden: 0 };

  const body = [];
  let itemRows = 0;
  let hidden = 0;

  for (const group of groups) {
    const sales = [];

    for (const sale of group.sales) {
      if (itemRows >= MAX_INVOICE_ROWS) {
        hidden += 1;
        continue;
      }
      sales.push(sale);
      itemRows += 1;
    }

    if (sales.length) {
      body.push({ type: 'buyer', label: group.name }, ...sales.map((sale) => ({ type: 'item', sale })));
    }
  }

  return { body, hidden };
}

/**
 * Render a trader sale (or a multi-sale invoice) as a PNG document.
 *
 * @param {{sales?: object[], kind?: 'sale'|'invoice', caption?: string, footerNote?: string}} notice
 * @returns {Promise<Buffer>}
 */
export async function renderTraderInvoiceImage({ sales = [], kind = 'sale', caption = '', footerNote = '' } = {}) {
  const list = (Array.isArray(sales) ? sales : []).filter(Boolean);
  if (!list.length) throw new Error('No trader sales to render.');

  const single = kind !== 'invoice' && list.length === 1;
  const groups = groupSalesByBuyer(list);
  const { body, hidden } = rowPlan(groups, single);

  const first = list[0];
  const guildName = String(first.guildName || '').trim() || 'GuildSync';
  const gross = sum(list, 'price');
  const tax = sum(list, 'tax');
  const net = sum(list, 'net');
  const quantity = sum(list, 'quantity');

  const measuring = createCanvas(8, 8).getContext('2d');
  measuring.font = font(500, 17);
  // A caller can replace the congratulations line; a search result is not a
  // fresh sale, so it passes a neutral caption instead.
  const headline = String(caption || '').trim() || (single
    ? `Congratulations! You sold ${first.itemName || 'an item'} on the ${guildName} Trader — the details are below.`
    : `Congratulations! You made ${list.length} trader sales on the ${guildName} Trader — the details are below.`);
  const headlineLines = wrapLines(measuring, headline, INNER_W);

  const rowH = single ? 40 : 36;
  const itemRowCount = body.filter((row) => row.type === 'item').length;
  const sectionCount = body.filter((row) => row.type === 'buyer').length;

  const bandTop = CARD_X;
  const congratsTop = bandTop + BAND_H + 34;
  const metaTop = congratsTop + headlineLines.length * HEADLINE_LINE_H + 8;
  const tableTop = metaTop + META_H + 14;
  const rowsTop = tableTop + TABLE_HEADER_H;
  const bodyHeight = itemRowCount * rowH + sectionCount * SECTION_H + (hidden ? 26 : 0);
  const rowsBottom = rowsTop + bodyHeight;
  const paidBaseline = rowsBottom + 34;
  const footerRule = rowsBottom + 60;
  const footerBaseline = footerRule + 26;
  const height = footerBaseline + 96;

  const canvas = createCanvas(WIDTH * SCALE, height * SCALE);
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);

  ctx.fillStyle = C.backdrop;
  ctx.fillRect(0, 0, WIDTH, height);

  // Card
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 6;
  roundRect(ctx, CARD_X, bandTop, CARD_W, height - CARD_X * 2, 18);
  ctx.fillStyle = C.card;
  ctx.fill();
  ctx.restore();

  // Header band, clipped to the card's rounded corners
  ctx.save();
  roundRect(ctx, CARD_X, bandTop, CARD_W, height - CARD_X * 2, 18);
  ctx.clip();
  ctx.fillStyle = C.band;
  ctx.fillRect(CARD_X, bandTop, CARD_W, BAND_H);
  ctx.fillStyle = C.gold;
  ctx.fillRect(CARD_X, bandTop + BAND_H - 3, CARD_W, 3);
  ctx.restore();

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  ctx.font = font(700, 13);
  ctx.fillStyle = C.gold;
  ctx.fillText(clipLine(ctx, guildName.toUpperCase(), INNER_W * 0.55), INNER_X, bandTop + 42);

  ctx.font = font(700, 27);
  ctx.fillStyle = C.white;
  ctx.fillText('TRADER SALES RECEIPT', INNER_X, bandTop + 80);

  ctx.textAlign = 'right';
  ctx.font = font(600, 11);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
  ctx.fillText('NET PAYOUT', RIGHT, bandTop + 40);
  ctx.font = font(700, 30);
  ctx.fillStyle = C.gold;
  ctx.fillText(gold(net), RIGHT, bandTop + 80);

  // Headline
  ctx.textAlign = 'left';
  ctx.font = font(500, 17);
  ctx.fillStyle = C.ink;
  headlineLines.forEach((line, index) => {
    ctx.fillText(line, INNER_X, congratsTop + index * HEADLINE_LINE_H);
  });

  // Meta columns
  const metaColumns = single
    ? [
      { label: 'DATE', value: traderSaleDate(first.time) },
      { label: 'TRANSACTION ID', value: `#${first.eventId || 'unknown'}` },
      { label: 'BUYER', value: String(first.buyer || 'Unknown') }
    ]
    : [
      { label: 'SALES', value: String(list.length) },
      { label: 'BUYERS', value: String(groups.length) },
      { label: 'ITEMS SOLD', value: String(quantity) }
    ];

  const metaWidth = INNER_W / 3;
  metaColumns.forEach((column, index) => {
    const x = INNER_X + index * metaWidth;
    ctx.font = font(700, 11);
    ctx.fillStyle = C.muted;
    ctx.fillText(column.label, x, metaTop + 12);

    ctx.font = font(600, 16);
    ctx.fillStyle = C.ink;
    ctx.fillText(clipLine(ctx, column.value, metaWidth - 16), x, metaTop + 36);
  });

  // Table header
  ctx.fillStyle = C.stripe;
  ctx.fillRect(INNER_X, tableTop, INNER_W, TABLE_HEADER_H);

  const colQty = RIGHT - 320;
  const colUnit = RIGHT - 170;

  const headerY = tableTop + 22;
  ctx.font = font(700, 11);
  ctx.fillStyle = C.muted;
  const itemX = single ? INNER_X + 16 : INNER_X + 16 + TIME_COLUMN_W;
  ctx.textAlign = 'left';
  ctx.fillText(single ? 'ITEM' : 'SOLD', INNER_X + 16, headerY);
  if (!single) ctx.fillText('ITEM', itemX, headerY);
  ctx.textAlign = 'right';
  ctx.fillText('QTY', colQty, headerY);
  ctx.fillText('UNIT', colUnit, headerY);
  ctx.fillText('AMOUNT', RIGHT, headerY);

  // Rows
  ctx.strokeStyle = C.rule;
  ctx.lineWidth = 1;
  let cursor = rowsTop;
  for (const row of body) {
    if (row.type === 'buyer') {
      ctx.fillStyle = C.gold;
      ctx.fillRect(INNER_X, cursor + 5, 3, SECTION_H - 12);

      ctx.font = font(700, 13);
      ctx.fillStyle = C.ink;
      ctx.textAlign = 'left';
      ctx.fillText(clipLine(ctx, row.label, INNER_W - 40), INNER_X + 14, cursor + SECTION_H - 9);

      cursor += SECTION_H;
      continue;
    }

    const sale = row.sale;
    const textY = cursor + rowH / 2 + 5;

    ctx.textAlign = 'left';
    if (!single) {
      ctx.font = font(500, 13);
      ctx.fillStyle = C.muted;
      ctx.fillText(clipLine(ctx, shortSaleDate(sale.time), TIME_COLUMN_W - 14), INNER_X + 16, textY);
    }
    ctx.font = font(500, single ? 15 : 14);
    ctx.fillStyle = C.ink;
    ctx.fillText(clipLine(ctx, sale.itemName || 'Item', colQty - 60 - itemX), itemX, textY);

    ctx.textAlign = 'right';
    ctx.fillStyle = C.ink;
    ctx.fillText(String(num(sale.quantity)), colQty, textY);
    ctx.fillText(gold(sale.unitPrice), colUnit, textY);
    ctx.font = font(600, 15);
    ctx.fillText(gold(sale.price), RIGHT, textY);

    ctx.beginPath();
    ctx.moveTo(INNER_X, cursor + rowH - 1);
    ctx.lineTo(RIGHT, cursor + rowH - 1);
    ctx.stroke();

    cursor += rowH;
  }

  if (hidden) {
    ctx.font = font(500, 13);
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'left';
    ctx.fillText(`…and ${hidden} more sale${hidden === 1 ? '' : 's'} not shown here.`, INNER_X + 16, cursor + 18);
  }

  if (single && first.seller) {
    ctx.font = font(500, 13);
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'left';
    ctx.fillText(clipLine(ctx, `Paid to ${first.seller}`, INNER_W - 200), INNER_X, paidBaseline);
  }

  // Footer
  ctx.strokeStyle = C.rule;
  ctx.beginPath();
  ctx.moveTo(INNER_X, footerRule);
  ctx.lineTo(RIGHT, footerRule);
  ctx.stroke();

  ctx.font = font(500, 12);
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'left';
  ctx.fillText(clipLine(ctx, ['GuildSync', guildName].filter(Boolean).join(' · '), INNER_W - 380), INNER_X, footerBaseline);
  ctx.fillText(
    single ? `Transaction #${first.eventId || 'unknown'}` : `${list.length} sales · ${groups.length} buyers`,
    INNER_X,
    footerBaseline + 20
  );

  const note = String(footerNote || '').trim();
  if (note) {
    ctx.fillText(clipLine(ctx, note, INNER_W - 380), INNER_X, footerBaseline + 40);
  }

  // The totals sit at the bottom right, one amount under the other the way the
  // arithmetic would be written: gross, less the guild tax, then the net.
  const totalsLabelRight = RIGHT - 160;
  const totalRows = [
    { label: 'Gross sales', value: gold(gross), color: C.ink, size: 13, weight: 600 },
    { label: 'Guild tax', value: tax > 0 ? `−${gold(tax)}` : gold(0), color: C.ink, size: 13, weight: 600 },
    { label: 'Net profit', value: gold(net), color: C.band, size: 16, weight: 700 }
  ];

  totalRows.forEach((row, index) => {
    const y = footerBaseline + index * 22;

    ctx.textAlign = 'right';
    ctx.font = font(500, 12);
    ctx.fillStyle = C.muted;
    ctx.fillText(row.label, totalsLabelRight, y);

    ctx.font = font(row.weight, row.size);
    ctx.fillStyle = row.color;
    ctx.fillText(row.value, RIGHT, y);

    if (index === 1) {
      ctx.strokeStyle = C.rule;
      ctx.beginPath();
      ctx.moveTo(RIGHT - 340, y + 9);
      ctx.lineTo(RIGHT, y + 9);
      ctx.stroke();
    }
  });

  return canvas.encode('png');
}
