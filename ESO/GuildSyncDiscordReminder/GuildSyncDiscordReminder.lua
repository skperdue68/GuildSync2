GuildSyncDiscordReminder = GuildSyncDiscordReminder or {}
local NAME = "GuildSyncDiscordReminder"
local MAILBOX_OPEN_DELAY_MS = 2000
local defaults = {
    settings = {
        enabled = true,
        subject = "{guild}: your Discord account",
        body = "Hello {account},\n\nWe are updating the Discord links for {guild}. Your ESO guild rank is {rank}. Please reply with your Discord username so we can match your accounts.\n{candidate}\nIf you do not use Discord and do not plan to, please let us know so we can stop these reminders. Thank you!",
        candidate = "\nWe found a possible match: {candidateName}. Is that your Discord account?\n",
    },
    mailQueue = {}, mailAck = {}, sentMailIds = {},
}
local sv, active, current, mailboxReady, opening, paused = nil, false, nil, false, false, false
local generation = 0
local sendingNow, ownedSend = false, nil
local start, nextMail
local function say(text) CHAT_ROUTER:AddSystemMessage("GuildSyncDiscordReminder: " .. text) end
local function key(value) return string.lower(tostring(value or "")):gsub("^@+", "") end
local function fill(template, values)
    return (tostring(template or ""):gsub("{([%w]+)}", function(token) return tostring(values[token] or "") end))
end
local function message(item)
    local values = {account = item.recipient, guild = item.guildName, rank = item.rank, candidateName = item.candidateDiscordName}
    values.candidate = item.candidateDiscordName and item.candidateDiscordName ~= "" and fill(sv.settings.candidate, values) or ""
    return fill(sv.settings.subject, values), fill(sv.settings.body, values)
end
local function acknowledgement(item, status, detail)
    local ack = {requestId = item.requestId, batchId = item.batchId, guildId = item.guildId,
        sendingAccount = item.sendingAccount, worldName = item.worldName, status = status, detail = tostring(detail or "")}
    if status == "sent" then ack.sentAt = GetTimeStamp() end
    sv.mailAck[item.requestId] = ack
end
local function stop(reason)
    active, opening = false, false
    generation = generation + 1
    if GuildSyncMailQueueOwner == NAME then
        GuildSyncMailQueueOwner = nil
        CloseMailbox()
    end
    mailboxReady = false
    if reason then say(reason) end
end
local function fail(status, detail)
    if current then acknowledgement(current, status, detail); current = nil end
    ownedSend = nil
    if GuildSyncMailSendInFlight and GuildSyncMailSendInFlight.owner == NAME then GuildSyncMailSendInFlight = nil end
    paused = true
    stop(detail .. " Queue paused. Use /gsdr status; /gsdr resume retries failed requests, but never uncertain ones.")
end
-- Observe every SendMail call, including manual mail and other add-ons. The
-- cooperative batch lock alone cannot identify those shared result events.
-- ZO_PostHook's string form hooks the named global on _G.
ZO_PostHook("SendMail", function(recipient)
    GuildSyncMailSendInFlight = {recipient = recipient, owner = sendingNow and NAME or (GuildSyncMailQueueOwner ~= NAME and GuildSyncMailQueueOwner or "external")}
    if sendingNow and current then ownedSend = current.requestId
    elseif current then ownedSend = nil; fail("uncertain", "Another mail send interrupted the reminder.") end
end)
EVENT_MANAGER:RegisterForEvent(NAME .. "MailMonitor", EVENT_MAIL_SEND_SUCCESS, function() GuildSyncMailSendInFlight = nil end)
EVENT_MANAGER:RegisterForEvent(NAME .. "MailMonitor", EVENT_MAIL_SEND_FAILED, function() GuildSyncMailSendInFlight = nil end)
local function inGuild(item)
    for index = 1, GetNumGuilds() do
        local guild = GetGuildId(index)
        if tostring(guild) == tostring(item.guildId) then
            local memberIndex = GetGuildMemberIndexFromDisplayName(guild, item.recipient)
            return type(memberIndex) == "number" and memberIndex > 0
        end
    end
    return false
