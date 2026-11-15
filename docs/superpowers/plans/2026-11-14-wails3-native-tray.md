# Wails 3 native tray

User direction: implement the tray follow-up and report other outstanding Wails 3 work. Execute inline on a branch from merged migration.

- [x] Replace the external tray implementation with a Wails-managed native tray and menu on Windows, macOS and Linux. Preserve Show/Hide/Quit, saved window state and native close-to-tray. Restore via icon/menu and macOS Dock reopen, without attaching the window as a transient tray popover.
- [x] Ensure tray registration and shutdown are idempotent and share Wails' application lifecycle. Remove the external tray dependency and obsolete event loop.
- [x] Enable all three platforms per the user's explicit choice. Linux without a registered tray host must close normally; monitor panel loss to restore access, including repeated panel restarts. Update migration notes and contributor guidance.
- [x] Verify client Go tests, tray lifecycle regression, native hotkey tests, frontend tests and Windows production build. Prepare a ready-for-review PR against master, noting manual native UI and other platform checks still needed.

Verification: Windows production build, complete client Go race suite, native hotkey suite and 15 frontend tests passed. Independent review found no actionable defects. Native macOS/Linux builds and interactive tray checks remain outstanding; the desktop workflow has no recorded runs yet.
