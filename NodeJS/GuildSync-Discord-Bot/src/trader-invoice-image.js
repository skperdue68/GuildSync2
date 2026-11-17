import { createCanvas } from '@napi-rs/canvas';

// The DM receipt is rendered as a PNG so Discord shows a single, tidy document
// instead of a wall of embed fields. A long list continues on extra pages
// rather than dropping rows.
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
// Wide enough for the full stamp including the timezone, e.g.
// "Sep 30 · 12:59 PM EDT", so the EST/EDT label is never clipped away.
export const SOLD_COLUMN_W = 178;
// A page holds as many rows as fit in this much body height; anything left
// moves to the next graphic.
const MAX_PAGE_BODY_H = 620;
const ROW_H = 36;
const SINGLE_ROW_H = 40;
const ROW_LINE_H = 16;

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

export const font = (weight, size) => `${weight} ${size}px "Segoe UI", "DejaVu Sans", Arial, sans-serif`;
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

// Item names may wrap onto a second line so the date column can keep the whole
// timestamp; anything past that is clipped rather than spilling out of its cell.
function itemLines(ctx, itemName, maxWidth, size = 14) {
  ctx.font = font(500, size);
  const lines = wrapLines(ctx, String(itemName || 'Item'), maxWidth);
  if (lines.length <= 2) return lines;

  return [lines[0], clipLine(ctx, lines.slice(1).join(' '), maxWidth)];
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

export function traderSaleDate(seconds) {
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
export function shortSaleDate(seconds) {
  const value = num(seconds);
  if (value <= 0) return '';

  const when = new Date(value * 1000);
  const date = when.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: EASTERN });
  const time = when.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: EASTERN, timeZoneName: 'short'
  });
  return `${date} · ${time}`;
}

