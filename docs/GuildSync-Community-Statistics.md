# Community Highlights and automatic spreadsheet recovery

## Community Highlights

Open Reports and Admin, then Community Highlights. The section requests fresh data every time it opens, including when returning to Reports and Admin with the section already expanded, and clicking the Reports and Admin tab reloads it even while the section is collapsed. The two seller cards measure one rolling window: exactly 14 × 24 hours back for sales and item counts, from the time of that request, so their cut-off moves with the clock instead of resetting on a calendar week or month. The two buyer cards follow the 50/50 raffle instead. Refresh remains available. Updates replace only the section results and preserve the page position; requests already in progress are reused. All approved Viewer, User, and Admin accounts can read it. No editing or account management privileges are granted by this report.

Highlights include longest and newest recorded current guild memberships, Busiest Discord Users (posts plus reactions given), Most Posts, Most Reactions Given, the top five current Bi-Weekly and 50/50 purchased-ticket leaders, bonus tickets awarded in the current raffles, the top five raffle spenders over the last 90 days, and four guild trader rankings, each limited to the top five: **Market Moguls** (highest sales over the last 14 days), **Pack Mules** (most items sold over the last 14 days), **Guild Regulars** (current member buyers) and **Window Shoppers** (non-member buyers). The two buyer cards follow the 50/50 raffle instead of a rolling window: each covers one raffle, counting from the previous draw to that raffle's own draw, so the ranking resets raffle to raffle rather than sliding forward day by day. A draw is one hour after ticket sales close, so a raffle counts from 8 PM Eastern on the previous draw date to 8 PM Eastern on its own. A raffle that has just closed keeps its buyer standings for an hour after its draw, until 9 PM Eastern, so they can still be quoted, then the next refresh starts the new raffle. That linger is the **Community highlights → Keep a closed 50/50 raffle on the buyer cards (hours)** setting in Administrator Configuration (`GUILDSYNC_COMMUNITY_BUYER_RAFFLE_LINGER_HOURS`, default 1, 0–168). Both cards name the draw the span counts from, the draw it ends at, and the clock time in the viewer own time zone the closed raffle is replaced, so the configured linger is visible as a real time rather than only a number of hours; `0` switches to the new raffle at the draw itself. The themed names are shorthand; every card's own description still states exactly what it counts. Discord activity uses a rolling 30-day window. The guild trader cards show gold amounts according to the **Community highlights → Who sees trader gold** setting (`GUILDSYNC_COMMUNITY_TRADER_GOLD_VISIBILITY`): by default approved users and admins see them and read-only viewers get the same names in the same order, `admin` limits amounts to admins, and `never` withholds them from everyone. The server decides this from the authenticated role read at refresh time, so a demoted account loses amounts on its next refresh and the Discord bot never receives any. All four trader cards share the 50/50 draw-to-draw span by default (`GUILDSYNC_COMMUNITY_TRADER_WINDOW`, `raffle` or `14 days`), list the top 5 by default (`GUILDSYNC_COMMUNITY_TRADER_TOP_LIMIT`, 1-25), and end their description with the newest recorded sale so a stale import is visible. Member matching ignores the ESO `@` prefix on trader names. The report only reads sales for this installation's bound ESO guild; if that binding cannot be read, no trader sales are read at all and the cards say so instead of showing another guild's activity. `GUILDSYNC_COMMUNITY_HIDDEN_HIGHLIGHTS` removes cards by id. `/highlights` in Discord posts the same report without gold, and an optional digest posts it on an interval when `GUILDSYNC_HIGHLIGHTS_CHANNEL_ID` is set. ESO and Discord join rankings appear at the end. Community totals show current roster sizes, recorded post/reaction activity, and raffle spending.

Colors, other report sections, and the main roster/banking screens are unchanged. The section uses the existing Reports accordion. Cached results and pending requests are discarded when the authenticated session changes.

### What the numbers mean

- These are rankings from retained GuildSync records, not claims of complete all-time history.
- Membership tenure uses actual recorded join events and current roster membership. Snapshot capture dates are not treated as real join dates. Missing joins/departures can leave people unranked or affect recorded tenure. Both membership rankings show how many current members lack an actual recorded join date; roster import dates are not reliable substitutes.
- Bulk Discord imports are excluded from join counts. Existing live history can treat first discovery during an update as a join; the report discloses that limitation.
- Guild trader buyers are matched to the current roster by ESO account name, ignoring case. A purchase counts for the guild member ranking only when the seller is also a current member, so sales from members who have left the guild are excluded from that card. Every buyer who is not on the roster forms the non-member ranking, whoever listed the item. Buyer spending counts the gold the buyer paid, and the ranking amounts are never displayed.
- Raffle purchasers are grouped by ESO account, ignoring case. Current-period leaders use existing raffle sales windows. Purchased tickets exclude bonus tickets; zero-ticket donations are excluded from purchase spending. Gold totals remove the +1/+3 raffle markers and exclude future-dated transactions.
- The bonus card totals bonus tickets earned in each raffle currently on sale and says how many buyers earned them. It scores each purchase with the bonus settings in force when that purchase was made, so an override or a mid-raffle settings change is reflected the same way the receipts are. Manual ticket entries are excluded because their ticket count is already discretionary.
- Discord activity counts new posts and emoji reactions given (including likes). Busiest Discord Users adds those two counts. Bots, DMs, system messages, historical scans, and bot commands are excluded. Emojis typed inside a post are not separate reactions.
- Each post counts once. Each member/message/emoji reaction counts once, so removing and re-adding the same reaction does not inflate the ranking. Deleting posts or removing reactions does not subtract earlier recorded activity.
- Discord activity and Discord join rankings show each member's current server nickname, then their Discord display name and username, so rows recorded earlier follow a nickname change. Members unknown to the live Discord roster are shown with the name recorded at the time.
- Counts cover only events the bot receives in channels it can access while connected. Offline or failed deliveries are not backfilled. These are recorded totals, not complete Discord-wide totals.
- The separate Discord activity tracking date starts when this update initializes the backend schema. The old last-seen tracking overwrote earlier activity and cannot reconstruct historical totals. Earlier slash-command counts are retained separately but no longer appear in the report.

