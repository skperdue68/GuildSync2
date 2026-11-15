# Desktop build assets

GuildSync2 uses Wails 3. Run `wails3 build` in the parent directory.
The shared build script is `tools/build-desktop.py` at the repository root.

- `appicon.png` and `windows/icon.ico` are source icons.
- `windows/wails.exe.manifest` is embedded using `wails3 generate syso`.
- `config.yml` configures the Wails 3 development runner.
- `bin/` is generated output used by the existing installer packaging.

The old `darwin` plists, Windows `info.json` and NSIS templates are retained as reference inputs from Wails 2. The current build generates version metadata and the macOS bundle directly from `VERSION`; it uses the repository's platform installer scripts rather than NSIS. See `docs/wails3-migration.md` at the repository root.
