package main

import (
	"encoding/xml"
	"fmt"
	"os"
	"strings"
)

// startAtLoginHiddenFlag is passed by every login item so a start at login goes
// straight to the tray instead of opening a window over whatever the user is
// doing. A desktop without a tray host still opens the window.
const startAtLoginHiddenFlag = "--start-hidden"

// hasStartHiddenFlag reports whether this process was launched by a login item.
func hasStartHiddenFlag(args []string) bool {
	for _, arg := range args {
		if arg == startAtLoginHiddenFlag {
			return true
		}
	}
	return false
}

// windowsLoginItemValue builds the per-user Run value.
//
// A Run value is a command line, so the executable only needs plain double
// quotes around it. Formatting it with %q or strconv.Quote would escape the
// backslashes as well ("C:\\Users\\..."), which is a different path once
// Windows parses the value.
func windowsLoginItemValue(executable string) string {
	return `"` + strings.TrimSpace(executable) + `" ` + startAtLoginHiddenFlag
}

// xmlEscape escapes text that goes inside a plist <string>.
func xmlEscape(value string) string {
	var builder strings.Builder
	_ = xml.EscapeText(&builder, []byte(value))
	return builder.String()
}

// launchAgentPlist renders the macOS LaunchAgent that starts GuildSync at login.
// The bundle path is escaped, so an install path containing & or < stays valid
// XML.
func launchAgentPlist(label, target string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>%s</string>
	<key>ProgramArguments</key>
	<array>
		<string>%s</string>
		<string>%s</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Interactive</string>
</dict>
</plist>
`, xmlEscape(label), xmlEscape(target), xmlEscape(startAtLoginHiddenFlag))
}

// desktopEntryExecArg quotes one Exec argument for a .desktop entry. The
// desktop entry spec reserves \ " ` $ inside quoted arguments and treats % as a
// field code, so each one is escaped or doubled.
func desktopEntryExecArg(value string) string {
	replacer := strings.NewReplacer(
		`\`, `\\`,
		`"`, `\"`,
		"`", "\\`",
		`$`, `\$`,
		`%`, `%%`,
	)
	return `"` + replacer.Replace(strings.TrimSpace(value)) + `"`
}

// autostartDesktopEntry renders the XDG autostart entry.
func autostartDesktopEntry(executable string) string {
	return fmt.Sprintf(`[Desktop Entry]
Type=Application
Name=GuildSync
Comment=GuildSync desktop helper
Exec=%s %s
Terminal=false
X-GNOME-Autostart-enabled=true
`, desktopEntryExecArg(executable), startAtLoginHiddenFlag)
}

// ensureStartAtLoginCurrent rewrites an existing login item when it points at a
// different executable, which happens after an app update or a moved install.
// Without this the menu keeps reporting the item as on while login launches a
// path that no longer exists.
func ensureStartAtLoginCurrent() error {
	if !startAtLoginSupported() || !startAtLoginActive() {
		return nil
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	return refreshStartAtLoginFor(executable)
}
