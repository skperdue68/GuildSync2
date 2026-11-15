# GuildSync2: minimal Wails 3 migration

GuildSync2's desktop client targets Wails **v3.1.0**. The original GuildSync repository is independent. This port retains the current UI, authentication, SavedVariables handling, settings paths and platform hotkeys. The subsequent native tray update enables Windows, macOS and supported Linux desktops. Dependabot is configured for weekly updates of both Go modules, all four npm projects and GitHub Actions. General repository improvements remain follow-up work.

## Build and development

Install Go 1.26+, Node 24 and Python 3, plus the native Wails platform dependencies. Install the pinned CLI:

```sh
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0
cd GO/GuildSync-Frontend-Client
wails3 build
# macOS release build (Intel + Apple Silicon):
wails3 build UNIVERSAL=true
# Development: rebuild and restart when source files change.
wails3 dev -config build/config.yml
```

`tools/build-desktop.py` is the shared build implementation for local commands and GitHub Actions. It generates bindings, installs locked frontend packages, builds assets, compiles Go, embeds Windows resources and assembles/ad-hoc signs the macOS app bundle. Outputs remain in `build/bin` for the existing installer scripts. macOS requires Xcode command-line tools; universal builds require both architectures' compiler support. Linux builds against GTK4 and WebKitGTK 6.0, Wails 3's default desktop stack; the `gtk3` build tag is no longer used.

Go module, CLI and npm runtime versions must move together. `Taskfile.yml` and `build/config.yml` control Wails 3 builds/development. `wails.json` remains only as legacy release metadata for the existing version synchronization tool; it no longer configures Wails or frontend builds. Old platform templates remain for reference; `tools/build-desktop.py` generates actual Windows metadata and the macOS plist from `VERSION`.

For a standalone frontend build, first run `wails3 generate bindings` from the client , then `npm ci` and `npm run build` from `frontend`. Generated `frontend/bindings`, `frontend/dist`, `.syso`, `build/bin` and release payloads are untracked.

## Verification

- `go test ./...` in the client on Linux (GTK4/WebKitGTK 6.0 development packages required).
- `node --test GO/GuildSync-Frontend-Client/frontend/src/*.test.mjs` at the root.
- `wails3 build` in the client for a production build.
- `.github/workflows/desktop.yml` runs desktop tests and production builds for Windows, macOS universal and Linux on pull requests and pushes to `master`. Release builds use the same entry point. No production deployment is enabled by this port.

Before publishing, manually check splash/main-window transition, dragging/resizing, persisted position, minimize/maximize, native close, Windows/macOS/Linux Show/Hide/Quit tray actions, OAuth browser login and events, watcher notifications and the mute shortcut toggle/auto-unmute. Compile/test checks alone do not prove native UI behavior.

## Native system tray: Windows, macOS and Linux

The tray uses Wails 3's native SystemTray manager on all three desktop platforms. The external Windows tray library, its separate event loop and unused dependencies have been removed, along with the dormant Objective-C tray implementation.

- **Windows:** click/double-click restores the normal window; right-click opens Show, Hide and Quit GuildSync.
- **macOS:** the menu-bar icon opens the same menu; Show or reopening through the Dock restores the window. The app keeps its normal Dock presence.
- **Linux:** the same native menu is enabled when the session bus reports a registered StatusNotifier panel host. Without a host, the window stays accessible and closing quits normally. If the panel disappears later, the window is restored within the two-second polling interval plus probe timeout. Recovery handles repeated panel restarts without repeatedly stealing focus. If no host exists at startup, restart GuildSync after enabling one to obtain its tray icon.

Where a tray is available, closing hides the window and Quit GuildSync ends the process and cleans up the watchers, hotkey listener and icon. Minimize remains a normal taskbar minimize. The main window is not attached as a transient tray popover, which would reposition it beside the icon and hide it on focus loss. Saved hidden state is restored only when a tray is available.

Tests cover idempotent registration/cleanup against the real Wails manager before native startup, panel-loss/restart transitions and monitor cancellation. A Linux-specific test covers a missing session bus. Manual interaction testing is still required on the actual operating systems, including tray icon visibility, menu clicks, close/reopen and Quit.

Linux tray hosting follows the [StatusNotifier host-registration contract](https://github.com/KDE/plasma-workspace/blob/master/xembed-sni-proxy/org.kde.StatusNotifierWatcher.xml). GNOME installations may need their AppIndicator/StatusNotifier extension enabled; the app falls back to normal window behavior when no host is registered.

## Desktop client follow-ups

Implemented:

- **Single instance.** A second launch restores the running window instead of competing for the fixed OAuth callback port and the SavedVariables watchers (`com.guildsync.client`).
- **Close-to-tray preference and start at login.** The profile menu exposes both. Close-to-tray defaults to on where a tray host exists and makes close quit the client when turned off. Start at login writes the Windows per-user `Run` value, a macOS LaunchAgent or an XDG autostart entry.
- **Integrated updater.** The client compares its stamped version with the newest GitHub release, caches the result for six hours, shows release notes, downloads the platform installer ZIP to the downloads folder and hands it to the OS installer. Development builds (`appVersion == "dev"`) skip the check.
- **GTK4 and WebKitGTK 6.0.** Linux builds no longer pass the `gtk3` tag, and CI installs `libgtk-4-dev` and `libwebkitgtk-6.0-dev`.
- **Global shortcut toggle with a separate unmute key.** Voice mute uses `app.GlobalShortcut` (no keyboard-capture permission on Windows, macOS or X11); pressing the mute key again restarts the auto-unmute countdown, and a second, separately assigned key ends a mute immediately. Both are captured in the profile menu.

Still open:

- Complete native UI smoke testing. Repository Actions is enabled (`allowed_actions: all`, every workflow `active`) and `desktop.yml` runs successfully on pushes to `master`. `buildguildsync.yml` has still never run: it triggers only on `release: published`, and the existing `v1.0.0` release predates those runs, so publish a fresh release (or dispatch the workflow with a `tag` input) to produce installer assets.
- Use additional native windows for settings, logs or a small status panel instead of expanding the main window.
- The updater downloads and launches the published installer rather than replacing binaries in place, so a failed install is recovered by rerunning the installer. Signed releases lasting longer than the installer's signature policy remain a release-process decision.
- Consider native menus, notifications and typed custom events as individually scoped improvements. Keep CLI, Go module and npm runtime versions aligned during Wails upgrades.
- Review vulnerability scanning, branch rules and release permissions. Dependabot is active on the default branch and has successful Go, npm and Actions update runs. Existing frontend dependencies also warrant a separate security update (the migration's npm install reported eight advisories).

Reference: [Wails v2-to-v3 migration guide](https://wails.io/migration/v2-to-v3/).
