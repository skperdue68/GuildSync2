GuildSyncChat = GuildSyncChat or {}

local TARGET_GUILD_NAME = "Alphabet Mafia"

local ADDON_NAME = "GuildSyncChat"
local SAVED_VARS_NAME = "GuildSyncChat"
local SAVED_VARS_VERSION = 1

-- Guild chat channels follow guild slots, and slots differ per player, so the
-- stored guild identity is a fixed key rather than a channel or slot number.
local GUILD_KEY = "alphabet_mafia"
local MAX_GUILD_SLOTS = 5

-- Older messages are dropped so SavedVariables stays bounded.
local MAX_SAVED_MESSAGES = 1000

local GUILD_CHAT_CHANNELS = {
  [1] = CHAT_CHANNEL_GUILD_1,
  [2] = CHAT_CHANNEL_GUILD_2,
  [3] = CHAT_CHANNEL_GUILD_3,
  [4] = CHAT_CHANNEL_GUILD_4,
  [5] = CHAT_CHANNEL_GUILD_5,
}

local gscSavedVars = nil
local gscTargetChannel = nil

local function GSC_Print(message)
  CHAT_ROUTER:AddSystemMessage("|c88CCFF[GuildSyncChat]|r " .. tostring(message))
end

local function GSC_TimeString(timestamp)
  if not timestamp or timestamp == 0 then
    return "unknown"
  end

  return os.date("%Y-%m-%d %H:%M:%S", timestamp)
end

local function GSC_Trim(value)
  value = tostring(value or "")

  if zo_strtrim then
    return zo_strtrim(value)
  end

  return value:match("^%s*(.-)%s*$") or ""
end

-- Guild slots are sparse: one guild can sit in slot 3, so every slot is checked
-- instead of stopping at GetNumGuilds().
local function GSC_FindTargetGuild()
  local wanted = string.lower(GSC_Trim(TARGET_GUILD_NAME))

  for slot = 1, MAX_GUILD_SLOTS do
    local guildId = GetGuildId(slot)

    if guildId and guildId ~= 0 then
      local guildName = GetGuildName(guildId)

      if string.lower(GSC_Trim(guildName)) == wanted then
        return guildId, slot, guildName
      end
    end
  end

  return nil, nil, nil
end

local function GSC_ResolveTargetChannel()
  local guildId, slot = GSC_FindTargetGuild()
  gscTargetChannel = guildId and GUILD_CHAT_CHANNELS[slot] or nil
end

-- A login, join or leave can land before the game has moved the guild in its
-- slots, so resolve again once the guild state has settled.
local function GSC_OnGuildStateChanged()
  GSC_ResolveTargetChannel()
  zo_callLater(GSC_ResolveTargetChannel, 3000)
end

local function GSC_TrimSavedMessages()
  local messages = gscSavedVars.messages

  while #messages > MAX_SAVED_MESSAGES do
    table.remove(messages, 1)
  end
end

local function GSC_OnChatMessage(eventCode, channelType, fromName, text, isCustomerService, fromDisplayName)
  if not gscSavedVars or not gscTargetChannel or channelType ~= gscTargetChannel then
    return
  end

  local sender = fromDisplayName

  if type(sender) ~= "string" or sender == "" then
    sender = fromName
  end

  if type(sender) ~= "string" or sender == "" then
    return
  end

  local message = {
    guild = GUILD_KEY,
    sender = sender,
    timestamp = GetTimeStamp(),
    text = tostring(text or ""),
  }

  gscSavedVars.messages[#gscSavedVars.messages + 1] = message
  GSC_TrimSavedMessages()

  if gscSavedVars.debugChat then
    GSC_Print(GSC_TimeString(message.timestamp) .. " " .. message.sender .. ": " .. message.text)
  end
end

local function GSC_EnsureSavedVars()
  if type(gscSavedVars.messages) ~= "table" then
    gscSavedVars.messages = {}
  end

  gscSavedVars.debugChat = gscSavedVars.debugChat == true
end

local function GSC_Status()
  local guildId, slot, guildName = GSC_FindTargetGuild()

  if guildId then
    GSC_Print("Saving " .. tostring(guildName) .. " guild chat from guild slot " .. tostring(slot) .. ".")
  else
    GSC_Print("Guild not found: " .. TARGET_GUILD_NAME .. ". Nothing is being captured.")
  end

  local messages = gscSavedVars.messages
  GSC_Print(tostring(#messages) .. " messages saved on " .. tostring(GetWorldName()) .. ".")

  local last = messages[#messages]

  if last then
    GSC_Print("Last message: " .. tostring(last.sender) .. " at " .. GSC_TimeString(last.timestamp) .. ".")
  end
end

local function GSC_PrintHelp()
  GSC_Print("Usage: /gsc status | debug on | debug off")
end

local function GSC_HandleCommand(args)
  local command, value = tostring(args or ""):match("^(%S*)%s*(.*)$")
  command = string.lower(command or "")

  if command == "" or command == "status" then
    GSC_Status()
    return
  end

  if command == "debug" then
    value = string.lower(GSC_Trim(value))

    if value == "on" or value == "off" then
      gscSavedVars.debugChat = value == "on"
      GSC_Print("Debug logging " .. value .. ".")
      return
    end

    GSC_Print("Usage: /gsc debug on")
    GSC_Print("Usage: /gsc debug off")
    return
  end

  GSC_Print("Unknown command: " .. tostring(command))
  GSC_PrintHelp()
end

local function OnAddonLoaded(eventCode, addonName)
  if addonName ~= ADDON_NAME then
    return
  end

  EVENT_MANAGER:UnregisterForEvent(ADDON_NAME, EVENT_ADD_ON_LOADED)

  gscSavedVars = ZO_SavedVars:NewAccountWide(
    SAVED_VARS_NAME,
    SAVED_VARS_VERSION,
    GetWorldName(),
    {
      messages = {},
      debugChat = false,
    }
  )

  GSC_EnsureSavedVars()

  EVENT_MANAGER:RegisterForEvent(ADDON_NAME, EVENT_PLAYER_ACTIVATED, GSC_OnGuildStateChanged)
  EVENT_MANAGER:RegisterForEvent(ADDON_NAME, EVENT_GUILD_SELF_JOINED_GUILD, GSC_OnGuildStateChanged)
  EVENT_MANAGER:RegisterForEvent(ADDON_NAME, EVENT_GUILD_SELF_LEFT_GUILD, GSC_OnGuildStateChanged)
  EVENT_MANAGER:RegisterForEvent(ADDON_NAME, EVENT_CHAT_MESSAGE_CHANNEL, GSC_OnChatMessage)

  SLASH_COMMANDS["/gsc"] = GSC_HandleCommand

  GSC_Print("GuildSyncChat loaded. Saving " .. TARGET_GUILD_NAME .. " guild chat to SavedVariables.")
  GSC_Print("Use /gsc status for the saved message count.")
end

EVENT_MANAGER:RegisterForEvent(
  ADDON_NAME,
  EVENT_ADD_ON_LOADED,
  OnAddonLoaded
)
