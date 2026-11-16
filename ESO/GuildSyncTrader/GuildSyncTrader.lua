GuildSyncTraderState = GuildSyncTraderState or {}
GuildSyncTrader = GuildSyncTrader or {}

local TARGET_GUILD_NAME = "Alphabet Mafia"

local ADDON_NAME = "GuildSyncTrader"
local SAVED_VARS_NAME = "GuildSyncTraderState"
local SAVED_VARS_VERSION = 1

local TRADER_SAVED_VARS_NAME = "GuildSyncTrader"
local TRADER_SAVED_VARS_VERSION = 1

local DEBUG_TRADER = false

local TRADER_HISTORY_TYPE = {
  category = GUILD_HISTORY_EVENT_CATEGORY_TRADER,
  eventTypeFilter = GUILD_HISTORY_TRADER_EVENT_ITEM_SOLD
}

local gstSavedVars = nil
local gstTraderSavedVars = nil
local gstLibHistoire = nil
local gstProcessor = nil
local gstInitialized = false
local gstStreamGeneration = 0

local function GST_Print(message)
  CHAT_ROUTER:AddSystemMessage("|c88CCFF[GuildSyncTrader]|r " .. tostring(message))
end

local function GST_TimeString(timestamp)
  if not timestamp or timestamp == 0 then
    return "unknown"
  end

  return os.date("%Y-%m-%d %H:%M:%S", timestamp)
end

local function GST_UtcTimeString(timestamp)
  if not timestamp or timestamp == 0 then
    return "unknown"
  end

  return os.date("!%Y-%m-%d %H:%M:%S UTC", timestamp)
end

local function GST_Trim(value)
  value = tostring(value or "")

  if zo_strtrim then
    return zo_strtrim(value)
  end

  return value:match("^%s*(.-)%s*$") or ""
end

local function GST_TableCount(tbl)
  local count = 0

  if type(tbl) ~= "table" then
    return count
  end

  for _ in pairs(tbl) do
    count = count + 1
  end

  return count
end

local function GST_GetTargetGuildId()
  local selectedId = gstSavedVars and gstSavedVars.targetGuildId
  local selectedName = gstSavedVars and gstSavedVars.targetGuildName or TARGET_GUILD_NAME
  for guildIndex = 1, GetNumGuilds() do
    local guildId = GetGuildId(guildIndex)
    local guildName = GetGuildName(guildId)

    if (selectedId and tostring(guildId) == tostring(selectedId))
      or (not selectedId and string.lower(GST_Trim(guildName)) == string.lower(selectedName)) then
      return guildId, guildIndex, guildName
    end
  end

  GST_Print("Could not find selected guild: " .. tostring(selectedId or selectedName))
  return nil, nil, nil
end

local function GST_EnsureSavedVars()
  if not gstSavedVars then
    return nil
  end

  if gstSavedVars.lastProcessedId ~= nil then
    local numericId = tonumber(gstSavedVars.lastProcessedId)

    if numericId then
      gstSavedVars.lastProcessedId = numericId
    else
      GST_Print("Saved LastProcessedId was not numeric. Clearing it.")
      gstSavedVars.lastProcessedId = nil
    end
  end

  if gstSavedVars.debugTrader ~= true then
    gstSavedVars.debugTrader = false
  end

  return gstSavedVars
end

local function GST_EnsureTraderSavedVars()
  if not gstTraderSavedVars then
    return nil
  end

  gstTraderSavedVars.trades = gstTraderSavedVars.trades or {}

  return gstTraderSavedVars
end

