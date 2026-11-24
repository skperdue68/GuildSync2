# GuildSyncDiscordReminder

Sends officer-requested ESO mail asking active guild members for their Discord usernames. GuildSync selects recipients; the add-on sends automatically on the next login. No LibHistoire dependency. LibAddonMenu-2.0 is optional for its settings panel.

## Install and use

1. Install this folder in ESO's `live/AddOns` directory. Update GuildSyncBanking too: both add-ons now cooperate through the shared runtime `GuildSyncMailQueueOwner` lock.
2. Enable the add-on, log in once with the account that will send the mail, then exit ESO completely. ESO creates `SavedVariables/GuildSyncDiscordReminder.lua`.
3. In GuildSync, open **Guild Roster → Discord Reminders**, beside **Lookup Roster History**. User or Admin access is required. Review eligible members, choose the sending account and NA/EU server, then choose **Queue reminders**. You can queue while ESO is running: GuildSync stores the batch and writes it to the add-on SavedVariables file as soon as ESO is closed, keeping a backup of the previous file.
4. Start ESO. After player activation the add-on waits for Banking and any observed outstanding send, opens the mailbox, waits two seconds for it to become usable (the same way GuildSyncBanking does), then sends one reminder at a time. It waits for ESO's confirmation and then waits three seconds before the next message. Mailbox open/close events are not used, so a close during login cannot stop the queue.
5. Exit ESO or `/reloadui` to persist the results, then use **Read saved delivery results** in the dialog to import them. GuildSync no longer places this SavedVariables file on its File Watch list; the export and read buttons handle it directly.

The backend must have `GUILDSYNC_ESO_GUILD_ID` configured. Optional `GUILDSYNC_ESO_GUILD_NAME` overrides the guild name in the message; when it is unset, or a queued request still carries the old "Your guild" placeholder, the add-on fills in the in-game guild name from the request's guild ID. The database remains scoped to one ESO guild.

## Test a message

In the same dialog, choose the sending account/server, enter an ESO account under **Test recipient**, and click **Queue one test mail**. It joins the next export and is written when ESO is closed. On the next login the add-on sends it through the same coordinated queue, with `[TEST]` in the subject. Tests do not change a member's normal reminder dates or cooldown.

## Templates and controls

Edit the subject, body and optional candidate paragraph under **Settings → Addons → GuildSyncDiscordReminder** with LibAddonMenu installed, or use:

- `/gsdr subject <text>`
- `/gsdr body <text>`
- `/gsdr candidate <text>`

Use `\n` for new lines. Placeholders: `{account}`, `{guild}`, `{rank}`, `{candidate}` and `{candidateName}`. The shipped default body is the current Alphabet Mafia wording; updating from an older add-on replaces a body that still holds the previous default and leaves an edited template untouched. `{candidate}` expands to the configurable candidate paragraph only when a candidate Discord name exists. Candidate matches are explicitly presented as questions.

`/gsdr status` reports counts and failed/uncertain request IDs. `/gsdr preview` prints a queued message. `/gsdr pause` pauses after the current send result. `/gsdr resume` resumes pending/failed work. An uncertain delivery is never automatically retried: first review your sent mail, then use `/gsdr retry <requestId>` only if you intend to retry it.

ESO enforces subject/body limits. The add-on stops rather than silently truncating a message. It never sends attached gold, items or COD; clear an existing attachment draft before resuming.

When ESO rejects a mail, the status reports the recipient and a readable reason, for example `ESO rejected the mail to @Name: the recipient name is invalid (reason 2).` A rejection that belongs to one recipient — an invalid name, a recipient ignoring you, or the sending account itself — marks that request failed and continues with the next member. Server, mailbox, attachment and money problems pause the queue for an officer to fix. `/gsdr resume` retries failed requests.

## Reminder history and opt-outs

Open a member's link window from the roster's **Discord Account Linked** dot (or from the Discord member list) to see a **Guild Roster · Discord reminder** section with separate **Exported** and **Sent** timestamps and a **Does not use Discord** checkbox. Opted-out members show a purple link dot in both lists. Opt-outs and history use stable ESO member IDs, surviving account renames and leaving/rejoining. The repeat interval defaults to 30 days and can be changed to 1–365 days. Recent exports or sends and unresolved requests prevent new duplicate campaigns.

Re-exporting a batch rechecks confirmed links, roster presence and opt-outs. Cancelled requests are removed from the local queue. Setting an opt-out in the desktop app also attempts that cleanup; ESO must be closed for local changes. If ESO is running, pause the add-on and close ESO so GuildSync can remove already queued messages. A saved opt-out cannot recall mail already sent.

The local file is backed up and replaced only while ESO is closed. Other accounts, settings and sent history are preserved. SavedVariables are written by ESO on reload/logout, so a game crash can lose the latest confirmations. Exact-once mail delivery cannot be guaranteed across that persistence boundary. Do not compose other mail during a batch; observed competing sends pause the reminder queue rather than attributing their results to it.

## Validation

The Lua harness is `ESO/tests/discord-reminder.lua` (Fengari/Lua). It covers queue activation, Banking ownership, candidate templates, strict recipient confirmation, pacing, failure and timeout. Backend/Go/frontend tests cover selection, dates, permissions, serialization, preservation, cancellation and export ordering. A live ESO smoke test is still required to verify delivery and installed add-on interaction on a game server.
