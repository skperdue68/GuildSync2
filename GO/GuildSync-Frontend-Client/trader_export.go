package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type GuildSyncTraderDataResult struct {
	OK       bool                   `json:"ok"`
	Message  string                 `json:"message"`
	Key      string                 `json:"key"`
	Label    string                 `json:"label"`
	FileName string                 `json:"fileName"`
	FilePath string                 `json:"filePath"`
	Data     map[string]interface{} `json:"data,omitempty"`
}

// CollectGuildSyncTraderData is called by the frontend after the Trader
// SavedVariables file changes. It extracts pending trader sales without
// clearing the file; the frontend calls CommitGuildSyncTraderData only after
// the backend confirms receipt.
func (a *App) CollectGuildSyncTraderData(event GuildSyncSavedVarsFileModifiedEvent) GuildSyncTraderDataResult {
	watchFile := getSavedVarsWatchFileByKey("trader")

	fileName := strings.TrimSpace(event.FileName)
	if fileName == "" {
		fileName = watchFile.FileName
	}
	fileName = filepath.Base(fileName)

	filePath := strings.TrimSpace(event.FilePath)
	if filePath == "" {
		filePath = filepath.Join(getSavedVarsDir(), fileName)
	}

	baseResult := GuildSyncTraderDataResult{
		OK:       false,
		Key:      "trader",
		Label:    watchFile.Label,
		FileName: fileName,
		FilePath: filePath,
	}

	info, err := os.Stat(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Trader SavedVariables file could not be read: %v", err)
		return baseResult
	}

	if info.IsDir() {
		baseResult.Message = fmt.Sprintf("Trader SavedVariables path is a directory, not a file: %s", filePath)
		return baseResult
	}

	originalBytes, err := os.ReadFile(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Trader SavedVariables file could not be read: %v", err)
		return baseResult
	}

	originalText := string(originalBytes)

	extracted, err := extractTraderLuaTable(originalText)
	if err != nil {
		baseResult.Message = err.Error()
		return baseResult
	}

	parsed, err := parseEsoLuaTable(extracted.tableText)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Trader SavedVariables file could not be parsed: %v", err)
		return baseResult
	}

	parsedMap, ok := parsed.(map[string]interface{})
	if !ok {
		baseResult.Message = fmt.Sprintf("%s did not parse as a Lua table object.", extracted.tableName)
		return baseResult
	}

	// The add-on now keys SavedVars by world name (GetWorldName), so the profile
	// key is the megaserver rather than "Default". Accept both layouts.
	profileName, profileSection, ok := getEsoSavedVarsProfileSection(parsedMap)
	if !ok {
		baseResult.Message = fmt.Sprintf("Could not find an ESO world profile under %s.", extracted.tableName)
		return baseResult
	}

	accountName := getFirstEsoAccountName(profileSection)
	if accountName == "" {
		baseResult.Message = fmt.Sprintf("Could not find an ESO account name under %s.%s", extracted.tableName, profileName)
		return baseResult
	}

	accountSection, ok := getLuaMap(profileSection[accountName])
	if !ok {
		baseResult.Message = fmt.Sprintf("Could not find %s.%s[\"%s\"]", extracted.tableName, profileName, accountName)
		return baseResult
	}

	accountWide, ok := getLuaMap(accountSection["$AccountWide"])
	if !ok {
		baseResult.Message = fmt.Sprintf("Could not find %s.%s[\"%s\"][\"$AccountWide\"]", extracted.tableName, profileName, accountName)
		return baseResult
	}

	tradesMap, _ := getLuaMap(accountWide["trades"])
	if len(tradesMap) == 0 {
		baseResult.Message = fmt.Sprintf("No trader sales found in %s.", fileName)
		return baseResult
	}

	tradeKeys := make([]string, 0, len(tradesMap))
	for key := range tradesMap {
		tradeKeys = append(tradeKeys, key)
	}
	sort.Strings(tradeKeys)

	entries := make([]interface{}, 0, len(tradeKeys))
	for _, key := range tradeKeys {
		if entry, ok := getLuaMap(tradesMap[key]); ok {
			entries = append(entries, entry)
		}
	}

	world := profileName
	if world == "Default" {
		// Legacy SavedVars without a world profile do not identify a world.
		world = ""
	}

	baseResult.OK = true
	baseResult.Message = fmt.Sprintf("Collected %d trader sale%s from %s. SavedVariables will be cleared after backend confirmation.", len(entries), pluralY(len(entries)), fileName)
	baseResult.Data = map[string]interface{}{
		"table_name":    extracted.tableName,
		"account_name":  accountName,
		"world":         world,
		"guildId":       accountWide["guildId"],
		"guildName":     accountWide["guildName"],
		"entries":       entries,
		"entries_count": len(entries),
	}

	return baseResult
}

