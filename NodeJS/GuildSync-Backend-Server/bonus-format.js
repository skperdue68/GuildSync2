// One place for the wording and numbers every raffle-bonus surface prints, so the
// deposit receipt, the raffle summaries the bot posts, the banking table/CSV and the
// spreadsheet export cannot drift apart.
const amount = value => {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.trunc(number).toLocaleString('en-US') : '0';
};

export function formatBonusTickets(value) {
  return amount(value);
}

export function formatBonusDeadline(timestamp) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).format(new Date(seconds * 1000)) + ' ET';
}

// Compact label for a purchase or raffle: "20% bonus · +20 · 120 total".
export function formatBonusLabel({ percent, tickets, total } = {}) {
  const bonusPercent = Number(percent) || 0;
  if (!(bonusPercent > 0)) return '';
  const parts = [`${bonusPercent}% bonus`];
  if (Number(tickets) > 0) parts.push(`+${amount(tickets)}`);
  if (Number(total) > 0) parts.push(`${amount(total)} total`);
  return parts.join(' · ');
}

// "10% until September 22, 2026 at 7:00 PM ET, then 5% until September 25, 2026 at 7:00 PM ET"
export function formatBonusSchedule(ladder) {
  return (Array.isArray(ladder) ? ladder : [])
    .filter(step => Number(step?.percent) > 0)
    .map(step => `${Number(step.percent)}% until ${formatBonusDeadline(step.expiresAt)}`)
    .join(', then ');
}
