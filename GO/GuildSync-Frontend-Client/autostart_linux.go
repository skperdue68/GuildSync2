//go:build linux

package main

import (
	"fmt"
	"os"
	"path/filepath"
)

func startAtLoginSupported() bool { return true }

func autostartEntryPath() (string, error) {
	root := os.Getenv("XDG_CONFIG_HOME")
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		root = filepath.Join(home, ".config")
	}
	return filepath.Join(root, "autostart", "guildsync.desktop"), nil
}

func startAtLoginActive() bool {
	path, err := autostartEntryPath()
	if err != nil {
		return false
	}
	_, err = os.Stat(path)
	return err == nil
}

func setStartAtLoginFor(executable string) error {
	path, err := autostartEntryPath()
	if err != nil {
		return err
	}
	entry := autostartDesktopEntry(executable)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(entry), 0644); err != nil {
		return fmt.Errorf("write autostart entry: %w", err)
	}
	return nil
}

// refreshStartAtLoginFor rewrites the entry when it names another executable.
func refreshStartAtLoginFor(executable string) error {
	path, err := autostartEntryPath()
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
	if string(recorded) == autostartDesktopEntry(executable) {
		return nil
	}
	return setStartAtLoginFor(executable)
}

func setStartAtLogin(enabled bool) error {
	path, err := autostartEntryPath()
	if err != nil {
		return err
	}
	if !enabled {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove autostart entry: %w", err)
		}
		return nil
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	return setStartAtLoginFor(executable)
}