-- Never apply a singleton checkpoint from an unidentified guild to another guild.
local function GST_GuildCheckpoint(guildId)
  local sv = GST_EnsureSavedVars()
  local key = tostring(guildId)
  sv.lastProcessedIdsByGuild = sv.lastProcessedIdsByGuild or {}
  if not sv.guildCheckpointMigrationComplete then
    if sv.lastProcessedId ~= nil then
      if tostring(sv.lastProcessedGuildId or "") == key then
        sv.lastProcessedIdsByGuild[key] = sv.lastProcessedIdsByGuild[key] or tonumber(sv.lastProcessedId)
      else
        sv.unboundLegacyLastProcessedId = sv.lastProcessedId
        GST_Print("Legacy checkpoint has no matching guild identity; replaying available cached history safely.")
      end
    end
    sv.guildCheckpointMigrationComplete = true
  end
  sv.lastProcessedGuildId = key
  sv.lastProcessedId = tonumber(sv.lastProcessedIdsByGuild[key])
  return sv.lastProcessedId
end

local function GST_AdvanceGuildCheckpoint(guildId, eventId)
  local sv = GST_EnsureSavedVars()
  local previous = GST_GuildCheckpoint(guildId)
  eventId = tonumber(eventId)
  if eventId and (not previous or eventId > previous) then
    sv.lastProcessedIdsByGuild[tostring(guildId)] = eventId
    sv.lastProcessedId = eventId
  end
end

local function GST_IsDebugEnabled()
  local sv = GST_EnsureSavedVars()

  if not sv then
    return DEBUG_TRADER
  end

  return sv.debugTrader == true
end

local function GST_Debug(message)
  if GST_IsDebugEnabled() then
    GST_Print(message)
  end
end

local function GST_TradeKey(guildId, eventId)
  return "guild_" .. tostring(guildId) .. "_event_" .. tostring(eventId)
end

-- Trader sales are saved by guild and eventId so a replayed or caught-up event
-- can never create a second row, even when it is older than the checkpoint.
local function GST_SaveTrade(entry)
  local traderSv = GST_EnsureTraderSavedVars()

  if not traderSv then
    GST_Print("Trader SavedVars not ready. Could not save trader sale.")
    return false
  end

  if not entry or not entry.eventId then
    GST_Print("Trader sale has no numeric EventId. Not saving.")
    return false
  end

  local key = GST_TradeKey(entry.guildId, entry.eventId)

  if traderSv.trades[key] ~= nil then
    return false
  end

  traderSv.trades[key] = entry
  traderSv.guildId = entry.guildId
  traderSv.guildName = entry.guildName

  return true
end

local function GST_ItemIdFromLink(itemLink)
  if itemLink == "" then
    return 0
  end

  if GetItemLinkItemId then
    local itemId = tonumber(GetItemLinkItemId(itemLink))

    if itemId then
      return itemId
    end
  end

  return tonumber(itemLink:match("|H1:item:(%d+)")) or 0
end

local function GST_ItemNameFromLink(itemLink)
  if itemLink == "" then
    return ""
  end

  if GetItemLinkName then
    local itemName = GST_Trim(GetItemLinkName(itemLink))

    if itemName ~= "" then
      return itemName
    end
  end

  return ""
end

local function GST_EventPassesTraderFilter(event)
  if not event then
    return false
  end

  if TRADER_HISTORY_TYPE.eventTypeFilter and event:GetEventType() ~= TRADER_HISTORY_TYPE.eventTypeFilter then
    return false
  end

  return true
end

local function GST_BuildTradeEntry(event, guildId, guildName)
  local info = event:GetEventInfo() or {}
  local eventId = tonumber(event:GetEventId()) or tonumber(info.eventId)

  if not eventId then
    return nil
  end

  local quantity = tonumber(info.quantity) or 0
  local price = tonumber(info.price) or 0
  local tax = tonumber(info.tax) or 0
  local itemLink = tostring(info.itemLink or "")

  return {
    eventId = eventId,
    guildId = tostring(guildId),
    guildName = guildName,
    time = tonumber(event:GetEventTimestampS()) or tonumber(info.timestampS),
    seller = GST_Trim(info.sellerDisplayName),
    buyer = GST_Trim(info.buyerDisplayName),
    itemLink = itemLink,
    itemId = GST_ItemIdFromLink(itemLink),
    itemName = GST_ItemNameFromLink(itemLink),
    quantity = quantity,
    price = price,
    unitPrice = quantity > 0 and math.floor(price / quantity) or 0,
    tax = tax,
    net = price - tax
  }
