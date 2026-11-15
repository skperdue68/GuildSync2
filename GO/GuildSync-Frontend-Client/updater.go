package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	updateRepo     = "skperdue68/GuildSync2"
	updateAPIURL   = "https://api.github.com/repos/" + updateRepo + "/releases/latest"
	updatePageURL  = "https://github.com/" + updateRepo + "/releases/latest"
	updateCheckTTL = 6 * time.Hour
)

// appVersion is stamped at build time with -X main.appVersion=<version>. Builds
// without the stamp report themselves as development builds and skip the check.
var appVersion = "dev"

// UpdateStatus is the result of comparing the running build with the newest
// published release.
type UpdateStatus struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Available bool   `json:"available"`
	PageURL   string `json:"pageUrl"`
	AssetName string `json:"assetName"`
	AssetURL  string `json:"assetUrl"`
	Notes     string `json:"notes"`
	CheckedAt string `json:"checkedAt"`
	Message   string `json:"message"`
}

type updateRelease struct {
	TagName    string `json:"tag_name"`
	Body       string `json:"body"`
	HTMLURL    string `json:"html_url"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
	Assets     []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
		Size               int64  `json:"size"`
	} `json:"assets"`
}

// versionParts compares dotted versions, ignoring a leading "v" and any
// pre-release or build suffix, which is enough to order GuildSync releases.
func versionParts(value string) ([3]int, bool) {
	parts := [3]int{}
	trimmed := strings.TrimPrefix(strings.TrimSpace(value), "v")
	if cut := strings.IndexAny(trimmed, "-+"); cut >= 0 {
		trimmed = trimmed[:cut]
	}
	if trimmed == "" {
		return parts, false
	}
	fields := strings.Split(trimmed, ".")
	if len(fields) > 3 {
		fields = fields[:3]
	}
	for index, field := range fields {
		number, err := strconv.Atoi(field)
		if err != nil {
			return parts, false
		}
		parts[index] = number
	}
	return parts, true
}

// compareVersions returns 1 when a is newer, -1 when b is newer and 0 when equal.
func compareVersions(a, b string) int {
	left, leftOK := versionParts(a)
	right, rightOK := versionParts(b)
	if !leftOK || !rightOK {
		return 0
	}
	for index := range left {
		switch {
		case left[index] > right[index]:
			return 1
		case left[index] < right[index]:
			return -1
		}
	}
	return 0
}

// installerSuffix maps the running platform to the installer asset the release
// workflow publishes.
func installerSuffix(goos string) string {
	switch goos {
	case "windows":
		return "-Windows.zip"
	case "darwin":
		return "-macOS.zip"
	case "linux":
		return "-Linux-x86_64.zip"
	}
	return ""
}

func (status *UpdateStatus) applyRelease(release updateRelease, current string) {
	status.Latest = strings.TrimPrefix(release.TagName, "v")
	status.PageURL = release.HTMLURL
	if status.PageURL == "" {
		status.PageURL = updatePageURL
	}
	status.Notes = strings.TrimSpace(release.Body)
	suffix := installerSuffix(runtime.GOOS)
	for _, asset := range release.Assets {
		if suffix != "" && strings.HasSuffix(asset.Name, suffix) {
			status.AssetName = asset.Name
			status.AssetURL = asset.BrowserDownloadURL
			break
		}
	}
	status.Available = compareVersions(status.Latest, current) > 0
	switch {
	case !status.Available:
		status.Message = fmt.Sprintf("GuildSync %s is up to date.", current)
	case status.AssetURL == "":
		status.Message = fmt.Sprintf("Version %s is available, but this release has no installer for %s.", status.Latest, runtime.GOOS)
	default:
		status.Message = fmt.Sprintf("Version %s is available.", status.Latest)
	}
}

func updateCachePath() (string, error) {
	root, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "GuildSync", "update-check.json"), nil
}

func readUpdateCache() (UpdateStatus, time.Time) {
	status := UpdateStatus{}
	path, err := updateCachePath()
	if err != nil {
		return status, time.Time{}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return status, time.Time{}
	}
	if json.Unmarshal(data, &status) != nil {
		return UpdateStatus{}, time.Time{}
	}
	checked, err := time.Parse(time.RFC3339, status.CheckedAt)
	if err != nil {
		return UpdateStatus{}, time.Time{}
	}
	return status, checked
}

func writeUpdateCache(status UpdateStatus) {
	path, err := updateCachePath()
	if err != nil {
		return
	}
	if os.MkdirAll(filepath.Dir(path), 0755) != nil {
		return
	}
	data, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(path, data, 0644)
}

func fetchLatestRelease() (updateRelease, error) {
	release := updateRelease{}
	request, err := http.NewRequest(http.MethodGet, updateAPIURL, nil)
	if err != nil {
		return release, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "GuildSync/"+appVersion)
	client := &http.Client{Timeout: 20 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return release, fmt.Errorf("contact GitHub: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return release, fmt.Errorf("GitHub returned %s", response.Status)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&release); err != nil {
		return release, fmt.Errorf("read release: %w", err)
	}
	if release.Draft {
		return release, fmt.Errorf("newest release is a draft")
	}
	return release, nil
}

// CheckForUpdate compares the running build with the newest release. Results are
// cached for six hours unless force is set, so opening the profile menu does not
// hammer the GitHub API.
func (a *App) CheckForUpdate(force bool) UpdateStatus {
	status := UpdateStatus{Current: appVersion, PageURL: updatePageURL}
	if appVersion == "" || appVersion == "dev" {
		status.Message = "Development build: update checks are disabled."
		return status
	}
	if !force {
		if cached, checked := readUpdateCache(); !checked.IsZero() && time.Since(checked) < updateCheckTTL && cached.Current == appVersion {
			return cached
		}
	}
	release, err := fetchLatestRelease()
	if err != nil {
		status.Message = err.Error()
		return status
	}
	status.applyRelease(release, appVersion)
	status.CheckedAt = time.Now().UTC().Format(time.RFC3339)
	writeUpdateCache(status)
	return status
}

// DownloadUpdate fetches the platform installer for the newest release into the
// downloads folder and opens it, leaving installation to the OS installer.
func (a *App) DownloadUpdate() (string, error) {
	status := a.CheckForUpdate(false)
	if status.AssetURL == "" {
		if status.Message != "" {
			return "", fmt.Errorf("%s", status.Message)
		}
		return "", fmt.Errorf("no update is available")
	}
	request, err := http.NewRequest(http.MethodGet, status.AssetURL, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("User-Agent", "GuildSync/"+appVersion)
	client := &http.Client{Timeout: 10 * time.Minute}
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("download update: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download update: %s", response.Status)
	}
	directory, err := downloadDirectory()
	if err != nil {
		return "", err
	}
	name := status.AssetName
	if name == "" {
		name = filepath.Base(status.AssetURL)
	}
	target := filepath.Join(directory, name)
	file, err := os.Create(target)
	if err != nil {
		return "", fmt.Errorf("save update: %w", err)
	}
	if _, err := io.Copy(file, response.Body); err != nil {
		file.Close()
		os.Remove(target)
		return "", fmt.Errorf("save update: %w", err)
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	openPath(target)
	return target, nil
}

// OpenReleasePage hands the releases page to the default browser.
func (a *App) OpenReleasePage() error {
	openPath(updatePageURL)
	return nil
}

func downloadDirectory() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return os.TempDir(), nil
	}
	directory := filepath.Join(home, "Downloads")
	if info, err := os.Stat(directory); err == nil && info.IsDir() {
		return directory, nil
	}
	return os.TempDir(), nil
}

// openPath hands a downloaded file to the platform's default handler.
func openPath(path string) {
	switch runtime.GOOS {
	case "windows":
		_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", path).Start()
	case "darwin":
		_ = exec.Command("open", path).Start()
	default:
		_ = exec.Command("xdg-open", path).Start()
	}
}
