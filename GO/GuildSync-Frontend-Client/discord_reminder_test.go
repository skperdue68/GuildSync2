package main

import (
	"strings"
	"testing"
)

func TestDiscordReminderQueuePreservesAccountsAndSettings(t *testing.T) {
	input := `GuildSyncDiscordReminder = { ["Default"] = { ["@Officer"] = { ["$AccountWide"] = { ["version"] = 1, ["settings"] = { ["subject"] = "Custom" }, ["mailQueue"] = {}, ["sentMailIds"] = { ["old"] = true } } }, ["@Other"] = { ["$AccountWide"] = { ["version"] = 1 } } } }
OtherAddon = { ["keep"] = true }`
	records := []map[string]interface{}{{"requestId": "new", "batchId": "batch", "recipient": "@Member", "rank": "A \"rank\"", "guildId": "123", "sendingAccount": "@Officer", "worldName": "NA Megaserver"}}
	output, err := mergeDiscordReminderQueue(input, "@Officer", "NA Megaserver", records)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "OtherAddon =") || !strings.Contains(output, "Custom") || !strings.Contains(output, "@Other") {
		t.Fatal("unrelated saved data was lost")
	}
	again, err := mergeDiscordReminderQueue(output, "@Officer", "NA Megaserver", records)
	if err != nil {
		t.Fatal(err)
	}
	if output != again {
		t.Fatal("same batch was not idempotent")
	}
	root, err := parseDiscordReminderSavedVars(again)
	if err != nil {
		t.Fatal(err)
	}
	section, _ := discordReminderAccount(root, "@Officer")
	queue, _ := getLuaMap(section["mailQueue"])
	record, _ := getLuaMap(queue["new"])
	if record["rank"] != "A \"rank\"" {
		t.Fatalf("escaped text did not round trip: %v", record)
	}
}

func TestDiscordReminderQueueRejectsWrongAccountWorldAndSentIDs(t *testing.T) {
	input := `GuildSyncDiscordReminder = { ["Default"] = { ["@Officer"] = { ["$AccountWide"] = { ["sentMailIds"] = { ["old"] = true } } } } }`
	base := map[string]interface{}{"requestId": "old", "batchId": "b", "recipient": "@Member", "sendingAccount": "@Officer", "worldName": "NA Megaserver", "guildId": "123"}
	for _, selection := range [][2]string{{"@Absent", "NA Megaserver"}, {"@Officer", "EU Megaserver"}} {
		if _, err := mergeDiscordReminderQueue(input, selection[0], selection[1], []map[string]interface{}{base}); err == nil {
			t.Fatal("accepted mismatched sender/world")
		}
	}
	output, err := mergeDiscordReminderQueue(input, "@Officer", "NA Megaserver", []map[string]interface{}{base})
	if err != nil {
		t.Fatal(err)
	}
	root, _ := parseDiscordReminderSavedVars(output)
	account, _ := discordReminderAccount(root, "@Officer")
	queue, _ := getLuaMap(account["mailQueue"])
	if len(queue) != 0 {
		t.Fatal("already sent request was requeued")
	}
}

func TestDiscordReminderCancelledRequestRemovesExistingQueueEntry(t *testing.T) {
	input := `GuildSyncDiscordReminder = { ["Default"] = { ["@Officer"] = { ["$AccountWide"] = { ["mailQueue"] = { ["cancel"] = { ["requestId"] = "cancel" } } } } } }`
	record := map[string]interface{}{"requestId": "cancel", "batchId": "b", "recipient": "@Member", "sendingAccount": "@Officer", "worldName": "NA Megaserver", "guildId": "123", "status": "cancelled"}
	output, err := mergeDiscordReminderQueue(input, "@Officer", "NA Megaserver", []map[string]interface{}{record})
	if err != nil {
		t.Fatal(err)
	}
	root, _ := parseDiscordReminderSavedVars(output)
	account, _ := discordReminderAccount(root, "@Officer")
	queue, _ := getLuaMap(account["mailQueue"])
	if len(queue) != 0 {
		t.Fatal("cancelled recipient remained in local queue")
	}
}
