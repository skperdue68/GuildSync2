-- Run from the repository root: fengari ESO/tests/guild-chat.lua
local function equal(actual, expected, message)
  assert(actual == expected, message .. ': expected ' .. tostring(expected) .. ', got ' .. tostring(actual))
end

local handlers, timers, messages = {}, {}, {}
EVENT_ADD_ON_LOADED = 1
EVENT_PLAYER_ACTIVATED = 2
EVENT_GUILD_SELF_JOINED_GUILD = 3
EVENT_GUILD_SELF_LEFT_GUILD = 4
EVENT_CHAT_MESSAGE_CHANNEL = 5
CHAT_CHANNEL_GUILD_1 = 10
CHAT_CHANNEL_GUILD_2 = 11
CHAT_CHANNEL_GUILD_3 = 12
CHAT_CHANNEL_GUILD_4 = 13
CHAT_CHANNEL_GUILD_5 = 14
EVENT_MANAGER = {
  RegisterForEvent = function(_, name, event, callback) handlers[name .. event] = callback end,
  UnregisterForEvent = function(_, name, event) handlers[name .. event] = nil end,
}
local function fire(event, ...)
  local snapshot = {}
  for key, callback in pairs(handlers) do snapshot[key] = callback end
  for key, callback in pairs(snapshot) do
    if key:sub(-1) == tostring(event) then callback(event, ...) end
  end