end

local function GST_PrintTradeEntry(source, entry)
  if not entry then
    return
  end

  local line =
      "[" .. tostring(source) .. "] "
      .. "EventId=" .. tostring(entry.eventId)
      .. " Time=" .. GST_TimeString(entry.time)
      .. " UTC=" .. GST_UtcTimeString(entry.time)
      .. " GuildId=" .. tostring(entry.guildId)
      .. " Seller=" .. tostring(entry.seller)
      .. " Buyer=" .. tostring(entry.buyer)
      .. " Item=" .. tostring(entry.itemName)
      .. " ItemId=" .. tostring(entry.itemId)
      .. " Qty=" .. tostring(entry.quantity)
      .. " Price=" .. tostring(entry.price)
      .. " UnitPrice=" .. tostring(entry.unitPrice)
      .. " Tax=" .. tostring(entry.tax)
      .. " Net=" .. tostring(entry.net)

  GST_Print(line)
end

local function GST_ProcessTradeEvent(event, shouldSave, guildId, guildName)
  if not GST_EventPassesTraderFilter(event) then
    return false
  end

  local entry = GST_BuildTradeEntry(event, guildId, guildName)

  if not entry then
    return false
  end

  if GST_IsDebugEnabled() or not shouldSave then
    GST_PrintTradeEntry(shouldSave and "stream" or "dump", entry)
  end

  if not shouldSave then
    return false
  end

  local saved = GST_SaveTrade(entry)

  if saved then
    GST_AdvanceGuildCheckpoint(guildId, entry.eventId)
    GST_Debug("Saved trader sale EventId=" .. tostring(entry.eventId) .. " Item=" .. tostring(entry.itemName))
  else
    GST_Debug("Trader sale EventId=" .. tostring(entry.eventId) .. " was already saved.")
  end

  return saved
end

local function GST_CreateProcessor(processorNameSuffix)
  if not gstLibHistoire then
    GST_Print("LibHistoire is not ready yet.")
    return nil
  end

  local guildId, guildIndex, guildName = GST_GetTargetGuildId()

  if not guildId then
    return nil
  end

  GST_Debug("Using guild: " ..
    tostring(guildName) .. " index=" .. tostring(guildIndex) .. " guildId=" .. tostring(guildId))

  local processor = gstLibHistoire:CreateGuildHistoryProcessor(
    guildId,
    TRADER_HISTORY_TYPE.category,
    ADDON_NAME .. "-" .. tostring(processorNameSuffix or "trader")
  )

  if not processor then
    GST_Print("Could not create LibHistoire trader processor.")
    GST_Print("LibHistoire may not have a cache for this guild/category yet.")
    return nil
  end

  if processor.GetKey then
    GST_Debug("Trader processor key: " .. tostring(processor:GetKey()))
  end

  return processor, guildId, guildName
end

local function GST_StopStream()
  gstStreamGeneration = gstStreamGeneration + 1
  if not gstProcessor then
    return true
  end

  if not gstProcessor.Stop then
    GST_Print("Trader processor does not expose Stop().")
    return false
  end

  gstProcessor:Stop()
  gstProcessor = nil

  return true
end

