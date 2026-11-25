package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type GuildSyncChatDataResult struct {
	OK       bool                   `json:"ok"`
	Empty    bool                   `json:"empty,omitempty"`
	Message  string                 `json:"message"`
	Key      string                 `json:"key"`
	Label    string                 `json:"label"`
	FileName string                 `json:"fileName"`
	FilePath string                 `json:"filePath"`
	Data     map[string]interface{} `json:"data,omitempty"`
}

// CollectGuildSyncChatData is called by the frontend when the GuildSyncChat
// SavedVariables file changes, on startup, and after a reconnect. It extracts
// captured messages from every world and account section without clearing
// anything; the frontend calls CommitGuildSyncChatData only after the backend
// confirms receipt.
func (a *App) CollectGuildSyncChatData(event GuildSyncSavedVarsFileModifiedEvent) GuildSyncChatDataResult {
	watchFile := getSavedVarsWatchFileByKey("chat")

	fileName := strings.TrimSpace(event.FileName)
	if fileName == "" {
		fileName = watchFile.FileName
	}
	fileName = filepath.Base(fileName)

	filePath := strings.TrimSpace(event.FilePath)
	if filePath == "" {
		filePath = filepath.Join(getSavedVarsDir(), fileName)
	}

	baseResult := GuildSyncChatDataResult{
		OK:       false,
		Key:      "chat",
		Label:    watchFile.Label,
		FileName: fileName,
		FilePath: filePath,
	}

	info, err := os.Stat(filePath)
	if err != nil {
		// Startup and reconnect read the file even before the add-on has saved
		// once, so a missing file is not an error.
		if os.IsNotExist(err) {
			baseResult.Empty = true
			baseResult.Message = fmt.Sprintf("%s has not been created yet.", fileName)
			return baseResult
		}

		baseResult.Message = fmt.Sprintf("Guild chat SavedVariables file could not be read: %v", err)
		return baseResult
	}

	if info.IsDir() {
		baseResult.Message = fmt.Sprintf("Guild chat SavedVariables path is a directory, not a file: %s", filePath)
		return baseResult
	}

	originalBytes, err := os.ReadFile(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Guild chat SavedVariables file could not be read: %v", err)
		return baseResult
	}

	extracted, err := extractChatLuaTable(string(originalBytes))
	if err != nil {
		baseResult.Message = err.Error()
		return baseResult
	}

	parsed, err := parseEsoLuaTable(extracted.tableText)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Guild chat SavedVariables file could not be parsed: %v", err)
		return baseResult
	}

	parsedMap, ok := parsed.(map[string]interface{})
	if !ok {
		baseResult.Message = fmt.Sprintf("%s did not parse as a Lua table object.", extracted.tableName)
		return baseResult
	}

	sections := guildSyncChatSections(parsedMap)
	if sections.sections == 0 {
		baseResult.Message = fmt.Sprintf("Could not find an ESO account section under %s.", extracted.tableName)
		return baseResult
	}

	if len(sections.entries) == 0 {
		baseResult.Empty = true
		baseResult.Message = fmt.Sprintf("No guild chat messages found in %s.", fileName)
		return baseResult
	}

	baseResult.OK = true
	baseResult.Message = fmt.Sprintf(
		"Collected %d guild chat message%s from %d account section%s in %s. Messages will be cleared after backend confirmation.",
		len(sections.entries),
		pluralS(len(sections.entries)),
		len(sections.accounts),
		pluralS(len(sections.accounts)),
		fileName,
	)
	baseResult.Data = map[string]interface{}{
		"table_name": extracted.tableName,
		"entries":    sections.entries,
	}

	return baseResult
}

