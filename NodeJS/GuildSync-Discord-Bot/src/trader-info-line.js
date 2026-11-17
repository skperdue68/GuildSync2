// A receipt is one picture for everyone, so a message that has to show a local
// time uses Discord's <t:…:f> stamp: every client renders it in the reader's own
// time zone, which is why the time is not baked into the text here.
const stamp = (value) => {
  const seconds = Math.round(Number(value) || 0);
  return seconds > 0 ? `<t:${seconds}:f>` : '';
};

/**
 * "As of <now> — most recent GuildSync info at <newest trader entry>."
 *
 * `latestEntryTime` is the newest event_timestamp in guildsync_trader_entries,
 * so the reader can judge how up to date the sales below it are.
 */
export function traderInfoLine({ now = Math.floor(Date.now() / 1000), latestEntryTime = 0 } = {}) {
  const asOf = stamp(now) || 'now';
  const latest = stamp(latestEntryTime);

  return latest
    ? `As of ${asOf} — most recent GuildSync info at ${latest}.`
    : `As of ${asOf} — no GuildSync trader info is stored yet.`;
}
