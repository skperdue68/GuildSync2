const gold = (value) => `${Math.round(Number(value) || 0).toLocaleString('en-US')}g`;

const total = (sales, field) => sales.reduce((sum, sale) => sum + (Number(sale[field]) || 0), 0);

/**
 * The headline numbers as text.
 *
 * A receipt is a picture, so this line is the part that can be searched in
 * Discord, copied into a spreadsheet, or read out by a screen reader.
 */
export function receiptSummary(sales = []) {
  const list = Array.isArray(sales) ? sales.filter(Boolean) : [];
  if (!list.length) return '';

  const count = list.length;

  return [
    `${count} sale${count === 1 ? '' : 's'}`,
    `${gold(total(list, 'price'))} gross`,
    `${gold(total(list, 'tax'))} tax`,
    `${gold(total(list, 'net'))} net`
  ].join(' · ');
}