end
zo_callLater = function(callback, delay) timers[#timers + 1] = {callback = callback, delay = delay} end
local function tick(delay)
  local queued = timers
  timers = {}
  for _, timer in ipairs(queued) do
    if timer.delay == delay then timer.callback() else timers[#timers + 1] = timer end
  end
end
CHAT_ROUTER = {AddSystemMessage = function(_, text) messages[#messages + 1] = text end}
SLASH_COMMANDS = {}
GetTimeStamp = function() return 1700000000 end
GetWorldName = function() return 'NA Megaserver' end
zo_strtrim = function(value) return value:match("^%s*(.-)%s*$") end
local slots = {[1] = 101, [3] = 303}
local names = {[101] = 'Other Guild', [303] = 'Alphabet Mafia'}
GetGuildId = function(slot) return slots[slot] or 0 end
GetGuildName = function(id) return names[id] end
local saved = {}
local savedProfiles = {}
ZO_SavedVars = {NewAccountWide = function(_, name, _, profile, defaults)
  savedProfiles[name] = profile
  saved[name] = saved[name] or defaults
  return saved[name]
end}
dofile('ESO/GuildSyncChat/GuildSyncChat.lua')
fire(EVENT_ADD_ON_LOADED, 'GuildSyncChat')
local data = saved.GuildSyncChat
equal(savedProfiles.GuildSyncChat, 'NA Megaserver', 'saved vars are stored per world')
equal(type(data.messages), 'table', 'messages table is created from the defaults')
equal(data.debugChat, false, 'debug logging defaults to off')
assert(SLASH_COMMANDS['/gsc'], 'the /gsc command is registered')
equal(#data.messages, 0, 'nothing is captured before activation')
fire(EVENT_CHAT_MESSAGE_CHANNEL, CHAT_CHANNEL_GUILD_3, '@Early', 'Before activation', false, '@Early')
equal(#data.messages, 0, 'chat before the guild slot is resolved is ignored')
fire(EVENT_PLAYER_ACTIVATED)
fire(EVENT_CHAT_MESSAGE_CHANNEL, CHAT_CHANNEL_GUILD_1, '@OtherMember', 'Wrong guild', false, '@OtherMember')
equal(#data.messages, 0, 'chat from another guild is ignored')
fire(EVENT_CHAT_MESSAGE_CHANNEL, CHAT_CHANNEL_GUILD_3, '@Member', 'Hello guild', false, '@Member')
equal(#data.messages, 1, 'target guild chat is captured')
local record = data.messages[1]
equal(record.guild, 'alphabet_mafia', 'guild identity is normalized, never a slot or channel number')
equal(record.sender, '@Member', 'sender is the canonical account name')
equal(record.timestamp, 1700000000, 'timestamp is the server epoch')
equal(record.text, 'Hello guild', 'raw message text is kept')
fire(EVENT_CHAT_MESSAGE_CHANNEL, CHAT_CHANNEL_GUILD_3, '@Legacy', 'No display name', false, nil)
equal(data.messages[2].sender, '@Legacy', 'sender falls back to the raw name')
equal(#data.messages, 2, 'each message is appended')
messages = {}
SLASH_COMMANDS['/gsc']('status')
local status = table.concat(messages, '\n')
assert(status:find('Alphabet Mafia guild chat from guild slot 3', 1, true), 'status names the resolved guild and slot')
assert(status:find('2 messages saved on NA Megaserver', 1, true), 'status reports the saved count and world')
SLASH_COMMANDS['/gsc']('debug on')
equal(data.debugChat, true, 'debug logging persists in SavedVariables')
messages = {}
fire(EVENT_CHAT_MESSAGE_CHANNEL, CHAT_CHANNEL_GUILD_3, '@Member', 'Debug line', false, '@Member')
assert(messages[#messages] and messages[#messages]:find('Debug line', 1, true), 'debug logging prints captured messages')
SLASH_COMMANDS['/gsc']('debug off')
equal(data.debugChat, false, 'debug logging can be turned off')
-- The guild can sit in a different slot for the next login, so the channel is
-- re-resolved from the guild name instead of remembered.
slots = {[1] = 101, [5] = 404}
names[404] = 'Alphabet Mafia'
names[303] = 'Former Guild'
fire(EVENT_GUILD_SELF_JOINED_GUILD, 'Alphabet Mafia')
fire(EVENT_CHAT_MESSAGE_CHANNEL, CHAT_CHANNEL_GUILD_3, '@Old', 'Old slot message', false, '@Old')
equal(#data.messages, 3, 'a slot the guild left is not captured')
fire(EVENT_CHAT_MESSAGE_CHANNEL, CHAT_CHANNEL_GUILD_5, '@New', 'New slot message', false, '@New')
equal(#data.messages, 4, 'the moved guild is captured on its new slot')
equal(data.messages[4].text, 'New slot message', 'moved guild message is stored')
-- Leaving is re-checked after the slot settles.
slots = {[1] = 101}
names[404] = 'Former Guild'
fire(EVENT_GUILD_SELF_LEFT_GUILD, 'Alphabet Mafia')
tick(3000)
fire(EVENT_CHAT_MESSAGE_CHANNEL, CHAT_CHANNEL_GUILD_5, '@Old', 'After leaving', false, '@Old')
equal(#data.messages, 4, 'capture stops once the guild slot is gone')
messages = {}
SLASH_COMMANDS['/gsc']('status')
assert(table.concat(messages, '\n'):find('Guild not found: Alphabet Mafia', 1, true), 'status reports a missing target guild')
print('GuildSyncChat: slot resolution, guild filtering, SavedVariables and /gsc passed')

-- The log is capped while capturing, so it never holds more than the limit.
local oversized = {messages = {}, debugChat = false}
for index = 1, 1005 do
  oversized.messages[index] = {guild = 'alphabet_mafia', sender = '@Member', timestamp = index, text = 'old ' .. index}
end
saved.GuildSyncChat = oversized
dofile('ESO/GuildSyncChat/GuildSyncChat.lua')
fire(EVENT_ADD_ON_LOADED, 'GuildSyncChat')
equal(#saved.GuildSyncChat.messages, 1005, 'login leaves an existing saved log untouched')
slots = {[1] = 101, [3] = 303}
names[303] = 'Alphabet Mafia'
fire(EVENT_PLAYER_ACTIVATED)
fire(EVENT_CHAT_MESSAGE_CHANNEL, CHAT_CHANNEL_GUILD_3, '@Member', 'new 1', false, '@Member')
equal(#saved.GuildSyncChat.messages, 1000, 'the next captured message trims the log to the limit')
equal(saved.GuildSyncChat.messages[1].text, 'old 7', 'the oldest messages are removed first')
equal(saved.GuildSyncChat.messages[1000].text, 'new 1', 'the newest message is kept')
for index = 2, 6 do fire(EVENT_CHAT_MESSAGE_CHANNEL, CHAT_CHANNEL_GUILD_3, '@Member', 'new ' .. index, false, '@Member') end
equal(#saved.GuildSyncChat.messages, 1000, 'capture never stores more than 1000 messages')
equal(saved.GuildSyncChat.messages[1000].text, 'new 6', 'the newest message stays at the end')
equal(saved.GuildSyncChat.messages[1].text, 'old 12', 'each new message pushes one more old message out')
print('GuildSyncChat: the saved log never holds more than 1000 messages')
