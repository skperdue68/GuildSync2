package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

const discordReminderTable = "GuildSyncDiscordReminder"

type DiscordReminderSavedVars struct {
	OK         bool                     `json:"ok"`
	Message    string                   `json:"message"`
	Accounts   []string                 `json:"accounts"`
	Acks       []map[string]interface{} `json:"acks"`
	Queued     []map[string]interface{} `json:"queued"`
	FilePath   string                   `json:"filePath"`
	BackupPath string                   `json:"backupPath,omitempty"`
}

func parseDiscordReminderSavedVars(text string) (map[string]interface{}, error) {
	extracted, err := extractFirstAvailableLuaTable(text, []string{discordReminderTable})
	if err != nil {
		return nil, err
	}
	value, err := parseEsoLuaTable(extracted.tableText)
	if err != nil {
		return nil, err
	}
	root, ok := getLuaMap(value)
	if !ok {
		return nil, fmt.Errorf("invalid Discord reminder SavedVariables table")
	}
	return root, nil
}

func discordReminderAccount(root map[string]interface{}, account string) (map[string]interface{}, error) {
	defaults, _ := getLuaMap(root["Default"])
	profile, ok := getLuaMap(defaults[account])
	if !ok {
		return nil, fmt.Errorf("sending account %s is absent; log into ESO with the add-on enabled, then exit ESO first", account)
	}
	wide, ok := getLuaMap(profile["$AccountWide"])
	if !ok {
		return nil, fmt.Errorf("missing account-wide Discord reminder data for %s", account)
	}
	return wide, nil
}

func mergeDiscordReminderQueue(text, account, world string, records []map[string]interface{}) (string, error) {
	root, err := parseDiscordReminderSavedVars(text)
	if err != nil {
		return "", err
	}
	wide, err := discordReminderAccount(root, account)
	if err != nil {
		return "", err
	}
	if world != "NA Megaserver" && world != "EU Megaserver" {
		return "", fmt.Errorf("select the sending ESO megaserver")
	}
	queue, _ := getLuaMap(wide["mailQueue"])
	if queue == nil {
		queue = map[string]interface{}{}
	}
	sent, _ := getLuaMap(wide["sentMailIds"])
	for _, record := range records {
		id := cleanString(record["requestId"])
		recipient := cleanString(record["recipient"])
		if id == "" || cleanString(record["batchId"]) == "" || !strings.HasPrefix(recipient, "@") || len(recipient) < 2 || cleanString(record["guildId"]) == "" {
			return "", fmt.Errorf("invalid Discord reminder request")
		}
		if !strings.EqualFold(cleanString(record["sendingAccount"]), account) || cleanString(record["worldName"]) != world {
			return "", fmt.Errorf("reminder request does not match the selected sending account and world")
		}
		if cleanString(record["status"]) == "cancelled" || cleanString(record["status"]) == "sent" {
			delete(queue, id)
			continue
		}
		if cleanString(record["status"]) == "uncertain" {
			acks, _ := getLuaMap(wide["mailAck"])
			if acks == nil {
				acks = map[string]interface{}{}
			}
			if _, exists := acks[id]; !exists {
				acks[id] = map[string]interface{}{"requestId": id, "batchId": record["batchId"], "guildId": record["guildId"], "sendingAccount": account, "worldName": world, "status": "uncertain", "detail": "GuildSync recorded uncertain delivery; review before retrying."}
			}
			wide["mailAck"] = acks
		}
		if _, exists := sent[id]; exists {
			continue
		}
		if _, exists := queue[id]; !exists {
			queue[id] = record
		}
	}
	wide["mailQueue"] = queue
	extracted, err := extractFirstAvailableLuaTable(text, []string{discordReminderTable})
	if err != nil {
		return "", err
	}
	return text[:extracted.assignmentStart] + renderLuaAssignment(discordReminderTable, root) + text[extracted.tableEnd:], nil
}

func discordReminderPath() string {
	return filepath.Join(getSavedVarsDir(), "GuildSyncDiscordReminder.lua")
}

