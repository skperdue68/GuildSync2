package main

import (
	"embed"
	"os"
	"runtime"

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
	// A login item starts the client with the window hidden, from the tray.
	service.startHidden = hasStartHiddenFlag(os.Args[1:])
	app := application.New(application.Options{
		Name: "GuildSync", Description: "GuildSync desktop helper", Icon: appIcon,
		Services: []application.Service{application.NewService(service)},
		Assets:   application.AssetOptions{Handler: application.AssetFileServerFS(assets)},
		Mac:      application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
		Linux:    application.LinuxOptions{ProgramName: "GuildSync"},
		// One client per machine: a second copy would fight over the fixed OAuth
		// callback port and the SavedVariables watchers. Relaunching restores the
		// running window instead.
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "com.guildsync.client",
			OnSecondInstanceLaunch: func(application.SecondInstanceData) {
				service.ShowFromTray()
			},
		},
		// Used only by server builds (`wails3 build -tags server`), where the app
		// serves the same services and frontend over HTTP instead of a window.
		Server: application.ServerOptions{Host: serverHost(), Port: serverPort()},
	})
	service.desktop = app
	service.emitDesktopEvent = func(name string, data any) { app.Event.Emit(name, data) }
	service.window = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name: "main", Title: "GuildSync", URL: "/",
		Width: 816, Height: 920, MinHeight: 800, MinWidth: 900,
		Frameless: true, AlwaysOnTop: true,
		BackgroundColour: application.RGBA{Red: 0, Green: 0, Blue: 0, Alpha: 255},
	})
	// Preserve close-to-tray for both custom and native close requests.
	service.window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		service.mu.Lock()
		quitting := service.quiting
		service.mu.Unlock()
		if quitting {
			return
		}
		if service.supportsTray() && service.closeToTrayEnabled() {
			service.HideToTray()
			event.Cancel()
			return
		}
		_ = service.SaveWindowState()
		if service.supportsTray() {
			// Close means quit when the preference is off, so a windowless process
			// is not left behind behind in the tray.
			service.mu.Lock()
			service.quiting = true
			service.mu.Unlock()
			go service.desktop.Quit()
		}
	})
	if runtime.GOOS == "darwin" {
		app.Event.OnApplicationEvent(events.Mac.ApplicationShouldHandleReopen, func(*application.ApplicationEvent) {
			service.ShowFromTray()
		})
	}
	if err := app.Run(); err != nil {
		println("Error:", err.Error())
	}
}
