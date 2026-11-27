import test from 'node:test';
import assert from 'node:assert/strict';
import {membershipDMMessage,membershipReplyMessage,membershipDeliveryFailureMessage,membershipDeliveryExplain,createMembershipDMWorker,formatMembershipStatus,CARD_WIDTH_PAD} from './membership-dms.js';
import {createMemoryDMIntake,membershipIntakeKey} from './membership-dm-intake.js';
// Every card carries an invisible width pad in its author line, so assertions read
// the visible text while the width test inspects the raw payload.
const unpadded=value=>String(value??'').replace(/\u2800+$/,'');
const cardOf=payload=>{const raw=payload.embeds[0].toJSON();
 const embed={...raw,author:{...raw.author,name:unpadded(raw.author?.name)}};
 return {embed,fields:Object.fromEntries(embed.fields.map(field=>[field.name,field.value]))};};

const job={id:'12345678-1234-1234-1234-123456789abc',userId:'10',name:'Member',token:'claim'};
const config={template:'Hello {name}, please tell {guild} your ESO name.',destinationType:'channel',destinationId:'99'};
test('DM presents five persistent buttons, protects mentions, and labels test messages',()=>{
 const message=membershipDMMessage(job,config,{name:'@everyone',guildName:'Alphabet Mafia'});
 const buttons=message.components[0].toJSON().components;
 assert.equal(buttons.length,5);
 assert.deepEqual(buttons.map(button=>button.label),["I'm in Alphabet Mafia — link my ESO login","I still play ESO, but I'm not in Alphabet Mafia",'I no longer play ESO — keep me on Discord','Request removal','Other response']);
 assert.deepEqual(buttons.map(button=>button.custom_id.split(':').at(-1)),['eso','community','not_playing','remove','other']);
 assert.match(message.content,/forwarded to guild officers/);assert.deepEqual(message.allowedMentions.parse,[]);
 assert.equal(message.enforceNonce,true);assert.ok(message.nonce.length<=25);
 assert.match(membershipDMMessage({...job,isTest:true},config,{name:'A',guildName:'Guild'}).content,/\[TEST\]/);
});
test('the forwarding notice is never repeated and a suggested match is optional',()=>{
 const withNotice=membershipDMMessage(job,{...config,template:'Hi {name}. Your responses will be forwarded to guild officers.'},{name:'A',guildName:'Guild'});
 assert.equal((withNotice.content.match(/forwarded to guild officers/g)||[]).length,1);
 const template={...config,template:'Hi {name}.{suggested_link}'};
 const suggested=membershipDMMessage({...job,suggestedEsoAccountName:'@Alice'},template,{name:'A',guildName:'Guild'});
 assert.match(suggested.content,/We think your ESO account may be @Alice\./);
 const none=membershipDMMessage({...job,suggestedEsoAccountName:''},template,{name:'A',guildName:'Guild'});
 assert.doesNotMatch(none.content,/We think your ESO account/);
 assert.doesNotMatch(none.content,/\{suggested_link\}/);
});
function fixture(request) {
 const sends=[],forwards=[],roles=[],kicks=[],nicknames=[];
 const member={user:{bot:false},displayName:'Member',send:async payload=>{sends.push(payload);return {id:'100'};},
  kick:async reason=>{kicks.push(reason);},setNickname:async(name,reason)=>{nicknames.push([name,reason]);},
  roles:{add:async id=>roles.push(['add',id]),remove:async id=>roles.push(['remove',id])}};
 const cache=new Map([['10',member]]);
 const intake=createMemoryDMIntake();
 const guild={id:'1',name:'Guild',members:{cache,fetch:async()=>member}};
 const client={user:{id:'bot'},isReady:()=>true,guilds:{fetch:async()=>guild},channels:{fetch:async()=>({guildId:'1',send:async payload=>{forwards.push(payload);return {id:'200'};}})}};
 return {worker:createMembershipDMWorker({client,guildId:'1',request,log:()=>{},intake}),sends,forwards,roles,member,kicks,nicknames,cache,intake};
}
test('worker revalidates immediately before send and saves the confirmed message ID',async()=>{
 const calls=[];let claimed=false;
 const {worker,sends}=fixture(async(action,payload)=>{
  calls.push([action,payload]);
  if(action==='claim'){if(claimed)return {job:null};claimed=true;return {job,config};}
  if(action==='validate')return {valid:true};
  return {};
 });
 await worker.sendNext();assert.equal(sends.length,1);
 assert.deepEqual(calls.map(([action])=>action),['claim','validate','finish']);
 assert.equal(calls[2][1].result.status,'sent');assert.equal(calls[2][1].result.messageId,'100');
});
test('ineligible recipients skip without a paced wait; failed DMs are recorded once',async()=>{
 const outcomes=[];let claims=0;
 const {worker,member}=fixture(async(action,payload)=>{
  if(action==='claim')return ++claims<=2?{job:{...job,id:String(claims)},config}:{job:null};
  if(action==='validate')return {valid:claims!==1};
  if(action==='finish')outcomes.push(payload.result.status);
  return {};
 });
 member.send=async()=>{throw Object.assign(Error('Closed DMs'),{code:50007});};
 await worker.sendNext();assert.deepEqual(outcomes,['skipped','failed']);
});
test('buttons open forms, and submitted responses are routed to the backend with recipient identity',async()=>{
 const calls=[];let modal;
 const {worker}=fixture(async(action,payload)=>{calls.push([action,payload]);return {message:'Linked'};});
 await worker.interaction({customId:`gs-membership:${job.id}:eso`,isButton:()=>true,isModalSubmit:()=>false,inGuild:()=>false,showModal:async value=>{modal=value;}});
 assert.equal(modal.toJSON().components[0].components[0].max_length,64);
 let prompt;
 await worker.interaction({customId:`gs-membership:${job.id}:eso`,isButton:()=>false,isModalSubmit:()=>true,inGuild:()=>false,user:{id:'10'},id:'123',fields:{getTextInputValue:()=>'@ESO'},reply:async value=>{prompt=value;}});
 assert.deepEqual(calls,[],'nothing is saved before the nickname choice');
 assert.deepEqual(prompt.components[0].toJSON().components.map(button=>button.custom_id),[
  `gs-membership-rename:${job.id}:eso:ESO`,`gs-membership-keepname:${job.id}:eso:ESO`]);
 let reply;
 await worker.interaction({customId:`gs-membership-keepname:${job.id}:eso:ESO`,isButton:()=>true,isModalSubmit:()=>false,inGuild:()=>false,user:{id:'10'},id:'124',deferReply:async()=>{},editReply:async value=>{reply=value;}});
 assert.equal(calls[0][1].userId,'10');assert.equal(calls[0][1].text,'ESO');assert.equal(calls[0][1].nicknameConsent,false);
 assert.match(reply,/Linked/);assert.match(reply,/left unchanged/);
});
test('declining the nickname change still saves the ESO answer and skips the rename',async()=>{
 const calls=[];let reply;
 const {worker,nicknames}=fixture(async(action,payload)=>{calls.push([action,payload]);
  return action==='response'?{status:'linked',message:'Linked.',nickname:{status:'declined',reason:'The member chose to keep their current server nickname.'}}:{ok:true};});
 await worker.interaction({customId:`gs-membership-keepname:${job.id}:eso:ESOName`,isButton:()=>true,isModalSubmit:()=>false,inGuild:()=>false,
  user:{id:'10'},id:'1004',deferReply:async()=>{},editReply:async value=>{reply=value;}});
 assert.deepEqual(nicknames,[]);
 assert.equal(calls[0][1].nicknameConsent,false);
 assert.equal(calls.filter(([action])=>action==='outcome').length,0,'there is no Discord action to report');
 assert.match(reply,/left unchanged/);
});
test('a Discord outcome survives a dropped backend and is replayed before the card',async()=>{
 let offline=true;const replayed=[];
 const {worker,member,intake,kicks}=fixture(async(action,payload)=>{
  if(action==='response')return {status:'removal requested',message:'Sent to the officers.'};
  if(action==='outcome'){
   if(offline)throw Object.assign(Error('Backend disconnected'),{code:'ECONNREFUSED'});
   replayed.push(payload);return {ok:true};
  }
  return {ok:true};
 });
 await worker.interaction({customId:`gs-membership-confirm:${job.id}:remove`,isButton:()=>true,isModalSubmit:()=>false,inGuild:()=>false,
  user:{id:'10'},id:'1005',deferReply:async()=>{},editReply:async()=>{}});
 assert.deepEqual(kicks,['User Request']);
 const pending=await intake.list();
 assert.equal(pending.length,1);
 assert.equal(pending[0].kind,'outcome');
 assert.deepEqual(pending[0].payload.removal,{status:'kicked'});
 offline=false;
 await worker.retryIntake();
 assert.equal(replayed.length,1);
 assert.deepEqual(replayed[0],{eventId:'1005',removal:{status:'kicked'}});
 assert.deepEqual(await intake.list(),[]);
});
test('a removal request asks for confirmation before anything is recorded or kicked',async()=>{
 const calls=[];let reply;
 const {worker,kicks}=fixture(async(action)=>{calls.push(action);return {};});
 await worker.interaction({customId:`gs-membership:${job.id}:remove`,isButton:()=>true,isModalSubmit:()=>false,inGuild:()=>false,
  reply:async value=>{reply=value;}});
 assert.deepEqual(calls,[],'nothing reaches the backend before the member confirms');
 assert.deepEqual(kicks,[],'nobody is kicked before the member confirms');
 assert.match(reply.content,/cannot be undone/);
 assert.deepEqual(reply.components[0].toJSON().components.map(button=>[button.custom_id,button.label,button.style]),[
  [`gs-membership-confirm:${job.id}:remove`,'Yes, remove me',4],
  [`gs-membership-cancel:${job.id}:remove`,'Keep me on the server',2]]);
});
test('declining the confirmation keeps the member and tells the officers',async()=>{
 const calls=[];let reply;
 const {worker,kicks}=fixture(async(action,payload)=>{calls.push([action,payload]);return {};});
 await worker.interaction({customId:`gs-membership-cancel:${job.id}:remove`,isButton:()=>true,isModalSubmit:()=>false,inGuild:()=>false,
  user:{id:'10'},id:'1007',deferReply:async()=>{},editReply:async value=>{reply=value;}});
 assert.deepEqual(kicks,[]);
 assert.deepEqual(calls.map(([action])=>action),['removal-declined']);
 assert.deepEqual([calls[0][1].deliveryId,calls[0][1].userId,calls[0][1].eventId],[job.id,'10','1007']);
 assert.match(reply,/still on the server/);assert.match(reply,/asked to be removed/);
});
test('a declined removal is queued when the backend is unreachable and replayed later',async()=>{
 let offline=true;const replayed=[];
 const {worker,intake,kicks}=fixture(async(action,payload)=>{
  if(action==='removal-declined'){
   if(offline)throw Object.assign(Error('Backend disconnected'),{code:'ECONNREFUSED'});
   replayed.push(payload);return {};
  }
  return {};
 });
 let reply;
 await worker.interaction({customId:`gs-membership-cancel:${job.id}:remove`,isButton:()=>true,isModalSubmit:()=>false,inGuild:()=>false,
  user:{id:'10'},id:'1008',deferReply:async()=>{},editReply:async value=>{reply=value;}});
 assert.deepEqual(kicks,[]);
 assert.match(reply,/saved for retry/);
 const pending=await intake.list();
 assert.equal(pending[0].kind,'removal-declined');assert.equal(pending[0].payload.eventId,'1008');
 offline=false;
 await worker.retryIntake();
 assert.deepEqual(replayed,[{deliveryId:job.id,userId:'10',eventId:'1008'}]);
 assert.deepEqual(await intake.list(),[]);
});
test('a confirmed removal still kicks with User Request while the backend is down',async()=>{
 const {worker,kicks,intake}=fixture(async()=>{throw Object.assign(Error('Backend disconnected'),{code:'ECONNREFUSED'});});
 let reply;
 await worker.interaction({customId:`gs-membership-confirm:${job.id}:remove`,isButton:()=>true,isModalSubmit:()=>false,inGuild:()=>false,
  user:{id:'10'},id:'1006',deferReply:async()=>{},editReply:async value=>{reply=value;}});
 assert.deepEqual(kicks,['User Request'],'the confirmation is enough to kick');
 const pending=(await intake.list()).map(membershipIntakeKey).sort();
 assert.deepEqual(pending,['1006','1006-outcome']);
 const outcome=(await intake.list()).find(event=>event.kind==='outcome');
 assert.deepEqual(outcome.payload,{eventId:'1006',removal:{status:'kicked'}});
 assert.match(reply,/removed from the server at your request/);
});
test('a test delivery never kicks even when the backend cannot confirm it is a test',async()=>{
 const {worker,kicks,intake}=fixture(async()=>{throw Object.assign(Error('Backend disconnected'),{code:'ECONNREFUSED'});});
 let reply;
 await worker.interaction({customId:`gs-membership-confirm:test:${job.id}:remove`,isButton:()=>true,isModalSubmit:()=>false,inGuild:()=>false,
  user:{id:'10'},id:'1009',deferReply:async()=>{},editReply:async value=>{reply=value;}});
 assert.deepEqual(kicks,[]);
 assert.equal((await intake.list()).filter(event=>event.kind==='outcome').length,0);
 assert.match(reply,/saved and will be forwarded/);
});
test('confirming removal kicks with the User Request reason and records the outcome',async()=>{
 const calls=[];let reply;
 const {worker,kicks,nicknames}=fixture(async(action,payload)=>{calls.push([action,payload]);
  if(action==='response')return {status:'removal requested',message:'Your request was sent to the officers.'};
  return {ok:true};});
 await worker.interaction({customId:`gs-membership-confirm:${job.id}:remove`,isButton:()=>true,isModalSubmit:()=>false,inGuild:()=>false,
  user:{id:'10'},id:'999',deferReply:async()=>{},editReply:async value=>{reply=value;}});
 assert.deepEqual(kicks,['User Request']);
 assert.deepEqual(nicknames,[]);
 const outcome=calls.find(([action])=>action==='outcome')[1];
 assert.deepEqual([outcome.eventId,outcome.removal.status],['999','kicked']);
 assert.match(reply,/removed from the server at your request/);
});
test('a test delivery never kicks, and the member is told nothing changed',async()=>{
 const calls=[];let reply;
 const {worker,kicks}=fixture(async(action,payload)=>{calls.push([action,payload]);
  return action==='response'?{status:'test',message:'Test response received. Nothing changed.'}:{ok:true};});
 await worker.interaction({customId:`gs-membership-confirm:${job.id}:remove`,isButton:()=>true,isModalSubmit:()=>false,inGuild:()=>false,
  user:{id:'10'},id:'1000',deferReply:async()=>{},editReply:async value=>{reply=value;}});
 assert.deepEqual(kicks,[]);
 assert.equal(calls.filter(([action])=>action==='outcome').length,0);
 assert.match(reply,/Nothing changed/);
});
test('a kick the bot cannot perform is reported to the member and on the card',async()=>{
 let reply;const calls=[];
 const {worker,member}=fixture(async(action,payload)=>{calls.push([action,payload]);
  return action==='response'?{status:'removal requested',message:'Sent to the officers.'}:{ok:true};});
 member.kick=async()=>{throw Object.assign(Error('Missing Permissions'),{code:50013});};
 await worker.interaction({customId:`gs-membership-confirm:${job.id}:remove`,isButton:()=>true,isModalSubmit:()=>false,inGuild:()=>false,
  user:{id:'10'},id:'1001',deferReply:async()=>{},editReply:async value=>{reply=value;}});
 const outcome=calls.find(([action])=>action==='outcome')[1];
 assert.equal(outcome.removal.status,'failed');
 assert.match(outcome.removal.reason,/Kick Members/);
 assert.match(reply,/officer will finish the removal/);
});
test('an ESO answer sets the server nickname once and reports it',async()=>{
 const calls=[];let reply;
 const {worker,nicknames}=fixture(async(action,payload)=>{calls.push([action,payload]);
  return action==='response'?{status:'linked',message:'Linked.',rename:{allowed:true,name:'ESOName'}}:{ok:true};});
 await worker.interaction({customId:`gs-membership-rename:${job.id}:eso:ESOName`,isButton:()=>true,isModalSubmit:()=>false,inGuild:()=>false,
  user:{id:'10'},id:'1002',deferReply:async()=>{},editReply:async value=>{reply=value;}});
 assert.deepEqual(nicknames,[['ESOName','GuildSync membership DM: ESO account name']]);
 const outcome=calls.find(([action])=>action==='outcome')[1];
 assert.deepEqual(outcome.nickname,{status:'set',name:'ESOName'});
 assert.match(reply,/server nickname is now @ESOName/);
});
test('a nickname another member already uses is never applied',async()=>{
 const calls=[];let reply;
 const {worker,nicknames,cache}=fixture(async(action,payload)=>{calls.push([action,payload]);
  return action==='response'?{status:'linked',message:'Linked.',rename:{allowed:true,name:'ESOName'}}:{ok:true};});
 cache.set('20',{id:'20',displayName:'Other',nickname:'ESOName',user:{username:'other'}});
 await worker.interaction({customId:`gs-membership-rename:${job.id}:eso:ESOName`,isButton:()=>true,isModalSubmit:()=>false,inGuild:()=>false,
  user:{id:'10'},id:'1003',deferReply:async()=>{},editReply:async value=>{reply=value;}});
 assert.deepEqual(nicknames,[]);
 const outcome=calls.find(([action])=>action==='outcome')[1];
 assert.equal(outcome.nickname.status,'skipped');
 assert.match(outcome.nickname.reason,/already uses that name/);
 assert.match(reply,/nickname was not changed/);
});
test('the card reports the kick outcome and any nickname change',()=>{
 const kicked=cardOf(membershipReplyMessage({eventId:'5',userId:'10',name:'Member',choice:'remove',at:100,result:{status:'removal requested',removal:{status:'kicked'}}},{guildName:'Guild'}));
 assert.equal(kicked.fields.Outcome,'Removed from the server (reason: User Request)');
 const declined=cardOf(membershipReplyMessage({eventId:'7',userId:'10',name:'Member',choice:'remove',at:100,result:{status:'removal declined',removal:{status:'declined'}}},{guildName:'Guild'}));
 assert.equal(declined.fields.Outcome,'Not removed — the member declined the confirmation. Officers decide any follow-up.');
 const failed=cardOf(membershipReplyMessage({eventId:'6',userId:'10',name:'Member',choice:'remove',at:100,result:{status:'removal requested',removal:{status:'failed',reason:'Missing Kick Members permission.'}}},{guildName:'Guild'}));
 assert.match(failed.fields.Outcome,/could not remove them: Missing Kick Members permission\. Officer action needed\./);
 const pending=cardOf(membershipReplyMessage({eventId:'7',userId:'10',name:'Member',choice:'remove',at:100,result:{status:'removal requested',removal:{status:'pending'}}},{guildName:'Guild'}));
 assert.equal(pending.fields.Outcome,'Removal requested — an officer still needs to remove them');
 const renamed=cardOf(membershipReplyMessage({eventId:'8',userId:'10',name:'Member',choice:'eso',at:100,result:{status:'linked',accountName:'ESOName',nickname:{status:'set',name:'ESOName'}}},{guildName:'Guild'}));
 assert.equal(renamed.fields['Server nickname'],'Set to @ESOName');
 const blocked=cardOf(membershipReplyMessage({eventId:'9',userId:'10',name:'Member',choice:'eso',at:100,result:{status:'review',nickname:{status:'skipped',reason:'Another member already uses that name.'}}},{guildName:'Guild'}));
 assert.equal(blocked.fields['Server nickname'],'Not changed — Another member already uses that name.');
 assert.equal(cardOf(membershipReplyMessage({eventId:'10',userId:'10',name:'Member',choice:'eso',at:100,result:{status:'linked',accountName:'A'}},{guildName:'Guild'})).fields['Server nickname'],undefined);
 const notFound=cardOf(membershipReplyMessage({eventId:'11',userId:'10',name:'Member',choice:'eso',at:100,result:{status:'review',rosterMatch:'missing'}},{guildName:'Guild'}));
 assert.equal(notFound.fields.Outcome,'Name not found on the current ESO roster — officer review needed');
 assert.equal(notFound.embed.description,'**ESO account submitted for officer review**');
 const ambiguous=cardOf(membershipReplyMessage({eventId:'12',userId:'10',name:'Member',choice:'eso',at:100,result:{status:'review',rosterMatch:'ambiguous'}},{guildName:'Guild'}));
 assert.equal(ambiguous.fields.Outcome,'Name matches more than one roster member — officer review needed');
});