// A list receipt is a catch-up document, not a single fresh sale, so it says
// plainly which slice of sales it covers.
export function defaultInvoiceHeadline(count) {
  const total = Math.max(0, Number(count) || 0);
  return `Last ${total} sale${total === 1 ? '' : 's'}.`;
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

function columnLayout(single) {
  const colQty = RIGHT - 320;
  const itemX = single ? INNER_X + 16 : INNER_X + 16 + SOLD_COLUMN_W;
  return {
    colQty,
    colUnit: RIGHT - 170,
    itemX,
    itemWidth: colQty - 60 - itemX
  };
}

/**
 * Split sales into pages of rows the page can actually hold. A buyer heading is
 * repeated on the next page when their rows continue there, and every sale
 * appears exactly once across the returned pages.
 */
export function planReceiptPages(sales = [], { maxBodyHeight = MAX_PAGE_BODY_H } = {}) {
  const list = (Array.isArray(sales) ? sales : []).filter(Boolean);
  const groups = groupSalesByBuyer(list);
  const measuring = createCanvas(8, 8).getContext('2d');
  const { itemWidth } = columnLayout(false);

  const pages = [];
  let rows = [];
  let used = 0;

  for (const group of groups) {
    let headerPending = group.name;

    for (const sale of group.sales) {
      const lines = itemLines(measuring, sale.itemName, itemWidth);
      const height = ROW_H + (lines.length - 1) * ROW_LINE_H;
      const needed = (headerPending ? SECTION_H : 0) + height;

      if (rows.length && used + needed > maxBodyHeight) {
        pages.push(rows);
        rows = [];
        used = 0;
      }

      if (headerPending) {
        rows.push({ type: 'buyer', label: headerPending });
        used += SECTION_H;
        headerPending = '';
      }

      rows.push({ type: 'item', sale, lines, height });
      used += height;
    }
  }

  if (rows.length) pages.push(rows);
  return pages;
}

/** File names for the pages of one receipt, in page order. */
export function traderReceiptFileNames(count = 1) {
  const total = Math.max(1, Number(count) || 1);
  if (total === 1) return [TRADER_INVOICE_FILE_NAME];

  return Array.from({ length: total }, (_, index) =>
    TRADER_INVOICE_FILE_NAME.replace(/\.png$/, `-${index + 1}.png`));
}

async function drawReceiptPage({
  rows = [],
  single = false,
  first = {},
  list = [],
  groups = [],
  headline = '',
  footerNote = '',
  pageIndex = 0,
  pageCount = 1,
  totals = { gross: 0, tax: 0, net: 0, quantity: 0 },
  guildName = 'GuildSync'
} = {}) {
  // Page one carries the meta block; only the last page carries the totals.
  const showMeta = single || pageIndex === 0;
  const showFooter = single || pageIndex === pageCount - 1;
  const measuring = createCanvas(8, 8).getContext('2d');
  measuring.font = font(500, 17);
  const headlineLines = wrapLines(measuring, headline, INNER_W);

  const bodyHeight = rows.reduce((total, row) => total + (row.type === 'buyer' ? SECTION_H : row.height), 0);

  const bandTop = CARD_X;
  const headlineTop = bandTop + BAND_H + 34;
  const afterHeadline = headlineTop + headlineLines.length * HEADLINE_LINE_H;
  const metaTop = afterHeadline + 8;
  const tableTop = showMeta ? metaTop + META_H + 14 : afterHeadline + 18;
  const rowsTop = tableTop + TABLE_HEADER_H;
  const rowsBottom = rowsTop + bodyHeight;
  // A single-sale receipt also prints "Paid to" above the footer rule.
  const footerRule = rowsBottom + (single ? 66 : 40);
  const footerBaseline = footerRule + 26;
  const height = showFooter ? footerBaseline + 88 : rowsBottom + 30;

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
  if (showFooter) {
    ctx.font = font(600, 11);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
    ctx.fillText('NET PAYOUT', RIGHT, bandTop + 40);
    ctx.font = font(700, 30);
    ctx.fillStyle = C.gold;
    ctx.fillText(gold(totals.net), RIGHT, bandTop + 80);
  } else {
    ctx.font = font(700, 16);
    ctx.fillStyle = C.gold;
    ctx.fillText(`PAGE ${pageIndex + 1} OF ${pageCount}`, RIGHT, bandTop + 62);
  }

  // Headline
  ctx.textAlign = 'left';
  ctx.font = font(500, 17);
  ctx.fillStyle = C.ink;
  headlineLines.forEach((line, index) => {
    ctx.fillText(line, INNER_X, headlineTop + index * HEADLINE_LINE_H);
  });

  // Meta columns
  if (showMeta) {
    const metaColumns = single
      ? [
        { label: 'DATE', value: traderSaleDate(first.time) },
        { label: 'TRANSACTION ID', value: `#${first.eventId || 'unknown'}` },
        { label: 'BUYER', value: String(first.buyer || 'Unknown') }
      ]
      : [
        { label: 'SALES', value: String(list.length) },
        { label: 'BUYERS', value: String(groups.length) },
        { label: 'ITEMS SOLD', value: String(totals.quantity) }
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
  }

  // Table header
  ctx.fillStyle = C.stripe;
  ctx.fillRect(INNER_X, tableTop, INNER_W, TABLE_HEADER_H);

  const { colQty, colUnit, itemX } = columnLayout(single);

  const headerY = tableTop + 22;
  ctx.font = font(700, 11);
  ctx.fillStyle = C.muted;
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

  for (const row of rows) {
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
    const textY = cursor + (single ? 26 : 23);

    ctx.textAlign = 'left';
    if (!single) {
      ctx.font = font(500, 13);
      ctx.fillStyle = C.muted;
      ctx.fillText(clipLine(ctx, shortSaleDate(sale.time), SOLD_COLUMN_W - 14), INNER_X + 16, textY);
    }

    ctx.font = font(500, single ? 15 : 14);
    ctx.fillStyle = C.ink;
    row.lines.forEach((line, index) => {
      ctx.fillText(line, itemX, textY + index * ROW_LINE_H);
    });

    ctx.textAlign = 'right';
    ctx.fillStyle = C.ink;
    ctx.fillText(String(num(sale.quantity)), colQty, textY);
    ctx.fillText(gold(sale.unitPrice), colUnit, textY);
    ctx.font = font(600, 15);
    ctx.fillText(gold(sale.price), RIGHT, textY);

    ctx.beginPath();
    ctx.moveTo(INNER_X, cursor + row.height - 1);
    ctx.lineTo(RIGHT, cursor + row.height - 1);
    ctx.stroke();

    cursor += row.height;
  }

  if (single && first.seller) {
    ctx.font = font(500, 13);
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'left';
    ctx.fillText(clipLine(ctx, `Paid to ${first.seller}`, INNER_W - 200), INNER_X, rowsBottom + 34);
  }

  if (!showFooter) return canvas.encode('png');

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
    { label: 'Gross sales', value: gold(totals.gross), color: C.ink, size: 13, weight: 600 },
    { label: 'Guild tax', value: totals.tax > 0 ? `−${gold(totals.tax)}` : gold(0), color: C.ink, size: 13, weight: 600 },
    { label: 'Net profit', value: gold(totals.net), color: C.band, size: 16, weight: 700 }
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

/**
 * Render trader sales as one or more PNG receipt pages.
 *
 * A single sale keeps the detailed receipt. A list is split across as many
 * pages as it needs, with the totals and the footer on the last page only.
 *
 * @param {{sales?: object[], kind?: 'sale'|'invoice', caption?: string, footerNote?: string}} notice
 * @returns {Promise<Buffer[]>}
 */
export async function renderTraderInvoiceImages({ sales = [], kind = 'sale', caption = '', footerNote = '' } = {}) {
  const list = (Array.isArray(sales) ? sales : []).filter(Boolean);
  if (!list.length) throw new Error('No trader sales to render.');

  const single = kind !== 'invoice' && list.length === 1;
  const groups = groupSalesByBuyer(list);
  const first = list[0];
  const guildName = String(first.guildName || '').trim() || 'GuildSync';
  const totals = {
    gross: sum(list, 'price'),
    tax: sum(list, 'tax'),
    net: sum(list, 'net'),
    quantity: sum(list, 'quantity')
  };

  if (single) {
    const measuring = createCanvas(8, 8).getContext('2d');
    const { itemWidth } = columnLayout(true);
    const lines = itemLines(measuring, first.itemName, itemWidth, 15);
    const headline = String(caption || '').trim()
      || `Congratulations! You sold ${first.itemName || 'an item'} on the ${guildName} Trader — the details are below.`;

    return [await drawReceiptPage({
      rows: [{ type: 'item', sale: first, lines, height: SINGLE_ROW_H + (lines.length - 1) * ROW_LINE_H }],
      single: true,
      first,
      list,
      groups,
      headline,
      footerNote,
      totals,
      guildName
    })];
  }

  const pages = planReceiptPages(list);
  const headline = String(caption || '').trim() || defaultInvoiceHeadline(list.length);
  const images = [];

  for (let index = 0; index < pages.length; index += 1) {
    images.push(await drawReceiptPage({
      rows: pages[index],
      single: false,
      first,
      list,
      groups,
      headline,
      footerNote,
      totals,
      guildName,
      pageIndex: index,
      pageCount: pages.length
    }));
  }

  return images;
}
