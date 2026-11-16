# GuildSyncTrader follow-up

The GuildSyncTrader add-on (`ESO/GuildSyncTrader`) is built and streams trader sales into the
`GuildSyncTrader` / `GuildSyncTraderState` SavedVars tables. The steps below are recorded for the next
pass and are **not** implemented yet. GuildSyncBanking must stay untouched.

## 1. Backend GuildSyncTrader table

- Add `guildsync_trader_entries` to the same MariaDB database and initializer as `guildsync_banking_entries`.
- Columns: `event_id`, `guild_id`, `guild_name`, `event_timestamp`, `seller`, `buyer`, `item_link`,
  `item_id`, `item_name`, `quantity`, `price`, `unit_price`, `tax`, `net`, `uploaded_at`.
- Dedupe with a unique key on (`guild_id`, `event_id`) and INSERT IGNORE-style inserts, matching banking.

## 2. Desktop collector for GuildSyncTrader.lua

- Mirror the banking path in `GO/GuildSync-Frontend-Client`: SavedVars watch key `trader`,
  file `GuildSyncTrader.lua`, collect/commit functions, backup before cleanup, and clear rows only
  after the backend ACK.
- Parse table `GuildSyncTrader`, path `Default["@account"]["$AccountWide"].trades`, and keep
  `guildId` / `guildName`.

## 3. Import path and test

- Add the Socket.IO upload event, SavedVars upload branch, parser for `GuildSyncTrader.lua`,
  `insertTraderEntries` with duplicate handling, and a focused test alongside the banking tests.

## 4. /gst guild lock

- `/gst guild <name or ESO guild ID>` currently refuses to switch guilds while
  `GuildSyncTrader.trades` has pending rows, which can trap a player on one guild.
- Allow a safe switch without dropping rows: either flush that guild's pending rows first, or scope
  pending rows so the switch cannot mix guilds. GuildSyncTrader only; do not change GuildSyncBanking.

## Notes

- ESO only serves a rolling trader-history window. `/gst catchup` covers what LibHistoire has cached,
  not unlimited server history.
- Add-on commands: `/gst stream`, `/gst catchup`, `/gst dump`, `/gst reset`, `/gst stop`,
  `/gst status`, `/gst guild`, `/gst debug`.