func (a *App) CollectDiscordReminderSavedVars() DiscordReminderSavedVars {
	result := DiscordReminderSavedVars{FilePath: discordReminderPath(), Accounts: []string{}, Acks: []map[string]interface{}{}}
	data, err := os.ReadFile(result.FilePath)
	if err != nil {
		result.Message = "Install GuildSyncDiscordReminder, log into ESO once, then exit ESO to create its SavedVariables file."
		return result
	}
	root, err := parseDiscordReminderSavedVars(string(data))
	if err != nil {
		result.Message = err.Error()
		return result
	}
	defaults, _ := getLuaMap(root["Default"])
	for account := range defaults {
		if !strings.HasPrefix(account, "@") {
			continue
		}
		wide, err := discordReminderAccount(root, account)
		if err != nil {
			continue
		}
		result.Accounts = append(result.Accounts, account)
		queue, _ := getLuaMap(wide["mailQueue"])
		for _, value := range queue {
			if record, ok := getLuaMap(value); ok {
				result.Queued = append(result.Queued, record)
			}
		}
		acks, _ := getLuaMap(wide["mailAck"])
		for _, value := range acks {
			if ack, ok := getLuaMap(value); ok {
				result.Acks = append(result.Acks, ack)
			}
		}
	}
	sort.Strings(result.Accounts)
	result.OK = true
	return result
}

// GuildSyncDiscordReminder.lua is rewritten by three paths: the export watcher,
// the cancelled-request rewrite and acknowledgement cleanup. Each one does its own
// read-modify-write, so they share this lock; without it a rewrite can silently
// drop another rewrite's change.
var discordReminderFileMu sync.Mutex

func (a *App) WriteDiscordReminderQueue(account, world string, records []map[string]interface{}) DiscordReminderSavedVars {
	filePath := discordReminderPath()
	if isESORunning() {
		return DiscordReminderSavedVars{FilePath: filePath, Message: "Close ESO completely before writing Discord reminders."}
	}
	return writeDiscordReminderQueueFile(filePath, account, world, records, isESORunning)
}

func writeDiscordReminderQueueFile(filePath, account, world string, records []map[string]interface{}, esoRunning func() bool) DiscordReminderSavedVars {
	discordReminderFileMu.Lock()
	defer discordReminderFileMu.Unlock()
	result := DiscordReminderSavedVars{FilePath: filePath}
	if len(records) == 0 {
		result.Message = "No reminder recipients were provided."
		return result
	}
	info, err := os.Stat(result.FilePath)
	if err != nil {
		result.Message = err.Error()
		return result
	}
	original, err := os.ReadFile(result.FilePath)
	if err != nil {
		result.Message = err.Error()
		return result
	}
	updated, err := mergeDiscordReminderQueue(string(original), account, world, records)
	if err != nil {
		result.Message = err.Error()
		return result
	}
	backup, err := createGuildSyncSavedVarsBackup(result.FilePath, original)
	if err != nil {
		result.Message = err.Error()
		return result
	}
	result.BackupPath = backup
	// Write beside the original and rename only after the complete replacement is closed.
	temp, err := os.CreateTemp(filepath.Dir(result.FilePath), ".discord-reminder-*.tmp")
	if err != nil {
		result.Message = err.Error()
		return result
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if _, err = temp.WriteString(updated); err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Chmod(tempPath, info.Mode().Perm())
	}
	if err == nil && esoRunning() {
		err = fmt.Errorf("ESO started during export; SavedVariables were not replaced")
	}
	if err == nil {
		err = os.Rename(tempPath, result.FilePath)
	}
	if err != nil {
		result.Message = err.Error()
		return result
	}
	result.OK = true
	result.Message = fmt.Sprintf("Wrote %d Discord reminder request(s). Start ESO to send them automatically.", len(records))
	return result
}

type DiscordReminderAckCleanupResult struct {
	OK           bool   `json:"ok"`
	Message      string `json:"message"`
	FilePath     string `json:"filePath"`
	BackupPath   string `json:"backupPath,omitempty"`
	RemovedCount int    `json:"removedCount"`
	PendingCount int    `json:"pendingCount"`
	ESOIsRunning bool   `json:"esoIsRunning"`
}

