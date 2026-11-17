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
`/trader test` sends the same receipt straight away for the newest stored sales of the linked account
and ignores the subscription cutoff below, so the DM can be checked without waiting for a live sale.
It is a temporary testing aid and can be removed once the trader path is settled. Run the
bot's `npm run deploy` once to register the global command (the same PUT removes the retired global
`/sales` command). A
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
This applies to live uploads, `/trader test` and `/gst catchup` alike. Sales
older than the subscription are skipped, so enabling notifications never floods someone with old
history.

## Tests

- `ESO/tests/trader.lua` covers streaming, dedupe, catch-up, reset, the pending-row guild switch,
  and per-guild checkpoints.
- `GO/GuildSync-Frontend-Client/trader_export_test.go` covers world/legacy profiles and commit cleanup.
- `NodeJS/GuildSync-Backend-Server/trader-import.test.js` covers SavedVars parsing and deduped inserts.
- A MariaDB 11.4.5 run confirmed the created schema, duplicate re-imports being ignored, the same
  eventId inserting once per guild, and `@OldName` renames updating trader seller and buyer while
  retaining the imported names in `seller_original` / `buyer_original`.
- `trader-sales-subscriptions.test.js` covers link-gated subscriptions, one notice per import, age
  filtering, buyer/time ordering and the bot socket handler.
- Bot tests cover `/trader` replies, the short caption embed, the details fallback embeds, the PNG
  render, and temp-file cleanup after sending.

## Still separate

Discord subscriber announcements for trader updates are not part of this change. They can read
`guildsync_trader_entries` once the notification design is agreed.

## Commands

`/gst stream`, `/gst catchup`, `/gst dump`, `/gst reset`, `/gst stop`, `/gst status`, `/gst guild`,
`/gst debug`.

## Planned follow-ups

Ranked by value per hour. None of these is started; the first three are the cheapest way to remove the
friction this work kept hitting.

1. **Bot/backend capability handshake.** The backend advertises what it supports (`latest_entry_time`,
   `test` returning sales, a protocol version) when the bot connects, so an old backend is reported in
   the log instead of silently producing an undated reply or a surprise DM. Small: one handshake field,
   one log line, one fallback string.
2. **`/trader status`.** The backend already implements `action: 'status'` (linked ESO name, enabled,
   `subscribed_at`) and nothing calls it. Surfacing it answers "am I linked, subscribed as whom, since
   when" and gives that dead branch a caller. Small.
3. **Text summary line with every receipt.** `50 sales · gross · tax · net` beside the image, because a
   PNG cannot be searched, copied into a spreadsheet or read by a screen reader. Small.
4. **Notice durability and de-duplication.** Notices are not deduplicated per (recipient, eventId), so a
   retried import can DM the same sale twice, and a whole batch is dropped with a log line when the bot
   socket is down. Medium.
5. **Visual regression fixtures.** Render 1 / 15 / 50 sales, long and non-ASCII names, zero tax and huge
   amounts, then compare hashes. Every layout defect so far was found by eye; only three strings are
   width-tested today. Medium.
6. **On-demand DM test.** `/trader test where:dm` (default stays in place) or a debug send through the
   real queue, since answering in place removed the only manual check of queue spacing and temp-file
   cleanup. Small.
7. **Surface DM delivery failures.** A closed DM (`user.send` throwing) is only logged; record it and
   report it from `/trader status`, so nobody believes they are subscribed while every receipt fails.
   Small to medium.
8. **Settle the image timezone.** Either one zone per guild or drop the per-row zone label and state
   it once in the header. Today the message line is the reader's local time while the image says
   Eastern: two times for the same sale. Small with a guild setting (medium if it needs config).
9. **Search depth.** `/trader sales` stops at the newest 50 matches, so older history of a fast-selling
   item is unreachable; add `before:`/`after:` or page the search itself. Small to medium.
10. **Officer view and export.** Permission-gated lookup of another member's sales, and/or CSV output;
    reconciliation is an officer job and currently means forwarding a DM. Medium, needs a permission
    decision first.
11. **Verify registration after `npm run deploy`.** Read the global and guild command sets back and
    print them, so a stale description or a duplicate definition shows up before typing the command.
    Small.
12. **Retire `/trader test`.** It is flagged temporary and now duplicates `/trader sales` minus the
    item filter; remove it once the trader path is settled. Small.
