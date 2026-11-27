//go:build linux

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// isolateAutostart points the XDG autostart lookup at a temporary config home.
func isolateAutostart(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", root)
	return root
}

func TestStartAtLoginWritesASelfContainedEntry(t *testing.T) {
	root := isolateAutostart(t)
	if err := setStartAtLoginFor("/opt/GuildSync/GuildSync"); err != nil {
		t.Fatalf("setStartAtLoginFor: %v", err)
	}
	if !startAtLoginActive() {
		t.Fatal("entry exists but startAtLoginActive reported false")
	}
	path := filepath.Join(root, "autostart", "guildsync.desktop")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read entry: %v", err)
	}
	if string(data) != autostartDesktopEntry("/opt/GuildSync/GuildSync") {
		t.Fatalf("entry content drifted:\n%s", data)
	}
	if err := setStartAtLogin(false); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if startAtLoginActive() {
		t.Fatal("disabled entry still reported active")
	}
}

func TestRefreshRepointsTheEntryAfterAnUpdate(t *testing.T) {
	isolateAutostart(t)
	if err := setStartAtLoginFor("/opt/GuildSync-1.2.0/GuildSync"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// This is the stale case: the app updated to a new directory, so the entry
	// still launches the old, deleted executable.
	if err := refreshStartAtLoginFor("/opt/GuildSync-1.3.0/GuildSync"); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	path, err := autostartEntryPath()
	if err != nil {
		t.Fatalf("path: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	want := autostartDesktopEntry("/opt/GuildSync-1.3.0/GuildSync")
	if string(data) != want {
		t.Fatalf("entry was not updated:\n%s\nwant:\n%s", data, want)
	}
}

func TestRefreshLeavesACurrentEntryAlone(t *testing.T) {
	isolateAutostart(t)
	if err := setStartAtLoginFor("/opt/GuildSync/GuildSync"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	path, err := autostartEntryPath()
	if err != nil {
		t.Fatalf("path: %v", err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if err := refreshStartAtLoginFor("/opt/GuildSync/GuildSync"); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatal("a current entry was rewritten")
	}
}

func TestRefreshWritesNothingWhenTheItemIsOff(t *testing.T) {
	isolateAutostart(t)
	if err := ensureStartAtLoginCurrent(); err != nil {
		t.Fatalf("ensure on a disabled item: %v", err)
	}
	path, err := autostartEntryPath()
	if err != nil {
		t.Fatalf("path: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("disabled login item was created: %v", err)
	}
}
