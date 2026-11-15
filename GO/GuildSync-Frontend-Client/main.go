package main

import (
	"embed"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/appicon.png
var appIcon []byte

//go:embed build/windows/icon.ico
var trayIcon []byte

func main() {
	loadOptionalEnvFile()
	service := NewApp(appIcon, trayIcon)
	app := application.New(application.Options{
		Name: "GuildSync", Description: "GuildSync desktop helper", Icon: appIcon,
		Services: []application.Service{application.NewService(service)},
		Assets:   application.AssetOptions{Handler: application.AssetFileServerFS(assets)},
		Mac:      application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
		Linux:    application.LinuxOptions{ProgramName: "GuildSync"},
	})
	service.desktop = app
	service.emitDesktopEvent = func(name string, data any) { app.Event.Emit(name, data) }
	service.window = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name: "main", Title: "GuildSync", URL: "/",
		Width: 816, Height: 920, MinHeight: 800, MinWidth: 900,
		Frameless: true, AlwaysOnTop: true,
		BackgroundColour: application.RGBA{Red: 0, Green: 0, Blue: 0, Alpha: 255},
	})
	// Preserve Windows close-to-tray, including native close requests (Alt+F4).
	service.window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		if supportsTray() {
			service.mu.Lock()
			quitting := service.quiting
			service.mu.Unlock()
			if !quitting {
				service.HideToTray()
				event.Cancel()
			}
		} else {
			_ = service.SaveWindowState()
		}
	})
	if err := app.Run(); err != nil {
		println("Error:", err.Error())
	}
}
