package main

import (
	"strings"
	"testing"
)

func TestGuildSyncChatSectionsCollectEveryAccount(t *testing.T) {
	parsed, err := parseEsoLuaTable(`{
		["Default"] = {
			["@alt"] = {
				["$AccountWide"] = {
					["messages"] = {
						[1] = { ["sender"] = "@OldAlt", ["timestamp"] = 1795636900, ["text"] = "old line" }
					}
				}
			}
		},
		["NA Megaserver"] = {
			["@evainefaye"] = {
				["$AccountWide"] = {
					["debugChat"] = false,
					["messages"] = {
						[1] = { ["sender"] = "@TheLamb_Sauce", ["timestamp"] = 1795636949, ["text"] = "Howdy Mafia!" },
						[2] = { ["sender"] = "@evainefaye", ["timestamp"] = 1795636954, ["text"] = "Hi Lamb!" }
					}
				}
			},
			["@secondaccount"] = {
				["$AccountWide"] = {
					["messages"] = {
						[1] = { ["sender"] = "@ThirdMember", ["timestamp"] = 1795636960, ["text"] = "Third line" }
					}
				}
			}
		}
	}`)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}

	parsedMap, ok := parsed.(map[string]interface{})
	if !ok {
		t.Fatal("parsed table is not an object")
	}

	sections := guildSyncChatSections(parsedMap)
	if len(sections.accounts) != 3 {
		t.Fatalf("expected 3 account sections, got %v", sections.accounts)
	}
	if strings.Join(sections.accounts, ",") != "@alt,@evainefaye,@secondaccount" {
		t.Fatalf("unexpected account order: %v", sections.accounts)
	}
	if len(sections.entries) != 4 {
		t.Fatalf("expected 4 messages, got %d", len(sections.entries))
	}

	texts := []string{}
	for _, entry := range sections.entries {
		value, ok := getLuaMap(entry)
		if !ok {
			t.Fatal("entry is not an object")
		}
		texts = append(texts, value["text"].(string))
	}
	if strings.Join(texts, "|") != "old line|Howdy Mafia!|Hi Lamb!|Third line" {
		t.Fatalf("unexpected message order: %v", texts)
	}
}

func TestGuildSyncChatSectionsReadWorldSectionUnderAccountWide(t *testing.T) {
	parsed, err := parseEsoLuaTable(`{
		["Default"] = {
			["@evainefaye"] = {
				["$AccountWide"] = {
					["NA Megaserver"] = {
						["version"] = 1,
						["debugChat"] = false,
						["messages"] = {
							[1] = { ["sender"] = "@TheLamb_Sauce", ["guild"] = "alphabet_mafia", ["timestamp"] = 1795636949, ["text"] = "Howdy Mafia!" },
							[2] = { ["guild"] = "alphabet_mafia", ["text"] = "Hi Lamb!!", ["sender"] = "@evainefaye", ["timestamp"] = 1795636954 }
						}
					}
				}
			}
		}
	}`)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}

	parsedMap, ok := parsed.(map[string]interface{})
	if !ok {
		t.Fatal("parsed table is not an object")
	}

	sections := guildSyncChatSections(parsedMap)
	if len(sections.accounts) != 1 || sections.accounts[0] != "@evainefaye" {
		t.Fatalf("expected the world-nested account section, got %v", sections.accounts)
	}
	if len(sections.entries) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(sections.entries))
	}

	texts := []string{}
	for _, entry := range sections.entries {
		value, ok := getLuaMap(entry)
		if !ok {
			t.Fatal("entry is not an object")
		}
		texts = append(texts, value["text"].(string))
	}
	if strings.Join(texts, "|") != "Howdy Mafia!|Hi Lamb!!" {
		t.Fatalf("unexpected message order: %v", texts)
	}
}

func TestGuildSyncChatEntriesOrderNumericallyAndDropInvalidRows(t *testing.T) {
	messages := map[string]interface{}{
		"10": map[string]interface{}{"sender": "@Ten", "timestamp": float64(1795636950), "text": "tenth"},
		"2":  map[string]interface{}{"sender": "@Two", "timestamp": float64(1795636949), "text": "second"},
		"1":  map[string]interface{}{"sender": "@One", "timestamp": float64(1795636948), "text": "first"},
		"3":  map[string]interface{}{"sender": "", "timestamp": float64(1795636951), "text": "no sender"},
		"4":  map[string]interface{}{"sender": "@Four", "timestamp": float64(0), "text": "no timestamp"},
		"5":  map[string]interface{}{"sender": "@Five", "timestamp": float64(1795636952), "text": "   "},
	}

	entries := guildSyncChatEntries(messages)
	if len(entries) != 3 {
		t.Fatalf("expected 3 valid entries, got %d", len(entries))
	}

	expected := []string{"first", "second", "tenth"}
	for index, entry := range entries {
		value, ok := getLuaMap(entry)
		if !ok {
			t.Fatalf("entry %d is not an object", index)
		}
		if value["text"] != expected[index] {
			t.Fatalf("entry %d: expected %q, got %q", index, expected[index], value["text"])
		}
		if _, ok := value["timestamp"].(int64); !ok {
			t.Fatalf("entry %d timestamp is not an int64", index)
		}
	}
}

func TestReplaceAllLuaBracketSubtablesClearsEveryAccount(t *testing.T) {
	text := `GuildSyncChat =
{
    ["NA Megaserver"] =
    {
        ["@one"] =
        {
            ["$AccountWide"] =
            {
                ["debugChat"] = false,
                ["messages"] =
                {
                    [1] =
                    {
                        ["text"] = "Hi Lamb!",
                        ["sender"] = "@evainefaye",
                    },
                },
            },
        },
        ["@two"] =
        {
            ["$AccountWide"] =
            {
                ["messages"] =
                {
                    [1] =
                    {
                        ["text"] = "Howdy Mafia!",
                        ["sender"] = "@TheLamb_Sauce",
                    },
                },
            },
        },
    },
}
`

	cleaned, cleared := replaceAllLuaBracketSubtables(text, "messages", renderEmptyLuaTableSection("messages"))
	if cleared != 2 {
		t.Fatalf("expected 2 cleared sections, got %d", cleared)
	}
	if strings.Contains(cleaned, "Hi Lamb!") || strings.Contains(cleaned, "Howdy Mafia!") {
		t.Fatal("cleared sections still contain messages")
	}
	if strings.Count(cleaned, `["messages"]`) != 2 {
		t.Fatalf("expected both messages sections to remain, got %d", strings.Count(cleaned, `["messages"]`))
	}
	if !strings.Contains(cleaned, `["debugChat"] = false`) {
		t.Fatal("add-on settings were removed")
	}
}
