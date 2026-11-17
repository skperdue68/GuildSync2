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
`/trader register` and `/trader unregister` are accepted as aliases for the same two actions. Run the
bot's `npm run deploy` once to register the global command (the same PUT removes the retired global
`/sales` command). A
Discord account must have a `linked` row in `guildsync_member_links`; otherwise the bot explains how
to link the account and who to contact for help. Subscriptions live in
`guildsync_trader_sales_subscriptions` (one row per Discord user) and the linked ESO name is resolved
when each sale is sent, so renames and re-links keep working.

Trader data arrives as one SavedVars batch, so each subscriber gets at most one DM per import. Every
DM is a short congratulations caption (guild, item or sale count, and the arithmetic
`unit × quantity − tax = net`) with the full invoice attached as a rendered PNG
(`trader-invoice.png`): date, transaction ID, buyer, item, quantity, unit price, amount, subtotal, tax
and net payout. The bot writes that PNG to the OS temp directory, attaches it with `attachment://`,
and deletes the file as soon as Discord has the message. Notices are queued instead of sent in a
burst: about two seconds between DMs, then a one to two minute pause after every five, so a
catch-up import is never mistaken for spam. If rendering fails, the DM falls back to a
details embed carrying every field (and, for several sales, the buyer-grouped item list), so the
information is never lost. Two or more matching sales become one
combined invoice, grouped by buyer and then by sale time, with one row per item and a grand total for
sales, quantity, gross, tax and net. This applies to live uploads and `/gst catchup` alike. Sales
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
