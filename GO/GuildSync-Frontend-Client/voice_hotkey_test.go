package main

import "testing"

func newTestVoiceApp(settings VoiceHotkeySettings) (*App, *[]string, *[]map[string]interface{}) {
	events := []string{}
	payloads := []map[string]interface{}{}
	a := &App{}
	a.voice = &voiceRuntime{
		settings: settings,
		emit: func(_ string, data interface{}) {
			payload, _ := data.(map[string]interface{})
			state, _ := payload["state"].(string)
			events = append(events, state)
			payloads = append(payloads, payload)
		},
	}
	return a, &events, &payloads
}

func testVoiceSettings() VoiceHotkeySettings {
	return VoiceHotkeySettings{
		Enabled:        true,
		Shortcut:       "Ctrl+M",
		UnmuteShortcut: "Ctrl+Shift+M",
		Supported:      true,
		TimeoutSeconds: 10,
	}
}

func TestVoiceShortcutValidation(t *testing.T) {
	for _, input := range []string{"", "Ctrl+Ctrl+M", "Win+L", "Ctrl+Unknown", "Alt+F4", "Ctrl", "M+N", "Ctrl+M+N"} {
		if _, err := parseVoiceShortcut(input); err == nil {
			t.Errorf("accepted unsafe or unregistrable %q", input)
		}
	}
	for _, input := range []string{"M", "Space", "F8", "Ctrl+M", "Ctrl+Shift+F8", "Alt+Q"} {
		if _, err := parseVoiceShortcut(input); err != nil {
			t.Errorf("rejected %q: %v", input, err)
		}
	}
}

func TestVoiceShortcutCanonicalLabel(t *testing.T) {
	shortcut, err := parseVoiceShortcut("shift+ctrl+f8")
	if err != nil {
		t.Fatal(err)
	}
	if shortcut.label != "Ctrl+Shift+F8" {
		t.Fatalf("label = %q", shortcut.label)
	}
}

func TestVoiceMuteTimeoutClamped(t *testing.T) {
	for _, testCase := range []struct{ in, want int }{
		{0, defaultVoiceMuteSeconds},
		{-5, defaultVoiceMuteSeconds},
		{1, minVoiceMuteSeconds},
		{10, 10},
		{9999, maxVoiceMuteSeconds},
	} {
		if got := clampVoiceMuteSeconds(testCase.in); got != testCase.want {
			t.Errorf("clamp(%d) = %d, want %d", testCase.in, got, testCase.want)
		}
	}
}

func TestVoiceSettingsPersistence(t *testing.T) {
	path := t.TempDir() + "/settings.json"
	want := VoiceHotkeySettings{Enabled: true, Shortcut: "Ctrl+Shift+F8", UnmuteShortcut: "Ctrl+F9", TimeoutSeconds: 15}
	if err := writeVoiceSettings(path, want); err != nil {
		t.Fatal(err)
	}
	got := readVoiceSettings(path)
	if !got.Enabled || got.Shortcut != want.Shortcut || got.UnmuteShortcut != want.UnmuteShortcut || got.TimeoutSeconds != want.TimeoutSeconds {
		t.Fatalf("%+v", got)
	}

	defaults := readVoiceSettings(path + "-missing")
	if defaults.Enabled || defaults.Shortcut != defaultVoiceShortcut || defaults.UnmuteShortcut != defaultVoiceUnmuteShortcut || defaults.TimeoutSeconds != defaultVoiceMuteSeconds {
		t.Fatalf("%+v", defaults)
	}
}

// A settings file written before the unmute shortcut existed must gain a usable
// default rather than an empty accelerator.
func TestVoiceSettingsAddsMissingUnmuteShortcut(t *testing.T) {
	path := t.TempDir() + "/settings.json"
	if err := writeVoiceSettings(path, VoiceHotkeySettings{Enabled: true, Shortcut: "Ctrl+M", TimeoutSeconds: 10}); err != nil {
		t.Fatal(err)
	}
	got := readVoiceSettings(path)
	if got.UnmuteShortcut != defaultVoiceUnmuteShortcut {
		t.Fatalf("unmute shortcut = %q", got.UnmuteShortcut)
	}
}

// The two shortcuts must never collide, even after editing the file by hand.
func TestVoiceSettingsSeparatesCollidingShortcuts(t *testing.T) {
	path := t.TempDir() + "/settings.json"
	if err := writeVoiceSettings(path, VoiceHotkeySettings{Enabled: true, Shortcut: "Ctrl+M", UnmuteShortcut: "Ctrl+M", TimeoutSeconds: 10}); err != nil {
		t.Fatal(err)
	}
	got := readVoiceSettings(path)
	if got.Shortcut == got.UnmuteShortcut {
		t.Fatalf("both shortcuts are %q", got.Shortcut)
	}
	if got.UnmuteShortcut != defaultVoiceUnmuteShortcut {
		t.Fatalf("unmute shortcut = %q", got.UnmuteShortcut)
	}

	// With the mute key on the normal unmute default, the fallback must differ too.
	if fallback := defaultVoiceUnmuteFor(defaultVoiceUnmuteShortcut); fallback == "" || fallback == defaultVoiceUnmuteShortcut {
		t.Fatalf("fallback for a colliding mute key = %q", fallback)
	}
}

func TestVoiceSettingsRejectsLegacyMultiKeyShortcut(t *testing.T) {
	path := t.TempDir() + "/settings.json"
	if err := writeVoiceSettings(path, VoiceHotkeySettings{Enabled: true, Shortcut: "M+N", TimeoutSeconds: 10}); err != nil {
		t.Fatal(err)
	}
	got := readVoiceSettings(path)
	if got.Shortcut != defaultVoiceShortcut {
		t.Fatalf("expected fallback to %q, got %q", defaultVoiceShortcut, got.Shortcut)
	}
}

