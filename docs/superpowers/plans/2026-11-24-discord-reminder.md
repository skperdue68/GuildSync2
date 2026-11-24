# GuildSyncDiscordReminder Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task by task.

**Goal:** Export eligible roster members from GuildSync and send configurable Discord reminders through an ESO add-on.

**Architecture:** A backend reminder service persists settings, opt-outs, batches and acknowledgements against stable ESO identities. A Wails 3 desktop bridge preserves ESO SavedVariables while exporting a server-authorized batch. The add-on sends automatically after login and confirms each send before acknowledging it.

**Tech Stack:** Existing Node/MySQL/Socket.IO, Wails 3/Go, vanilla JavaScript and ESO Lua.

**Spec:** User-approved GuildSyncDiscordReminder design, amended to put the launch button beside Lookup Roster History, expose reminder dates and opt-outs in the roster, and enforce a configurable reminder interval.

## Global constraints

- Keep Wails CLI, Go module and frontend runtime at 3.1.0.
- Write SavedVariables only while ESO is closed, backing up existing data and selecting the sending account explicitly.
- Automatically send after login; keep settings editable in-game.
- Only current roster members without any confirmed Discord link qualify. Opt-outs never qualify.
- Cooldown means the minimum elapsed time since the latest successful export or confirmed send. Default 30 days; configurable 1–365 days. An unresolved exported request blocks a fresh request even after cooldown.
- Separate exported and confirmed-sent dates. Unknown delivery must never become a successful acknowledgement.
- Do not send real mail or deploy production changes during validation.

## Review focus

- Members with both candidate and confirmed links must be excluded.
- Renames and leaving/rejoining the roster must retain opt-outs and contact history through stable member IDs.
- Retry after a network failure must reuse the same batch/request IDs.
- Shared mail-success events must not acknowledge another add-on's send; coordinate with Banking and pause when mail is already in flight.
- Multi-account/world SavedVariables must not target an arbitrary first account.

## Task 1: Backend service and permissions

Files: create `NodeJS/GuildSync-Backend-Server/discord-reminders.js` and `.test.js`; integrate backend startup/socket registration and role permissions.

- [ ] Write and run failing Node tests for recipient selection, cooldown boundary, opt-outs, confirmed-link exclusion, and duplicate candidate handling.
- [ ] Implement service schema, roster decoration, officer-authorized preview/create/export/ack/config/opt-out socket operations, stable identity joins and idempotent batch handling.
- [ ] Test permissions, invalid inputs, export versus send timestamps, transaction rollback and replay.

## Task 2: SavedVariables bridge

Files: create `GO/GuildSync-Frontend-Client/discord_reminder.go` and `_test.go`; extend watcher paths and frontend Wails imports.

- [ ] Write and run failing Go tests for serialization round trips, escaping, preservation, explicit account selection, and duplicate IDs.
- [ ] Implement `WriteDiscordReminderQueue(account string, records []map[string]interface{})` plus account/ack collection methods using existing Lua parser/serializer. Use backups and atomic replacement; reject exports while ESO runs.
- [ ] Run focused Go tests and the complete Go suite.

## Task 3: ESO add-on

Files: create `ESO/GuildSyncDiscordReminder/GuildSyncDiscordReminder.lua`, manifest and README; `ESO/tests/discord-reminder.lua`.

- [ ] Write and run failing Lua harness tests for automatic activation, templating, confirmation, failures, timeout, pacing, duplicate suppression and account/world mismatch.
- [ ] Implement the queue state machine, configurable settings, commands and LibAddonMenu panel. Wait for mailbox readiness and confirmed send results; prevent concurrent Banking sends.
- [ ] Run Lua harness and existing add-on tests.

## Task 4: Roster UI

Files: desktop and web `src/discord-reminders.js`; desktop/web `main.js`; web API bridge as needed.

- [ ] Write failing workflow tests for preview/export/record ordering, error recovery and opt-out updates.
- [ ] Add Discord Reminders button beside Lookup Roster History, recipient preview, interval configuration, explicit sending account, export action and saved-ack sync.
- [ ] Show dates and opt-out toggle in roster rows. Keep web read/config/opt-out support with desktop export guidance.
- [ ] Run frontend tests, backend tests and production desktop/web builds.

## Task 5: Review and delivery

- [ ] Document install, first export, configurable message placeholders, queue outcomes and in-game smoke test.
- [ ] Run repository-required Wails 3 version/build checks and inspect final diff.
- [ ] Obtain a fresh whole-branch review, address material findings, and present the exact button location and validation limitations.

## Execution ledger

- 2026-11-24: User approved continuing with automatic login sending and amended roster UI/cooldown/opt-out requirements. Interpreted their cooldown wording as excluding recently contacted members, consistent with avoiding repeated reminders.
- 2026-11-24: Isolated branch `codex/discord-reminder` from `origin/master` at `1169b4e`. Implementing inline under existing authorization.
- 2026-11-24: Implemented tasks 1–4, installation documentation, a one-recipient test export, and an automated Lua harness check. Fresh independent review addressed cancellation, foreign acknowledgements, server uncertainty and competing mail sends. Verified the actual mail-success signature directly against ESO UI documentation (`playerName` is supplied).
- Validation: complete backend suite 656/656 before the final two regression additions; focused backend/frontend suite 14/14 afterward; complete Go suite passed; frontend suite and Wails version checks passed; production desktop and web builds passed. Live ESO delivery and macOS/Linux smoke tests remain manual follow-up.
