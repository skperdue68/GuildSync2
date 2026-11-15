# Minimal Wails 3 migration

User direction: proceed with the minimal migration, retain current behavior, update this repository's automation, and record future opportunities. Implement inline.

- [x] Port application/window lifecycle and runtime calls to Wails 3.0.0 services, retaining settings, OAuth, file watching, hotkeys and Windows-only tray behavior.
- [x] Generate Wails 3 JavaScript bindings, replace the legacy global hotkey bridge, and adapt event payloads with regression tests.
- [x] Provide one reproducible Wails 3 build entry point used locally and by CI. Keep existing installer payload names and macOS universal builds; align Go 1.26 and CLI/module/runtime versions.
- [x] Update active contributor/build instructions and note native tray, multi-window, updater and shortcut opportunities for later. Defer Dependabot and unrelated additions as requested.
- [x] Verify frontend tests/build, Go tests and a production Windows build; add the same build to PR CI for all supported platforms. Report platform checks that cannot run locally.


Validation: Windows production build, client Go suite, native hotkey race suite, 15 frontend tests, Windows manifest tests, and four release-version synchronization tests passed. Independent review found no remaining actionable issues. macOS/Linux native execution and manual UI checks await platform verification.
