# macOS ESO process detection

The old macOS fallback searched complete process arguments for `eso`. That matches the `eso` inside `Resources`, so normal system/browser processes could make GuildSync report that ESO was running after the game closed. The shared Linux/macOS `pgrep -af` command was also unsuitable on macOS: macOS `-a` includes process ancestors, and the output without `-l` contains only process IDs.

macOS now runs `/usr/bin/pgrep -ilx 'eso|eso64|eso[.]exe|eso64[.]exe'`, matching complete process names, case-insensitively. Exit 0 means running; exit 1 means stopped. Other exits or execution failures produce a detection error, pause native SavedVariables writes/cleanup, and show **ESO Status Unknown** in the desktop Banking status. The macOS full-argument fallback is removed. Windows and Linux retain their existing commands and matching behavior.

This applies to both Banking receipt exports and Discord reminder exports. Discord reminder writes check the shared status before preparing the replacement and again immediately before replacing the file. When polling confirms ESO has closed, GuildSync processes pending Banking work and also synchronizes Discord reminder delivery results and queued-recipient cleanup. Unknown status does not trigger either closed-game action. No Wails version or build command changes are required.

## Mac user validation

Run the following in Terminal with GuildSync open:

```sh
/usr/bin/pgrep -ilx 'eso|eso64|eso[.]exe|eso64[.]exe'
printf 'Exit code: %s\n' "$?"
```

Check three states:

1. ESO open: a PID and process name appear; exit code 0. The supplied Mac sample already confirmed `92614 eso`.
2. ESO fully closed: no matching output; exit code 1.
3. ESO closed with its launcher still open: no matching output; exit code 1.

After installing the updated GuildSync, its Banking status should follow those transitions within the existing five-second polling interval. The two closed-game cases still require confirmation on the user's Mac. If a Wine/CrossOver installation exposes a different process name, capture that separately before expanding the exact-name list; do not restore broad command-line substring matching.

Regression tests exercise process names, Resources/browser/launcher false positives, normal and wrapped exit codes, execution errors, write protection, UI error recovery and unchanged Windows/Linux commands. Local validation uses injected macOS command results; it does not execute macOS binaries on the Windows development machine.
