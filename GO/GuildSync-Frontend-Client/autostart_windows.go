//go:build windows

package main

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows/registry"
)

const (
	autostartKeyPath   = `Software\Microsoft\Windows\CurrentVersion\Run`
	autostartValueName = "GuildSync"
)

func startAtLoginSupported() bool { return true }

func startAtLoginActive() bool {
	_, ok := recordedLoginItemValue()
	return ok
}

// recordedLoginItemValue returns the Run value when the login item exists.
func recordedLoginItemValue() (string, bool) {
	key, err := registry.OpenKey(registry.CURRENT_USER, autostartKeyPath, registry.QUERY_VALUE)
	if err != nil {
		return "", false
	}
	defer key.Close()
	value, _, err := key.GetStringValue(autostartValueName)
	if err != nil || value == "" {
		return "", false
	}
	return value, true
}

func writeLoginItemValue(value string) error {
	key, _, err := registry.CreateKey(registry.CURRENT_USER, autostartKeyPath, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return fmt.Errorf("open login items: %w", err)
	}
	defer key.Close()
	if err := key.SetStringValue(autostartValueName, value); err != nil {
		return fmt.Errorf("register login item: %w", err)
	}
	return nil
}

func setStartAtLoginFor(executable string) error {
	return writeLoginItemValue(windowsLoginItemValue(executable))
}

// refreshStartAtLoginFor repairs the Run value when it names another path.
func refreshStartAtLoginFor(executable string) error {
	expected := windowsLoginItemValue(executable)
	if recorded, ok := recordedLoginItemValue(); ok && recorded == expected {
		return nil
	}
	return setStartAtLoginFor(executable)
}

func setStartAtLogin(enabled bool) error {
	if !enabled {
		key, err := registry.OpenKey(registry.CURRENT_USER, autostartKeyPath, registry.SET_VALUE)
		if err != nil {
			return nil
		}
		defer key.Close()
		if err := key.DeleteValue(autostartValueName); err != nil && err != registry.ErrNotExist {
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