test('an ESO name the roster does not have is answered with an officer-review promise',async()=>{
 let reply;
 const {worker,nicknames}=fixture(async action=>action==='response'?{status:'review',rosterMatch:'missing',
  message:'I cannot find that member name in Alphabet Mafia currently, but I will have an officer review your reply.',
  rename:{allowed:false,reason:'That name is not on the current ESO roster.'}}:{ok:true});
 await worker.interaction({customId:`gs-membership-rename:${job.id}:eso:NotOnRoster`,isButton:()=>true,isModalSubmit:()=>false,inGuild:()=>false,
  user:{id:'10'},id:'1100',deferReply:async()=>{},editReply:async value=>{reply=value;}});
 assert.deepEqual(nicknames,[],'a name that is not on the roster is never set as a nickname');
 assert.match(reply,/cannot find that member name in Alphabet Mafia currently/);
 assert.match(reply,/officer review/);
});

test('forwarding renders the approved embed card, names the server and member, and attaches a long reply',async()=>{
 const event={eventId:'123',userId:'10',name:'Member',choice:'other',text:'X'.repeat(4000),at:100,deliveryId:job.id,result:{status:'review'},destinationType:'channel',destinationId:'99',token:'token'};
 const calls=[];
 const {worker,forwards}=fixture(async(action,payload)=>{calls.push([action,payload]);return action==='claim-forward'?{event}:{};});
 await worker.forwardOne();assert.equal(forwards.length,1);assert.deepEqual(forwards[0].allowedMentions.parse,[]);
 assert.equal(calls.at(-1)[1].success,true);
 const {embed:card,fields}=cardOf(forwards[0]);
 assert.equal(card.author.name,'Membership DM response');
 assert.equal(card.title,'Member');
 assert.equal(card.description,'**Sent another response**');
 assert.equal(card.footer.text,'GuildSync');
 assert.equal(new Date(card.timestamp).getTime(),100000);
 assert.equal(card.color,0xfee75c);
 assert.equal(fields.Server,'Guild');assert.equal(fields.Discord,'Member (10)');
 assert.equal(fields.Outcome,'Response forwarded');
 assert.equal(fields['Member response'],'```text\n'+'X'.repeat(1011)+'…\n```');
 assert.ok(fields['Member response'].length<=1024);
 assert.equal(forwards[0].files[0].attachment.toString(),'X'.repeat(4000));
});

