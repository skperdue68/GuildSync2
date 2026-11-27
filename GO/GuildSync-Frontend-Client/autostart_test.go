package main

import (
	"encoding/xml"
	"strings"
	"testing"
)

func TestWindowsLoginItemValueQuotesWithoutEscapingBackslashes(t *testing.T) {
	cases := []struct {
		name       string
		executable string
		want       string
	}{
		{
			name:       "program files path",
			executable: `C:\Program Files\GuildSync\GuildSync.exe`,
			want:       `"C:\Program Files\GuildSync\GuildSync.exe" --start-hidden`,
		},
		{
			name:       "path with ampersand",
			executable: `C:\Tools & Games\GuildSync.exe`,
			want:       `"C:\Tools & Games\GuildSync.exe" --start-hidden`,
		},
		{
			name:       "surrounding whitespace",
			executable: "  C:\\GuildSync\\GuildSync.exe \n",
			want:       `"C:\GuildSync\GuildSync.exe" --start-hidden`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := windowsLoginItemValue(tc.executable)
			if got != tc.want {
				t.Fatalf("windowsLoginItemValue(%q) = %q, want %q", tc.executable, got, tc.want)
			}
			// A Go or JSON quoted string would double every backslash, and
			// Windows would then look for a path that does not exist.
			if strings.Contains(strings.TrimPrefix(got, `"`), `\\`) {
				t.Fatalf("windows login item value escaped backslashes: %q", got)
			}
			if !strings.Contains(got, startAtLoginHiddenFlag) {
				t.Fatalf("login item does not start hidden: %q", got)
			}
		})
	}
}

func TestHasStartHiddenFlag(t *testing.T) {
	if !hasStartHiddenFlag([]string{"--start-hidden"}) {
		t.Fatal("exact flag not detected")
	}
	if !hasStartHiddenFlag([]string{"--enable-features=x", "--start-hidden"}) {
		t.Fatal("flag among other arguments not detected")
	}
	if hasStartHiddenFlag(nil) || hasStartHiddenFlag([]string{"--start-hidden=false", "start-hidden"}) {
		t.Fatal("near-miss arguments must not count as the flag")
	}
}

type launchAgent struct {
	XMLName xml.Name `xml:"plist"`
	Dict    struct {
		Keys  []string `xml:"key"`
		Array struct {
			Arguments []string `xml:"string"`
		} `xml:"array"`
	} `xml:"dict"`
}

func TestLaunchAgentPlistStaysValidXMLForAwkwardPaths(t *testing.T) {
	cases := []string{
		"/Applications/GuildSync.app",
		"/Users/a & b/Applications/GuildSync.app",
		"/Users/ro <dev>/Applications/GuildSync.app",
	}
	for _, target := range cases {
		t.Run(target, func(t *testing.T) {
			plist := launchAgentPlist("com.guildsync.client", target)
			var parsed launchAgent
			if err := xml.Unmarshal([]byte(plist), &parsed); err != nil {
				t.Fatalf("plist is not valid XML: %v\n%s", err, plist)
			}
			if len(parsed.Dict.Array.Arguments) != 2 {
				t.Fatalf("expected the bundle and the hidden flag, got %#v", parsed.Dict.Array.Arguments)
			}
			if parsed.Dict.Array.Arguments[0] != target {
				t.Fatalf("argument round-trip = %q, want %q", parsed.Dict.Array.Arguments[0], target)
			}
			if parsed.Dict.Array.Arguments[1] != startAtLoginHiddenFlag {
				t.Fatalf("second argument = %q, want %q", parsed.Dict.Array.Arguments[1], startAtLoginHiddenFlag)
			}
			if !strings.Contains(plist, "<key>RunAtLoad</key>") {
				t.Fatal("plist lost RunAtLoad")
			}
		})
	}
}

func TestAutostartDesktopEntryEscapesExecPath(t *testing.T) {
	entry := autostartDesktopEntry(`/opt/Guild Sync & Tools/100% ready/GuildSync`)
	if !strings.HasPrefix(entry, "[Desktop Entry]\n") {
		t.Fatalf("missing group header: %q", entry)
	}
	exec := desktopEntryExecArg(`/opt/Guild Sync & Tools/100% ready/GuildSync`)
	want := `"/opt/Guild Sync & Tools/100%% ready/GuildSync"`
	if exec != want {
		t.Fatalf("desktopEntryExecArg = %q, want %q", exec, want)
	}
	if !strings.Contains(entry, "Exec="+want+" "+startAtLoginHiddenFlag+"\n") {
		t.Fatalf("Exec line does not carry the quoted path and hidden flag:\n%s", entry)
	}
	if !strings.Contains(entry, "Terminal=false\n") {
		t.Fatal("entry lost Terminal=false")
	}
	// Every remaining percent sign is an escaped field code, so no stray one can
	// swallow the path as a %-field.
	for _, line := range strings.Split(entry, "\n") {
		if !strings.HasPrefix(line, "Exec=") {
			continue
		}
		if strings.Count(line, "%")%2 != 0 {
			t.Fatalf("unescaped field code in %q", line)
		}
	}
}

func TestDesktopEntryExecArgEscapesQuotesBackslashesAndDollars(t *testing.T) {
	got := desktopEntryExecArg(`/opt/a"b\c` + "`" + `d$e`)
	want := `"/opt/a\"b\\c\` + "`" + `d\$e"`
	if got != want {
		t.Fatalf("desktopEntryExecArg = %q, want %q", got, want)
	}
}