end
local function nextEligible()
    local ids = {}
    for id in pairs(sv.mailQueue) do ids[#ids + 1] = id end
    table.sort(ids)
    for _, id in ipairs(ids) do
        local queued = sv.mailQueue[id]
        if type(queued) == "table" then
            if sv.sentMailIds[id] then
                sv.mailQueue[id] = nil
            elseif queued.worldName == GetWorldName() and key(queued.sendingAccount) == key(GetDisplayName()) then
                local ack = sv.mailAck[id]
                if not ack or ack.status ~= "uncertain" then return queued end
            end
        end
    end
end
nextMail = function()
    if not active or current then return end
    if paused or not sv.settings.enabled then stop("Sending paused."); return end
    if GuildSyncMailSendInFlight then
        local token = generation
        zo_callLater(function() if token == generation then nextMail() end end, 3000)
        return
    end
    local item = nextEligible()
    if not item then stop("Queue complete. Exit ESO or /reloadui to save delivery results for GuildSync."); return end
    if not item.requestId or not item.batchId or not item.recipient or item.recipient:sub(1, 1) ~= "@" or (not item.isTest and not inGuild(item)) then
        current = item; fail("failed", "Recipient is invalid or is no longer in the specified guild."); return
    end
    local subject, body = message(item)
    if item.isTest then subject = "[TEST] " .. subject end
    local length = zo_strlen or string.len
    if subject == "" or body == "" or length(subject) > (MAIL_MAX_SUBJECT_CHARACTERS or 100) or length(body) > (MAIL_MAX_BODY_CHARACTERS or 700) then
        current = item; fail("failed", "Message is empty or exceeds ESO's subject/body limit. Edit the template."); return
    end
    local leftover = GetQueuedMoneyAttachment() > 0 or GetQueuedCOD() > 0
    for slot = 1, MAIL_MAX_ATTACHED_ITEMS or 6 do
        if GetMailQueuedAttachmentLink(slot) ~= nil then leftover = true; break end
    end
    current = item
    -- Persist an uncertain marker before requesting the send. A reload while a
    -- response is in flight must not silently send this request a second time.
    acknowledgement(item, "uncertain", "Awaiting ESO mail confirmation.")
    -- A reminder never carries items, gold, or COD. ClearQueuedMail resets the
    -- whole compose draft, so a stale draft is cleared instead of pausing the
    -- queue; SendMail only takes recipient, subject and body, and a real
    -- rejection still arrives as EVENT_MAIL_SEND_FAILED.
    ClearQueuedMail()
    if leftover then say("Cleared a stale mail draft before sending.") end
    local token = generation
    sendingNow = true
    SendMail(item.recipient, subject, body)
    sendingNow = false
    zo_callLater(function()
        if active and current == item and token == generation then fail("uncertain", "ESO did not confirm delivery within 15 seconds.") end
    end, 15000)
end
start = function()
    if not sv or active or paused or not sv.settings.enabled or not next(sv.mailQueue) then return end
    if GuildSyncMailSendInFlight or (GuildSyncMailQueueOwner and GuildSyncMailQueueOwner ~= NAME) then zo_callLater(start, 3000); return end
    GuildSyncMailQueueOwner = NAME
    active, opening = true, true
    generation = generation + 1
    local token = generation
    RequestOpenMailbox()
    -- GuildSyncBanking opens the mailbox and sends on a timer instead of reacting to
    -- EVENT_MAIL_OPEN_MAILBOX, which ESO can deliver late or followed by an immediate
    -- close during login. Do the same so a spurious close cannot stop the queue.
    zo_callLater(function()
        if active and opening and token == generation then
            opening = false
            mailboxReady = true
            nextMail()
        end
    end, MAILBOX_OPEN_DELAY_MS)
end
local function status()
    local queued, sent, uncertain = 0, 0, 0
    for _ in pairs(sv.mailQueue) do queued = queued + 1 end
    for _ in pairs(sv.sentMailIds) do sent = sent + 1 end
    for _, ack in pairs(sv.mailAck) do if ack.status == "uncertain" then uncertain = uncertain + 1 end end
    say(tostring(queued) .. " queued, " .. tostring(sent) .. " confirmed sent, " .. tostring(uncertain) .. " uncertain.")
    for id, ack in pairs(sv.mailAck) do if ack.status == "uncertain" or ack.status == "failed" then say(tostring(id) .. ": " .. ack.status .. " — " .. tostring(ack.detail)) end end
end
local function command(text)
    local verb, value = tostring(text or ""):match("^(%S*)%s*(.*)$")
    verb = string.lower(verb)
    if verb == "pause" then
        paused = true
        if current then say("Pausing after ESO responds to the current mail.") else stop("Paused.") end
    elseif verb == "resume" then paused = false; start()
    elseif verb == "retry" then
        if current then say("Wait for the current send to finish."); return end
        local ack = sv.mailAck[value]
        if not ack or ack.status ~= "uncertain" or not sv.mailQueue[value] then say("Provide an uncertain request ID from /gsdr status."); return end
        ack.status = "failed"; ack.detail = "Officer explicitly requested a retry after reviewing delivery."
        paused = false; start()
    elseif verb == "subject" or verb == "body" or verb == "candidate" then
        if value == "" then say("Provide the template text. Use \\n for a new line.")
        else sv.settings[verb] = value:gsub("\\n", "\n"); say(verb .. " template updated.") end
    elseif verb == "preview" then
        for _, item in pairs(sv.mailQueue) do
            if type(item) == "table" and item.worldName == GetWorldName() then local subject, body = message(item); say(subject .. "\n" .. body); return end
        end
        say("No queued messages to preview.")
    else
        status()
        say("/gsdr preview | pause | resume | subject <text> | body <text> | candidate <text>. Edit templates in Settings > Addons when LibAddonMenu is installed.")
    end
end
local function settingsPanel()
    local lam = LibAddonMenu2
    if not lam then return end
    lam:RegisterAddonPanel(NAME .. "Settings", {type = "panel", name = NAME, displayName = NAME, author = "@evainefaye", version = "1.0.2", registerForRefresh = true})
    local options = {{type = "checkbox", name = "Automatically send queued reminders", getFunc = function() return sv.settings.enabled end,
        setFunc = function(value) sv.settings.enabled = value; if value then start() end end}}
    for _, entry in ipairs({{"subject", "Subject"}, {"body", "Message body"}, {"candidate", "Optional candidate paragraph"}}) do
        local setting, label = entry[1], entry[2]
        options[#options + 1] = {type = "editbox", name = label, isMultiline = setting ~= "subject", width = "full",
            tooltip = "Placeholders: {account}, {guild}, {rank}, {candidate}, {candidateName}.",
            getFunc = function() return sv.settings[setting] end, setFunc = function(value) sv.settings[setting] = value end}
    end
    lam:RegisterOptionControls(NAME .. "Settings", options)
end
EVENT_MANAGER:RegisterForEvent(NAME, EVENT_ADD_ON_LOADED, function(_, addon)
    if addon ~= NAME then return end
    EVENT_MANAGER:UnregisterForEvent(NAME, EVENT_ADD_ON_LOADED)
    sv = ZO_SavedVars:NewAccountWide(NAME, 1, nil, defaults)
    for setting, value in pairs(defaults.settings) do if sv.settings[setting] == nil then sv.settings[setting] = value end end
    SLASH_COMMANDS["/gsdr"] = command
    settingsPanel()
    EVENT_MANAGER:RegisterForEvent(NAME, EVENT_PLAYER_ACTIVATED, function()
        EVENT_MANAGER:UnregisterForEvent(NAME, EVENT_PLAYER_ACTIVATED)
        zo_callLater(start, 3000)
    end)
    EVENT_MANAGER:RegisterForEvent(NAME, EVENT_MAIL_SEND_SUCCESS, function(_, playerName)
        if not active or not current or GuildSyncMailQueueOwner ~= NAME then return end
        if ownedSend ~= current.requestId or not playerName or playerName == "" or key(playerName) ~= key(current.recipient) then return end
        local item = current
        acknowledgement(item, "sent")
        sv.sentMailIds[item.requestId] = GetTimeStamp()
        sv.mailQueue[item.requestId] = nil
        current = nil
        ownedSend = nil
        say("Mail confirmed sent to " .. item.recipient)
        local token = generation
        zo_callLater(function() if token == generation then nextMail() end end, 3000)
    end)
    EVENT_MANAGER:RegisterForEvent(NAME, EVENT_MAIL_SEND_FAILED, function(_, reason)
        if active and current and GuildSyncMailQueueOwner == NAME then fail("failed", "ESO rejected mail (reason " .. tostring(reason) .. ").") end
    end)
    say("Loaded. Queued reminders will send automatically after login. /gsdr for controls.")
end)