The `guildsync_discord_activity` table stores deduplicated event keys, guild/user IDs, display names, action type, and collection time. Reaction identity is hashed for deduplication; message text, attachments, and emoji text are not saved. Records are retained until explicitly removed. Writes require the authenticated matching-guild bot; reports require currently approved GuildSync access.

## Automatic raffle spreadsheet recovery

Previously a deposit could commit to MariaDB, fail its immediate Google write, and never retry because later file uploads were duplicates. The backend now queues the spreadsheet export in the same transaction as the banking insert. Manual entries use the same durable transaction boundary, including when ordinary exports are temporarily disabled.

Immediate exports still run normally. A background worker checks pending exports every minute, with retry delays from one minute up to one hour. Failure of credentials, network, or Google requests leaves the item pending across backend restarts. Re-enable exports to allow pending writes to resume; disabled exports make no Google requests.

At startup (or the first enable for that running worker), existing current-period database entries are also queued for recovery. The worker checks the sheet transaction IDs and appends only missing entries. It does not reset sheets, erase data, create archives, change draw dates, or replay all historical raffle purchases. Existing coordinator/database locks and displayed raffle-date guards still apply. Entries outside the displayed period stay in the database and queue; archive/load remains responsible for historical periods. A Google-confirmed batch or an ID already read from the sheet completes the queue entry. A duplicate reserved only inside an unsubmitted batch is not acknowledged early.

The queue is keyed by spreadsheet ID plus transaction ID. Completed rows are retained so restart backfill does not repeatedly enqueue completed work. They are an export ledger, not a replacement for banking or archive history. Manual clear/refresh commands retain their existing behavior.

### Linux credential checks

If the credential path changed during migration, edit the backend .env and restart the backend. With the default service working directory, a credential file alongside the backend can use:

```env
GUILDSYNC_GOOGLE_SERVICE_ACCOUNT_FILE=./guildsync-service-account.json
```

The file must be readable by the service user, and the service-account email must have edit access to the spreadsheet. A nonempty GUILDSYNC_GOOGLE_SERVICE_ACCOUNT_JSON takes precedence over the file setting. Existing GuildSync administrator overrides can also disable ordinary Google Sheets writes even when the .env default is enabled.

Review recent Linux logs without sharing credential-file contents:

```bash
sudo journalctl -u guildsync-backend -n 100 --no-pager
```

Look for Export stopped, Automatic spreadsheet export will retry, Automatic spreadsheet recovery confirmed, and the Google error or missing-file path. A blank/invalid working draw date or a deposit assigned to a different raffle intentionally prevents an append.

### Database tables and deployment

Startup creates these tables idempotently:

| Table | Purpose |
| --- | --- |
| guildsync_sheets_export_queue | Per-spreadsheet transaction export state, attempt count, retry time, last error, completion time. |
| guildsync_discord_activity | Deduplicated posts and emoji reactions given for community rankings. |
| guildsync_discord_interactions | Retained earlier bot usage metadata; excluded from current activity rankings. |
| guildsync_community_statistics_metadata | Separate persistent start times for legacy interactions and post/reaction activity. |

Read-only queue review:

```sql
SELECT spreadsheet_id, event_id, status, attempts,
       FROM_UNIXTIME(next_attempt_at) AS next_retry, last_error
FROM guildsync_sheets_export_queue
ORDER BY status, next_attempt_at, event_id;
```

Back up the database, deploy the updated backend and bot, restart both, and rebuild/deploy the web and desktop clients. Existing Linux installations extracted from a server ZIP need the updated server files or a newly built server release; git pull does not update a directory that was never cloned. No new dependency, slash-command registration, Google Apps Script update, or new environment setting is required. Schema setup runs as part of ordinary startup.

Tests simulate Google/database failures and cannot establish that a production spreadsheet is writable. Confirm a real eligible deposit appears on the working sheet after deployment and review the queue/logs if it does not.

For the Discord activity update, deploy and restart **both** the backend and Discord bot, and rebuild/update both clients to show the revised coverage label. Existing Discord message/reaction intents are sufficient; no new `.env`, slash-command registration, Google Apps Script change, or dependency is required. New totals begin when the updated bot starts sending activity to the updated backend.