local function GST_StartStream()
  if not gstLibHistoire then
    GST_Print("LibHistoire is not ready yet.")
    return
  end

  if gstProcessor and gstProcessor:IsRunning() then
    GST_Debug("Trader stream is already running.")
    return
  end

  local sv = GST_EnsureSavedVars()

  if not sv then
    GST_Print("SavedVars not ready.")
    return
  end

  local processor, guildId, guildName = GST_CreateProcessor("stream")

  if not processor then
    return
  end

  if not processor.StartStreaming then
    GST_Print("This processor does not have StartStreaming(). Your LibHistoire version may be outdated.")
    return
  end

  local lastProcessedId = GST_GuildCheckpoint(guildId)
  gstStreamGeneration = gstStreamGeneration + 1
  local generation = gstStreamGeneration
  gstProcessor = processor

  if lastProcessedId then
    GST_Print("Starting trader stream after saved LastProcessedId=" .. tostring(lastProcessedId))
  else
    GST_Print("Starting trader stream from the beginning because LastProcessedId is not set.")
  end

  local started = processor:StartStreaming(lastProcessedId, function(event)
    if generation ~= gstStreamGeneration or gstProcessor ~= processor then return end

    local eventId = tonumber(event:GetEventId())

    if eventId then
      GST_AdvanceGuildCheckpoint(guildId, eventId)
    end

    GST_ProcessTradeEvent(event, true, guildId, guildName)
  end)

  if not started then
    gstProcessor = nil
    gstStreamGeneration = gstStreamGeneration + 1
    GST_Print("Trader stream could not be started. It may already be running.")
    return
  end

  gstProcessor = processor

  GST_Print("Trader stream started.")
end

-- Review-only: prints every cached trader sale without saving rows or moving checkpoints.
local function GST_DumpTraderHistory()
  if not gstLibHistoire then
    GST_Print("LibHistoire is not ready yet.")
    return
  end

  local processor, guildId, guildName = GST_CreateProcessor("dump")

  if not processor then
    return
  end

  if processor.SetStopOnLastCachedEvent then
    processor:SetStopOnLastCachedEvent(true)
  end

  local startTime = 0
  local endTime = GetTimeStamp()

  GST_Print("Starting review-only dump of all cached trader sales.")
  GST_Print("Dump does not save trader rows and does not update LastProcessedId.")
  GST_Print("Start: " .. GST_TimeString(startTime) .. " / " .. GST_UtcTimeString(startTime))
  GST_Print("End: " .. GST_TimeString(endTime) .. " / " .. GST_UtcTimeString(endTime))

  local started = processor:StartIteratingTimeRange(
    startTime,
    endTime,
    function(event)
      GST_ProcessTradeEvent(event, false, guildId, guildName)
    end,
    function(reason)
      GST_Print("Trader dump stopped. Reason=" .. tostring(reason))
    end
  )

  if not started then
    GST_Print("Trader dump could not be started.")
  else
    GST_Print("Trader dump started.")
  end
end

-- Catch-up: saves every trader sale in LibHistoire's cache from the beginning of
-- cached history, keeping eventId dedupe and only advancing checkpoints forward,
-- then resumes the normal stream. ESO only serves a limited rolling history window,
-- so this catches up everything downloaded, not an unlimited server archive.
local function GST_CatchUpTraderHistory()
  if not gstLibHistoire then
    GST_Print("LibHistoire is not ready yet.")
    return
  end

  local guildId, guildIndex, guildName = GST_GetTargetGuildId()

  if not guildId then
    return
  end

  if not GST_StopStream() then
    return
  end

  local processor = GST_CreateProcessor("catchup")

  if not processor then
    GST_StartStream()
    return
  end

  if processor.SetStopOnLastCachedEvent then
    processor:SetStopOnLastCachedEvent(true)
  end

  local startTime = 0
  local endTime = GetTimeStamp()
  local seenCount = 0
  local savedCount = 0

  GST_Print("Starting trader catch-up for " .. tostring(guildName) .. " / ESO guild ID: " .. tostring(guildId))
  GST_Print("Catch-up saves every cached trader sale from the start of LibHistoire's cache.")
  GST_Print("Existing EventIds are skipped. LastProcessedId only moves forward. The stream resumes when done.")
  GST_Print("Start: " .. GST_TimeString(startTime) .. " / " .. GST_UtcTimeString(startTime))
  GST_Print("End: " .. GST_TimeString(endTime) .. " / " .. GST_UtcTimeString(endTime))

  local started = processor:StartIteratingTimeRange(
    startTime,
    endTime,
    function(event)
      if not GST_EventPassesTraderFilter(event) then
        return
      end

      seenCount = seenCount + 1

      if GST_ProcessTradeEvent(event, true, guildId, guildName) then
        savedCount = savedCount + 1
      end
    end,
    function(reason)
      GST_Print("Trader catch-up finished. Seen=" .. tostring(seenCount)
        .. " New=" .. tostring(savedCount)
        .. " Total saved=" .. tostring(GST_TableCount(GST_EnsureTraderSavedVars().trades))
        .. " StopReason=" .. tostring(reason))
      GST_StartStream()
    end
  )

  if not started then
    GST_Print("Trader catch-up could not be started. Resuming the normal stream.")
    GST_StartStream()
  end
