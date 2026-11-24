import test from 'node:test';
import assert from 'node:assert/strict';
import {selectReminderRecipients, reminderInterval, registerDiscordReminderSocket,createDiscordReminders} from './discord-reminders.js';

const now = new Date('2026-11-24T12:00:00Z');
test('only current, unlinked, opted-in members beyond the cooldown qualify', () => {
  const rows = [
    {account_name:'Member',in_roster:1,rank:'Associate',link_status:'candidate',discord_username:'possible',match_confidence:70},
    {account_name:'@MEMBER',in_roster:1,rank:'Associate',link_status:'candidate',discord_username:'better',match_confidence:90},
    {account_name:'Linked',in_roster:1,link_status:'candidate'},
    {account_name:'@linked',in_roster:1,link_status:'linked'},
    {account_name:'Departed',in_roster:0},
    {account_name:'OptOut',in_roster:1,discord_opt_out:1},
    {account_name:'Recent',in_roster:1,reminder_exported_at:'2026-11-20T00:00:00Z'},
    {account_name:'Pending',in_roster:1,pending_request_id:'request'},
    {account_name:'Boundary',in_roster:1,reminder_sent_at:'2026-10-25T12:00:00Z'},
    {account_name:'NoLinkRow',in_roster:1}
  ];
  const recipients=selectReminderRecipients(rows,30,now);
  assert.deepEqual(recipients.map(r=>r.recipient),['@Boundary','@Member','@NoLinkRow']);
  assert.equal(recipients[1].rank,'Associate');
  assert.equal(recipients[1].candidateDiscordName,'better');
});

function batchDatabase() {
 const record={requestId:'request',batchId:'batch',memberId:'member',recipient:'@Member',guildId:'123',sendingAccount:'@Officer',worldName:'NA Megaserver'};
 const request={request_id:'request',status:'exported',record_json:JSON.stringify(record)};
 const batch={batch_id:'batch',officer_id:'officer',guild_id:'123',created_at:new Date('2026-11-01'),exported_at:null};
 const data={row:{account_name:'Member',in_roster:1,member_id:'member'},commits:0,rollbacks:0,updates:[]};
 const connection={beginTransaction:async()=>{},commit:async()=>{data.commits++;},rollback:async()=>{data.rollbacks++;},release(){},
  async execute(sql,args=[]) {
   if(sql.includes('GET_LOCK'))return [[{acquired:1}]];
   if(sql.includes('RELEASE_LOCK'))return [[{released:1}]];
   if(sql.includes('SELECT value FROM guildsync_settings'))return [[{value:'30'}]];
   if(sql.startsWith('SELECT * FROM guildsync_discord_reminder_batches'))return [[batch]];
   if(sql.startsWith('SELECT * FROM guildsync_discord_reminder_requests'))return [[request]];
   if(sql.includes('SELECT r.account_name'))return [[data.row]];
   if(sql.startsWith('SELECT guild_id'))return [args[0]==='batch'?[{guild_id:'123'}]:[]];
   if(sql.includes("SET status='cancelled'"))request.status='cancelled';
   data.updates.push({sql,args});return [{affectedRows:1}];
  }};
 return {db:{getConnection:async()=>connection,execute:connection.execute},data,request};
}
test('retry revalidates opt-outs and confirmed links and returns a cancellation for local queue removal',async()=>{
 for(const change of [{discord_opt_out:1},{link_status:'linked'},{in_roster:0}]){
  const {db,data}=batchDatabase();Object.assign(data.row,change);
  const service=createDiscordReminders(db,{guildId:'123',now:()=>now});
  const result=await service.getBatch('officer','batch');
  assert.equal(result.records[0].status,'cancelled');assert.equal(data.commits,1);
 }
});
test('foreign installation acknowledgements are skipped without disabling other accounts',async()=>{
 const {db}=batchDatabase();const service=createDiscordReminders(db,{guildId:'123',now:()=>now});
 assert.deepEqual(await service.acknowledge('other-officer',[{batchId:'foreign',status:'sent'}]),{processed:0});
});
test('confirmed send accepts ESO seconds and writes the send date, never on a failed outcome',async()=>{
 for(const status of ['sent','failed']){
  const {db,data}=batchDatabase();const service=createDiscordReminders(db,{guildId:'123',now:()=>now});
  await service.acknowledge('other-officer',[{batchId:'batch',requestId:'request',status,guildId:'123',sendingAccount:'@Officer',worldName:'NA Megaserver',sentAt:now.getTime()/1000-10}]);
  assert.equal(data.updates.some(u=>u.sql.includes('INSERT INTO guildsync_discord_reminder_members')&&u.sql.includes('reminder_sent_at')),status==='sent');
 }
});
test('test mail export and confirmation never change normal member cooldown dates',async()=>{
 const {db,data,request}=batchDatabase();
 const record=JSON.parse(request.record_json);record.isTest=true;request.record_json=JSON.stringify(record);
 const service=createDiscordReminders(db,{guildId:'123',now:()=>now});
 await service.exported('officer','batch');
 await service.acknowledge('officer',[{batchId:'batch',requestId:'request',status:'sent',guildId:'123',sendingAccount:'@Officer',worldName:'NA Megaserver',sentAt:now.getTime()/1000-10}]);
 assert.equal(data.updates.some(u=>u.sql.includes('INSERT INTO guildsync_discord_reminder_members')),false);
});
test('historical unsuccessful acknowledgements cannot resurrect cancelled requests',async()=>{
 const {db,data,request}=batchDatabase();request.status='cancelled';
 await createDiscordReminders(db,{guildId:'123',now:()=>now}).acknowledge('officer',[{batchId:'batch',requestId:'request',status:'uncertain',guildId:'123',sendingAccount:'@Officer',worldName:'NA Megaserver'}]);
 assert.equal(data.updates.some(u=>u.sql.startsWith('UPDATE guildsync_discord_reminder_requests')),false);
});
test('sent and export timestamps both enforce cooldown; malformed dates fail closed',()=>{
  assert.equal(selectReminderRecipients([{account_name:'A',in_roster:1,reminder_exported_at:'2026-10-01',reminder_sent_at:'2026-11-23'}],30,now).length,0);
  assert.equal(selectReminderRecipients([{account_name:'A',in_roster:1,reminder_sent_at:'invalid'}],30,now).length,0);
});
test('interval rejects fractional, zero, excessive and nonnumeric values',()=>{
  assert.equal(reminderInterval(30),30);
  for(const value of [0,-1,1.5,366,'abc',null,''])assert.throws(()=>reminderInterval(value));
});
test('socket operations reject unauthenticated users, bots and viewers',async()=>{
  for(const socketState of [{},{guildSyncAuthenticated:true,guildSyncUser:{role:'viewer',discord_user_id:'1'}},{guildSyncAuthenticated:true,guildSyncAuthType:'discord-bot',guildSyncUser:{role:'admin',discord_user_id:'1'}}]){
    const handlers={};let called=false;
    const socket={...socketState,on:(event,fn)=>handlers[event]=fn};
    registerDiscordReminderSocket(socket,{overview:()=>{called=true;}},{authorize:async s=>s.guildSyncUser?.role});
    let response;
    await handlers['guildsync:discord-reminders']({action:'preview'},r=>response=r);
    assert.equal(response.ok,false);assert.equal(called,false);
  }
});
