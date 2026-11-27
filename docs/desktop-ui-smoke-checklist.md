# Desktop UI smoke checklist

Compile and unit checks cannot prove native behaviour. This checklist is the
manual pass to run on a real Windows, macOS and Linux desktop before a release,
and it doubles as the screenshot session for the user manual: capturing each
`SHOT-…` slot listed in `manual/SCREENSHOTS.md` covers most of the UI review in
one pass.

Record, per platform: OS version, desktop client version, tray host (Linux), and
whether the session used a real Discord guild and ESO install.

## Window and shell

- [ ] Splash appears and hands over to the main window without a flash of the empty shell.
- [ ] The window drags by the title bar and resizes from every edge and corner.
- [ ] Size and position survive a quit and relaunch; a saved off-screen position is recoverable.
- [ ] Minimise, maximise and restore behave like normal window controls.
- [ ] Custom close follows the close-to-tray preference: hiding when on (with a tray), quitting when off.
- [ ] A second launch brings the existing window forward instead of starting a second copy.

## Tray

- [ ] Windows: click and double-click restore; right-click shows Show, Hide and Quit GuildSync.
- [ ] macOS: the menu-bar icon opens the same menu; Dock reopen restores the window.
- [ ] Linux with a StatusNotifier host: the icon appears and the menu works.
- [ ] Linux without a host: no icon, the window is reachable, and closing quits normally.
- [ ] Killing the panel host restores the window within the polling interval, once, without stealing focus repeatedly.
- [ ] Quit GuildSync ends the process and removes the tray icon, watchers and hotkey listener.

## Start at login

- [ ] The profile-menu switch turns on and off, and the state survives a restart.
- [ ] Enabling writes the platform login item (Windows `Run`, macOS LaunchAgent, XDG autostart).
- [ ] A login start lands in the tray with no window; clicking the tray icon shows the window.
- [ ] With no tray host, a login start opens the window instead of hiding.
- [ ] Move or update the app, launch it once, then sign out and back in: login still starts the new copy.
- [ ] The login item's path contains no doubled separators or XML breakage for an install path with spaces, `&`, `<` or `%`.
- [ ] Turning the switch off removes the entry.

## Files, uploads and receipts

- [ ] Each watcher switch stops and starts only its own file.
- [ ] A `/reloadui` in ESO produces an upload for roster, banking and applications.
- [ ] Changing the SavedVariables folder in User Settings takes effect without a restart.
- [ ] Receipt mail writes only with ESO closed, and the queue count matches what was written.
- [ ] The unsupported-desktop screen appears for an out-of-date build and its download button opens the installer link.

## Reports, dialogs and icons

- [ ] Member Links report shows all three sections, including "Possible links to make"; no section is clipped to a sliver.
- [ ] The chain, check and restore icons render at a consistent weight in the 30 px report buttons and the 36 px dialog buttons, with no glyph fallbacks.
- [ ] `→ block` and `→ candidate` captions sit under the unlink button, centred, without touching the row edge.
- [ ] Unlink, approve and remove-block each show the confirmation dialog and refresh the report afterwards.
- [ ] User Settings opens above an already-open report dialog.
- [ ] Escape closes a report; focus does not tab into the page behind it (known gap: no focus trap).
- [ ] The profile menu's presence tooltip shows the client type pill for each signed-in person.

## Manual

- [ ] **User Manual** in the profile menu opens the manual and its section navigation works.
- [ ] Every page renders its screenshot slot label and caption; no unstyled text or missing stylesheet.
- [ ] On the web client the same link opens `/manual/index.html` in a new browser tab.

## Screenshot capture

Capture these while the session is set up; each one is a slot in the manual.
Store them as `manual/assets/shots/<SHOT-ID>.png` and swap the placeholder as
described in `manual/SCREENSHOTS.md`.

- [ ] `SHOT-START-01`, `SHOT-START-02`
- [ ] `SHOT-DESKTOP-01`, `SHOT-DESKTOP-02`, `SHOT-DESKTOP-03`
- [ ] `SHOT-MEMBERS-01` … `SHOT-MEMBERS-06`
- [ ] `SHOT-BANK-01`, `SHOT-BANK-02`
- [ ] `SHOT-RAFFLE-01`, `SHOT-RAFFLE-02`, `SHOT-RAFFLE-03`
- [ ] `SHOT-CMD-01`
- [ ] `SHOT-REPORTS-01`, `SHOT-REPORTS-02`
- [ ] `SHOT-TROUBLE-01`