test('the embed card summarizes links, button answers, removal requests and reposts',()=>{
 const linked=cardOf(membershipReplyMessage({eventId:'1',userId:'10',name:'Member',choice:'eso',text:'Evaine',at:100,result:{status:'linked',accountName:'Evaine'}},{guildName:'Guild'}));
 assert.equal(linked.embed.color,0x57f287);
 assert.equal(linked.embed.description,'**Linked ESO account @Evaine**');
 assert.equal(linked.fields['Member response'],"```text\nI'm in Guild — my ESO login is @Evaine\n```");
 assert.equal(linked.fields.Outcome,'Linked to @Evaine');
 const community=cardOf(membershipReplyMessage({eventId:'2',userId:'10',name:'Member',choice:'community',at:100,result:{status:'community'}},{guildName:'Guild'}));
 assert.equal(community.embed.color,0x5865f2);
 assert.equal(community.embed.description,'**Still plays ESO, not in Guild**');
 assert.equal(community.fields['Member response'],undefined);
 assert.equal(community.fields.Outcome,'Preference saved — membership DMs stopped');
 const removal=cardOf(membershipReplyMessage({eventId:'3',userId:'10',name:'Member',choice:'remove',at:100,result:{status:'removal requested'}},{guildName:'Guild'}));
 assert.equal(removal.embed.color,0xed4245);
 assert.equal(removal.embed.description,'**Asked to be removed from the Discord server**');
 assert.equal(removal.fields.Outcome,'Removal requested — an officer still needs to remove them');
 const repost=cardOf(membershipReplyMessage({eventId:'4',userId:'10',name:'Member',choice:'not_playing',at:100,result:{status:'not_playing'}},{guildName:'Guild',repostedBy:'Officer',nonceKey:'repost-1'}));
 assert.equal(repost.fields['Reposted by'],'Officer');
 assert.equal(repost.fields.Server,'Guild');
 assert.equal(repost.embed.description,'**No longer plays ESO — staying on Discord**');
 assert.equal(new Date(repost.embed.timestamp).getTime(),100000);
});

