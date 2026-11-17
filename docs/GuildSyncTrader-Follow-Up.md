# GuildSyncTrader storage path

The GuildSyncTrader add-on (`ESO/GuildSyncTrader`) streams trader sales from LibHistoire into the
`GuildSyncTrader` / `GuildSyncTraderState` SavedVars tables. The storage path below is implemented.
GuildSyncBanking is untouched.

## Data path

1. The add-on saves each sale with `eventId`, `guildId`, `guildName`, `time`, `seller`, `buyer`,
   `itemLink`, `itemId`, `itemName`, `quantity`, `price`, `unitPrice`, `tax`, and `net`.
   SavedVars are keyed by world (`GetWorldName()` profile), so the file layout is
   `GuildSyncTrader[world]["@account"]["$AccountWide"].trades`.
2. The desktop file watcher watches `GuildSyncTrader.lua` (key `trader`,
   `SAVED_VARS_TRADER_FILE_NAME` / `SAVED_VARS_TRADER_TABLE_NAME`).
   `CollectGuildSyncTraderData` reads the world profile (falling back to legacy `Default`), sends the
   rows, and `CommitGuildSyncTraderData` clears only `trades` after the backend ACK, with a backup.
3. The backend accepts `guildsync:sending-trader-data`, `GuildSyncTrader.lua` in the raw upload
   allowlist, and `POST /api/guildsync/upload-savedvars/trader`. Rows are stored in
   `guildsync_trader_entries` in the same database as `guildsync_banking_entries`, deduped by
   `(guild_id, event_id)`.
4. `/gst guild <name or ESO guild ID>` no longer blocks while rows are pending. Rows carry their own
   `guildId` / `guildName`, so a switch cannot mix guilds and per-guild checkpoints stay separate.
5. ESO account renames propagate to trader rows: `seller` is a primary identity reference and `buyer`
   a secondary one, with the imported name preserved in `seller_original` / `buyer_original`. Renamed
   members keep their sale history on both sides.

## Table

`guildsync_trader_entries`: `event_id`, `guild_id`, `guild_name`, `world`, `seller`,
`seller_original`, `buyer`, `buyer_original`, `item_link`, `item_id`, `item_name`, `quantity`,
`price`, `unit_price`, `tax`, `net`, `event_timestamp`, `event_datetime`, `data_source`,
`uploaded_at`. Primary key (`guild_id`, `event_id`) provides eventId dedupe.

## Sale notifications

`/trader on` and `/trader off` are global Discord commands, so they work in the guild and in DMs;
`/trader register` and `/trader unregister` are accepted as aliases for the same two actions.
`/trader sales <item>` searches the linked account's own sales for any part of an item name (spaces
allowed) and answers with the same receipt, or `There are no sales entries for an item named <item>.`
Its receipt opens with a neutral caption (`Your sale of Soul Gem.` or `Your 2 sales matching “blueprint”.`)
rather than the congratulations line, since a search result is not a fresh sale. The item match runs
through `LOWER(item_name) LIKE LOWER(?)`, so it is case-insensitive whatever the column collation is.
It replies privately to the caller and never enters the DM queue. Only the newest 50 matching sales are
searched, and both the reply and the receipt say so when the list was cut off instead of implying that
is everything.
`/trader receipt` DMs a receipt for the newest stored sale of the linked account as if it had just
happened, and confirms where the command was typed (ephemerally in a channel, in the DM itself when
the command was a DM) with the freshness line, `Sent your newest sale receipt to your DMs.` and the
same totals as text. It ignores the subscription cutoff below, so the receipt can be checked without
waiting for a live sale, and it is a replay rather than an announcement, so it is not recorded as a
sale already sent.
`/trader status` answers whether receipts are on for the linked account, since when, and whether the
bot's last receipt DM to that member failed, so someone whose DMs are closed is told instead of
silently missing every receipt. Run the bot's `npm run deploy` once to register the global command
(the same PUT removes the retired global `/sales` command). The deploy is also the place `/trader
test` disappears: it deletes a global `/trader` that still lists it, puts the current definition, then
reads both command sets back and fails if `/trader receipt` is missing, `/trader test` is still offered,
or a guild-scoped `/trader` remains. A
Discord account must have a `linked` row in `guildsync_member_links`; otherwise the bot explains how
to link the account and who to contact for help. Subscriptions live in
`guildsync_trader_sales_subscriptions` (one row per Discord user) and the linked ESO name is resolved
when each sale is sent, so renames and re-links keep working.

