package main

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Register with the real Wails manager before Run so these tests do not create
// native UI. Repeated startup must not leave duplicate notification icons behind.
func TestNativeTrayRegistrationIsIdempotent(t *testing.T) {
	a := NewApp(nil, nil)
	a.desktop = application.New(application.Options{Name: "GuildSync tray test"})
	a.configureNativeTray()
	first := a.systemTray
	if first == nil {
		t.Fatal("native tray was not registered")
	}
	a.configureNativeTray()
	if a.systemTray != first {
		t.Fatal("repeated startup registered another tray")
	}
	a.stopTray()
	if a.systemTray != nil {
		t.Fatal("shutdown retained the tray")
	}
	a.stopTray() // Repeated shutdown must be safe.
}

func TestNativeTrayConfigurationWithoutDesktopIsSafe(t *testing.T) {
	a := NewApp(nil, nil)
	a.configureNativeTray()
	a.stopTray()
	if a.systemTray != nil {
		t.Fatal("tray registered without an application")
	}
}