// CommitGuildSyncChatData clears sent guild chat messages from every account
// section after the backend confirms receipt. The add-on's settings stay
// untouched, and the clear waits until ESO is closed so the next game save
// cannot resurrect or drop messages.
func (a *App) CommitGuildSyncChatData(filePath string, fileName string) GuildSyncChatDataResult {
	watchFile := getSavedVarsWatchFileByKey("chat")

	fileName = filepath.Base(strings.TrimSpace(fileName))
	if fileName == "." || fileName == string(filepath.Separator) || fileName == "" {
		fileName = watchFile.FileName
	}

	filePath = strings.TrimSpace(filePath)
	if filePath == "" {
		filePath = filepath.Join(getSavedVarsDir(), fileName)
	}

	baseResult := GuildSyncChatDataResult{
		OK:       false,
		Key:      "chat",
		Label:    watchFile.Label,
		FileName: fileName,
		FilePath: filePath,
	}

	status := a.GetESORunningStatus()
	if status.Error != "" {
		baseResult.Message = status.Message
		return baseResult
	}

	if esoStatusBlocksSavedVarsWrites(status) {
		baseResult.Message = "ESO is currently running. Guild chat messages were not cleared from SavedVariables yet."
		return baseResult
	}

	info, err := os.Stat(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Guild chat SavedVariables file could not be read for cleanup: %v", err)
		return baseResult
	}

	if info.IsDir() {
		baseResult.Message = fmt.Sprintf("Guild chat SavedVariables cleanup path is a directory, not a file: %s", filePath)
		return baseResult
	}

	originalBytes, err := os.ReadFile(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Guild chat SavedVariables file could not be read for cleanup: %v", err)
		return baseResult
	}

	backupPath, err := createGuildSyncSavedVarsBackup(filePath, originalBytes)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Guild chat backend ACK received, but backup file could not be written: %v", err)
		return baseResult
	}

	cleanedText, clearedSections := replaceAllLuaBracketSubtables(string(originalBytes), "messages", renderEmptyLuaTableSection("messages"))
	if clearedSections == 0 {
		baseResult.Message = "Guild chat backend ACK received, but the messages sections could not be found; nothing was cleared."
		return baseResult
	}

	if err := os.WriteFile(filePath, []byte(cleanedText), info.Mode().Perm()); err != nil {
		baseResult.Message = fmt.Sprintf("Guild chat backend ACK received, but SavedVariables file could not be cleared: %v", err)
		return baseResult
	}

	baseResult.OK = true
	baseResult.Message = fmt.Sprintf("Backend confirmed guild chat. Cleared messages from %d section%s in %s.", clearedSections, pluralS(clearedSections), fileName)
	baseResult.Data = map[string]interface{}{
		"backup_path":      backupPath,
		"cleared_sections": clearedSections,
	}

	return baseResult
}

func extractChatLuaTable(text string) (extractedLuaTable, error) {
	missing := []string{}

	for _, tableName := range getChatSavedVarsTableNames() {
		extracted, err := extractLuaTableByName(text, tableName)
		if err == nil {
			return extracted, nil
		}

		missing = append(missing, tableName)
	}

	if len(missing) == 0 {
		return extractedLuaTable{}, fmt.Errorf("No valid guild chat SavedVariables table names were configured.")
	}

	return extractedLuaTable{}, fmt.Errorf("Could not find guild chat table assignment. Tried: %s", strings.Join(missing, ", "))
}

func getChatSavedVarsTableNames() []string {
	candidates := []string{}

	if envTableName := strings.TrimSpace(os.Getenv("SAVED_VARS_CHAT_TABLE_NAME")); envTableName != "" {
		candidates = append(candidates, envTableName)
	}

	candidates = append(candidates, "GuildSyncChat")

	seen := map[string]bool{}
	cleaned := []string{}

	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" || !luaIdentifierPattern.MatchString(candidate) {
			continue
		}

		lower := strings.ToLower(candidate)
		if seen[lower] {
			continue
		}

		seen[lower] = true
		cleaned = append(cleaned, candidate)
	}

	return cleaned
}

type guildSyncChatCollection struct {
	accounts []string
	sections int
	entries  []interface{}
}

// guildSyncChatSections gathers pending messages from every world profile and
// every ESO account section in the file, so one upload covers all accounts.
func guildSyncChatSections(parsedMap map[string]interface{}) guildSyncChatCollection {
	collection := guildSyncChatCollection{
		accounts: []string{},
		entries:  []interface{}{},
	}

	for _, world := range orderedGuildSyncChatWorlds(parsedMap) {
		profile, ok := getLuaMap(parsedMap[world])
		if !ok {
			continue
		}

		accountNames := make([]string, 0, len(profile))
		for key := range profile {
			if strings.HasPrefix(key, "@") {
				accountNames = append(accountNames, key)
			}
		}
		sort.Strings(accountNames)

		for _, accountName := range accountNames {
			accountSection, ok := getLuaMap(profile[accountName])
			if !ok {
				continue
			}

			accountWide, ok := getLuaMap(accountSection["$AccountWide"])
			if !ok {
				continue
			}

			// The section is present even when its messages table is empty, which
			// is the normal state right after a confirmed upload was cleared.
			collection.sections++

			entries := guildSyncChatAccountWideEntries(accountWide)
			if len(entries) == 0 {
				continue
			}

			collection.accounts = append(collection.accounts, accountName)
			collection.entries = append(collection.entries, entries...)
		}
	}

	return collection
}