// GuildSync uploads delivery results from mailAck, so the saved copies become
// redundant once the database acknowledges them. ESO must be closed to rewrite
// the file, so a cleanup requested while it is running is stored and applied on
// exit instead of being dropped.
func (a *App) CleanupDiscordReminderMailAcks(requestIDs []string) DiscordReminderAckCleanupResult {
	filePath := discordReminderPath()
	ids := normalizeMailRequestIDList(requestIDs)
	result := DiscordReminderAckCleanupResult{OK: true, FilePath: filePath, ESOIsRunning: isESORunning()}
	if len(ids) == 0 {
		result.Message = "No reminder acknowledgements were provided for cleanup."
		return result
	}
	if result.ESOIsRunning {
		pending, err := addPendingDiscordReminderAckCleanupIDs(ids)
		if err != nil {
			result.OK = false
			result.Message = fmt.Sprintf("ESO is running and pending reminder acknowledgement cleanup could not be stored: %v", err)
			return result
		}
		result.PendingCount = len(pending)
		result.Message = fmt.Sprintf("ESO is running. Stored %d reminder acknowledgement cleanup item(s) for later.", len(ids))
		return result
	}
	return removeDiscordReminderAckIDsFromFile(filePath, ids, false, isESORunning)
}

func (a *App) FlushPendingDiscordReminderAckCleanup() DiscordReminderAckCleanupResult {
	filePath := discordReminderPath()
	ids, err := loadPendingDiscordReminderAckCleanupIDs()
	result := DiscordReminderAckCleanupResult{OK: true, FilePath: filePath, ESOIsRunning: isESORunning(), PendingCount: len(ids)}
	if err != nil {
		result.OK = false
		result.Message = fmt.Sprintf("Pending reminder acknowledgement cleanup could not be read: %v", err)
		return result
	}
	if len(ids) == 0 {
		result.Message = "No pending reminder acknowledgement cleanup is stored."
		return result
	}
	if result.ESOIsRunning {
		result.Message = fmt.Sprintf("ESO is running. %d reminder acknowledgement cleanup item(s) remain pending.", len(ids))
		return result
	}
	cleanup := removeDiscordReminderAckIDsFromFile(filePath, ids, true, isESORunning)
	if cleanup.OK {
		_ = removePendingDiscordReminderAckCleanupIDs(ids)
	}
	return cleanup
}

