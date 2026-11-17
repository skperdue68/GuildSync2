// A receipt is one picture for everyone, so a message that has to show a local
// time uses Discord's <t:…:f> stamp: every client renders it in the reader's own
// time zone, which is why the time is not baked into the text here.
const stamp = (value) => {
  const seconds = Math.round(Number(value) || 0);
  return seconds > 0 ? `<t:${seconds}:f>` : '';
};

// A backend that predates the feature sends no timestamp at all. That is not
// the same as an empty table, so it gets its own answer instead of claiming
// nothing is stored while sales are on screen.
const hasLatest = (value) => value !== undefined
  && value !== null
  && String(value).trim() !== ''
  && Number.isFinite(Number(value));

/**
 * "As of <now> — most recent GuildSync info at <newest trader entry>."
 *
 * `latestEntryTime` is the newest event_timestamp in guildsync_trader_entries:
 * a positive stamp is shown as a local time, a real zero means the table is
 * empty, and a missing value means the sender did not say.
 */
export function traderInfoLine({ now = Math.floor(Date.now() / 1000), latestEntryTime } = {}) {
  const asOf = stamp(now) || 'now';

  if (!hasLatest(latestEntryTime)) {
    return `As of ${asOf} — the GuildSync backend did not report when its trader data was last updated.`;
  }

  const latest = Number(latestEntryTime);
  if (latest <= 0) {
    return `As of ${asOf} — no GuildSync trader info is stored yet.`;
  }

  return `As of ${asOf} — most recent GuildSync info at <t:${Math.round(latest)}:f>.`;
}
