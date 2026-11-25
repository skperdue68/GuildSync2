package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestDiscordReminderAckCleanupPrunesOnlyAcknowledgedIDs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "GuildSyncDiscordReminder.lua")
	contents := `GuildSyncDiscordReminder = {
	["Default"] = {
		["@Officer"] = {
			["$AccountWide"] = {
				["version"] = 1,
				["settings"] = { ["subject"] = "Keep me" },
				["mailAck"] = {
					["a"] = { ["requestId"] = "a", ["status"] = "sent" },
					["b"] = { ["requestId"] = "b", ["status"] = "failed" }
				},
				["mailQueue"] = { ["q"] = { ["requestId"] = "q" } },
				["sentMailIds"] = { ["s"] = 1 }
			}
		},
		["@Second"] = { ["$AccountWide"] = { ["mailAck"] = { ["b"] = { ["requestId"] = "b" } } } }
	}
}
OtherAddon = { ["keep"] = true }`
	if err := os.WriteFile(path, []byte(contents), 0644); err != nil {
		t.Fatal(err)
	}

	result := removeDiscordReminderAckIDsFromFile(path, []string{"a", "b"}, false, func() bool { return false })
	if !result.OK || result.RemovedCount != 3 {
		t.Fatalf("cleanup failed: %+v", result)
	}

	updated, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	root, err := parseDiscordReminderSavedVars(string(updated))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(updated), "OtherAddon =") {
		t.Fatal("unrelated SavedVariables data was lost")
	}
	for _, account := range []string{"@Officer", "@Second"} {
		wide, err := discordReminderAccount(root, account)
		if err != nil {
			t.Fatal(err)
		}
		acks, _ := getLuaMap(wide["mailAck"])
		if len(acks) != 0 {
			t.Fatalf("%s still holds acknowledgements: %v", account, acks)
		}
	}
	wide, _ := discordReminderAccount(root, "@Officer")
	settings, _ := getLuaMap(wide["settings"])
	if cleanString(settings["subject"]) != "Keep me" {
		t.Fatal("member settings were not preserved")
	}
	queue, _ := getLuaMap(wide["mailQueue"])
	if _, exists := queue["q"]; !exists {
		t.Fatal("a pending queue entry was removed")
	}
	sent, _ := getLuaMap(wide["sentMailIds"])
	if _, exists := sent["s"]; !exists {
		t.Fatal("the duplicate-send guard was removed")
	}
}

func TestDiscordReminderAckCleanupLeavesTheFileAloneWhenNothingMatches(t *testing.T) {
	path := filepath.Join(t.TempDir(), "GuildSyncDiscordReminder.lua")
	contents := `GuildSyncDiscordReminder = { ["Default"] = { ["@Officer"] = { ["$AccountWide"] = { ["mailAck"] = { ["a"] = { ["requestId"] = "a" } } } } } }`
	if err := os.WriteFile(path, []byte(contents), 0644); err != nil {
		t.Fatal(err)
	}

	result := removeDiscordReminderAckIDsFromFile(path, []string{"unknown"}, false, func() bool { return false })
	if !result.OK || result.RemovedCount != 0 {
		t.Fatalf("unexpected cleanup result: %+v", result)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != contents {
		t.Fatal("a no-op cleanup rewrote the SavedVariables file")
	}
}

func TestDiscordReminderFileWritesAreSerialized(t *testing.T) {
	path := filepath.Join(t.TempDir(), "GuildSyncDiscordReminder.lua")
	acks := []string{}
	for i := 0; i < 10; i++ {
		acks = append(acks, fmt.Sprintf("[\"a%d\"] = { [\"requestId\"] = \"a%d\" }", i, i))
	}
	contents := fmt.Sprintf(`GuildSyncDiscordReminder = { ["Default"] = { ["@Officer"] = { ["$AccountWide"] = { ["version"] = 1, ["mailAck"] = { %s }, ["mailQueue"] = {} } } } }`, strings.Join(acks, ", "))
	if err := os.WriteFile(path, []byte(contents), 0644); err != nil {
		t.Fatal(err)
	}
	noESO := func() bool { return false }

	// Cleanup and export both read-modify-write the same file. Unserialized, one
	// rewrite would drop the other's change and the file could lose queue entries.
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		index := i
		wg.Add(2)
		go func() {
			defer wg.Done()
			writeDiscordReminderQueueFile(path, "@Officer", "NA Megaserver", []map[string]interface{}{{
				"requestId": fmt.Sprintf("q%d", index), "batchId": "batch", "recipient": "@Member",
				"sendingAccount": "@Officer", "worldName": "NA Megaserver", "guildId": "123",
			}}, noESO)
		}()
		go func() {
			defer wg.Done()
			removeDiscordReminderAckIDsFromFile(path, []string{fmt.Sprintf("a%d", index)}, false, noESO)
		}()
	}
	wg.Wait()

	updated, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	root, err := parseDiscordReminderSavedVars(string(updated))
	if err != nil {
		t.Fatalf("concurrent writes left an unparseable file: %v", err)
	}
	wide, err := discordReminderAccount(root, "@Officer")
	if err != nil {
		t.Fatal(err)
	}
	queue, _ := getLuaMap(wide["mailQueue"])
	for i := 0; i < 10; i++ {
		if _, exists := queue[fmt.Sprintf("q%d", i)]; !exists {
			t.Fatalf("exported request q%d was lost by a concurrent rewrite", i)
		}
	}
	remaining, _ := getLuaMap(wide["mailAck"])
	if len(remaining) != 0 {
		t.Fatalf("acknowledgement cleanup was lost by a concurrent rewrite: %v", remaining)
	}
	if fmt.Sprint(wide["version"]) != "1" {
		t.Fatal("unrelated account data was not preserved")
	}
}
