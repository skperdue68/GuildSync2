package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTraderFixture(t *testing.T, profile string, body string) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "GuildSyncTrader.lua")
	text := `GuildSyncTrader = { ["` + profile + `"] = { ["@Example"] = { ["$AccountWide"] = {
		["guildId"] = "761817", ["guildName"] = "Example Guild",
		` + body + `
	} } } }`
	if err := os.WriteFile(file, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestTraderExportReadsWorldProfileSales(t *testing.T) {
	file := writeTraderFixture(t, "EU Megaserver", `["trades"] = { ["guild_761817_event_123"] = {
		["eventId"] = 123, ["guildId"] = "761817", ["guildName"] = "Example Guild", ["time"] = 1780000000,
		["seller"] = "@Seller", ["buyer"] = "@Buyer",
		["itemLink"] = "|H1:item:12345:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0|h|h",
		["itemId"] = 12345, ["itemName"] = "Dreugh Wax", ["quantity"] = 10,
		["price"] = 100000, ["unitPrice"] = 10000, ["tax"] = 7000, ["net"] = 93000
	} }`)

	result := (&App{}).CollectGuildSyncTraderData(GuildSyncSavedVarsFileModifiedEvent{FileName: filepath.Base(file), FilePath: file})
	if !result.OK {
		t.Fatal(result.Message)
	}
	if result.Data["world"] != "EU Megaserver" {
		t.Fatalf("Missing world profile: %#v", result.Data)
	}
	if result.Data["guildId"] != "761817" || result.Data["guildName"] != "Example Guild" {
		t.Fatalf("Missing guild origin: %#v", result.Data)
	}
	entries := result.Data["entries"].([]interface{})
	if len(entries) != 1 {
		t.Fatalf("Expected one trader sale, got %d", len(entries))
	}
	entry := entries[0].(map[string]interface{})
	if entry["seller"] != "@Seller" || entry["buyer"] != "@Buyer" || entry["itemName"] != "Dreugh Wax" {
		t.Fatalf("Sale fields missing: %#v", entry)
	}
	if entry["unitPrice"] != float64(10000) || entry["net"] != float64(93000) || entry["tax"] != float64(7000) {
		t.Fatalf("Sale amounts wrong: %#v", entry)
	}
}

func TestTraderExportAcceptsLegacyDefaultProfile(t *testing.T) {
	file := writeTraderFixture(t, "Default", `["trades"] = { ["guild_761817_event_9"] = {
		["eventId"] = 9, ["guildId"] = "761817", ["guildName"] = "Example Guild", ["time"] = 1780000001,
		["seller"] = "@Seller", ["buyer"] = "@Buyer", ["itemId"] = 1, ["itemName"] = "Item",
		["quantity"] = 1, ["price"] = 500, ["unitPrice"] = 500, ["tax"] = 35, ["net"] = 465
	} }`)

	result := (&App{}).CollectGuildSyncTraderData(GuildSyncSavedVarsFileModifiedEvent{FileName: filepath.Base(file), FilePath: file})
	if !result.OK {
		t.Fatal(result.Message)
	}
	if result.Data["world"] != "" {
		t.Fatalf("Legacy Default profile should not invent a world: %#v", result.Data["world"])
	}
	if len(result.Data["entries"].([]interface{})) != 1 {
		t.Fatalf("Legacy sale was not collected: %#v", result.Data)
	}
}

func TestTraderCommitClearsOnlyTrades(t *testing.T) {
	file := writeTraderFixture(t, "EU Megaserver", `["trades"] = { ["guild_761817_event_123"] = {
		["eventId"] = 123, ["guildId"] = "761817", ["time"] = 1780000000, ["seller"] = "@Seller", ["buyer"] = "@Buyer",
		["quantity"] = 1, ["price"] = 500, ["unitPrice"] = 500, ["tax"] = 35, ["net"] = 465
	} }`)

	result := (&App{}).CommitGuildSyncTraderData(file, filepath.Base(file))
	if !result.OK {
		t.Fatal(result.Message)
	}

	updated, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	text := string(updated)
	if strings.Contains(text, "guild_761817_event_123") {
		t.Fatal("Commit did not clear exported trades")
	}
	if !strings.Contains(text, `["trades"]`) || !strings.Contains(text, `["guildId"] = "761817"`) {
		t.Fatalf("Commit removed unrelated SavedVars data: %s", text)
	}
	if result.Data["backup_path"] == "" {
		t.Fatal("Commit did not report a backup path")
	}
	if _, err := os.Stat(result.Data["backup_path"].(string)); err != nil {
		t.Fatalf("Backup file missing: %v", err)
	}
}
