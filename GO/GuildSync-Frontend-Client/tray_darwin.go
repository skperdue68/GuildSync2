//go:build darwin

package main

import "context"

func trayHostAvailable(context.Context) bool { return true }
func (a *App) watchTrayHost()                {}
