# GuildSync2

This repository's desktop client targets **Wails 3**, not Wails 2.

- Use Go 1.26+, Node 24, Python 3, and `wails3` v3.0.0. The Go module and `@wailsio/runtime` are pinned to v3.0.0; update them and the CLI together.
- Build in `GO/GuildSync-Frontend-Client` using `wails3 build`; use `wails3 build UNIVERSAL=true` on macOS for release parity. The shared implementation is `tools/build-desktop.py`.
- Use `wails3 dev -config build/config.yml` for development. Do not introduce `wails build`, `wails generate module`, v2 runtime imports, `frontend/wailsjs`, or `window.go` calls.
- Generate bindings using `wails3 generate bindings`. Do not commit bindings or compiled frontend/binary output.
- Check `go test ./...` from the client, `node --test GO/GuildSync-Frontend-Client/frontend/src/*.test.mjs` from the root, and the production build before proposing desktop changes.
- Preserve current Windows-only tray and platform hotkey behavior during this migration. Future enhancements are tracked in `docs/wails3-migration.md`.
- GuildSync2 is a separate development repository. Do not change the original GuildSync repository or enable production deployment as part of this port.