// One press mutes. Further presses restart the countdown instead of unmuting, so
// the mute is only ever ended by the unmute shortcut, the timer, or losing the
// session.
func TestVoicePressExtendsActiveMute(t *testing.T) {
	a, events, payloads := newTestVoiceApp(testVoiceSettings())
	a.voice.active = true

	a.toggleVoiceMute()
	if !a.VoiceMuteActive() {
		t.Fatal("first press did not start a mute")
	}
	a.toggleVoiceMute()
	if !a.VoiceMuteActive() {
		t.Fatal("second press unmuted; it should extend the mute")
	}
	a.toggleVoiceMute()
	if !a.VoiceMuteActive() {
		t.Fatal("third press unmuted; it should extend the mute")
	}
	if got := *events; len(got) != 3 || got[0] != "pressed" || got[1] != "extended" || got[2] != "extended" {
		t.Fatalf("%v", got)
	}
	if seconds, _ := (*payloads)[1]["timeoutSeconds"].(int); seconds != 10 {
		t.Fatalf("extended payload reported %d seconds", seconds)
	}
}

// The separately assigned unmute shortcut ends a mute immediately.
func TestVoiceUnmuteShortcutEndsMute(t *testing.T) {
	a, events, payloads := newTestVoiceApp(testVoiceSettings())
	a.voice.active = true

	a.toggleVoiceMute()
	a.unmuteVoiceMute()
	if a.VoiceMuteActive() {
		t.Fatal("unmute shortcut left the mute running")
	}
	if got := *events; len(got) != 3 || got[0] != "pressed" || got[1] != "released" || got[2] != "unmuted" {
		t.Fatalf("%v", got)
	}
	message, _ := (*payloads)[2]["message"].(string)
	if message == "" {
		t.Fatal("unmute event carried no message")
	}
}

// Pressing the unmute shortcut with nothing muted must be harmless.
func TestVoiceUnmuteShortcutWhenIdle(t *testing.T) {
	a, events, _ := newTestVoiceApp(testVoiceSettings())
	a.voice.active = true

	a.unmuteVoiceMute()
	if a.VoiceMuteActive() {
		t.Fatal("idle unmute started a mute")
	}
	if got := *events; len(got) != 1 || got[0] != "idle" {
		t.Fatalf("%v", got)
	}
}

// The safety timer is what ends a mute when nobody is at the keyboard.
func TestVoiceMuteExpiresAndReportsTimeout(t *testing.T) {
	settings := testVoiceSettings()
	settings.TimeoutSeconds = minVoiceMuteSeconds
	a, events, _ := newTestVoiceApp(settings)
	a.voice.active = true

	a.toggleVoiceMute()
	if !a.VoiceMuteActive() {
		t.Fatal("mute did not start")
	}
	a.expireVoiceMute()
	if a.VoiceMuteActive() {
		t.Fatal("expired mute stayed active")
	}
	if got := *events; len(got) != 3 || got[0] != "pressed" || got[1] != "released" || got[2] != "timeout" {
		t.Fatalf("%v", got)
	}
	// Expiring an already released mute must not emit a second release.
	a.expireVoiceMute()
	if got := *events; len(got) != 3 {
		t.Fatalf("duplicate release: %v", got)
	}
}

func TestVoiceToggleIgnoredWhenDisabledOrCapturing(t *testing.T) {
	a, events, _ := newTestVoiceApp(testVoiceSettings())
	a.voice.active = true
	a.voice.capture = true
	a.toggleVoiceMute()
	if a.VoiceMuteActive() {
		t.Fatal("capture mode must not toggle mute")
	}
	a.voice.capture = false
	a.voice.settings.Enabled = false
	a.toggleVoiceMute()
	if a.VoiceMuteActive() {
		t.Fatal("disabled setting must not toggle mute")
	}
	if len(*events) != 0 {
		t.Fatalf("%v", *events)
	}
}

// Disabling the feature, changing a shortcut or losing the voice connection ends
// an in-flight mute even without the unmute shortcut.
func TestVoiceDeactivateReleasesMute(t *testing.T) {
	a, events, _ := newTestVoiceApp(testVoiceSettings())
	a.voice.active = true
	a.toggleVoiceMute()
	a.voice.mu.Lock()
	a.releaseVoiceMuteLocked(a.voice)
	a.voice.mu.Unlock()
	if a.VoiceMuteActive() {
		t.Fatal("mute survived release")
	}
	if got := *events; len(got) != 2 || got[1] != "released" {
		t.Fatalf("%v", got)
	}
}

func TestVersionComparison(t *testing.T) {
	for _, testCase := range []struct {
		a, b string
		want int
	}{
		{"1.2.0", "1.2.0", 0},
		{"v1.2.1", "1.2.0", 1},
		{"1.1.9", "v1.2.0", -1},
		{"1.2.0-beta.1", "1.2.0", 0},
		{"dev", "1.2.0", 0},
	} {
		if got := compareVersions(testCase.a, testCase.b); got != testCase.want {
			t.Errorf("compare(%q, %q) = %d, want %d", testCase.a, testCase.b, got, testCase.want)
		}
	}
}

func TestInstallerAssetSelection(t *testing.T) {
	if got := installerSuffix("windows"); got != "-Windows.zip" {
		t.Fatalf("windows suffix = %q", got)
	}
	if got := installerSuffix("darwin"); got != "-macOS.zip" {
		t.Fatalf("darwin suffix = %q", got)
	}
	if got := installerSuffix("linux"); got != "-Linux-x86_64.zip" {
		t.Fatalf("linux suffix = %q", got)
	}
}
