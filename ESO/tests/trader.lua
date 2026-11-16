-- Run from the repository root: fengari ESO/tests/trader.lua
local function equal(actual, expected, message)
  assert(actual == expected, message .. ': expected ' .. tostring(expected) .. ', got ' .. tostring(actual))
end

local saved = {}
local callbacks = {}
local processors = {}
local messages = {}
local iterateEvents = {}
local guildIds = {101, 202}
local names = {[101] = 'Alphabet Mafia', [202] = 'Other Guild'}

local function event(id, eventType)
  return {
    GetEventId = function() return id end,
    GetEventType = function() return eventType or 60 end,
    GetEventTimestampS = function() return 1700000000 + id end,
    GetEventInfo = function()
      return {
        eventId = id,
        eventType = eventType or 60,
        sellerDisplayName = '@Seller',
        buyerDisplayName = '@Buyer',
        itemLink = '|H1:item:12345:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0|h|h',
        quantity = 10,
        price = 100000,
        tax = 7000,
      }
    end,
  }
end

CHAT_ROUTER = {AddSystemMessage = function(_, message) messages[#messages + 1] = message end}
SLASH_COMMANDS = {}
EVENT_ADD_ON_LOADED = 1
EVENT_MANAGER = {
  RegisterForEvent = function(_, _, _, callback) callbacks.loaded = callback end,
  UnregisterForEvent = function() end,
}
ZO_SavedVars = {NewAccountWide = function(_, name, _, _, defaults)
  saved[name] = saved[name] or defaults
  return saved[name]
end}
GetNumGuilds = function() return #guildIds end
GetGuildId = function(index) return guildIds[index] end
GetGuildName = function(id) return names[id] end
GetTimeStamp = function() return 1700000100 end
GUILD_HISTORY_EVENT_CATEGORY_TRADER = 4
GUILD_HISTORY_TRADER_EVENT_ITEM_SOLD = 60
GetItemLinkItemId = function(link) return tonumber(link:match('item:(%d+)')) end
GetItemLinkName = function() return 'Dreugh Wax' end

LibHistoire = {OnReady = function(_, callback) callback(LibHistoire) end}

function LibHistoire:CreateGuildHistoryProcessor(guildId, category, name)
  local processor = {guildId = guildId, category = category, name = name, running = false}
  function processor:GetKey() return tostring(name) end
  function processor:IsRunning() return self.running end
  function processor:Stop() self.running = false; return true end
  function processor:SetStopOnLastCachedEvent(value) self.stopOnLastCachedEvent = value end
  function processor:StartStreaming(cursor, callback)
    if self.running then return false end
    self.cursor, self.callback, self.running = cursor, callback, true
    processors[#processors + 1] = self
    return true
  end
  function processor:StartIteratingTimeRange(_, _, callback, stopCallback)
    for _, item in ipairs(iterateEvents) do callback(item) end
    if stopCallback then stopCallback('end of cache') end
    return true
  end
  return processor
end

dofile('ESO/GuildSyncTrader/GuildSyncTrader.lua')
callbacks.loaded(nil, 'GuildSyncTrader')

local state, data = saved['GuildSyncTraderState'], saved['GuildSyncTrader']
local function tradeCount()
  local count = 0
  for _ in pairs(data.trades) do count = count + 1 end
  return count
end

local first = processors[#processors]
equal(first.category, 4, 'processor uses the trader category')
equal(first.cursor, nil, 'unbound legacy checkpoint must replay')

first.callback(event(5))
local trade = data.trades.guild_101_event_5
equal(type(trade), 'table', 'sale saved under guild and event key')
equal(trade.guildId, '101', 'guild id')
equal(trade.guildName, 'Alphabet Mafia', 'guild name')
equal(trade.time, 1700000005, 'event time')
equal(trade.seller, '@Seller', 'seller')
equal(trade.buyer, '@Buyer', 'buyer')
equal(trade.itemId, 12345, 'item id from link')
equal(trade.itemName, 'Dreugh Wax', 'item name from link')
equal(trade.quantity, 10, 'quantity')
equal(trade.price, 100000, 'total price')
equal(trade.unitPrice, 10000, 'unit price')
equal(trade.tax, 7000, 'tax')
equal(trade.net, 93000, 'net after tax')
equal(state.lastProcessedIdsByGuild['101'], 5, 'guild checkpoint')

first.callback(event(5))
equal(tradeCount(), 1, 'replayed event id is deduped')
equal(state.lastProcessedIdsByGuild['101'], 5, 'duplicate never moves checkpoint')

first.callback(event(6, 999))
equal(tradeCount(), 1, 'non-sale event is not stored')
equal(state.lastProcessedIdsByGuild['101'], 6, 'checkpoint still advances over filtered events')

iterateEvents = {event(4)}
SLASH_COMMANDS['/gst']('dump')
equal(tradeCount(), 1, 'dump never saves rows')
equal(state.lastProcessedIdsByGuild['101'], 6, 'dump never moves the checkpoint')

iterateEvents = {event(4), event(5)}
SLASH_COMMANDS['/gst']('catchup')
equal(first.running, false, 'catch-up stops the active stream first')
equal(tradeCount(), 2, 'catch-up saves older cached sales and skips duplicates')
equal(type(data.trades.guild_101_event_4), 'table', 'caught-up sale stored')
equal(state.lastProcessedIdsByGuild['101'], 6, 'catch-up never regresses the checkpoint')
local resumed = processors[#processors]
equal(resumed.cursor, 6, 'stream resumes after the newest caught-up event')
equal(resumed.running, true, 'stream is running after catch-up')

messages = {}
SLASH_COMMANDS['/gst']('status')
equal(table.concat(messages, '\n'):find('Saved trader sales waiting for upload: 2', 1, true) ~= nil, true,
  'status reports pending rows')

SLASH_COMMANDS['/gst']('reset')
local reset = processors[#processors]
equal(reset.cursor, nil, 'reset replays cached history')
equal(tradeCount(), 2, 'reset keeps pending rows')
equal(state.lastProcessedIdsByGuild['101'], nil, 'reset clears only this guild checkpoint')

messages = {}
SLASH_COMMANDS['/gst']('guild 202')
equal(state.targetGuildId, nil, 'pending rows block guild changes')
equal(table.concat(messages, '\n'):find('Upload pending trader sales', 1, true) ~= nil, true,
  'guild change explains why nothing changed')

data.trades = {}
SLASH_COMMANDS['/gst']('guild 202')
equal(state.targetGuildId, '202', 'guild change allowed after rows are uploaded')
equal(processors[#processors].cursor, nil, 'new guild starts from its own checkpoint')
processors[#processors].callback(event(7))
equal(type(data.trades.guild_202_event_7), 'table', 'new guild sale uses its own key')
equal(state.lastProcessedIdsByGuild['202'], 7, 'new guild checkpoint advances')
equal(state.lastProcessedIdsByGuild['101'], nil, 'other guild checkpoint untouched')

print('GuildSyncTrader tests passed')