func removeDiscordReminderAckIDsFromFile(filePath string, requestIDs []string, fromPending bool, esoRunning func() bool) DiscordReminderAckCleanupResult {
	discordReminderFileMu.Lock()
	defer discordReminderFileMu.Unlock()
	ids := normalizeMailRequestIDList(requestIDs)
	result := DiscordReminderAckCleanupResult{OK: false, FilePath: filePath, ESOIsRunning: esoRunning()}
	if len(ids) == 0 {
		result.Message = "No reminder acknowledgements were provided for cleanup."
		return result
	}

	info, err := os.Stat(filePath)
	if err != nil {
		result.Message = fmt.Sprintf("GuildSyncDiscordReminder SavedVariables file could not be read for mailAck cleanup: %v", err)
		return result
	}
	if info.IsDir() {
		result.Message = fmt.Sprintf("GuildSyncDiscordReminder SavedVariables cleanup path is a directory, not a file: %s", filePath)
		return result
	}
	originalBytes, err := os.ReadFile(filePath)
	if err != nil {
		result.Message = fmt.Sprintf("GuildSyncDiscordReminder SavedVariables file could not be read for mailAck cleanup: %v", err)
		return result
	}
	originalText := string(originalBytes)
	extracted, err := extractFirstAvailableLuaTable(originalText, []string{discordReminderTable})
	if err != nil {
		result.Message = err.Error()
		return result
	}
	parsed, err := parseEsoLuaTable(extracted.tableText)
	if err != nil {
		result.Message = fmt.Sprintf("GuildSyncDiscordReminder SavedVariables file could not be parsed for mailAck cleanup: %v", err)
		return result
	}
	parsedMap, ok := parsed.(map[string]interface{})
	if !ok {
		result.Message = fmt.Sprintf("%s did not parse as a Lua table object.", extracted.tableName)
		return result
	}

	idSet := map[string]bool{}
	for _, id := range ids {
		idSet[id] = true
	}
	// Reminders can be sent from more than one ESO account, so every account-wide
	// mailAck table is checked rather than only the first account in the file.
	removedCount := 0
	defaults, _ := getLuaMap(parsedMap["Default"])
	for account, value := range defaults {
		if !strings.HasPrefix(account, "@") {
			continue
		}
		profile, ok := getLuaMap(value)
		if !ok {
			continue
		}
		accountWide, ok := getLuaMap(profile["$AccountWide"])
		if !ok {
			continue
		}
		mailAck := normalizeExistingMailQueue(accountWide["mailAck"])
		changed := false
		for id := range idSet {
			if _, exists := mailAck[id]; exists {
				delete(mailAck, id)
				removedCount++
				changed = true
			}
		}
		if changed {
			accountWide["mailAck"] = mailAck
		}
	}

	result.RemovedCount = removedCount
	if removedCount == 0 {
		result.OK = true
		result.Message = "No matching reminder acknowledgement entries remained in GuildSyncDiscordReminder.lua."
		return result
	}

	backupPath, err := createGuildSyncSavedVarsBackup(filePath, originalBytes)
	if err != nil {
		result.Message = fmt.Sprintf("Reminder acknowledgement cleanup could not create a backup file: %v", err)
		return result
	}
	result.BackupPath = backupPath

	newTableText := renderLuaAssignment(extracted.tableName, parsedMap)
	newSavedVarsText := originalText[:extracted.assignmentStart] + newTableText + originalText[extracted.tableEnd:]
	temp, err := os.CreateTemp(filepath.Dir(filePath), ".discord-reminder-ack-*.tmp")
	if err != nil {
		result.Message = fmt.Sprintf("Reminder acknowledgement cleanup could not create a temporary file: %v", err)
		return result
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if _, err = temp.WriteString(newSavedVarsText); err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Chmod(tempPath, info.Mode().Perm())
	}
	if err == nil && esoRunning() {
		err = fmt.Errorf("ESO started during cleanup; SavedVariables were not replaced")
	}
	if err == nil {
		err = os.Rename(tempPath, filePath)
	}
	if err != nil {
		result.Message = fmt.Sprintf("Reminder acknowledgement backup was created, but SavedVariables could not be updated: %v", err)
		return result
	}

	result.OK = true
	result.Message = fmt.Sprintf("Removed %d reminder acknowledgement(s) from GuildSyncDiscordReminder.lua.", removedCount)
	if fromPending {
		result.PendingCount = len(mustLoadPendingDiscordReminderAckCleanupIDs())
	}
	return result
}

func getDiscordReminderAckCleanupPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "GuildSync", "pending-discord-reminder-ack-cleanup.json"), nil
}

func loadPendingDiscordReminderAckCleanupIDs() ([]string, error) {
	path, err := getDiscordReminderAckCleanupPath()
	if err != nil {
		return []string{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return []string{}, err
	}
	var ids []string
	if err := json.Unmarshal(data, &ids); err != nil {
		return []string{}, err
	}
	return normalizeMailRequestIDList(ids), nil
}

func mustLoadPendingDiscordReminderAckCleanupIDs() []string {
	ids, err := loadPendingDiscordReminderAckCleanupIDs()
	if err != nil {
		return []string{}
	}
	return ids
}

func savePendingDiscordReminderAckCleanupIDs(ids []string) error {
	path, err := getDiscordReminderAckCleanupPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	ids = normalizeMailRequestIDList(ids)
	if len(ids) == 0 {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	data, err := json.MarshalIndent(ids, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func addPendingDiscordReminderAckCleanupIDs(ids []string) ([]string, error) {
	existing, err := loadPendingDiscordReminderAckCleanupIDs()
	if err != nil {
		return []string{}, err
	}
	merged := normalizeMailRequestIDList(append(existing, ids...))
	if err := savePendingDiscordReminderAckCleanupIDs(merged); err != nil {
		return []string{}, err
	}
	return merged, nil
}

func removePendingDiscordReminderAckCleanupIDs(ids []string) error {
	removeSet := map[string]bool{}
	for _, id := range normalizeMailRequestIDList(ids) {
		removeSet[id] = true
	}
	existing, err := loadPendingDiscordReminderAckCleanupIDs()
	if err != nil {
		return err
	}
	kept := []string{}
	for _, id := range existing {
		if !removeSet[id] {
			kept = append(kept, id)
		}
	}
	return savePendingDiscordReminderAckCleanupIDs(kept)
}
