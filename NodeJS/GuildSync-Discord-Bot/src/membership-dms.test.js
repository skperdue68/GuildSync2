import test from 'node:test';
import assert from 'node:assert/strict';
import {membershipDMMessage,membershipReplyMessage,createMembershipDMWorker,formatMembershipStatus} from './membership-dms.js';
const cardOf=payload=>{const embed=payload.embeds[0].toJSON();return {embed,fields:Object.fromEntries(embed.fields.map(field=>[field.name,field.value]))};};

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
 const sends=[],forwards=[],roles=[];
 const member={user:{bot:false},displayName:'Member',send:async payload=>{sends.push(payload);return {id:'100'};},roles:{add:async id=>roles.push(['add',id]),remove:async id=>roles.push(['remove',id])}};
 const guild={id:'1',name:'Guild',members:{fetch:async()=>member}};
 const client={user:{id:'bot'},isReady:()=>true,guilds:{fetch:async()=>guild},channels:{fetch:async()=>({guildId:'1',send:async payload=>{forwards.push(payload);return {id:'200'};}})}};
 return {worker:createMembershipDMWorker({client,guildId:'1',request,log:()=>{}}),sends,forwards,roles,member};
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
 let reply;
 await worker.interaction({customId:`gs-membership:${job.id}:eso`,isButton:()=>false,isModalSubmit:()=>true,inGuild:()=>false,user:{id:'10'},id:'123',fields:{getTextInputValue:()=>'@ESO'},deferReply:async()=>{},editReply:async value=>{reply=value;}});
 assert.equal(calls[0][1].userId,'10');assert.equal(calls[0][1].text,'@ESO');assert.equal(reply,'Linked');
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

test('status lists recent failures with their reason',()=>{
 const text=formatMembershipStatus({campaign:null,recentFailures:[
   {userId:'10',name:'Member',status:'failed',reason:'Cannot send messages to this user',at:70},
   {userId:'20',name:'Other',status:'uncertain',reason:'Send timed out.',at:60},
   {userId:'30',name:'Gone',status:'skipped',reason:'No longer in the Discord server.',at:50}]});
 assert.match(text,/Recent failures and skips \(3\):/);
 assert.match(text,/Member \(10\) — failed: Cannot send messages to this user at <t:70:f>/);
 assert.match(text,/Other \(20\) — uncertain: Send timed out\. at <t:60:f>/);
 assert.match(text,/Gone \(30\) — skipped: No longer in the Discord server\. at <t:50:f>/);
});
