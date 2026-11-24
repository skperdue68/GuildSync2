import test from 'node:test';
import assert from 'node:assert/strict';
import {data,execute} from './discord-reminders.js';
test('command registers all campaign controls and an explicit required test recipient',()=>{
 const command=data.toJSON();assert.equal(command.name,'discord-reminders');
 assert.deepEqual(command.options.map(o=>o.name),['start','pause','resume','restart','status','resolve','test']);
 assert.equal(command.options.find(o=>o.name==='test').options[0].required,true);
});
test('test command sends only to the chosen user and reports the real outcome',async()=>{
 const calls=[],replies=[];
 const interaction={guildId:'1',memberPermissions:{has:()=>true},user:{id:'officer'},
  options:{getSubcommand:()=>'test',getUser:()=>({id:'10',username:'Target'})},
  client:{membershipDM:{test:async(...args)=>{calls.push(args);return {status:'sent'};}}},
  deferReply:async()=>{},editReply:async reply=>replies.push(reply)};
 await execute(interaction,{});assert.deepEqual(calls,[['officer','10']]);assert.match(replies[0],/Test DM sent to Target/);
 interaction.memberPermissions.has=()=>false;await execute(interaction,{});assert.equal(calls.length,1);
});
test('resolve records whether an uncertain DM arrived and reports the outcome',async()=>{
 const resolve=data.toJSON().options.find(o=>o.name==='resolve');
 assert.equal(resolve.options.find(o=>o.name==='user').required,true);
 assert.deepEqual(resolve.options.find(o=>o.name==='outcome').choices.map(choice=>choice.value),['sent','retry']);
 const replies=[];
 const socket={connected:true,timeout:()=>({emit:(event,payload,callback)=>{assert.equal(event,'guildsync:membership-dm');
  assert.deepEqual(payload,{guildId:'1',action:'resolve',actorId:'officer',userId:'10',outcome:'retry'});
  callback(null,{ok:true,result:{message:'Cleared the uncertain delivery and requeued this member for the current campaign.'}});}})};
 const interaction={guildId:'1',memberPermissions:{has:()=>true},user:{id:'officer'},
  options:{getSubcommand:()=>'resolve',getUser:()=>({id:'10'}),getString:()=>'retry'},
  deferReply:async()=>{},editReply:async reply=>replies.push(reply)};
 await execute(interaction,socket);
 assert.match(replies[0].content,/requeued/);assert.deepEqual(replies[0].allowedMentions.parse,[]);
});
