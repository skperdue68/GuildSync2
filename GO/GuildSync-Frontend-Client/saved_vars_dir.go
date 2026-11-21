package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// GuildSyncSavedVarsDirSetting is the per-account SavedVariables folder as this
// computer sees it. SavedVarsDir is the folder actually in use.
type GuildSyncSavedVarsDirSetting struct {
	SavedVarsDir        string `json:"savedVarsDir"`
	DefaultSavedVarsDir string `json:"defaultSavedVarsDir"`
	LegacySavedVarsDir  string `json:"legacySavedVarsDir"`
	Configured          bool   `json:"configured"`
	Error               string `json:"error,omitempty"`
}

var savedVarsDirMu sync.Mutex
var savedVarsDirValue string

func currentSavedVarsDirOverride() string {
	savedVarsDirMu.Lock()
	defer savedVarsDirMu.Unlock()
	return savedVarsDirValue
}

// legacySavedVarsDir is the pre-database GuildSyncSettings.txt value. It is only
// read so an existing installation can move the folder into the account.
func legacySavedVarsDir() string {
	return resolvePathFromEnv(os.Getenv("SAVED_VARS_DIR"))
}

func normalizeSavedVarsDir(value string) (string, error) {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return "", nil
	}
	if len(raw) > 1024 {
		return "", fmt.Errorf("the SavedVariables folder path is too long")
	}
	if strings.ContainsAny(raw, "\x00\n\r") {
		return "", fmt.Errorf("the SavedVariables folder path contains characters that cannot be used in a path")
	}
	resolved := resolvePathFromEnv(raw)
	if !filepath.IsAbs(resolved) {
		return "", fmt.Errorf("enter the full folder path, for example C:\\Users\\You\\Documents\\Elder Scrolls Online\\live\\SavedVariables")
	}
	return filepath.Clean(resolved), nil
}

func (a *App) savedVarsDirSetting(err error) GuildSyncSavedVarsDirSetting {
	setting := GuildSyncSavedVarsDirSetting{
		SavedVarsDir:        getSavedVarsDir(),
		DefaultSavedVarsDir: getDefaultSavedVarsDir(),
		LegacySavedVarsDir:  legacySavedVarsDir(),
		Configured:          currentSavedVarsDirOverride() != "",
	}
	if err != nil {
		setting.Error = err.Error()
	}
	return setting
}

// GetSavedVarsDirSetting reports the folder in use, the default folder, and any
// legacy settings-file value that still has to move into the account.
func (a *App) GetSavedVarsDirSetting() GuildSyncSavedVarsDirSetting {
	return a.savedVarsDirSetting(nil)
}

// SetSavedVarsDirSetting applies the account value fetched from the backend. An
// empty value uses the default folder. Invalid input leaves the current folder.
func (a *App) SetSavedVarsDirSetting(value string) GuildSyncSavedVarsDirSetting {
	clean, err := normalizeSavedVarsDir(value)
	if err != nil {
		return a.savedVarsDirSetting(err)
	}
	savedVarsDirMu.Lock()
	savedVarsDirValue = clean
	savedVarsDirMu.Unlock()
	return a.savedVarsDirSetting(nil)
}
