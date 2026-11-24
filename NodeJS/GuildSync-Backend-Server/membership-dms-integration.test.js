import test from 'node:test';
import assert from 'node:assert/strict';
import {createMembershipDMService,registerMembershipDMSocket} from './membership-dms.js';
import {dmConfig} from './membership-dm-config.js';
import {createMembershipDMWorker} from '../GuildSync-Discord-Bot/src/membership-dms.js';

function fixture() {
 let time=1800000000,json=JSON.stringify({history:{},preferences:{},events:[],deliveries:{}}),snapshot;
 let links=[],roster=[{account_name:'ESOName'}],upserts=0,roleId='';
 const responses=new Map();
 const members=[{id:'10',name:'Alice'},{id:'20',name:'Zebra'}];
 const connection={
  beginTransaction:async()=>{snapshot={json,links:structuredClone(links),responses:structuredClone(responses)};},commit:async()=>{},rollback:async()=>{json=snapshot.json;links=snapshot.links;responses.clear();for(const [key,value] of snapshot.responses)responses.set(key,value);},release(){},
  async execute(sql,args=[]) {
   if(sql.includes('GET_LOCK'))return [[{acquired:1}]];
   if(sql.includes('RELEASE_LOCK'))return [[{released:1}]];
   if(sql.startsWith('INSERT IGNORE INTO guildsync_membership_dm_state'))return [{affectedRows:0}];
   if(sql.startsWith('SELECT state_json'))return [[{state_json:json}]];
   if(sql.startsWith('UPDATE guildsync_membership_dm_state')){json=args[0];return [{affectedRows:1}];}
   if(sql.includes('SELECT d.discord_id AS id'))return [members.filter(m=>!links.some(l=>l.discord_user_id===m.id&&l.link_status==='linked'))];
   if(sql.startsWith('SELECT account_name FROM guildsync_roster_members'))return [roster.filter(r=>r.account_name.toLowerCase()===args[0])];
   if(sql.startsWith('SELECT * FROM guildsync_member_links'))return [links.filter(l=>l.eso_account_name.toLowerCase()===args[0]||l.discord_user_id===args[1])];
   if(sql.startsWith('SELECT * FROM discord_members'))return [[{discord_id:args[0],username:'Alice'}]];
   if(sql.startsWith('INSERT INTO guildsync_membership_dm_responses')){
    const [guild,user,displayName,eso,choice,text,at]=args,key=guild+':'+user,previous=responses.get(key);
    responses.set(key,{guild_id:guild,discord_user_id:user,display_name:displayName,eso_account_name:eso??previous?.eso_account_name??null,choice,response_text:text,responded_at:at});
    return [{affectedRows:1}];
   }
   if(sql.startsWith('SELECT choice,eso_account_name,responded_at FROM guildsync_membership_dm_responses'))return [[...responses.values()].filter(row=>row.guild_id===args[0]&&row.discord_user_id===args[1])];
   throw Error('Unexpected query: '+sql);
  }
 };
 const db={getConnection:async()=>connection,execute:(...args)=>connection.execute(...args)};
 const options={configuration:()=>dmConfig({GUILDSYNC_MEMBERSHIP_DM_ENABLED:'true',GUILDSYNC_MEMBERSHIP_DM_DESTINATION_ID:'99',GUILDSYNC_MEMBERSHIP_DM_COMMUNITY_ROLE_ID:roleId}),
  authorizeOfficer:async id=>id==='officer',now:()=>time,random:()=>0,
  upsertLink:async(_connection,link)=>{upserts++;links.push({discord_user_id:link.discordUserId,eso_account_name:link.esoAccountName,link_status:link.linkStatus});}};
 const service=createMembershipDMService(db,options);
 const sends=[],forwards=[];
 const client={user:{id:'bot'},isReady:()=>true,guilds:{fetch:async()=>({id:'1',name:'Alphabet Mafia',members:{fetch:async id=>({user:{bot:false},displayName:members.find(m=>m.id===id)?.name||'Test',send:async payload=>{sends.push(payload);return {id:String(100+sends.length)};}})}})},
  channels:{fetch:async()=>({guildId:'1',send:async payload=>{forwards.push(payload);return {id:'200'};}})}};
 const handlers={};
 const socket={guildSyncAuthenticated:true,guildSyncAuthType:'discord-bot',guildSyncBot:{guild_id:'1'},on:(event,fn)=>handlers[event]=fn};
 registerMembershipDMSocket(socket,service,{guildId:'1'});
 const request=async(action,payload={})=>{
  let response;await handlers['guildsync:membership-dm']({guildId:'1',action,...payload},r=>response=r);
  if(!response.ok)throw Object.assign(Error(response.message),{code:response.code});
  return structuredClone(response.result);
 };
 return {db,service,worker:createMembershipDMWorker({client,guildId:'1',request,log:()=>{}}),request,sends,forwards,
  advance:seconds=>time+=seconds,state:()=>JSON.parse(json),restart:()=>createMembershipDMService(db,options),
  block:()=>{links=[{eso_account_name:'ESOName',discord_user_id:'30',link_status:'linked'}];},upserts:()=>upserts,responses:()=>[...responses.values()],setRole:id=>roleId=id};
}
test('bot → authenticated backend → persisted send date → modal auto-link → durable forwarding',async()=>{
 const f=fixture();await f.service.command('1','officer','start');f.advance(600);
 await f.worker.sendNext();assert.equal(f.sends.length,1);
 const delivery=f.state().history['10'].deliveryId;
 assert.equal(f.state().history['10'].sentAt,1800000600);
 const result=await f.request('response',{deliveryId:delivery,userId:'10',eventId:'300',choice:'eso',text:'@ESOName'});
 assert.equal(result.status,'linked');assert.equal(f.upserts(),1);
 await f.request('response',{deliveryId:delivery,userId:'10',eventId:'300',choice:'eso',text:'@ESOName'});
 assert.equal(f.upserts(),1,'event replay never relinks');
 await f.worker.forwardOne();assert.equal(f.forwards.length,1);assert.equal(f.state().events[0].forwardStatus,'sent');
 const status=await f.restart().command('1','officer','status','10');
 assert.equal(status.member.history.sentAt,1800000600);assert.equal(status.campaign.lastSent.userId,'10');
});
test('community choices persist across restart and prevent future campaigns contacting that member',async()=>{
 const f=fixture();await f.service.command('1','officer','start');f.advance(600);await f.worker.sendNext();
 await f.request('response',{deliveryId:f.state().history['10'].deliveryId,userId:'10',eventId:'301',choice:'community'});
 assert.equal(f.state().preferences['10'],'community');
 f.advance(40*86400);await f.restart().command('1','officer','restart');
 assert.deepEqual(f.state().campaign.queue.map(q=>q.userId),['20']);
});
test('another recipient cannot submit a form; existing account ownership routes the answer to review',async()=>{
 const f=fixture();await f.service.command('1','officer','start');f.advance(600);await f.worker.sendNext();
 const delivery=f.state().history['10'].deliveryId;
 await assert.rejects(()=>f.request('response',{deliveryId:delivery,userId:'20',eventId:'302',choice:'eso',text:'@ESOName'}),/No membership DM/);
 f.block();const result=await f.request('response',{deliveryId:delivery,userId:'10',eventId:'303',choice:'eso',text:'@ESOName'});
 assert.equal(result.status,'review');assert.equal(f.upserts(),0);
});
test('test delivery and responses leave normal dates, preferences, links and campaign schedule unchanged',async()=>{
 const f=fixture();await f.service.command('1','officer','start');const before=f.state().campaign.nextAt;
 const outcome=await f.worker.test('officer','10');assert.equal(outcome.status,'sent');
 assert.deepEqual(f.state().history,{});assert.equal(f.state().campaign.nextAt,before);
 const delivery=f.state().testHistory['10'].deliveryId;
 const result=await f.request('response',{deliveryId:delivery,userId:'10',eventId:'304',choice:'eso',text:'@ESOName'});
 assert.equal(result.status,'test');assert.equal(f.upserts(),0);assert.deepEqual(f.state().preferences,{});assert.equal(f.responses().length,0);
});
test('a response must name the delivered membership DM it answers',async()=>{
 const f=fixture();await f.service.command('1','officer','start');f.advance(600);await f.worker.sendNext();
 await assert.rejects(()=>f.request('response',{userId:'10',eventId:'330',choice:'community'}),/No membership DM/);
 await assert.rejects(()=>f.request('response',{deliveryId:'unknown',userId:'10',eventId:'331',choice:'community'}),/No membership DM/);
 assert.deepEqual(f.state().preferences,{});
});
test('the latest response per member stores the choice, ESO name and response time',async()=>{
 const f=fixture();await f.service.command('1','officer','start');f.advance(600);await f.worker.sendNext();
 const delivery=f.state().history['10'].deliveryId;
 await f.request('response',{deliveryId:delivery,userId:'10',eventId:'340',choice:'eso',text:'@ESOName'});
 f.advance(30);
 await f.request('response',{deliveryId:delivery,userId:'10',eventId:'341',choice:'other',text:'Away this month'});
 const rows=f.responses();
 assert.equal(rows.length,1);
 assert.equal(rows[0].choice,'other');
 assert.equal(rows[0].eso_account_name,'ESOName');
 assert.equal(rows[0].response_text,'Away this month');
 assert.equal(rows[0].responded_at.getTime(),(1800000600+30)*1000);
 const status=await f.service.command('1','officer','status','10');
 assert.deepEqual(status.member.lastResponse,{choice:'other',accountName:'ESOName',at:1800000630});
});
test('unapproved actors and unauthenticated or cross-guild callers cannot run campaigns',async()=>{
 const f=fixture();await assert.rejects(()=>f.service.command('1','stranger','start'),/approved/i);
 for(const state of [{},{guildSyncAuthenticated:true,guildSyncAuthType:'discord-bot',guildSyncBot:{guild_id:'2'}}]){
  let handler;registerMembershipDMSocket({...state,on:(_event,fn)=>handler=fn},f.service,{guildId:'1'});
  let result;await handler({action:'command',guildId:'1',actorId:'officer',command:'start'},r=>result=r);assert.equal(result.ok,false);
 }
});
test('a newer linked response supersedes a failed community role addition',async()=>{
 const f=fixture();f.setRole('77');await f.service.command('1','officer','start');f.advance(600);await f.worker.sendNext();
 await f.request('response',{deliveryId:f.state().history['10'].deliveryId,userId:'10',eventId:'310',choice:'community'});
 const {event}=await f.service.claimForward('1');
 await f.service.finishForward('1',event.eventId,event.token,true,false);
 await f.request('response',{deliveryId:f.state().history['10'].deliveryId,userId:'10',eventId:'311',choice:'eso',text:'@ESOName'});
 assert.equal(f.state().events[0].roleStatus,'superseded');
 const next=await f.service.claimForward('1');assert.equal(next.event.roleAction,'remove');
 await f.service.finishForward('1',next.event.eventId,next.event.token,true,true);
 f.advance(200);assert.equal((await f.service.claimForward('1')).event,null);
});
test('a member becomes eligible again after the configured cooldown, including send-time validation',async()=>{
 const f=fixture();await f.service.command('1','officer','start');f.advance(600);await f.worker.sendNext();
 await f.service.command('1','officer','restart');assert.deepEqual(f.state().campaign.queue.map(q=>q.userId),['20']);
 f.advance(31*86400);await f.service.command('1','officer','restart');f.advance(600);
 await f.worker.sendNext();assert.equal(f.sends.length,2);assert.equal(f.state().campaign.lastSent.userId,'10');
});
test('an uncertain delivery can be retried in the current campaign without editing the database',async()=>{
 const f=fixture();await f.service.command('1','officer','start');f.advance(600);
 const job=(await f.request('claim')).job;
 await f.request('finish',{deliveryId:job.id,token:job.token,result:{status:'uncertain',detail:'Send timed out.'}});
 assert.equal(f.state().history['10'].uncertain,true);
 const status=await f.service.command('1','officer','status');
 assert.deepEqual(status.campaign.uncertainMembers,[{userId:'10',name:'Alice'}]);
 await assert.rejects(()=>f.request('resolve',{actorId:'stranger',userId:'10',outcome:'retry'}),/approved/i);
 await assert.rejects(()=>f.request('resolve',{actorId:'officer',userId:'20',outcome:'retry'}),/no uncertain/i);
 const resolved=await f.request('resolve',{actorId:'officer',userId:'10',outcome:'retry'});
 assert.match(resolved.message,/requeued/i);
 assert.equal(f.state().history['10'].uncertain,false);
 assert.equal(f.state().campaign.queue.find(q=>q.userId==='10').status,'pending');
 f.advance(600);await f.worker.sendNext();assert.equal(f.sends.length,1);
});
test('an officer can confirm an uncertain delivery as sent',async()=>{
 const f=fixture();await f.service.command('1','officer','start');f.advance(600);
 const job=(await f.request('claim')).job;
 await f.request('finish',{deliveryId:job.id,token:job.token,result:{status:'uncertain',detail:'Send timed out.'}});
 const resolved=await f.request('resolve',{actorId:'officer',userId:'10',outcome:'sent'});
 assert.match(resolved.message,/delivered/i);
 assert.equal(f.state().history['10'].uncertain,false);assert.equal(f.state().history['10'].sentAt,1800000600);
 assert.equal(f.state().campaign.queue.find(q=>q.userId==='10').status,'sent');
 await f.service.command('1','officer','restart');assert.deepEqual(f.state().campaign.queue.map(q=>q.userId),['20']);
});

test('the test mode plan is read-only and lists unlinked members',async()=>{
 const f=fixture();
 const before=JSON.stringify(f.state());
 const plan=await f.request('test-plan',{actorId:'officer'});
 assert.deepEqual(plan.members.map(member=>member.name),['Alice','Zebra']);
 assert.equal(plan.config.enabled,true);
 assert.equal(JSON.stringify(f.state()),before,'plan never writes campaign state');
 await assert.rejects(()=>f.request('test-plan',{actorId:'stranger'}),/approved/i);
});
