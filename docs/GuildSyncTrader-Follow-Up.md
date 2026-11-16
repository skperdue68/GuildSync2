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

## Table

`guildsync_trader_entries`: `event_id`, `guild_id`, `guild_name`, `world`, `seller`, `buyer`,
`item_link`, `item_id`, `item_name`, `quantity`, `price`, `unit_price`, `tax`, `net`,
`event_timestamp`, `event_datetime`, `data_source`, `uploaded_at`. Primary key
(`guild_id`, `event_id`) provides eventId dedupe.

## Tests

- `ESO/tests/trader.lua` covers streaming, dedupe, catch-up, reset, the pending-row guild switch,
  and per-guild checkpoints.
- `GO/GuildSync-Frontend-Client/trader_export_test.go` covers world/legacy profiles and commit cleanup.
- `NodeJS/GuildSync-Backend-Server/trader-import.test.js` covers SavedVars parsing and deduped inserts.

## Still separate

Discord subscriber announcements for trader updates are not part of this change. They can read
`guildsync_trader_entries` once the notification design is agreed.

## Commands

`/gst stream`, `/gst catchup`, `/gst dump`, `/gst reset`, `/gst stop`, `/gst status`, `/gst guild`,
`/gst debug`.
