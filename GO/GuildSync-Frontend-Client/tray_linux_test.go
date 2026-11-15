//go:build linux

package main

import (
	"context"
	"path/filepath"
	"testing"
)

func TestLinuxTrayUnavailableWithoutSessionBus(t *testing.T) {
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path="+filepath.Join(t.TempDir(), "missing-bus"))
	if trayHostAvailable(context.Background()) {
		t.Fatal("a desktop without a session bus must not hide to an inaccessible tray")
	}
}
