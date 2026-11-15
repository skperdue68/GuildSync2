# GuildSync2: minimal Wails 3 migration

GuildSync2's desktop client targets Wails **v3.0.0**. The original GuildSync repository is independent. This port retains the current UI, authentication, SavedVariables handling, settings paths, platform hotkeys and Windows-only tray behavior. Dependabot and general repository improvements are deferred to a separate change.

## Build and development

Install Go 1.26+, Node 24 and Python 3, plus the native Wails platform dependencies. Install the pinned CLI:

```sh
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0
cd GO/GuildSync-Frontend-Client
wails3 build
# macOS release build (Intel + Apple Silicon):
wails3 build UNIVERSAL=true
# Development: rebuild and restart when source files change.
wails3 dev -config build/config.yml
```

`tools/build-desktop.py` is the shared build implementation for local commands and GitHub Actions. It generates bindings, installs locked frontend packages, builds assets, compiles Go, embeds Windows resources and assembles/ad-hoc signs the macOS app bundle. Outputs remain in `build/bin` for the existing installer scripts. macOS requires Xcode command-line tools; universal builds require both architectures' compiler support. Linux retains GTK3 and WebKitGTK 4.1, using Wails 3's `gtk3` build tag, rather than changing runtime dependencies during this port.

Go module, CLI and npm runtime versions must move together. `Taskfile.yml` and `build/config.yml` control Wails 3 builds/development. `wails.json` remains only as legacy release metadata for the existing version synchronization tool; it no longer configures Wails or frontend builds. Old platform templates remain for reference; `tools/build-desktop.py` generates actual Windows metadata and the macOS plist from `VERSION`.

For a standalone frontend build, first run `wails3 generate bindings` from the client (on Linux add `-f '-tags gtk3'`), then `npm ci` and `npm run build` from `frontend`. Generated `frontend/bindings`, `frontend/dist`, `.syso`, `build/bin` and release payloads are untracked.

## Verification

- `go test ./...` in the client; add `-tags gtk3` on Linux.
- `node --test GO/GuildSync-Frontend-Client/frontend/src/*.test.mjs` at the root.
- `python tools/test-voice-native.py` at the root for native hotkey coverage.
- `wails3 build` in the client for a production build.
- `.github/workflows/desktop.yml` runs desktop tests and production builds for Windows, macOS universal and Linux on pull requests and pushes to `master`. Release builds use the same entry point. No production deployment is enabled by this port.

Before publishing, manually check splash/main-window transition, dragging/resizing, persisted position, minimize/maximize, native close, Windows Show/Hide/Quit tray actions, OAuth browser login and events, watcher notifications and hold/release hotkeys. Compile/test checks alone do not prove native UI behavior.

## Follow-up opportunities (not implemented)

- Replace the external Windows tray library with Wails 3's native system tray. Consider opt-in macOS/Linux tray support, reopen behavior and explicit close-to-tray preferences; preserve existing behavior until reviewed on each platform.
- Use additional native windows for settings, logs or a small status panel instead of expanding the main window.
- Evaluate Wails 3 global shortcuts against the current hold-to-mute semantics. A shortcut activation callback alone does not replace key-release handling or permission recovery.
- Evaluate the integrated updater with signed releases, rollback/recovery and this repository's separate release channel.
- Consider native menus, notifications, single-instance handling and typed custom events as individually scoped improvements.
- Add Dependabot for Go, all npm package roots and GitHub Actions; review vulnerability scanning, branch rules and release permissions. Existing frontend dependencies also warrant a separate security update (the migration's npm install reported eight advisories).

Reference: [Wails v2-to-v3 migration guide](https://wails.io/migration/v2-to-v3/).
