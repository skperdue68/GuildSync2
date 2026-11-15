package main

import (
	"os"
	"strconv"
	"strings"
)

const (
	defaultServerHost = "127.0.0.1"
	defaultServerPort = 8080
)

// serverHost and serverPort configure the headless server build
// (`wails3 task server`, built with the `server` build tag). Desktop builds
// ignore them because no HTTP listener is started.
func serverHost() string {
	host := strings.TrimSpace(os.Getenv("GUILDSYNC_SERVER_HOST"))
	if host == "" {
		return defaultServerHost
	}
	return host
}

func serverPort() int {
	raw := strings.TrimSpace(os.Getenv("GUILDSYNC_SERVER_PORT"))
	if raw == "" {
		return defaultServerPort
	}
	port, err := strconv.Atoi(raw)
	if err != nil || port < 1 || port > 65535 {
		return defaultServerPort
	}
	return port
}
