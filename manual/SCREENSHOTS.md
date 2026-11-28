# Manual screenshot slots

Every page of the user manual leaves a labelled slot where a screenshot belongs.
Each slot has a **stable reference** (`SHOT-…`) in its `id` and `data-shot`
attributes, so a screenshot sent later can be matched to the exact place it was
wanted without re-reading the prose.

## How to add a screenshot when it arrives

1. Save the image as `manual/assets/shots/<SHOT-ID>.png` (PNG, same ID as below).
2. In the page, replace the placeholder block

   ```html
   <div class="shot-slot"><span class="shot-id">SHOT-MEMBERS-04</span><span>Screenshot slot</span></div>
   ```

   with

   ```html
   <img src="assets/shots/SHOT-MEMBERS-04.png" alt="Link report rows with the broken-chain button and its outcome caption">
   ```

   Keep the `<figure>` and its `id`/`data-shot` exactly as they are.
3. Leave the `figcaption` alone: it describes the picture and doubles as the alt
   text when the image is missing.

## Slots

| Reference | Page | What the screenshot should show |
| --- | --- | --- |
| `SHOT-START-01` | `getting-started.html` | The sign-in screen before Discord authorisation: Discord button, empty tab bar. |
| `SHOT-START-02` | `index.html` | Signed-in main window with all six tabs visible: Discord Member Data, Guild Roster, Guild Chat, Bank Deposits / Raffle Tickets, Reports, Admin. |
| `SHOT-DESKTOP-01` | `desktop-client.html` | Profile menu: name, role, client version, the **Start GuildSync at login** row with its checkbox, and the User Settings button. |
| `SHOT-DESKTOP-02` | `desktop-client.html` | Tray menu on Windows showing Show, Hide, Quit GuildSync. |
| `SHOT-DESKTOP-03` | `desktop-client.html` | User Settings dialog with the SavedVariables folder field and the per-file watcher switches. |
| `SHOT-MEMBERS-01` | `members.html` | Guild Roster tab: rank filters and a row with the history button between Notes and Linked. |
| `SHOT-MEMBERS-02` | `members.html` | Discord Member Data tab: several rows, role filter, history and linked columns. |
| `SHOT-MEMBERS-03` | `members.html` | An open roster history window for one member: search box and dated events. |
| `SHOT-MEMBERS-04` | `members.html` | Member Links report, **Links we can unlink** section: broken-chain button, `→ block` / `→ candidate` captions, filter row. |
| `SHOT-MEMBERS-05` | `members.html` | Member link dialog for a linked member: ESO account, Discord match, status line, round action buttons. |
| `SHOT-MEMBERS-06` | `members.html` | Member discovery view listing members present on only one side. |
| `SHOT-BANK-01` | `banking.html` | Bank Deposits tab: search and filters, a deposit that bought tickets, ticket and bonus columns. |
| `SHOT-BANK-02` | `banking.html` | Receipt mail area: availability line, pending mail count, write button. |
| `SHOT-RAFFLE-01` | `raffles.html` | Discord response to `/gsr load` with the Open Working Raffle button and the summary. |
| `SHOT-RAFFLE-02` | `raffles.html` | Raffle Bonus Tickets section: raffle selector marking `(Bonuses)`, period list, Save Bonus Settings. |
| `SHOT-RAFFLE-03` | `raffles.html` | Private `/tickets` reply: a Bi-Weekly and a 50/50 purchase, bonus percentage, As of and Latest recorded transaction times. |
| `SHOT-CMD-01` | `commands.html` | Discord's command picker in the guild listing the GuildSync slash commands with their options. |
| `SHOT-REPORTS-01` | `reports.html` | Reports tab with the report list and one report open. |
| `SHOT-REPORTS-02` | `reports.html` | Community Highlights report filled in for a completed period. |
| `SHOT-FAQ-01` | `faq.html` | A banking entry open for editing, with its type field and the ticket count it produces. |
| `SHOT-TROUBLE-01` | `desktop-client.html`, `troubleshooting.html` | The unsupported-desktop screen with download, minimise and close buttons. |

Two pages reference `SHOT-TROUBLE-01`; one image serves both.
