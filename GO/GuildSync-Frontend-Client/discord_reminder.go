package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
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

func (a *App) WriteDiscordReminderQueue(account, world string, records []map[string]interface{}) DiscordReminderSavedVars {
	result := DiscordReminderSavedVars{FilePath: discordReminderPath()}
	if isESORunning() {
		result.Message = "Close ESO completely before writing Discord reminders."
		return result
	}
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
	if err == nil && isESORunning() {
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