test('repost sends the stored reply card to the configured destination',async()=>{
 const {worker,forwards}=fixture(async()=>({}));
 const message=await worker.repost({response:{userId:'10',name:'Member',choice:'community',text:'',at:100,result:{status:'community'}},destinationType:'channel',destinationId:'99'},'Officer');
 assert.equal(message.id,'200');assert.equal(forwards.length,1);
 const {embed:card,fields}=cardOf(forwards[0]);
 assert.equal(fields['Reposted by'],'Officer');
 assert.equal(fields.Server,'Guild');
 assert.equal(card.title,'Member');
});

test('status reports last attempted, last delivered and next scheduled time',()=>{
 const text=formatMembershipStatus({campaign:{status:'paused',remaining:2,nextAt:100,lastAttempted:{name:'A',at:50},lastSent:{name:'B',at:40},uncertain:1,uncertainMembers:[{userId:'10',name:'Member'}]}});
 assert.match(text,/Last attempted: A/);assert.match(text,/Last sent: B/);assert.match(text,/paused/);
 assert.match(text,/Uncertain deliveries: Member \(10\)/);
 const withResponse=formatMembershipStatus({member:{userId:'10',history:{sentAt:40},preference:null,lastResponse:{choice:'not_playing',at:50}}});
 assert.match(withResponse,/Last response: no longer plays ESO; staying on Discord \(<t:50:f>\)/);
 const withAccount=formatMembershipStatus({member:{userId:'10',history:{},lastResponse:{choice:'eso',accountName:'Name',at:60}}});
 assert.match(withAccount,/ESO @Name/);
});
test('general DMs are never forwarded; only button and form responses reach the backend',async()=>{
 const calls=[];
 const {worker}=fixture(async action=>{calls.push(action);return {message:'Received'};});
 assert.equal(worker.message,undefined);
 assert.equal(typeof worker.interaction,'function');
 await worker.retryIntake();
 assert.deepEqual(calls,[]);
});
test('lookup, validation and rendering failures are recorded as failed, never uncertain',async()=>{
 for(const failure of ['validate','render']) {
  const outcomes=[];
  const {worker,sends}=fixture(async (action,payload)=>{
   if(action==='claim')return {job,config:failure==='render'?{...config,template:'X'.repeat(2000)}:config};
   if(action==='validate'){if(failure==='validate')throw Error('Backend disconnected');return {valid:true};}
   if(action==='finish')outcomes.push(payload.result.status);
   return {};
  });
  await worker.sendNext();
  assert.deepEqual(outcomes,['failed'],failure);assert.equal(sends.length,0,failure);
 }
});

