package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

type processExitError int

func (e processExitError) Error() string { return fmt.Sprintf("process exit %d", e) }
func (e processExitError) ExitCode() int { return int(e) }

func TestMacESOExactProcessNames(t *testing.T) {
	for _, tc := range []struct {
		name      string
		processes []string
		running   bool
	}{
		{"native ESO", []string{"eso"}, true},
		{"case insensitive", []string{"ESO"}, true},
		{"64 bit", []string{"eso64"}, true},
		{"exe name", []string{"eso64.exe"}, true},
		{"32 bit exe name", []string{"eso.exe"}, true},
		{"resources without ESO", []string{"usbmuxd", "WindowServer", "AdobeResourceSynchronizer", "Google Chrome Helper"}, false},
		{"launcher only", []string{"Bethesda.net_Launcher", "Zenimax Online Launcher"}, false},
		{"partial name", []string{"esohelper", "myeso", "eso64.exe.backup"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			run := func(name string, args ...string) ([]byte, error) {
				calls++
				if name != "/usr/bin/pgrep" || !reflect.DeepEqual(args, []string{"-ilx", "eso|eso64|eso[.]exe|eso64[.]exe"}) {
					t.Fatalf("unexpected process command: %s %v", name, args)
				}
				matcher := regexp.MustCompile("(?i)^(?:" + args[1] + ")$")
				for _, process := range tc.processes {
					if matcher.MatchString(process) {
						return []byte("92614 " + process + "\n"), nil
					}
				}
				return nil, processExitError(1)
			}
			running, err := detectESORunning("darwin", run)
			if err != nil || running != tc.running {
				t.Fatalf("running=%v err=%v; want %v", running, err, tc.running)
			}
			if calls != 1 {
				t.Fatalf("called process tools %d times; must not fall back to full argument scanning", calls)
			}
		})
	}
}

func TestMacESOExitStatusAndFailures(t *testing.T) {
	for _, tc := range []struct {
		name            string
		err             error
		running, failed bool
	}{
		{"found", nil, true, false},
		{"not found", processExitError(1), false, false},
		{"wrapped no match", fmt.Errorf("command: %w", processExitError(1)), false, false},
		{"invalid arguments", processExitError(2), false, true},
		{"internal error", processExitError(3), false, true},
		{"cannot execute", errors.New("permission denied"), false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status := esoProcessStatus("darwin", func(string, ...string) ([]byte, error) { return nil, tc.err })
			if status.Running != tc.running || (status.Error != "") != tc.failed {
				t.Fatalf("unexpected status: %+v", status)
			}
			if esoStatusBlocksSavedVarsWrites(status) != (tc.running || tc.failed) {
				t.Fatalf("wrong write protection for %+v", status)
			}
			if tc.failed && !strings.Contains(status.Message, "could not determine") {
				t.Fatalf("error must explain unknown state: %s", status.Message)
			}
		})
	}
}

func TestOtherPlatformCommandsPreserved(t *testing.T) {
	for _, platform := range []string{"windows", "linux"} {
		t.Run(platform, func(t *testing.T) {
			var command string
			var arguments []string
			running, err := detectESORunning(platform, func(name string, args ...string) ([]byte, error) {
				command = name
				arguments = args
				return []byte("eso64.exe"), nil
			})
			if err != nil || !running {
				t.Fatalf("unexpected running=%v err=%v", running, err)
			}
			if platform == "windows" {
				if command != "tasklist" || !reflect.DeepEqual(arguments, []string{"/FO", "CSV", "/NH"}) {
					t.Fatal("Windows detection changed")
				}
			}
			if platform == "linux" {
				if command != "pgrep" || len(arguments) != 2 || arguments[0] != "-af" {
					t.Fatal("Linux detection changed")
				}
			}
		})
	}
}

func TestMacDetectionErrorProtectsDiscordReminderExportAndCleanup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "GuildSyncDiscordReminder.lua")
	original := `GuildSyncDiscordReminder = { ["Default"] = { ["@Officer"] = { ["$AccountWide"] = { ["version"] = 1, ["mailQueue"] = {}, ["mailAck"] = { ["ack"] = { ["requestId"] = "ack" } } } } } }`
	if err := os.WriteFile(path, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	blocked := func() bool {
		status := esoProcessStatus("darwin", func(string, ...string) ([]byte, error) { return nil, processExitError(3) })
		return esoStatusBlocksSavedVarsWrites(status)
	}
	record := map[string]interface{}{"requestId": "new", "batchId": "batch", "recipient": "@Member", "guildId": "123", "sendingAccount": "@Officer", "worldName": "NA Megaserver"}
	if result := writeDiscordReminderQueueFile(path, "@Officer", "NA Megaserver", []map[string]interface{}{record}, blocked); result.OK {
		t.Fatal("export succeeded with unknown ESO state")
	}
	if result := removeDiscordReminderAckIDsFromFile(path, []string{"ack"}, false, blocked); result.OK {
		t.Fatal("acknowledgement cleanup succeeded with unknown ESO state")
	}
	actual, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(actual) != original {
		t.Fatal("unknown ESO state changed reminder SavedVariables")
	}
}
