import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {clearMembershipContactForConfirmedLink,isConfirmedMemberLink} from './membership-dms.js';

function fixture({preference='not_playing',optOut=true,roleId='55',guildId='1',events=[]}={}) {
 const queries=[],history=[];
 let state=JSON.stringify({preferences:preference?{42:preference}:{},events:structuredClone(events)}),optOuts=optOut?1:0;
 const connection={
  async execute(sql,args=[]) {
   queries.push(sql.replace(/\s+/g,' ').trim());
   if(sql.includes('GET_LOCK'))return [[{acquired:1}]];
   if(sql.includes('RELEASE_LOCK'))return [[{released:1}]];
   if(sql.startsWith('UPDATE guildsync_discord_reminder_members')){const changed=optOuts;optOuts=0;return [{affectedRows:changed}];}
   if(sql.startsWith('SELECT value FROM guildsync_settings'))return [guildId?[{value:guildId}]:[]];
   if(sql.startsWith('SELECT state_json FROM guildsync_membership_dm_state'))return guildId?[[{state_json:state}]]:[[]];
   if(sql.startsWith('UPDATE guildsync_membership_dm_state')){state=args[0];return [{affectedRows:1}];}
   if(sql.startsWith('SELECT username,global_name,server_nickname FROM discord_members'))return [[{username:'Alice'}]];
   if(sql.startsWith('INSERT INTO discord_member_history')){history.push(args);return [{affectedRows:1}];}
   throw Error('Unexpected query: '+sql);
  },
  release(){}
 };
 const db={getConnection:async()=>connection,execute:(...args)=>connection.execute(...args)};
 const clear=(options={})=>clearMembershipContactForConfirmedLink(db,{discordUserId:'42',esoAccountName:'@Alice',method:'exact',
  configuration:()=>({communityRoleId:roleId}),now:()=>1800000000,...options});
 return {queries,history,state:()=>JSON.parse(state),optOuts:()=>optOuts,clear};
}

test('a confirmed exact link clears both opt-outs and queues the community role removal',async()=>{
 const f=fixture({events:[{eventId:'old',userId:'42',roleAction:'add',roleStatus:'pending',forwardStatus:'sent'}]});
 const result=await f.clear();
 assert.deepEqual(result,{cleared:true,rosterOptOutCleared:true,preferenceCleared:true,roleQueued:true});
 const state=f.state();
 assert.equal(state.preferences['42'],undefined);
 assert.equal(state.events[0].roleStatus,'superseded');
 const removal=state.events.at(-1);
 assert.deepEqual([removal.userId,removal.roleId,removal.roleAction,removal.roleStatus,removal.forwardStatus,removal.isTest],
  ['42','55','remove','pending','sent',false]);
 assert.ok(removal.retryAt<=1800000000);
 assert.match(f.history.at(-1)[7],/linked.*preference cleared.*does not use Discord.*community role removal queued/);
 assert.equal(f.history.at(-1)[10],'guildsync');
});

test('a manual link clears the roster answer even when no membership preference was saved',async()=>{
 const f=fixture({preference:'',roleId:''});
 const result=await f.clear({method:'manual'});
 assert.deepEqual(result,{cleared:true,rosterOptOutCleared:true,preferenceCleared:false,roleQueued:false});
 assert.equal(f.state().events.length,0,'nothing to queue without a community role');
});

test('an already-cleared roster answer is not reported again',async()=>{
 const f=fixture({preference:'',optOut:false,roleId:'55'});
 const result=await f.clear();
 assert.equal(result.rosterOptOutCleared,false);
 assert.equal(result.preferenceCleared,false);
});

test('fuzzy matches never clear a preference, an opt-out or a role',async()=>{
 for(const method of ['fuzzy','','none']){
  const f=fixture();
  assert.deepEqual(await f.clear({method}),{cleared:false,rosterOptOutCleared:false,preferenceCleared:false,roleQueued:false});
  assert.equal(f.queries.length,0);
  assert.equal(f.state().preferences['42'],'not_playing');
 }
});

test('only exact, manual and self-reported links count as confirmed',()=>{
 for(const method of ['exact','manual','dm-self-report',' MANUAL '])assert.equal(isConfirmedMemberLink('linked',method),true,method);
 for(const method of ['fuzzy','none',''])assert.equal(isConfirmedMemberLink('linked',method),false,method);
 assert.equal(isConfirmedMemberLink('candidate','exact'),false);
});

test('the shared link upsert clears answers only when the pair becomes a confirmed link',()=>{
 const source=fs.readFileSync(new URL('./guildsync-database-actions.js',import.meta.url),'utf8');
 assert.match(source,/await clearMembershipContactForConfirmedLink\(applicationDB, \{ discordUserId, esoAccountName, method: linkMethod \}\)/);
 assert.match(source,/if \(confirmedLink && !pairWasLinked\)/);
 assert.match(source,/if \(\(link\.linkStatus \|\| link\.link_status\) === 'linked'\) await notifyDiscordConfirmedLink/);
});

test('auto-linking skips members marked as not using Discord or not playing ESO',()=>{
 const source=fs.readFileSync(new URL('./guildsync-database-actions.js',import.meta.url),'utf8');
 assert.match(source,/const optOuts = await loadMemberLinkOptOuts\(applicationDB\)/);
 assert.match(source,/linkableDiscordRows = discordRows\.filter/);
 assert.match(source,/optOuts\.esoKeys\.has\(esoAccountKey\(esoName\)\)/);
 assert.match(source,/for \(const discord of linkableDiscordRows\)/);
 const reminders=fs.readFileSync(new URL('./discord-reminders.js',import.meta.url),'utf8');
 assert.match(reminders,/const \[links\]=optOut/);
 assert.match(reminders,/DELETE FROM guildsync_member_links WHERE LOWER\(TRIM\(LEADING '@' FROM eso_account_name\)\)=\? AND auto_link_blocked=0/);
 assert.match(reminders,/'Discord link removed'/);
 assert.match(reminders,/INSERT IGNORE INTO guildsync_roster_events/);
 const membership=fs.readFileSync(new URL('./membership-dms.js',import.meta.url),'utf8');
 assert.match(membership,/DELETE FROM guildsync_member_links WHERE discord_user_id=\? AND auto_link_blocked=0/);
 assert.match(membership,/link_status NOT IN \('blocked','unlinked'\)/);
});
