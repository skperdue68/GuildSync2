# Discord membership DMs

An officer starts an alphabetical campaign for current Discord members without a confirmed ESO account link. The bot waits a random 10–15 minutes before its first attempt and between subsequent attempts. It rechecks eligibility immediately before sending. Recent contacts, existing links, bots, departed members and community preferences are skipped without waiting another interval.

## Configure

In GuildSync, open **Reports & Admin → Administrator Configuration → Discord membership DMs**:

- Enable officer-initiated membership DMs. Enabling alone does not create a campaign.
- Set the minimum days between confirmed membership DMs; the default is 30, configurable from 1 to 365.
- Edit the message using `{name}` and `{guild}`. The four buttons and the notice that replies go to guild officers are added automatically.
- Select a reply destination type (**channel** or **user**) and its numeric Discord ID. A channel must be in this Discord server and writable by the bot; a user must accept the bot’s DMs.
- Optionally choose a numeric community role ID. Blank records preferences without changing roles. A configured role requires the bot’s Manage Roles permission and a role position above it. These responses do not remove existing access or rank roles.

The same settings are documented in the backend `.env.example`. They are backend-owned live settings; they do not require restarting the bot when saved through GuildSync. The bot must have `DISCORD_GUILD_ID` configured and be connected to the same backend.

Deploy the updated bot and backend together. Register the new command with the bot package’s existing `npm run deploy` command when ready to update Discord. Development tests do not register commands or send actual DMs.

## Officer commands

The commands require Discord **Manage Server** permission and an approved GuildSync **User** or **Admin** account:

| Command | Result |
| --- | --- |
| `/discord-reminders start` | Refresh the Discord roster and start a new eligible-member campaign. |
| `/discord-reminders pause` | Stop new sends; a request already in flight may finish. |
| `/discord-reminders resume` | Resume the saved alphabetical queue with a fresh scheduled delay. |
| `/discord-reminders restart` | Build a fresh queue, retaining contact dates and preferences. Refuses to replace an active send. |
| `/discord-reminders status` | Show state, last attempted name, last successfully sent name, remaining count, uncertain count, which members are uncertain and next attempt time. |
| `/discord-reminders status user:@someone` | Also show that member’s last confirmed send date and community preference. |
| `/discord-reminders resolve user:@someone outcome:delivered\|retry` | Record whether an uncertain DM arrived. `delivered` counts it as a confirmed send; `retry` clears the uncertainty and requeues the member in the current campaign, or makes them eligible for the next one. |
| `/discord-reminders test user:@someone` | Immediately send a labelled test message to one server member. |

Test messages use the same buttons, forms and forwarding path. Test responses do not establish links, change preferences or roles, or affect ordinary campaign cooldowns or pacing.

## Member responses

1. **Provide my ESO account:** opens a text form. A unique active roster account without a confirmed link is linked automatically. Conflicts and officer-blocked pairs go to review without changing existing ownership. A claimed name is self-reported; the modal does not authenticate ownership of an ESO account.
2. **Not in guild; keep Discord:** records a persistent community-member preference and stops subsequent membership DMs.
3. **No longer play ESO; stay:** records that preference and stops subsequent membership DMs.
4. **Other response:** opens a free-text form.

Only the membership DM's buttons and forms produce a forwarded record. A message typed to the bot without pressing one of those buttons is ignored, and a response is accepted only for the exact delivery it answers. Each forwarded record names the Discord server, the member's display name (server nickname, then global display name, then username), the chosen option in words, the outcome and the received time. Delivery and response IDs stay in the database rather than the message. Long responses are attached as a text file so nothing is silently truncated, and replies without text omit the placeholder line. Mentions are disabled in forwarded content.

Buttons remain valid after restarts and validate the intended recipient. Supplying a valid ESO account later clears a previous community preference and removes the optional community role. Existing onboarding promotion behavior handles the confirmed link. A member only counts as managed — and therefore skips the older onboarding reminder — after a confirmed or uncertain membership DM, or after recording a community preference; a failed or skipped send leaves the onboarding reminder available.

## Persistence and failures

Campaign order, send dates, next attempt, preferences, delivery claims and reply forwarding state are stored in MariaDB’s `guildsync_membership_dm_state`, scoped by Discord guild. Each member’s latest response is also stored in `guildsync_membership_dm_responses`, one row per guild and Discord user with their display name, confirmed ESO account name, last choice, supplied text and response time; a later response overwrites that row, and `/discord-reminders status user:@someone` shows it. Fully forwarded events and settled delivery claims are pruned from the guild state, so it cannot grow with every response. Restarting does not reset cooldowns or cause catch-up bursts. Confirmed send dates require a successful Discord message response; failed DMs are recorded without inventing a successful send.

Closed DMs are recorded as failed and the campaign proceeds at the normal slow pace. Failures before a message is sent — roster or member lookup, eligibility validation or message rendering — are always recorded as failed, never as uncertain. Unknown send outcomes are retained as uncertain rather than automatically sent again; `/discord-reminders status` names those members, and after checking the bot log’s delivery/message IDs an officer resolves each one with `/discord-reminders resolve user:@someone outcome:delivered` or `outcome:retry`. Platform or worker delays can make sends later than their scheduled time.

Incoming replies are saved locally before submission to the backend. If the backend is unavailable, the bot acknowledges the saved response and replays it idempotently when connected again. Keep the bot’s `data/membership-dm-intake` directory across restarts, or configure an absolute persistent directory with `GUILDSYNC_MEMBERSHIP_DM_SPOOL_DIR` in the bot `.env`. That directory temporarily contains member reply text and is excluded from source control. This protects replies received by a running bot during backend outages; it cannot capture an interaction Discord never delivered to the bot.

Reply forwarding and optional role changes retry independently. A newer membership response supersedes a pending older role change, so an old failed community-role addition cannot undo a later successful link. Fixing the configured destination or role applies to pending retries.

## Smoke test after deployment

Configure a private officer destination, then send a test to your own Discord account. Exercise all four buttons, submit an ESO account and an Other response, and confirm a message typed to the bot without pressing a button is ignored. Confirm the forwarded records are labelled TEST and that actual links, roles, preferences and normal send dates are unchanged. Then start a small real campaign, inspect status, pause/resume it, and verify its next scheduled time and the member’s confirmed send date. No live Discord send or role operation was performed during implementation.
## Simulated test mode

`/discord-reminders test-mode` sends a simulated copy of the membership DM to the officer who started it, one message every 30 seconds, cycling through the members a real campaign would contact. Each message is rendered from the live template for that member but is delivered only to the operator.

Test mode writes nothing: no delivery claim, send date, preference, account link, role change or response row. Buttons on simulated messages are acknowledged privately and save nothing. Stop it with `/discord-reminders test-mode-stop`; it also stops when the bot restarts.
