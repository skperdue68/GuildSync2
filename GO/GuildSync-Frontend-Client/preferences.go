package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// DesktopPreferences holds window/tray and login behaviour that the profile menu
// exposes. It is stored next to the window state so a reinstall keeps it.
type DesktopPreferences struct {
	CloseToTray           bool   `json:"closeToTray"`
	StartAtLogin          bool   `json:"startAtLogin"`
	TrayAvailable         bool   `json:"trayAvailable"`
	StartAtLoginSupported bool   `json:"startAtLoginSupported"`
	Version               string `json:"version"`
}

var prefsMu sync.Mutex

func desktopPreferencesPath() (string, error) {
	root, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "GuildSync", "desktop-preferences.json"), nil
}

func defaultDesktopPreferences() DesktopPreferences {
	// Hiding to the tray is the historical behaviour, so it stays the default.
	return DesktopPreferences{CloseToTray: true}
}

func readDesktopPreferences() DesktopPreferences {
	settings := defaultDesktopPreferences()
	path, err := desktopPreferencesPath()
	if err != nil {
		return settings
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return settings
	}
	if json.Unmarshal(data, &settings) != nil {
		return defaultDesktopPreferences()
	}
	return settings
}

func writeDesktopPreferences(settings DesktopPreferences) error {
	path, err := desktopPreferencesPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// preferences returns the stored preferences with the state that only the host
// can answer (tray host present, login item actually registered) filled in.
func (a *App) preferences() DesktopPreferences {
	prefsMu.Lock()
	defer prefsMu.Unlock()
	settings := readDesktopPreferences()
	settings.TrayAvailable = a.supportsTray()
	settings.StartAtLoginSupported = startAtLoginSupported()
	if settings.StartAtLoginSupported {
		settings.StartAtLogin = startAtLoginActive()
	}
	settings.Version = appVersion
	return settings
}

func (a *App) GetDesktopPreferences() DesktopPreferences {
	return a.preferences()
}

func (a *App) SetCloseToTray(enabled bool) (DesktopPreferences, error) {
	prefsMu.Lock()
	settings := readDesktopPreferences()
	settings.CloseToTray = enabled
	err := writeDesktopPreferences(settings)
	prefsMu.Unlock()
	return a.preferences(), err
}

func (a *App) SetStartAtLogin(enabled bool) (DesktopPreferences, error) {
	if !startAtLoginSupported() {
		return a.preferences(), fmt.Errorf("starting at login is not supported on this platform")
	}
	if err := setStartAtLogin(enabled); err != nil {
		return a.preferences(), err
	}
	prefsMu.Lock()
	settings := readDesktopPreferences()
	settings.StartAtLogin = enabled
	err := writeDesktopPreferences(settings)
	prefsMu.Unlock()
	return a.preferences(), err
}

// closeToTrayEnabled reports whether the close button should hide the window
// instead of quitting. Callers still need a tray host to fall back on.
func (a *App) closeToTrayEnabled() bool {
	prefsMu.Lock()
	defer prefsMu.Unlock()
	return readDesktopPreferences().CloseToTray
}
