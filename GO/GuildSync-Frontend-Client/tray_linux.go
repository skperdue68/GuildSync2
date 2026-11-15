//go:build linux

package main

import (
	"context"
	"time"

	"github.com/godbus/dbus/v5"
)

func trayHostAvailable(parent context.Context) bool {
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, 500*time.Millisecond)
	defer cancel()
	conn, err := dbus.ConnectSessionBus(dbus.WithContext(ctx))
	if err != nil {
		return false
	}
	defer conn.Close()
	// A watcher service alone is not enough: there must be a registered panel
	// host actually displaying notification icons. Do not auto-start a watcher.
	var registered dbus.Variant
	err = conn.Object("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher").CallWithContext(ctx,
		"org.freedesktop.DBus.Properties.Get", dbus.FlagNoAutoStart,
		"org.kde.StatusNotifierWatcher", "IsStatusNotifierHostRegistered").Store(&registered)
	available, _ := registered.Value().(bool)
	return err == nil && available
}

func (a *App) watchTrayHost() {
	go func() {
		monitorTrayHost(a.ctx, 2*time.Second, trayHostAvailable, func() {
			// Never leave a background app inaccessible when its desktop panel goes away.
			if a.ctx.Err() == nil && !a.window.IsVisible() {
				a.ShowFromTray()
			}
		})
	}()
}
