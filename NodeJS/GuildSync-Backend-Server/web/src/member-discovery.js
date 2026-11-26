const text = value => String(value ?? '').trim();
const escape = value => text(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function discordDisplayName(member = {}) {
  return [member.server_nickname, member.global_name, member.username, member.discord_id].map(text).find(Boolean) || 'Unknown';
}

export function renderDiscordNames(member = {}, {matchField = '', fuzzy = false} = {}) {
  const fields = [
    {label: 'Username', keys: ['discord_username', 'username'], value: member.username ?? member.discord_username},
    {label: 'Global Name', keys: ['discord_display_name', 'global_name', 'display_name'], value: member.global_name ?? member.discord_display_name},
    {label: 'Server Nickname', keys: ['discord_server_nickname', 'server_nickname', 'nickname'], value: member.server_nickname ?? member.discord_server_nickname}
  ];
  const selected = text(matchField).toLowerCase().replaceAll(' ', '_');
  return `<span class="member-discord-names">${fields.map(field => {
    const matched = Boolean(text(field.value)) && (field.keys.includes(selected) || field.label.toLowerCase().replaceAll(' ', '_') === selected);
    const value = escape(field.value) || 'Not set';
    return `<span class="member-discord-name"><span class="member-discord-name-label">${field.label}:</span> ${matched
      ? `<mark class="member-name-match${fuzzy ? ' member-name-match-fuzzy' : ''}">${value}</mark><small class="member-name-match-label">${fuzzy ? 'Fuzzy match' : 'Matched'}</small>`
      : `<span>${value}</span>`}</span>`;
  }).join('')}</span>`;
}

// Only the latest, still-empty visible search may open a history dialog.
export function createMemberHistoryFallback({context, request, open, delayMs = 700, setTimer = setTimeout, clearTimer = clearTimeout}) {
  let generation = 0, timer = null;
  function cancel() {
    generation++;
    clearTimer(timer);
    timer = null;
  }
  function schedule(kind) {
    cancel();
    const original = context(kind);
    if (!original.eligible || !text(original.query)) return;
    const token = generation;
    const current = () => {
      const latest = context(kind);
      return token === generation && latest.eligible && latest.query === original.query && latest.tab === original.tab && latest.session === original.session;
    };
    const run = async () => {
      timer = null;
      if (!current()) return;
      if (context(kind).loading) {
        timer = setTimer(run, delayMs);
        return;
      }
      try {
        const response = await request(kind, original.query);
        if (!current() || !response?.ok || !Array.isArray(response.matches) || !response.matches.length) return;
        open(kind, {query: original.query, matches: response.matches});
      } catch {
        // Background lookup failure leaves the user's current list and search intact.
      }
    };
    timer = setTimer(run, delayMs);
  }
  return {schedule, cancel};
}
