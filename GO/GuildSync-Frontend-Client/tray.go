package main

import (
	"context"
	"runtime"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func (a *App) supportsTray() bool {
	a.mu.Lock()
	registered := a.systemTray != nil
	a.mu.Unlock()
	return registered && trayHostAvailable(a.ctx)
}

func (a *App) startTray() {
	if trayHostAvailable(a.ctx) && a.configureNativeTray() {
		a.watchTrayHost()
	}
}

func (a *App) configureNativeTray() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.desktop == nil || a.systemTray != nil {
		return false
	}
	tray := a.desktop.SystemTray.New()
	if runtime.GOOS == "windows" {
		tray.SetIcon(a.trayIcon)
	} else {
		tray.SetIcon(a.appIcon)
	}
	tray.SetTooltip("GuildSync is running")
	if runtime.GOOS == "darwin" {
		// A normal macOS status item opens its menu on left click.
		tray.OnClick(tray.OpenMenu)
	} else {
		tray.OnClick(a.ShowFromTray)
	}
	tray.OnDoubleClick(a.ShowFromTray)
	menu := a.desktop.NewMenu()
	menu.Add("Show").OnClick(func(*application.Context) { a.ShowFromTray() })
	menu.Add("Hide").OnClick(func(*application.Context) { a.HideToTray() })
	menu.AddSeparator()
	menu.Add("Quit GuildSync").OnClick(func(*application.Context) { a.QuitFromTray() })
	tray.SetMenu(menu)
	// Do not AttachWindow: that would reposition the normal window by the icon
	// and hide it on focus loss, as if it were a transient tray popover.
	a.systemTray = tray
	return true
}

func (a *App) stopTray() {
	a.mu.Lock()
	tray := a.systemTray
	a.systemTray = nil
	a.mu.Unlock()
	if tray != nil {
		tray.Destroy()
	}
}

// Linux desktops can lose their panel/tray host while the app is hidden.
// Restore once per loss, including after panel restarts; shutdown must not
// reopen the window and an absent panel must not repeatedly steal focus.
func monitorTrayHost(ctx context.Context, interval time.Duration, available func(context.Context) bool, onLost func()) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	wasAvailable := true
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if ctx.Err() != nil {
				return
			}
			isAvailable := available(ctx)
			if wasAvailable && !isAvailable && ctx.Err() == nil {
				onLost()
			}
			wasAvailable = isAvailable
		}
	}
}
