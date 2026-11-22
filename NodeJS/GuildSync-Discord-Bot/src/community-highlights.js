// The bot reads the same report the Community Highlights panel shows. The backend builds
// it for the bot as a viewer, so gold amounts never reach Discord even when the guild
// shows them to its own users.
export function requestCommunityHighlights(socket, { timeZone = 'America/New_York', timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) return reject(new Error('GuildSync is temporarily unavailable. Please try again.'));
    socket.timeout(timeoutMs).emit('guildsync:request-community-statistics', { timeZone }, (error, response) => {
      if (error) return reject(new Error('GuildSync did not respond. Please try again.'));
      if (!response?.ok || !response.report || !Array.isArray(response.report.highlights)) {
        return reject(new Error(response?.message || 'Community highlights are unavailable.'));
      }
      resolve(response.report);
    });
  });
}

const MAX_CONTENT = 1900;
const number = value => Number(value || 0).toLocaleString('en-US');

// One Discord message: the overview line, then each card that has rows. Amounts appear
// only when the report carries them, which it does not for the bot.
export function formatCommunityHighlights(report, { rowsPerCard = 3 } = {}) {
  if (!report) return 'No community highlights are available yet.';
  const lines = ['**Community Highlights**'];
  const overview = Array.isArray(report.overview) ? report.overview : [];
  if (overview.length) lines.push(overview.map(item => `${item.label}: ${number(item.value)}`).join(' · '));
  const cards = (report.highlights || []).filter(card => Array.isArray(card.rows) && card.rows.length);
  for (const card of cards) {
    const rows = card.rows.slice(0, rowsPerCard).map(row => {
      if (card.hideValue) return row.name;
      const unit = card.unit ? ` ${card.unit}` : '';
      return `${row.name} — ${number(row.value)}${unit}`;
    });
    lines.push('', `**${card.title}**`, rows.join('\n'));
  }
  if (!cards.length) lines.push('', 'No records yet.');
  let content = lines.join('\n');
  if (content.length > MAX_CONTENT) content = `${content.slice(0, MAX_CONTENT - 1).trimEnd()}…`;
  return content;
}