end

local function GST_ResetStream()
  local guildId = GST_GetTargetGuildId()
  if not guildId then return end
  GST_Print("Reset requested. Stopping stream, clearing this guild's LastProcessedId, and starting again from the beginning.")

  if not GST_StopStream() then return end

  local sv = GST_EnsureSavedVars()

  if sv then
    GST_GuildCheckpoint(guildId)
    sv.lastProcessedIdsByGuild[tostring(guildId)] = nil
    sv.lastProcessedId = nil
  end

  GST_StartStream()
end

local function GST_Status()
  local guildId, _, guildName = GST_GetTargetGuildId()
  if guildId then
    GST_GuildCheckpoint(guildId)
    GST_Print("Guild: " .. tostring(guildName) .. " / ESO guild ID: " .. tostring(guildId))
  end
  local sv = GST_EnsureSavedVars()
  local lastProcessedId = sv and sv.lastProcessedId or nil
  local traderSv = GST_EnsureTraderSavedVars()
  local savedTrades = traderSv and traderSv.trades or {}

  if gstProcessor then
    GST_Print("Trader stream running: " .. tostring(gstProcessor:IsRunning()))
  else
    GST_Print("Trader stream running: false")
  end

  GST_Print("LastProcessedId=" .. tostring(lastProcessedId))
  GST_Print("Saved trader sales waiting for upload: " .. tostring(GST_TableCount(savedTrades)))
  GST_Print("Debug trader output: " .. tostring(GST_IsDebugEnabled()))
end

local function GST_SetDebug(value)
  local sv = GST_EnsureSavedVars()

  if not sv then
    GST_Print("SavedVars not ready.")
    return
  end

  sv.debugTrader = value == true

  if sv.debugTrader then
    GST_Print("Debug trader output enabled.")
  else
    GST_Print("Debug trader output disabled.")
  end
end

local function GST_SelectGuild(query)
  query = string.lower(GST_Trim(query))
  if query == "" then GST_Status(); GST_Print("Usage: /gst guild <guild name or ESO guild ID>"); return end
  local state, trader = GST_EnsureSavedVars(), GST_EnsureTraderSavedVars()
  for index = 1, GetNumGuilds() do
    local id = GetGuildId(index)
    local name = GetGuildName(id)
    if query == tostring(id) or query == string.lower(GST_Trim(name)) then
      if next(trader.trades) then
        GST_Print("Upload pending trader sales before changing guilds. Nothing was changed.")
        return
      end
      if not GST_StopStream() then return end
      state.targetGuildId, state.targetGuildName = tostring(id), name
      trader.guildId, trader.guildName = tostring(id), name
      GST_Print("Selected guild " .. name .. " / ESO guild ID: " .. tostring(id))
      GST_StartStream()
      return
    end
  end
  GST_Print("No joined guild matches that name or ESO guild ID. Nothing was changed.")
end

