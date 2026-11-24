import test from 'node:test';
import assert from 'node:assert/strict';
import {membershipDMMessage,createMembershipDMWorker,formatMembershipStatus} from './membership-dms.js';

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
test('forwarding includes identity, outcome and full long response, disables mentions and persists completion',async()=>{
 const event={eventId:'123',userId:'10',name:'Member',choice:'other',text:'X'.repeat(4000),at:100,deliveryId:job.id,result:{status:'review'},destinationType:'channel',destinationId:'99',token:'token'};
 const calls=[];
 const {worker,forwards}=fixture(async(action,payload)=>{calls.push([action,payload]);return action==='claim-forward'?{event}:{};});
 await worker.forwardOne();assert.equal(forwards.length,1);assert.ok(forwards[0].files?.length);assert.deepEqual(forwards[0].allowedMentions.parse,[]);
 assert.equal(calls.at(-1)[1].success,true);assert.match(forwards[0].content,/123/);
});
test('status reports last attempted, last delivered and next scheduled time',()=>{
 const text=formatMembershipStatus({campaign:{status:'paused',remaining:2,nextAt:100,lastAttempted:{name:'A',at:50},lastSent:{name:'B',at:40},uncertain:1}});
 assert.match(text,/Last attempted: A/);assert.match(text,/Last sent: B/);assert.match(text,/paused/);
});
test('typed replies survive a backend outage and replay once the connection returns',async()=>{
 let online=false,saved=0;const replies=[];
 const {worker}=fixture(async action=>{assert.equal(action,'response');if(!online)throw Error('Backend disconnected');saved++;return {message:'Received'};});
 await worker.message({id:'123',author:{id:'10'},content:'My ESO name is @Member',reply:async value=>replies.push(value)});
 assert.match(replies[0]?.content||'',/saved.*reconnect/i);
 online=true;await worker.retryIntake();await worker.retryIntake();assert.equal(saved,1);
});
