GuildSyncChat = GuildSyncChat or {}

local TARGET_GUILD_NAME = "Alphabet Mafia"

local ADDON_NAME = "GuildSyncChat"
local SAVED_VARS_NAME = "GuildSyncChat"
local SAVED_VARS_VERSION = 1

local MAX_GUILD_SLOTS = 5

-- Older messages are dropped so SavedVariables stays bounded.
local MAX_SAVED_MESSAGES = 1000

-- Guild chat arrives with the channel of the slot it was sent to, so the
-- channel of a message identifies which guild spoke.
local SLOT_BY_GUILD_CHANNEL = {
  [CHAT_CHANNEL_GUILD_1] = 1,
  [CHAT_CHANNEL_GUILD_2] = 2,
  [CHAT_CHANNEL_GUILD_3] = 3,
  [CHAT_CHANNEL_GUILD_4] = 4,
  [CHAT_CHANNEL_GUILD_5] = 5,
}

-- Officer chat has its own channels but belongs to the same guild slot.
local SLOT_BY_OFFICER_CHANNEL = {
  [CHAT_CHANNEL_OFFICER_1] = 1,
  [CHAT_CHANNEL_OFFICER_2] = 2,
  [CHAT_CHANNEL_OFFICER_3] = 3,
  [CHAT_CHANNEL_OFFICER_4] = 4,
  [CHAT_CHANNEL_OFFICER_5] = 5,
}

-- Every saved message says which of the two conversations it came from.
local CHANNEL_GUILD = "guild"
local CHANNEL_OFFICER = "officer"

local gscSavedVars = nil

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

local function GSC_IsTargetGuildName(guildName)
  return string.lower(GSC_Trim(guildName)) == string.lower(GSC_Trim(TARGET_GUILD_NAME))
end

-- Guild slots are sparse: one guild can sit in slot 3, so every slot is checked
-- instead of stopping at GetNumGuilds().
local function GSC_FindTargetGuild()
  for slot = 1, MAX_GUILD_SLOTS do
    local guildId = GetGuildId(slot)

    if guildId and guildId ~= 0 then
      local guildName = GetGuildName(guildId)

      if GSC_IsTargetGuildName(guildName) then
        return guildId, slot, guildName
      end
    end
  end

  return nil, nil, nil
end

-- The guild that owns a channel is looked up whenever a message arrives instead
-- of being cached at login, so a guild that fills its slot late, or that moves
-- slots between sessions, is still captured. Guild and officer channels share
-- the slot numbering, so the same lookup serves both.
local function GSC_GuildForChannel(channelType)
  local slot = SLOT_BY_GUILD_CHANNEL[channelType]
  local channel = CHANNEL_GUILD

  if not slot then
    slot = SLOT_BY_OFFICER_CHANNEL[channelType]
    channel = CHANNEL_OFFICER
  end

  if not slot then
    return nil, nil, nil
  end

  local guildId = GetGuildId(slot)

  if not guildId or guildId == 0 then
    return slot, nil, channel
  end

  return slot, GetGuildName(guildId), channel
end

local function GSC_PrintSlots()
  local printed = false

  for slot = 1, MAX_GUILD_SLOTS do
    local guildId = GetGuildId(slot)

    if guildId and guildId ~= 0 then
      GSC_Print("Slot " .. tostring(slot) .. ": " .. tostring(GetGuildName(guildId)))
      printed = true
    end
  end

  if not printed then
    GSC_Print("No guild slots have loaded yet.")
  end
end

local function GSC_TrimSavedMessages()
  local messages = gscSavedVars.messages

  while #messages > MAX_SAVED_MESSAGES do
    table.remove(messages, 1)
  end
end

local function GSC_OnChatMessage(eventCode, channelType, fromName, text, isCustomerService, fromDisplayName)
  if not gscSavedVars then
    return
  end

  local slot, guildName, channel = GSC_GuildForChannel(channelType)

  if not slot or not GSC_IsTargetGuildName(guildName) then
    if slot and gscSavedVars.debugChat then
      GSC_Print("Ignored guild chat in slot " .. tostring(slot) .. " (" .. tostring(guildName) .. ").")
    end

    return
  end

  local sender = fromDisplayName

  if type(sender) ~= "string" or sender == "" then
    sender = fromName
  end

  if type(sender) ~= "string" or sender == "" then
    return
  end

  -- The add-on only captures TARGET_GUILD_NAME, so the guild does not need to be
  -- repeated in every saved message. Officer chat shares the guild, so only the
  -- channel is stored to tell the two conversations apart.
  local message = {
    sender = sender,
    timestamp = GetTimeStamp(),
    text = tostring(text or ""),
    channel = channel,
  }

  gscSavedVars.messages[#gscSavedVars.messages + 1] = message
  GSC_TrimSavedMessages()

  if gscSavedVars.debugChat then
    GSC_Print(
      "["
        .. channel
        .. "] "
        .. GSC_TimeString(message.timestamp)
        .. " "
        .. message.sender
        .. ": "
        .. message.text
    )
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
    GSC_Print("Saving " .. tostring(guildName) .. " guild and officer chat from guild slot " .. tostring(slot) .. ".")
  else
    GSC_Print("Guild not found: " .. TARGET_GUILD_NAME .. ". Nothing is being captured.")
    GSC_PrintSlots()
  end

  local messages = gscSavedVars.messages
  GSC_Print(tostring(#messages) .. " messages saved on " .. tostring(GetWorldName()) .. ".")

  local last = messages[#messages]

  if last then
    GSC_Print(
      "Last message: "
        .. tostring(last.sender)
        .. (last.channel == CHANNEL_OFFICER and " (officer)" or "")
        .. " at "
        .. GSC_TimeString(last.timestamp)
        .. "."
    )
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

  EVENT_MANAGER:RegisterForEvent(ADDON_NAME, EVENT_CHAT_MESSAGE_CHANNEL, GSC_OnChatMessage)

  SLASH_COMMANDS["/gsc"] = GSC_HandleCommand

  local guildId, slot, guildName = GSC_FindTargetGuild()

  if guildId then
    GSC_Print("GuildSyncChat loaded. Saving " .. tostring(guildName) .. " guild and officer chat from guild slot " .. tostring(slot) .. ".")
  else
    GSC_Print("GuildSyncChat loaded, but " .. TARGET_GUILD_NAME .. " is not in a guild slot yet.")
    GSC_PrintSlots()
  end

  GSC_Print("Use /gsc status for the saved message count.")
end

EVENT_MANAGER:RegisterForEvent(
  ADDON_NAME,
  EVENT_ADD_ON_LOADED,
  OnAddonLoaded
)