local function GST_PrintHelp()
  GST_Print("Commands:")
  GST_Print("/gst dump - Review all cached trader sales. Does not save rows or update LastProcessedId.")
  GST_Print("/gst catchup - Save every cached trader sale from the start of cached history, then resume the stream.")
  GST_Print("/gst stream - Stream trader sales after the saved LastProcessedId, or from the beginning if not set.")
  GST_Print("/gst stop - Stop the active trader stream.")
  GST_Print("/gst reset - Stop stream, clear this guild's LastProcessedId, and stream from the beginning.")
  GST_Print("/gst status - Show guild, stream status, LastProcessedId and saved row count.")
  GST_Print("/gst guild <name or ESO guild ID> - Select the guild after pending trader sales are uploaded.")
  GST_Print("/gst debug on - Enable detailed trader sale chat output.")
  GST_Print("/gst debug off - Disable detailed trader sale chat output.")
end

local function GST_HandleCommand(args)
  args = GST_Trim(args)

  local command, rest = args:match("^(%S+)%s*(.-)$")
  command = string.lower(GST_Trim(command or ""))
  rest = GST_Trim(rest or "")

  if command == "" or command == "help" then
    GST_PrintHelp()
    return
  end

  if command == "dump" then
    GST_DumpTraderHistory()
    return
  end

  if command == "catchup" then
    GST_CatchUpTraderHistory()
    return
  end

  if command == "stream" then
    GST_StartStream()
    return
  end

  if command == "stop" then
    local stopped = GST_StopStream()
    GST_Print("Trader stream stopped: " .. tostring(stopped))
    return
  end

  if command == "reset" then
    GST_ResetStream()
    return
  end

  if command == "status" then
    GST_Status()
    return
  end

  if command == "guild" then GST_SelectGuild(rest); return end

  if command == "debug" then
    local lowerRest = string.lower(rest)

    if lowerRest == "on" then
      GST_SetDebug(true)
      return
    end

    if lowerRest == "off" then
      GST_SetDebug(false)
      return
    end

    GST_Print("Usage: /gst debug on")
    GST_Print("Usage: /gst debug off")
    return
  end

  GST_Print("Unknown command: " .. tostring(command))
  GST_PrintHelp()
end

local function GST_InitLibHistoire()
  if gstInitialized then
    return
  end

  if not LibHistoire then
    GST_Print("LibHistoire global not found. Is LibHistoire enabled and listed as a dependency?")
    return
  end

  gstInitialized = true
  GST_Print("Waiting for LibHistoire OnReady...")

  LibHistoire:OnReady(function(lib)
    gstLibHistoire = lib

    GST_Print("LibHistoire is ready.")
    GST_StartStream()
  end)
end

local function OnAddonLoaded(eventCode, addonName)
  if addonName ~= ADDON_NAME then
    return
  end

  EVENT_MANAGER:UnregisterForEvent(ADDON_NAME, EVENT_ADD_ON_LOADED)

  gstSavedVars = ZO_SavedVars:NewAccountWide(
    SAVED_VARS_NAME,
    SAVED_VARS_VERSION,
    GetWorldName(),
    {
      lastProcessedId = nil,
      debugTrader = false,
    }
  )

  gstTraderSavedVars = ZO_SavedVars:NewAccountWide(
    TRADER_SAVED_VARS_NAME,
    TRADER_SAVED_VARS_VERSION,
    nil,
    {
      trades = {},
    }
  )

  GST_EnsureSavedVars()
  GST_EnsureTraderSavedVars()

  SLASH_COMMANDS["/gst"] = GST_HandleCommand

  GST_Print("GuildSyncTrader loaded.")
  GST_Print("Trader stream will start automatically when LibHistoire is ready.")
  GST_Print("Use /gst help for commands.")
  GST_Print("SavedVars: GuildSyncTraderState.lua and GuildSyncTrader.lua")

  GST_InitLibHistoire()
end

EVENT_MANAGER:RegisterForEvent(
  ADDON_NAME,
  EVENT_ADD_ON_LOADED,
  OnAddonLoaded
)