// CommitGuildSyncTraderData clears exported trader sales after the backend
// confirms receipt. Checkpoints and guild identity stay untouched so an upload
// failure can never lose pending rows.
func (a *App) CommitGuildSyncTraderData(filePath string, fileName string) GuildSyncTraderDataResult {
	watchFile := getSavedVarsWatchFileByKey("trader")

	fileName = filepath.Base(strings.TrimSpace(fileName))
	if fileName == "." || fileName == string(filepath.Separator) || fileName == "" {
		fileName = watchFile.FileName
	}

	filePath = strings.TrimSpace(filePath)
	if filePath == "" {
		filePath = filepath.Join(getSavedVarsDir(), fileName)
	}

	baseResult := GuildSyncTraderDataResult{
		OK:       false,
		Key:      "trader",
		Label:    watchFile.Label,
		FileName: fileName,
		FilePath: filePath,
	}

	info, err := os.Stat(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Trader SavedVariables file could not be read for cleanup: %v", err)
		return baseResult
	}

	if info.IsDir() {
		baseResult.Message = fmt.Sprintf("Trader SavedVariables cleanup path is a directory, not a file: %s", filePath)
		return baseResult
	}

	originalBytes, err := os.ReadFile(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Trader SavedVariables file could not be read for cleanup: %v", err)
		return baseResult
	}

	originalText := string(originalBytes)

	backupPath, err := createGuildSyncSavedVarsBackup(filePath, originalBytes)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Trader backend ACK received, but backup file could not be written: %v", err)
		return baseResult
	}

	cleanedText, replaced := replaceLuaBracketSubtable(originalText, "trades", renderEmptyLuaTableSection("trades"))
	if !replaced {
		baseResult.Message = "Trader backend ACK received, but the trades section could not be found; nothing was cleared."
		return baseResult
	}

	if err := os.WriteFile(filePath, []byte(cleanedText), info.Mode().Perm()); err != nil {
		baseResult.Message = fmt.Sprintf("Trader backend ACK received, but SavedVariables file could not be cleared: %v", err)
		return baseResult
	}

	baseResult.OK = true
	baseResult.Message = fmt.Sprintf("Backend confirmed trader data. Cleared trades from %s.", fileName)
	baseResult.Data = map[string]interface{}{
		"backup_path": backupPath,
	}

	return baseResult
}

func extractTraderLuaTable(text string) (extractedLuaTable, error) {
	missing := []string{}

	for _, tableName := range getTraderSavedVarsTableNames() {
		extracted, err := extractLuaTableByName(text, tableName)
		if err == nil {
			return extracted, nil
		}

		missing = append(missing, tableName)
	}

	if len(missing) == 0 {
		return extractedLuaTable{}, fmt.Errorf("No valid trader SavedVariables table names were configured.")
	}

	return extractedLuaTable{}, fmt.Errorf("Could not find trader table assignment. Tried: %s", strings.Join(missing, ", "))
}

func getTraderSavedVarsTableNames() []string {
	candidates := []string{}

	if envTableName := strings.TrimSpace(os.Getenv("SAVED_VARS_TRADER_TABLE_NAME")); envTableName != "" {
		candidates = append(candidates, envTableName)
	}

	candidates = append(candidates, "GuildSyncTrader")

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

// getEsoSavedVarsProfileSection finds the world/profile key that holds the
// account data. Newer add-ons pass GetWorldName() to ZO_SavedVars, so the key
// is a megaserver name; older files use "Default". A profile with pending
// trades is preferred so leftover data in another profile is not uploaded twice.
func getEsoSavedVarsProfileSection(parsedMap map[string]interface{}) (string, map[string]interface{}, bool) {
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

	var fallbackName string
	var fallbackSection map[string]interface{}

	for _, key := range ordered {
		profile, ok := getLuaMap(parsedMap[key])
		if !ok {
			continue
		}

		accountName := getFirstEsoAccountName(profile)
		if accountName == "" {
			continue
		}

		if fallbackSection == nil {
			fallbackName, fallbackSection = key, profile
		}

		accountSection, ok := getLuaMap(profile[accountName])
		if !ok {
			continue
		}

		accountWide, ok := getLuaMap(accountSection["$AccountWide"])
		if !ok {
			continue
		}

		if trades, ok := getLuaMap(accountWide["trades"]); ok && len(trades) > 0 {
			return key, profile, true
		}
	}

	if fallbackSection != nil {
		return fallbackName, fallbackSection, true
	}

	return "", nil, false
}
