# GuildSync desktop client

The Wails desktop client authenticates through Discord, displays GuildSync data, watches ESO SavedVariables exports, and safely writes queued ESO receipt mail when the game is closed. It shares administration concepts with the server-backed browser interface.

- [Everyday user guide and Discord/ESO commands](../../docs/GuildSync-User-Guide.md)
- [Detailed workflows, configuration, and troubleshooting](../../docs/GuildSync-Detailed-Help.md)
- [Release packaging and deployment](../../docs/GuildSync-1.2.7.md)

## Development and builds

This repository uses Wails **v3.1.0**, Go 1.26+, Node 24 and Python 3. Install the CLI with `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0`. See [migration details and future improvements](../../docs/wails3-migration.md).

Run `wails3 dev -config build/config.yml` here for desktop development with automatic rebuild/restart. Run `wails3 build` for a desktop build. The frontend lives in `frontend`; install its locked dependencies with `npm ci` and build using `npm run build` as described in the release guide. Platform installers are prepared through the repository packaging/release workflow.

Generated `frontend/dist`, `frontend/bindings`, `frontend/package.json.md5`, `build/bin`, and `release` files are not committed. The empty `frontend/dist/.gitkeep` lets Go's embed directive compile before the first build; `frontend/public/.gitkeep` preserves it when Vite recreates the output directory. On a fresh checkout use `wails3 dev -config build/config.yml` or `wails3 build` to regenerate the Go/JavaScript bindings and frontend output. A standalone frontend build needs the bindings first (`wails3 generate bindings` from this directory). Direct Go tests can use the placeholder, but runnable desktop applications require the real frontend build. Keep `build` icons, platform manifests and installer templates: those are source inputs, not compiled output.

## Native tray

Windows, macOS and supported Linux desktops offer a native Show/Hide/Quit tray menu. Closing hides to the tray when available; Minimize remains a normal taskbar minimize. On macOS, reopening through the Dock restores the window. On Linux without a registered tray host, closing quits normally; panel loss restores the window so the background app stays accessible. See the migration notes for platform verification and follow-up work.

## Local settings

### Voice Channel Mute (Windows)

Open your profile menu and enable **Voice Channel Mute**. Hold **Ctrl+M** to request a temporary server mute for eligible lower-ranked members of your current Discord voice channel. Release the keys to end it. Your server must enable the feature and allow your Discord role; server owners, peers, higher ranks, bots, and moderator mutes are protected.

**Set Hotkey** captures Ctrl, Alt, or Shift plus a letter, number, or F1–F12. Escape cancels capture. The feature starts disabled; personal settings are saved in the operating system user configuration directory under `GuildSync/voice-hotkey.json`, independently on each computer. Changing settings or capturing a shortcut ends an active session.

Global hotkeys are supported by the Windows desktop client. Browser, macOS, and Linux clients display an unsupported notice. A separately distributable companion is a follow-up.

Logout, disconnection, and exit release the session. While held, the desktop sends authenticated heartbeats every two seconds; the server expires a lost release after eight seconds. Reconnecting while holding the shortcut does not start a new session: release and press again. Recovery may take longer if Discord cleanup fails. Discord exposes a single server-mute flag, so a moderator reapplying mute to someone already temporarily muted may be unobservable; ambiguous mutes are preserved for review.

Packaged defaults normally suffice. `.env` and `GuildSyncSettings.txt` can override local SavedVariables paths and backend connection settings. The profile's Banking/Roster/Applications watcher switches persist independently. Do not put server secrets in desktop configuration. See the [desktop environment table](../../docs/GuildSync-Detailed-Help.md#desktop-optional-local-overrides).

ESO saves add-on data to disk at reload/logout/exit. Writing a receipt mail batch requires ESO to be fully closed; the queue sends on the next Banking add-on load. Backups are kept under SavedVariables/GuildSyncBackups before cleanup/queue edits.
