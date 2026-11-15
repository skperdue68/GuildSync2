package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	defaultVoiceShortcut       = "Ctrl+M"
	defaultVoiceUnmuteShortcut = "Ctrl+Shift+M"
	defaultVoiceMuteSeconds    = 10
	minVoiceMuteSeconds        = 3
	maxVoiceMuteSeconds        = 120
)

// VoiceHotkeySettings is the persisted voice mute shortcut configuration.
//
// Muting is a toggle: Shortcut mutes, and pressing it again restarts the
// countdown, so a repeated press extends the attention window instead of
// unmuting. The mute always ends on its own after TimeoutSeconds, so a forgotten
// mute cannot leave eligible channel members silenced.
//
// UnmuteShortcut is a second, separately assigned shortcut that ends an active
// mute immediately. It is ignored when no mute is running, so it is safe to
// leave registered all the time.
type VoiceHotkeySettings struct {
	Enabled        bool   `json:"enabled"`
	Shortcut       string `json:"shortcut"`
	UnmuteShortcut string `json:"unmuteShortcut"`
	Supported      bool   `json:"supported"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
}

type voiceShortcut struct {
	keys  []int
	label string
}

// voiceHotkeySupported reports whether this build can register a system-wide
// shortcut. Wails implements global shortcuts natively on Windows, macOS, X11
// and Wayland (through the desktop Global Shortcuts portal), so no per-platform
// keyboard listener is required.
func voiceHotkeySupported() bool {
	switch runtime.GOOS {
	case "windows", "darwin", "linux":
		return true
	default:
		return false
	}
}

// parseVoiceShortcut accepts the accelerator subset Wails can register: optional
// Ctrl/Alt/Shift modifiers followed by exactly one ordinary key.
func parseVoiceShortcut(input string) (voiceShortcut, error) {
	result := voiceShortcut{}
	codes := map[string]int{"CTRL": 17, "ALT": 18, "SHIFT": 16, "SPACE": 32, "TAB": 9, "ENTER": 13, "BACKSPACE": 8, "DELETE": 46, "INSERT": 45, "HOME": 36, "END": 35, "PAGEUP": 33, "PAGEDOWN": 34, "LEFT": 37, "UP": 38, "RIGHT": 39, "DOWN": 40}
	labels := map[string]string{"CTRL": "Ctrl", "ALT": "Alt", "SHIFT": "Shift", "SPACE": "Space", "TAB": "Tab", "ENTER": "Enter", "BACKSPACE": "Backspace", "DELETE": "Delete", "INSERT": "Insert", "HOME": "Home", "END": "End", "PAGEUP": "PageUp", "PAGEDOWN": "PageDown", "LEFT": "Left", "UP": "Up", "RIGHT": "Right", "DOWN": "Down"}
	seen := map[string]bool{}
	ordinaryKeys := 0
	for _, part := range strings.Split(strings.ToUpper(strings.TrimSpace(input)), "+") {
		key := strings.TrimSpace(part)
		if key == "" {
			continue
		}
		if seen[key] {
			return result, fmt.Errorf("duplicate shortcut key")
		}
		seen[key] = true
		code := codes[key]
		if len(key) == 1 && ((key[0] >= 'A' && key[0] <= 'Z') || (key[0] >= '0' && key[0] <= '9')) {
			code = int(key[0])
		}
		for n := 1; n <= 12; n++ {
			if key == fmt.Sprintf("F%d", n) {
				code = 111 + n
			}
		}
		if code == 0 {
			return result, fmt.Errorf("use letters, numbers, F1–F12, Ctrl, Alt, Shift, or supported navigation keys")
		}
		if code != 17 && code != 18 && code != 16 {
			ordinaryKeys++
		}
		result.keys = append(result.keys, code)
	}
	if ordinaryKeys == 0 {
		return result, fmt.Errorf("include one key in addition to Ctrl, Alt or Shift")
	}
	if ordinaryKeys > 1 {
		return result, fmt.Errorf("use one key with optional Ctrl, Alt or Shift")
	}
	if ((seen["ALT"] || seen["CTRL"]) && seen["F4"]) || (seen["ALT"] && seen["TAB"]) || (seen["CTRL"] && seen["ALT"] && seen["DELETE"]) {
		return result, fmt.Errorf("reserved system shortcut")
	}
	order := func(code int) int {
		switch code {
		case 17:
			return -3
		case 18:
			return -2
		case 16:
			return -1
		}
		return code
	}
	sort.Slice(result.keys, func(i, j int) bool { return order(result.keys[i]) < order(result.keys[j]) })
	canonical := []string{}
	for _, code := range result.keys {
		label := ""
		for key, value := range codes {
			if value == code {
				label = labels[key]
			}
		}
		if label == "" {
			if code >= 112 {
				label = fmt.Sprintf("F%d", code-111)
			} else {
				label = string(rune(code))
			}
		}
		canonical = append(canonical, label)
	}
	result.label = strings.Join(canonical, "+")
	if result.label == "" {
		return result, fmt.Errorf("shortcut is empty")
	}
	return result, nil
}

func clampVoiceMuteSeconds(seconds int) int {
	if seconds <= 0 {
		return defaultVoiceMuteSeconds
	}
	if seconds < minVoiceMuteSeconds {
		return minVoiceMuteSeconds
	}
	if seconds > maxVoiceMuteSeconds {
		return maxVoiceMuteSeconds
	}
	return seconds
}

// defaultVoiceUnmuteFor returns an unmute default that cannot collide with the
// configured mute shortcut.
func defaultVoiceUnmuteFor(muteLabel string) string {
	for _, candidate := range []string{defaultVoiceUnmuteShortcut, "Ctrl+Alt+M"} {
		if parsed, err := parseVoiceShortcut(candidate); err == nil && parsed.label != muteLabel {
			return parsed.label
		}
	}
	return ""
}

// normalizeVoiceUnmuteShortcut keeps a stored unmute shortcut only when it is
// registrable and distinct from the mute shortcut.
func normalizeVoiceUnmuteShortcut(value, muteLabel string) string {
	parsed, err := parseVoiceShortcut(value)
	if err != nil || parsed.label == muteLabel {
		return defaultVoiceUnmuteFor(muteLabel)
	}
	return parsed.label
}

func voiceSettingsPath() (string, error) {
	root, err := os.UserConfigDir()
	return filepath.Join(root, "GuildSync", "voice-hotkey.json"), err
}

func defaultVoiceSettings() VoiceHotkeySettings {
	return VoiceHotkeySettings{
		Shortcut:       defaultVoiceShortcut,
		UnmuteShortcut: defaultVoiceUnmuteShortcut,
		TimeoutSeconds: defaultVoiceMuteSeconds,
	}
}

func readVoiceSettings(path string) VoiceHotkeySettings {
	settings := defaultVoiceSettings()
	data, err := os.ReadFile(path)
	if err == nil {
		if json.Unmarshal(data, &settings) != nil {
			return defaultVoiceSettings()
		}
	}
	shortcut, err := parseVoiceShortcut(settings.Shortcut)
	if err != nil {
		// Older files may hold a multi-key chord that accelerators cannot express.
		return defaultVoiceSettings()
	}
	settings.Shortcut = shortcut.label
	settings.UnmuteShortcut = normalizeVoiceUnmuteShortcut(settings.UnmuteShortcut, shortcut.label)
	settings.TimeoutSeconds = clampVoiceMuteSeconds(settings.TimeoutSeconds)
	return settings
}

func writeVoiceSettings(path string, settings VoiceHotkeySettings) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

// voiceRuntime owns the two Wails global shortcut registrations and the mute
// timer. The frontend still receives "pressed" and "released" edges, so a mute
// session is opened and closed exactly as it was with the hold-to-mute listener.
type voiceRuntime struct {
	mu               sync.Mutex
	settings         VoiceHotkeySettings
	active           bool
	capture          bool
	muted            bool
	registered       string
	unmuteRegistered string
	timer            *time.Timer
	emit             func(string, interface{})
}

func (a *App) voiceState() *voiceRuntime {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.voice == nil {
		path, _ := voiceSettingsPath()
		settings := readVoiceSettings(path)
		settings.Supported = voiceHotkeySupported()
		a.voice = &voiceRuntime{settings: settings}
		a.voice.emit = func(event string, data interface{}) {
			if a.emitDesktopEvent != nil {
				a.emitDesktopEvent(event, data)
			}
		}
	}
	return a.voice
}

func (a *App) GetVoiceHotkeySettings() VoiceHotkeySettings {
	v := a.voiceState()
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.settings
}

// SetVoiceHotkeySettings keeps the original two-argument service signature so
// the existing frontend continues to work; the unmute shortcut and the mute
// timeout are saved separately.
func (a *App) SetVoiceHotkeySettings(enabled bool, shortcut string) (VoiceHotkeySettings, error) {
	parsed, err := parseVoiceShortcut(shortcut)
	if err != nil {
		return a.GetVoiceHotkeySettings(), err
	}
	v := a.voiceState()
	v.mu.Lock()
	unmute := v.settings.UnmuteShortcut
	v.mu.Unlock()
	return a.applyVoiceSettings(enabled, parsed.label, unmute, 0)
}

func (a *App) SetVoiceMuteTimeout(seconds int) (VoiceHotkeySettings, error) {
	v := a.voiceState()
	v.mu.Lock()
	shortcut := v.settings.Shortcut
	unmute := v.settings.UnmuteShortcut
	enabled := v.settings.Enabled
	v.mu.Unlock()
	return a.applyVoiceSettings(enabled, shortcut, unmute, clampVoiceMuteSeconds(seconds))
}

// SetVoiceUnmuteShortcut assigns the shortcut that ends an active mute.
func (a *App) SetVoiceUnmuteShortcut(shortcut string) (VoiceHotkeySettings, error) {
	parsed, err := parseVoiceShortcut(shortcut)
	if err != nil {
		return a.GetVoiceHotkeySettings(), err
	}
	current := a.GetVoiceHotkeySettings()
	if parsed.label == current.Shortcut {
		return current, fmt.Errorf("choose a different key from the mute shortcut (%s)", current.Shortcut)
	}
	v := a.voiceState()
	v.mu.Lock()
	enabled := v.settings.Enabled
	v.mu.Unlock()
	return a.applyVoiceSettings(enabled, current.Shortcut, parsed.label, 0)
}

func (a *App) applyVoiceSettings(enabled bool, shortcut, unmuteShortcut string, timeoutSeconds int) (VoiceHotkeySettings, error) {
	v := a.voiceState()
	v.mu.Lock()
	if timeoutSeconds > 0 {
		v.settings.TimeoutSeconds = clampVoiceMuteSeconds(timeoutSeconds)
	}
	settings := VoiceHotkeySettings{
		Enabled:        enabled,
		Shortcut:       shortcut,
		UnmuteShortcut: normalizeVoiceUnmuteShortcut(unmuteShortcut, shortcut),
		Supported:      voiceHotkeySupported(),
		TimeoutSeconds: v.settings.TimeoutSeconds,
	}
	path, err := voiceSettingsPath()
	if err != nil {
		defer v.mu.Unlock()
		return v.settings, err
	}
	if err = writeVoiceSettings(path, settings); err != nil {
		defer v.mu.Unlock()
		return v.settings, err
	}
	// Changing either shortcut or disabling the feature always ends an active mute.
	a.releaseVoiceMuteLocked(v)
	a.unregisterVoiceShortcutLocked()
	v.settings = settings
	v.capture = false
	if v.active && settings.Enabled && settings.Supported {
		if err := a.registerVoiceShortcutLocked(v); err != nil {
			v.mu.Unlock()
			return settings, err
		}
	}
	v.mu.Unlock()
	return settings, nil
}

func (a *App) SetVoiceHotkeyCapture(capture bool) {
	v := a.voiceState()
	v.mu.Lock()
	defer v.mu.Unlock()
	v.capture = capture
	if capture {
		a.releaseVoiceMuteLocked(v)
	}
}

func (a *App) SetVoiceHotkeyActive(active bool) error {
	v := a.voiceState()
	v.mu.Lock()
	defer v.mu.Unlock()
	v.active = active
	if !active {
		a.releaseVoiceMuteLocked(v)
		a.unregisterVoiceShortcutLocked()
		return nil
	}
	if v.registered != "" || !v.settings.Supported || !v.settings.Enabled {
		return nil
	}
	return a.registerVoiceShortcutLocked(v)
}

// registerVoiceShortcutLocked binds the mute and unmute accelerators. Their
// callbacks run on their own goroutine whenever a shortcut is pressed
// system-wide.
func (a *App) registerVoiceShortcutLocked(v *voiceRuntime) error {
	if a.desktop == nil {
		return fmt.Errorf("global shortcut unavailable: application is not running")
	}
	if v.settings.UnmuteShortcut != "" && v.settings.UnmuteShortcut == v.settings.Shortcut {
		return fmt.Errorf("unmute shortcut must differ from the mute shortcut")
	}
	accelerator := v.settings.Shortcut
	if err := a.desktop.GlobalShortcut.Register(accelerator, a.toggleVoiceMute); err != nil {
		return fmt.Errorf("register %s: %w", accelerator, err)
	}
	v.registered = accelerator
	if v.settings.UnmuteShortcut == "" {
		return nil
	}
	if err := a.desktop.GlobalShortcut.Register(v.settings.UnmuteShortcut, a.unmuteVoiceMute); err != nil {
		// Keep nothing half-registered: the mute shortcut alone would leave the
		// user without the escape hatch they just configured.
		_ = a.desktop.GlobalShortcut.Unregister(accelerator)
		v.registered = ""
		return fmt.Errorf("register unmute shortcut %s: %w", v.settings.UnmuteShortcut, err)
	}
	v.unmuteRegistered = v.settings.UnmuteShortcut
	return nil
}

func (a *App) unregisterVoiceShortcutLocked() {
	if a.desktop == nil || a.voice == nil {
		return
	}
	if a.voice.registered != "" {
		_ = a.desktop.GlobalShortcut.Unregister(a.voice.registered)
		a.voice.registered = ""
	}
	if a.voice.unmuteRegistered != "" {
		_ = a.desktop.GlobalShortcut.Unregister(a.voice.unmuteRegistered)
		a.voice.unmuteRegistered = ""
	}
}

// toggleVoiceMute starts a mute, or restarts its countdown when one is already
// running. It never ends a mute; that is what unmuteVoiceMute and the timer do.
func (a *App) toggleVoiceMute() {
	v := a.voiceState()
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.active || v.capture || !v.settings.Enabled || !v.settings.Supported {
		return
	}
	if v.muted {
		// Already muted: restart the countdown rather than unmuting. The mute only
		// ends when the timer expires (or the session goes away), so pressing again
		// buys more time to get someone's attention.
		a.startVoiceMuteTimerLocked(v)
		v.emit("guildsync:voice-hotkey", map[string]interface{}{
			"state":          "extended",
			"timeoutSeconds": clampVoiceMuteSeconds(v.settings.TimeoutSeconds),
		})
		return
	}
	v.muted = true
	v.emit("guildsync:voice-hotkey", map[string]interface{}{"state": "pressed"})
	a.startVoiceMuteTimerLocked(v)
}

// unmuteVoiceMute is the emergency exit: it ends a mute immediately, whatever
// started it. Pressing it with no active mute only reports that nothing is on.
func (a *App) unmuteVoiceMute() {
	v := a.voiceState()
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.active || v.capture || !v.settings.Supported {
		return
	}
	if !v.muted {
		v.emit("guildsync:voice-hotkey", map[string]interface{}{
			"state":   "idle",
			"message": "No voice mute is active.",
		})
		return
	}
	a.releaseVoiceMuteLocked(v)
	v.emit("guildsync:voice-hotkey", map[string]interface{}{
		"state":   "unmuted",
		"message": "Voice mute ended by the unmute shortcut.",
	})
}

// startVoiceMuteTimerLocked (re)arms the automatic unmute for the configured
// timeout. Callers must hold v.mu.
func (a *App) startVoiceMuteTimerLocked(v *voiceRuntime) {
	if v.timer != nil {
		v.timer.Stop()
	}
	timeout := time.Duration(clampVoiceMuteSeconds(v.settings.TimeoutSeconds)) * time.Second
	v.timer = time.AfterFunc(timeout, a.expireVoiceMute)
}

// expireVoiceMute ends a mute that has been active for the configured timeout.
func (a *App) expireVoiceMute() {
	if a.voice == nil {
		return
	}
	v := a.voice
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.muted {
		return
	}
	a.releaseVoiceMuteLocked(v)
	v.emit("guildsync:voice-hotkey", map[string]interface{}{"state": "timeout", "message": "Voice mute ended automatically"})
}

// releaseVoiceMuteLocked clears mute state and reports the release edge once.
func (a *App) releaseVoiceMuteLocked(v *voiceRuntime) {
	if v.timer != nil {
		v.timer.Stop()
		v.timer = nil
	}
	if !v.muted {
		return
	}
	v.muted = false
	v.emit("guildsync:voice-hotkey", map[string]interface{}{"state": "released"})
}

// VoiceMuteActive reports whether a mute session is currently held by the
// desktop client, so the frontend can recover after a reconnect.
func (a *App) VoiceMuteActive() bool {
	v := a.voiceState()
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.muted
}
