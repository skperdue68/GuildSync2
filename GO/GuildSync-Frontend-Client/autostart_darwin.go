//go:build darwin

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const launchAgentLabel = "com.guildsync.client"

func startAtLoginSupported() bool { return true }

func launchAgentPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", launchAgentLabel+".plist"), nil
}

// loginItemTarget prefers the application bundle so macOS launches GuildSync the
// same way Finder does, and falls back to the executable for unbundled builds.
func loginItemTarget(executable string) string {
	if index := strings.Index(executable, "/Contents/MacOS/"); index > 0 {
		return executable[:index]
	}
	return executable
}

func startAtLoginActive() bool {
	path, err := launchAgentPath()
	if err != nil {
		return false
	}
	_, err = os.Stat(path)
	return err == nil
}

func setStartAtLoginFor(executable string) error {
	path, err := launchAgentPath()
	if err != nil {
		return err
	}
	plist := launchAgentPlist(launchAgentLabel, loginItemTarget(executable))
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(plist), 0644); err != nil {
		return fmt.Errorf("write login item: %w", err)
	}
	return nil
}

// refreshStartAtLoginFor rewrites the LaunchAgent when the bundle moved.
func refreshStartAtLoginFor(executable string) error {
	path, err := launchAgentPath()
	if err != nil {
		return err
	}
	recorded, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return setStartAtLoginFor(executable)
		}
		return err
	}
	if string(recorded) == launchAgentPlist(launchAgentLabel, loginItemTarget(executable)) {
		return nil
	}
	return setStartAtLoginFor(executable)
}

func setStartAtLogin(enabled bool) error {
	path, err := launchAgentPath()
	if err != nil {
		return err
	}
	if !enabled {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove login item: %w", err)
		}
		return nil
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	return setStartAtLoginFor(executable)
}
