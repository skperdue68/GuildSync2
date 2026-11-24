# GuildSyncDiscordReminder

Sends officer-requested ESO mail asking active guild members for their Discord usernames. GuildSync selects recipients; the add-on sends automatically on the next login. No LibHistoire dependency. LibAddonMenu-2.0 is optional for its settings panel.

## Install and use

1. Install this folder in ESO's `live/AddOns` directory. Update GuildSyncBanking too: both add-ons now cooperate through the shared runtime `GuildSyncMailQueueOwner` lock.
2. Enable the add-on, log in once with the account that will send the mail, then exit ESO completely. ESO creates `SavedVariables/GuildSyncDiscordReminder.lua`.
3. In GuildSync, open **Guild Roster → Discord Reminders**, beside **Lookup Roster History**. User or Admin access is required. Review eligible members, choose the sending account and NA/EU server, then choose **Write reminders to add-on**.
4. Start ESO. After player activation the add-on waits for Banking and any observed outstanding send, opens the mailbox and sends one reminder at a time. It waits for ESO's confirmation and then waits three seconds before the next message.
5. Exit ESO or `/reloadui` to persist the results. GuildSync's Discord Reminders file watcher reads acknowledgements; the dialog also offers **Read saved delivery results**.

The backend must have `GUILDSYNC_ESO_GUILD_ID` configured. Optional `GUILDSYNC_ESO_GUILD_NAME` supplies the message's guild name; set it to your guild. The database remains scoped to one ESO guild.

## Test a message

In the same dialog, choose the sending account/server, enter an ESO account under **Test recipient**, and click **Write one test mail** while ESO is closed. On the next login the add-on sends it through the same coordinated queue, with `[TEST]` in the subject. Tests do not change a member's normal reminder dates or cooldown.

## Templates and controls

Edit the subject, body and optional candidate paragraph under **Settings → Addons → GuildSyncDiscordReminder** with LibAddonMenu installed, or use:

- `/gsdr subject <text>`
- `/gsdr body <text>`
- `/gsdr candidate <text>`

Use `\n` for new lines. Placeholders: `{account}`, `{guild}`, `{rank}`, `{candidate}` and `{candidateName}`. `{candidate}` expands to the configurable candidate paragraph only when a candidate Discord name exists. Candidate matches are explicitly presented as questions.

`/gsdr status` reports counts and failed/uncertain request IDs. `/gsdr preview` prints a queued message. `/gsdr pause` pauses after the current send result. `/gsdr resume` resumes pending/failed work. An uncertain delivery is never automatically retried: first review your sent mail, then use `/gsdr retry <requestId>` only if you intend to retry it.

ESO enforces subject/body limits. The add-on stops rather than silently truncating a message. It never sends attached gold, items or COD; clear an existing attachment draft before resuming.

## Reminder history and opt-outs

The roster's **Discord Reminder** column shows separate **Exported** and **Sent** timestamps and a **Does not use Discord** checkbox. Opt-outs and history use stable ESO member IDs, surviving account renames and leaving/rejoining. The repeat interval defaults to 30 days and can be changed to 1–365 days. Recent exports or sends and unresolved requests prevent new duplicate campaigns.

Re-exporting a batch rechecks confirmed links, roster presence and opt-outs. Cancelled requests are removed from the local queue. Setting an opt-out in the desktop app also attempts that cleanup; ESO must be closed for local changes. If ESO is running, pause the add-on and close ESO so GuildSync can remove already queued messages. A saved opt-out cannot recall mail already sent.

The local file is backed up and replaced only while ESO is closed. Other accounts, settings and sent history are preserved. SavedVariables are written by ESO on reload/logout, so a game crash can lose the latest confirmations. Exact-once mail delivery cannot be guaranteed across that persistence boundary. Do not compose other mail during a batch; observed competing sends pause the reminder queue rather than attributing their results to it.

## Validation

The Lua harness is `ESO/tests/discord-reminder.lua` (Fengari/Lua). It covers queue activation, Banking ownership, candidate templates, strict recipient confirmation, pacing, failure and timeout. Backend/Go/frontend tests cover selection, dates, permissions, serialization, preservation, cancellation and export ordering. A live ESO smoke test is still required to verify delivery and installed add-on interaction on a game server.
