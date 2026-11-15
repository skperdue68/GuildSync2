package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type App struct {
	ctx              context.Context
	desktop          *application.App
	window           *application.WebviewWindow
	systemTray       *application.SystemTray
	emitDesktopEvent func(string, any)
	appIcon          []byte
	trayIcon         []byte
	mu               sync.Mutex
	quiting          bool
	oauth            *oauthRuntimeState
	voice            *voiceRuntime

	fileWatcherMu        sync.Mutex
	fileWatcherCancel    context.CancelFunc
	fileWatcherRunning   bool
	fileWatcherSignature string
}

type WindowState struct {
	X            int  `json:"x"`
	Y            int  `json:"y"`
	Width        int  `json:"width"`
	Height       int  `json:"height"`
	Saved        bool `json:"saved"`
	HiddenToTray bool `json:"hidden_to_tray"`
}

func NewApp(appIcon []byte, trayIcon []byte) *App {
	return &App{
		appIcon:  appIcon,
		trayIcon: trayIcon,
	}
}

func (a *App) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	a.ctx = ctx

	// Register the native tray when the desktop provides a tray host.
	a.startTray()

	// Splash screen behavior.
	a.window.Center()
	a.window.SetAlwaysOnTop(true)
	return nil
}

func (a *App) ServiceShutdown() error {
	_ = a.SetVoiceHotkeyActive(false)
	a.StopGuildSyncFileWatcher()
	_ = a.SaveWindowState()
	a.stopTray()
	return nil
}

// ShowMainWindow is called after the splash screen finishes.
//
// Restore hidden-to-tray state only when a native tray is available.
// Linux desktops without a tray host always show the window normally.
func (a *App) ShowMainWindow() bool {
	if a.ctx == nil {
		return false
	}

	a.window.SetAlwaysOnTop(false)

	state := a.loadWindowState()

	if state.Saved {
		a.window.SetSize(state.Width, state.Height)
		a.window.SetPosition(state.X, state.Y)
	} else {
		a.window.SetSize(1100, 720)
		a.window.Center()
	}

	if a.supportsTray() && state.HiddenToTray {
		a.window.Hide()
		return false
	}

	a.window.Show()
	_ = a.saveWindowStateWithHiddenToTray(false)

	return true
}

func (a *App) SaveWindowState() error {
	return a.saveWindowState(nil)
}

func (a *App) saveWindowStateWithHiddenToTray(hiddenToTray bool) error {
	return a.saveWindowState(&hiddenToTray)
}

func (a *App) saveWindowState(hiddenToTrayOverride *bool) error {
	if a.ctx == nil {
		return nil
	}

	existing := a.loadWindowState()

	x, y := a.window.Position()
	width, height := a.window.Size()
	if width < 700 || height < 500 {
		width = existing.Width
		height = existing.Height
		x = existing.X
		y = existing.Y
	}

	hiddenToTray := existing.HiddenToTray
	if hiddenToTrayOverride != nil {
		hiddenToTray = *hiddenToTrayOverride
	}

	state := WindowState{
		X:            x,
		Y:            y,
		Width:        width,
		Height:       height,
		Saved:        true,
		HiddenToTray: hiddenToTray,
	}

	path, err := getConfigPath()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0644)
}

func (a *App) HideToTray() {
	_ = a.saveWindowStateWithHiddenToTray(true)

	if a.ctx == nil {
		return
	}

	if a.supportsTray() {
		a.window.Hide()
		return
	}

	a.window.Minimise()
}

func (a *App) ShowFromTray() {
	if a.ctx == nil {
		return
	}

	state := a.loadWindowState()

	if state.Saved {
		a.window.SetSize(state.Width, state.Height)
		a.window.SetPosition(state.X, state.Y)
	}

	_ = a.saveWindowStateWithHiddenToTray(false)

	a.window.Show()
	a.window.UnMinimise()
	a.window.Focus()
	a.window.SetAlwaysOnTop(true)
	a.window.SetAlwaysOnTop(false)
}

func (a *App) MaximizeWindow() {
	if a.ctx == nil {
		return
	}

	a.window.ToggleMaximise()
}

func (a *App) MinimizeWindow() {
	if a.ctx == nil {
		return
	}

	// Minimize should remain a normal window minimize on every platform.
	// Closing hides only when a native tray is available.
	_ = a.saveWindowStateWithHiddenToTray(false)
	a.window.Minimise()
}

func (a *App) CloseWindow() {
	if a.ctx == nil {
		return
	}

	if a.supportsTray() {
		// Existing tray platforms hide to system tray on close.
		_ = a.saveWindowStateWithHiddenToTray(true)
		a.window.Hide()
		return
	}

	_ = a.saveWindowStateWithHiddenToTray(false)

	// Non-tray platforms quit normally.
	a.desktop.Quit()
}

func (a *App) QuitFromTray() {
	a.mu.Lock()
	a.quiting = true
	a.mu.Unlock()

	// Quitting from the tray preserves the current tray-hidden state.
	_ = a.SaveWindowState()

	if a.ctx != nil {
		a.desktop.Quit()
	}
}

func (a *App) loadWindowState() WindowState {
	path, err := getConfigPath()
	if err != nil {
		return WindowState{}
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return WindowState{}
	}

	var state WindowState
	if err := json.Unmarshal(data, &state); err != nil {
		return WindowState{}
	}

	if state.Width < 700 || state.Height < 500 {
		return WindowState{}
	}

	return state
}

func getConfigPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}

	return filepath.Join(configDir, "GuildSync", "window-state.json"), nil
}
