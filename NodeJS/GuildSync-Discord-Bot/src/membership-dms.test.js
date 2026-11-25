import test from 'node:test';
import assert from 'node:assert/strict';
import {membershipDMMessage,createMembershipDMWorker,formatMembershipStatus,formatMembershipReplyChoice} from './membership-dms.js';

const job={id:'12345678-1234-1234-1234-123456789abc',userId:'10',name:'Member',token:'claim'};
const config={template:'Hello {name}, please tell {guild} your ESO name.',destinationType:'channel',destinationId:'99'};
test('DM presents four persistent buttons, protects mentions, and labels test messages',()=>{
 const message=membershipDMMessage(job,config,{name:'@everyone',guildName:'Alphabet Mafia'});
 assert.equal(message.components[0].toJSON().components.length,4);
 assert.match(message.content,/forwarded to guild officers/);assert.deepEqual(message.allowedMentions.parse,[]);
 assert.equal(message.enforceNonce,true);assert.ok(message.nonce.length<=25);
 assert.match(membershipDMMessage({...job,isTest:true},config,{name:'A',guildName:'Guild'}).content,/\[TEST\]/);
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
test('forwarding names the server and member, describes the option, and omits internal delivery IDs',async()=>{
 const event={eventId:'123',userId:'10',name:'Member',choice:'other',text:'X'.repeat(4000),at:100,deliveryId:job.id,result:{status:'review'},destinationType:'channel',destinationId:'99',token:'token'};
 const calls=[];
 const {worker,forwards}=fixture(async(action,payload)=>{calls.push([action,payload]);return action==='claim-forward'?{event}:{};});
 await worker.forwardOne();assert.equal(forwards.length,1);assert.ok(forwards[0].files?.length);assert.deepEqual(forwards[0].allowedMentions.parse,[]);
 assert.equal(calls.at(-1)[1].success,true);
 assert.match(forwards[0].content,/Server: Guild\n/);assert.doesNotMatch(forwards[0].content,/Server: 1\b/);
 assert.match(forwards[0].content,/Discord: Member \(10\)/);
 assert.match(forwards[0].content,/Choice: Other response \(full text below\)/);
 assert.doesNotMatch(forwards[0].content,/Delivery:/);assert.doesNotMatch(forwards[0].content,/Response:/);
});
test('each option reads as a sentence and an empty reply omits placeholder text',async()=>{
 assert.equal(formatMembershipReplyChoice('eso','@Name','Guild'),'I play ESO — my ESO account name is @Name');
 assert.equal(formatMembershipReplyChoice('eso','','Guild'),'I play ESO — my ESO account name is not supplied');
 assert.equal(formatMembershipReplyChoice('community','','Guild'),'I am no longer in Guild but would like to stay on Discord');
 assert.equal(formatMembershipReplyChoice('not_playing','','Guild'),'I do not play ESO but would like to stay on Discord');
 assert.equal(formatMembershipReplyChoice('other','Short note','Guild'),'Other response: Short note');
 assert.equal(formatMembershipReplyChoice('other','','Guild'),'Other response');
});
test('status reports last attempted, last delivered and next scheduled time',()=>{
 const text=formatMembershipStatus({campaign:{status:'paused',remaining:2,nextAt:100,lastAttempted:{name:'A',at:50},lastSent:{name:'B',at:40},uncertain:1,uncertainMembers:[{userId:'10',name:'Member'}]}});
 assert.match(text,/Last attempted: A/);assert.match(text,/Last sent: B/);assert.match(text,/paused/);
 assert.match(text,/Uncertain deliveries: Member \(10\)/);
 const withResponse=formatMembershipStatus({member:{userId:'10',history:{sentAt:40},preference:null,lastResponse:{choice:'not_playing',at:50}}});
 assert.match(withResponse,/Last response: no longer plays ESO, staying on Discord \(<t:50:f>\)/);
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

test('simulated test mode messages name the member and never use real button IDs',()=>{
 const message=membershipDMMessage({...job,isTest:true,simulated:true},config,{name:'Alice',guildName:'Alphabet Mafia',position:2,total:5});
 assert.match(message.content,/^Test mode 2 of 5 — this is what Alice \(10\) would receive\./);
 assert.doesNotMatch(message.content,/\[TEST\]/);
 assert.match(message.content,/Hello Alice, please tell Alphabet Mafia your ESO name\./);
 assert.match(message.content,/Simulation only/);
 const buttons=message.components[0].toJSON().components;
 assert.equal(buttons.length,4);
 assert.ok(buttons.every(button=>button.custom_id.startsWith('gs-membership-sim:')));
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