// guildSyncChatAccountWideEntries reads the messages ZO_SavedVars keeps under
// $AccountWide. NewAccountWide stores one section per megaserver, so the
// messages table usually sits under the world name instead of directly on
// $AccountWide; files written that older, flatter way are still read.
func guildSyncChatAccountWideEntries(accountWide map[string]interface{}) []interface{} {
	entries := guildSyncChatEntries(accountWide["messages"])

	keys := make([]string, 0, len(accountWide))
	for key := range accountWide {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	for _, key := range keys {
		section, ok := getLuaMap(accountWide[key])
		if !ok {
			continue
		}

		entries = append(entries, guildSyncChatEntries(section["messages"])...)
	}

	return entries
}

// orderedGuildSyncChatWorlds returns profile keys with the legacy "Default"
// profile first, followed by megaserver profiles in a stable order.
func orderedGuildSyncChatWorlds(parsedMap map[string]interface{}) []string {
	keys := make([]string, 0, len(parsedMap))
	for key := range parsedMap {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	ordered := make([]string, 0, len(keys))
	if _, ok := parsedMap["Default"]; ok {
		ordered = append(ordered, "Default")
	}
	for _, key := range keys {
		if key != "Default" {
			ordered = append(ordered, key)
		}
	}

	return ordered
}

// guildSyncChatEntries returns the captured messages in the order the add-on
// wrote them, dropping rows that could never be matched or stored.
func guildSyncChatEntries(value interface{}) []interface{} {
	ordered := []interface{}{}

	switch typed := value.(type) {
	case []interface{}:
		ordered = typed
	case map[string]interface{}:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}

		sort.Slice(keys, func(i, j int) bool {
			left, leftErr := strconv.Atoi(strings.TrimSpace(keys[i]))
			right, rightErr := strconv.Atoi(strings.TrimSpace(keys[j]))

			if leftErr == nil && rightErr == nil {
				return left < right
			}

			return keys[i] < keys[j]
		})

		for _, key := range keys {
			ordered = append(ordered, typed[key])
		}
	}

	entries := make([]interface{}, 0, len(ordered))
	for _, item := range ordered {
		entry, ok := getLuaMap(item)
		if !ok {
			continue
		}

		sender := strings.TrimSpace(luaChatString(entry["sender"]))
		text := luaChatString(entry["text"])
		timestamp := luaChatTimestamp(entry["timestamp"])

		if sender == "" || strings.TrimSpace(text) == "" || timestamp <= 0 {
			continue
		}

		entries = append(entries, map[string]interface{}{
			"sender":    sender,
			"timestamp": timestamp,
			"text":      text,
		})
	}

	return entries
}

// replaceAllLuaBracketSubtables replaces every table assigned to the key, so a
// SavedVariables file with one messages section per account is fully cleared.
func replaceAllLuaBracketSubtables(text string, key string, replacement string) (string, int) {
	pattern := fmt.Sprintf("[\"%s\"]", luaString(key))
	indexes := []int{}
	searchFrom := 0

	for {
		relative := strings.Index(text[searchFrom:], pattern)
		if relative == -1 {
			break
		}

		index := searchFrom + relative
		indexes = append(indexes, index)
		searchFrom = index + len(pattern)
	}

	cleared := 0
	for position := len(indexes) - 1; position >= 0; position-- {
		updated, ok := replaceLuaBracketSubtableAt(text, indexes[position], pattern, replacement)
		if !ok {
			continue
		}

		text = updated
		cleared++
	}

	return text, cleared
}

func replaceLuaBracketSubtableAt(text string, keyIndex int, pattern string, replacement string) (string, bool) {
	equalsRelative := strings.Index(text[keyIndex+len(pattern):], "=")
	if equalsRelative == -1 {
		return text, false
	}
	equalsIndex := keyIndex + len(pattern) + equalsRelative

	openBraceRelative := strings.Index(text[equalsIndex:], "{")
	if openBraceRelative == -1 {
		return text, false
	}
	openBraceIndex := equalsIndex + openBraceRelative

	closeBraceIndex, ok := findMatchingLuaBrace(text, openBraceIndex)
	if !ok {
		return text, false
	}

	lineStart := strings.LastIndex(text[:keyIndex], "\n")
	if lineStart == -1 {
		lineStart = 0
	} else {
		lineStart += 1
	}

	indent := text[lineStart:keyIndex]
	indentedReplacement := indentLuaReplacement(replacement, indent)

	return text[:keyIndex] + indentedReplacement + text[closeBraceIndex+1:], true
}

func luaChatString(value interface{}) string {
	if text, ok := value.(string); ok {
		return text
	}

	return ""
}

func luaChatTimestamp(value interface{}) int64 {
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case int64:
		return typed
	case int:
		return int64(typed)
	case string:
		parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		if err == nil {
			return parsed
		}
	}

	return 0
}