test('the width pad rides on the author line, the only line with room to spare',()=>{
 for(const choice of ['community','other','remove']){
  const raw=membershipReplyMessage({eventId:'30',userId:'10',name:'Member',choice,text:'hi',at:100,result:{status:'review'}},{guildName:'Guild'}).embeds[0].toJSON();
  assert.equal(raw.author.name,'Membership DM response'+CARD_WIDTH_PAD,choice);
  assert.equal(raw.footer.text,'GuildSync',choice);
  assert.equal(`${raw.description}${JSON.stringify(raw.fields)}`.includes('\u2800'),false,`${choice}: no pad in the body`);
 }
 const failure=membershipDeliveryFailureMessage({name:'Member',userId:'10',status:'failed',detail:'Cannot send messages to this user',at:100}).embeds[0].toJSON();
 assert.equal(failure.author.name,'GuildSync membership DM'+CARD_WIDTH_PAD);
});
test('a blocked DM is explained as the member\'s privacy setting, not a missing server',()=>{
 const explanation=membershipDeliveryExplain('failed','Cannot send messages to this user');
 assert.match(explanation,/still in the server/);
 assert.match(explanation,/Direct Messages from server members/);
 assert.doesNotMatch(explanation,/mutual guild/i);
 assert.doesNotMatch(membershipDeliveryExplain('failed','no mutual guilds'),/mutual guild/i);
 assert.ok((explanation.match(/\./g)||[]).length<=2,'two short sentences at most');
 assert.ok(membershipDeliveryExplain('uncertain','socket hang up').split(/[.!?] /).length<=2);
 const {embed,fields}=cardOf(membershipDeliveryFailureMessage({name:'Member',userId:'10',status:'failed',detail:'Cannot send messages to this user',at:100}));
 assert.equal(embed.author.name,'GuildSync membership DM');
 assert.equal(embed.title,'Member');
 assert.equal(embed.color,0xed4245);
 assert.equal(embed.description,'**GuildSync could not send this membership DM**');
 assert.equal(fields['Discord ID'],'10');assert.equal(fields.Status,undefined,'the description already carries the outcome');
 assert.match(fields['Likely cause and next step'],/Direct Messages from server members/);
 assert.equal(new Date(embed.timestamp).getTime(),100000);
});
test('a failed DM posts one card to the reply channel and an unconfirmed one says so',async()=>{
 const {worker,member,forwards}=fixture(async action=>action==='claim'?{job,config}:action==='validate'?{valid:true}:{ok:true});
 member.send=async()=>{throw Object.assign(Error('Cannot send messages to this user'),{code:50007});};
 await worker.sendNext();
 assert.equal(forwards.length,1,'the officer channel gets the failure card');
 const failed=cardOf(forwards[0]);
 assert.equal(failed.embed.title,'Member');
 assert.equal(failed.embed.description,'**GuildSync could not send this membership DM**');
 assert.match(failed.fields['Likely cause and next step'],/privacy/i);
 const unconfirmed=fixture(async action=>action==='claim'?{job,config}:action==='validate'?{valid:true}:{ok:true});
 unconfirmed.member.send=async()=>{throw Object.assign(Error('socket hang up'),{code:'ECONNRESET'});};
 await unconfirmed.worker.sendNext();
 assert.equal(unconfirmed.forwards.length,1);
 const card=cardOf(unconfirmed.forwards[0]);
 assert.equal(card.embed.description,'**Delivery not confirmed — GuildSync could not tell whether this DM arrived**');
 assert.equal(card.embed.color,0xfee75c);
});
test('a test delivery failure is reported to the officer without an officer card',async()=>{
 const {worker,member,forwards}=fixture(async action=>action==='claim'?{job:{...job,isTest:true},config}:action==='validate'?{valid:true}:{ok:true});
 member.send=async()=>{throw Object.assign(Error('Cannot send messages to this user'),{code:50007});};
 await worker.sendNext();
 assert.deepEqual(forwards,[]);
});
