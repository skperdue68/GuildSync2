//go:build !windows && !linux && !darwin

package main

import "context"

func trayHostAvailable(context.Context) bool { return false }
func (a *App) watchTrayHost()                {}
