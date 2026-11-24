local function eq(actual,expected,label) assert(actual==expected,(label or '')..': expected '..tostring(expected)..', got '..tostring(actual)) end
local handlers,timers,sent,messages={},{},{},{}
EVENT_ADD_ON_LOADED=1; EVENT_PLAYER_ACTIVATED=2; EVENT_MAIL_OPEN_MAILBOX=3
EVENT_MAIL_CLOSE_MAILBOX=4; EVENT_MAIL_SEND_SUCCESS=5; EVENT_MAIL_SEND_FAILED=6
EVENT_MANAGER={RegisterForEvent=function(_,name,event,fn) handlers[name..event]=fn end,
UnregisterForEvent=function(_,name,event) handlers[name..event]=nil end}
function fire(event,...) local snapshot={} for key,fn in pairs(handlers) do snapshot[key]=fn end for key,fn in pairs(snapshot) do if key:sub(-1)==tostring(event) then fn(event,...) end end end
zo_callLater=function(fn,delay) timers[#timers+1]={fn=fn,delay=delay} end
local function tick(delay) local old=timers;timers={} for _,timer in ipairs(old) do if timer.delay==delay then timer.fn() else timers[#timers+1]=timer end end end
CHAT_ROUTER={AddSystemMessage=function(_,message) messages[#messages+1]=message end}
SLASH_COMMANDS={}
GetDisplayName=function() return '@Officer' end
GetWorldName=function() return 'NA Megaserver' end
GetTimeStamp=function() return 1795521600 end
GetDateStringFromTimestamp=function() return 'unused' end
GetNumGuilds=function() return 1 end
GetGuildId=function() return 123 end
GetGuildName=function(id) return id==123 and 'Live Guild' or nil end
GetGuildMemberIndexFromDisplayName=function(_,name) if name=='@Member' or name=='@Other' then return 1 end end
RequestOpenMailbox=function() fire(EVENT_MAIL_OPEN_MAILBOX) end
CloseMailbox=function() end
local cleared=0
ClearQueuedMail=function() cleared=cleared+1 end
-- A stale draft (items, gold, COD) must never pause the queue.
GetQueuedMoneyAttachment=function() return 250 end
GetQueuedCOD=function() return 0 end
MAIL_MAX_ATTACHED_ITEMS=6
GetMailQueuedAttachmentLink=function() return '|H1:item:1:1:1:1:1:1:1:1:1:0:0:0:0:0|h|h' end
SendMail=function(recipient,subject,body) sent[#sent+1]={recipient=recipient,subject=subject,body=body} end
ZO_PostHook=function(name,hook) local original=_G[name];_G[name]=function(...) original(...);hook(...) end end
local saved={settings={},mailQueue={},mailAck={},sentMailIds={}}
-- A stored body still holding the old default must be replaced by the new wording.
saved.settings.body='Hello {account},\n\nWe are updating the Discord links for {guild}. Your ESO guild rank is {rank}. Please reply with your Discord username so we can match your accounts.\n{candidate}\nIf you do not use Discord and do not plan to, please let us know so we can stop these reminders. Thank you!'
ZO_SavedVars={NewAccountWide=function(_,_,_,_,defaults) for key,value in pairs(defaults) do if saved[key]==nil then saved[key]=value end end return saved end}
local function record(id,name) return {requestId=id,batchId='batch',recipient=name or '@Member',rank='Associate',guildId='123',guildName='Guild',sendingAccount='@Officer',worldName='NA Megaserver'} end
saved.mailQueue.a=record('a');saved.mailQueue.a.candidateDiscordName='possible%name'
saved.mailQueue.b=record('b','@Other')
dofile('ESO/GuildSyncDiscordReminder/GuildSyncDiscordReminder.lua')
fire(EVENT_ADD_ON_LOADED,'GuildSyncDiscordReminder')
assert(saved.settings.body:find('Alphabet Mafia has a new system',1,true),'old default body replaced with the new wording')
eq(#sent,0,'does not send before activation')
GuildSyncMailQueueOwner='GuildSyncBanking'
fire(EVENT_PLAYER_ACTIVATED)
tick(3000)
eq(#sent,0,'Banking owns the shared lock')
GuildSyncMailQueueOwner=nil
tick(3000);tick(2000)
eq(#sent,1,'automatic first send')
assert(sent[1].body:find('possible%%name'),'candidate placeholder preserved')
eq(saved.sentMailIds.a,nil,'request is not a confirmation')
fire(EVENT_MAIL_SEND_SUCCESS,'@SomeoneElse')
eq(saved.sentMailIds.a,nil,'another recipient success ignored')
fire(EVENT_MAIL_SEND_SUCCESS)
eq(saved.sentMailIds.a,nil,'unidentified success ignored')
fire(EVENT_MAIL_SEND_SUCCESS,'@Member')
eq(saved.sentMailIds.a,1795521600,'confirmed sent')
eq(saved.mailQueue.a,nil,'confirmed removed from queue')
eq(saved.mailAck.a.status,'sent')
eq(#sent,1,'paced')
tick(3000)
eq(#sent,2,'second send')
fire(EVENT_MAIL_SEND_FAILED,16)
eq(saved.mailAck.b.status,'failed')
assert(saved.mailQueue.b,'failure retained')
tick(3000);eq(#sent,2,'failure stops queue')
SLASH_COMMANDS['/gsdr']('resume');tick(3000);tick(2000)
eq(#sent,3,'explicit resume retries failed mail')
tick(15000)
eq(saved.mailAck.b.status,'uncertain','timeout is uncertain')
SLASH_COMMANDS['/gsdr']('resume');tick(3000);tick(2000)
eq(#sent,3,'uncertain is never automatically retried')
saved.mailQueue.c=record('c');saved.mailQueue.c.worldName='EU Megaserver'
saved.mailQueue.d=record('d');saved.sentMailIds.d=true
SLASH_COMMANDS['/gsdr']('resume');tick(3000);tick(2000)
eq(#sent,3,'wrong world and duplicate not sent')
SLASH_COMMANDS['/gsdr']('subject Custom {rank}')
saved.mailQueue.e=record('e');SLASH_COMMANDS['/gsdr']('resume');tick(3000);tick(2000)
eq(sent[#sent].subject,'Custom Associate','subject configurable')
fire(EVENT_MAIL_SEND_SUCCESS,'@Member')
saved.settings.body='Guild {guild}: hello {account}'
saved.mailQueue.f=record('f');saved.mailQueue.f.guildName='Your guild'
tick(3000)
assert(sent[#sent].body:find('Live Guild'),'placeholder guild name replaced with the live one')
fire(EVENT_MAIL_CLOSE_MAILBOX)
local closed=false
for _,message in ipairs(messages) do if tostring(message):find('Mailbox closed') then closed=true end end
assert(not closed,'a mailbox close event never stops the queue')
assert(cleared>=3,'the draft is cleared before each send')
for _,message in ipairs(messages) do assert(not tostring(message):find('Mail has attachments'),'a stale draft never pauses the queue') end
fire(EVENT_MAIL_SEND_SUCCESS,'@Member')
local before=#sent
saved.mailQueue.g=record('g','@Other');saved.mailQueue.h=record('h')
tick(3000);tick(2000)
eq(#sent,before+1,'record with a bad name is attempted')
fire(EVENT_MAIL_SEND_FAILED,2)
eq(saved.mailAck.g.status,'failed','an invalid name marks the request failed')
assert(saved.mailAck.g.detail:find('recipient name is invalid'),'rejection reason is named')
assert(saved.mailAck.g.detail:find('@Other'),'rejected recipient is named')
assert(saved.mailQueue.g,'failed request stays queued for review')
tick(3000)
eq(sent[#sent].recipient,'@Member','queue continues after one invalid recipient')
eq(#sent,before+2,'the skipped request is not sent twice in one run')
fire(EVENT_MAIL_SEND_SUCCESS,'@Member')
tick(3000)
eq(#sent,before+2,'a completed queue does not resend the skipped request')
local complete=false
for _,message in ipairs(messages) do if tostring(message):find('Queue complete') then complete=true end end
assert(complete,'queue completes after skipping an invalid recipient')
SLASH_COMMANDS['/gsdr']('resume');tick(3000);tick(2000)
eq(sent[#sent].recipient,'@Other','resume retries the failed recipient')
fire(EVENT_MAIL_SEND_SUCCESS,'@Other')
local sendingLine,processedLine,prefixed=false,false,false
for _,message in ipairs(messages) do
    local text=tostring(message)
    if text:find('Sending reminder mail',1,true) then sendingLine=true end
    if text:find('Processed reminder mail',1,true) then processedLine=true end
    if text:find('[GSDiscord]',1,true) then prefixed=true end
end
assert(sendingLine,'banking-style sending line is printed')
assert(processedLine,'banking-style processed line is printed')
assert(prefixed,'messages use the bracketed add-on prefix')
print('GuildSyncDiscordReminder queue tests passed')
