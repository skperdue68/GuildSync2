# Voice Channel Mute on Windows, Mac and Linux

The desktop client can mute your Discord voice channel from any application with two global shortcuts. The **mute key** silences the eligible lower-ranked members in your current channel; pressing it again restarts the countdown, and the mute ends on its own when the timeout expires, so a forgotten mute cannot leave the channel silenced. The **unmute key** is a separate, independently assigned shortcut that ends a mute immediately.

Existing server policy, Discord identity and role permissions still determine who can use this feature. Enable Voice Channel Mute in your desktop profile after connecting. The mute key defaults to `Ctrl+M`, the unmute key to `Ctrl+Shift+M`, and the auto-unmute timeout to 10 seconds.

## How it behaves

- **Press the mute key once to mute.** The status line shows the remaining timeout.
- **Press the mute key again to restart the countdown**, buying more time without ending the mute.
- **Press the unmute key to end the mute immediately**, whatever started it. Pressing it with nothing muted only reports that no mute is active.
- **Automatic unmute** ends the mute when the timeout expires, and the status line says so.
- The timeout is configurable in the profile (3–120 seconds). Keep it short — long enough to get someone's attention, not long enough to leave the channel muted if you walk away.
- Disabling the feature, changing a shortcut, disconnecting from voice, switching accounts or closing GuildSync all end an active mute immediately.

Both shortcuts are registered with each platform's own global shortcut facility, so they work while another application has focus and need **no keyboard-capture permission**:

| Platform | Facility | Permission needed |
| --- | --- | --- |
| Windows | `RegisterHotKey` | none |
| macOS | Carbon hot keys | none — no Input Monitoring or Accessibility grant |
| Linux X11 | `XGrabKey` | none beyond access to your own X session |
| Linux Wayland | XDG Global Shortcuts portal | the desktop's own approval dialog |

## Configuring the shortcuts

Open your desktop profile, enable **Voice Channel Mute**, then use **Set Mute Key** and **Set Unmute Key** to capture each shortcut. The profile shows both assigned keys, and the two must differ: assigning the mute key as the unmute key is rejected with a message naming the conflict.

A shortcut must be one ordinary key with optional `Ctrl`, `Alt` and `Shift` — for example `Ctrl+M`, `Ctrl+Shift+F8`, `Alt+Q` or `F8`. Chords of several ordinary keys (such as `M+N`) and modifier-only shortcuts are rejected, because the platform shortcut APIs cannot register them. Reserved combinations like `Alt+F4`, `Alt+Tab` and `Ctrl+Alt+Delete` are refused. If you remove or rename the unmute key in the settings file, GuildSync falls back to the default unmute key (or `Ctrl+Alt+M` when the mute key already uses it).

On macOS, `Ctrl` means Control and `Alt` means Option; use `Alt`/Option if you prefer the macOS-style modifier. macOS binds letter shortcuts to the labelled key on non-QWERTY layouts, so `Ctrl+M` follows the same key you see on an AZERTY or QWERTZ keyboard.

## Wayland notes

Wayland desktops grant global shortcuts through `org.freedesktop.portal.GlobalShortcuts`. Enabling the feature may open your desktop's shortcut approval or configuration dialog — approve it and use the combination the desktop assigns. The portal accepts one ordinary key plus modifiers, so multi-key chords are not available there. Both the mute and unmute keys need portal approval.

If your desktop does not provide the portal, only voice mute is unavailable: GuildSync still installs and runs, and the profile menu explains why. Use an X11 session if you need the shortcuts and your desktop cannot supply the portal. A cancelled or failed approval is not retried automatically; disable and re-enable the feature to try again.

## Test before using in a guild session

Use a test Discord voice channel and accounts with the intended role hierarchy:

1. Press the mute key once with GuildSync unfocused and confirm the mute starts.
2. Press it again and confirm the countdown restarts and the channel stays muted.
3. Press the unmute key and confirm the mute ends immediately and the status line says the unmute shortcut ended it.
4. Press the unmute key with nothing muted and confirm it only reports that no mute is active.
5. Press the mute key once and wait for the timeout; confirm the mute ends on its own and the status line reports the automatic unmute.
6. Change the timeout to the minimum and maximum values and repeat.
7. Change both keys to new combinations, including one attempt to reuse the mute key as the unmute key, and confirm the rejection message appears.
8. Disable the feature, change a shortcut, disconnect from voice, switch accounts, and close GuildSync while muted — each must end the mute.

Verify existing manual server mutes remain subject to the backend's ownership rules.

## Automated coverage

`go test ./...` in `GO/GuildSync-Frontend-Client` covers shortcut validation, timeout clamping, settings persistence, migration of older settings files, shortcut collisions, the toggle state machine, the unmute key and the automatic unmute. The frontend controller's behaviour is covered by `node --test GO/GuildSync-Frontend-Client/frontend/src/*.test.mjs`. Real shortcut delivery still needs a manual check per platform, because operating-system shortcut registration and Wayland consent are outside automated test reach — these checks do not build or publish installers.