Trader data arrives as one SavedVars batch, so each subscriber gets at most one DM per import. Every
DM is the receipt image alone (`trader-sales-receipt.png`, or `-1.png`, `-2.png` … when the list runs over
several pages, headed **TRADER SALES RECEIPT**) with no
caption text beside it: date, transaction ID, buyer, item, quantity, unit price and amount, plus the
guild name and NET PAYOUT total in the header band. The bottom right corner stacks gross sales, guild
tax and net profit one under the other, right aligned, with the net emphasised; the guild name and the
transaction number (one sale) or the sale and buyer count (several sales) sit to its left. The PNG is drawn at
2× resolution, so the inline preview stays modest while opening the image shows a full-size, sharp
receipt. Times are Eastern Time, labelled with the current EST or EDT. The bot writes that PNG to the OS temp directory, attaches it with `attachment://`, and
deletes the file as soon as Discord has the message. Notices are queued instead of sent in a
burst: about two seconds between DMs, then a one to two minute pause after every five, so a
catch-up import is never mistaken for spam. If rendering fails, the DM falls back to a
details embed carrying every field (and, for several sales, the buyer-grouped item list), so the
information is never lost. Two or more sales become a list receipt headed `Last <n> sales.`, grouped by
buyer and then by sale time with one row per item. Each row starts with the full sale date and time,
`Nov 17 · 5:15 AM EST`, and the item name wraps onto a second line when it needs the room instead of
pushing the timezone out of view. The list is split across as many pages as the rows need: every page
repeats the buyer headings and the header shows `PAGE 2 OF 3`, while the totals, the footer and the
NET PAYOUT figure appear on the last page only. All pages arrive together in the same DM, so no sale is
dropped and no "and N more sales" line is needed. A single sale keeps the detailed one-page receipt.
This applies to live uploads and `/gst catchup` alike. Sales
older than the subscription are skipped, so enabling notifications never floods someone with old
history.

Every announced sale is also recorded per recipient in `guildsync_trader_sale_notices`, keyed by
`(discord_user_id, guild_id, event_id)`, so a retried or replayed import cannot DM the same sale twice.
The guild is part of that key because trader entries are deduped per guild. The row
is marked delivered only when the bot acknowledges the notice, so a notice the bot never took (offline,
restart, dropped connection) stays pending and is sent when the bot connects again. A DM that fails,
for example because the member closed their DMs, is recorded on the subscription and shown by
`/trader status`. The backend stamps every subscription reply with a protocol number and the bot logs
once when it is talking to an older backend, instead of leaving receipts looking like they lost their
timestamps.

## Tests

- `ESO/tests/trader.lua` covers streaming, dedupe, catch-up, reset, the pending-row guild switch,
  and per-guild checkpoints.
- `GO/GuildSync-Frontend-Client/trader_export_test.go` covers world/legacy profiles and commit cleanup.
- `NodeJS/GuildSync-Backend-Server/trader-import.test.js` covers SavedVars parsing and deduped inserts.
- A MariaDB 11.4.5 run confirmed the created schema, duplicate re-imports being ignored, the same
  eventId inserting once per guild, and `@OldName` renames updating trader seller and buyer while
  retaining the imported names in `seller_original` / `buyer_original`.
- `trader-sales-subscriptions.test.js` covers link-gated subscriptions, one notice per import, age
  filtering, buyer/time ordering, the bot socket handler, the protocol stamp, the receipt replay, the
  announced-sale de-duplication, pending replay and the failed-DM record.
- Bot tests cover `/trader` replies (including `receipt` and `status`), the text summary line, the
  short caption embed, the details fallback embeds, the PNG render, notice acknowledgement, pending
  replay on connect, and temp-file cleanup after sending.

## Still separate

Discord subscriber announcements for trader updates are not part of this change. They can read
`guildsync_trader_entries` once the notification design is agreed.

## Commands

`/gst stream`, `/gst catchup`, `/gst dump`, `/gst reset`, `/gst stop`, `/gst status`, `/gst guild`,
`/gst debug`.

## Planned follow-ups

Updated after `/trader receipt`, `/trader status`, the protocol stamp, the text summary and the
notice table shipped. Items 1, 2, 3, 4, 7 and 12 of the previous list are done: every reply carries
`protocol`, `/trader status` reports the subscription and the last failed DM, every receipt DM and
reply carries `N sales · gross · tax · net`, announcements are deduplicated per
`(recipient, guild, eventId)` and replayed after a reconnect, and `/trader test` is gone.

Still open, ranked by value per hour:

1. **Notice retention for undelivered rows.** Delivered notices are pruned after 90 days; a pending
   row for a member who never comes back lives forever. Add a cut-off and a log line when it fires.
   Small.
2. **End-to-end notify test.** `notifyTraderSaleSubscribers` in `guildsync-backend-server.js` has no
   test because the file is too large to import cheaply: the announce and delivery-mark pieces it
   calls are tested, the wiring is not. Medium.
3. **Idempotent replay.** A notice is marked delivered when the bot acknowledges the attempt, so a
   lost acknowledgement can duplicate one DM. A per-notice token the bot remembers would close it.
   Medium.
4. **Visual regression fixtures.** Render 1 / 15 / 50 sales, long and non-ASCII names, zero tax and
   huge amounts, then compare hashes. Every layout defect so far was found by eye; only three strings
   are width-tested today. Medium.
5. **Settle the image timezone.** Either one zone per guild or drop the per-row zone label and state
   it once in the header. Today the message line is the reader's local time while the image says
   Eastern: two times for the same sale. Small with a guild setting (medium if it needs config).
6. **Search depth.** `/trader sales` stops at the newest 50 matches, so older history of a fast-selling
   item is unreachable; add `before:`/`after:` or page the search itself. Small to medium.
7. **Officer view and export.** Permission-gated lookup of another member's sales, and/or CSV output;
   reconciliation is an officer job and currently means forwarding a DM. Medium, needs a permission
   decision first.
8. **Verify registration after `npm run deploy`.** Read the global and guild command sets back and
   print them, so a stale description or a duplicate definition shows up before typing the command.
   Small.
