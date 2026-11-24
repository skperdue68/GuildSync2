import test from 'node:test';
import assert from 'node:assert/strict';
import {data,execute} from './discord-reminders.js';
test('command registers all campaign controls and an explicit required test recipient',()=>{
 const command=data.toJSON();assert.equal(command.name,'discord-reminders');
 assert.deepEqual(command.options.map(o=>o.name),['start','pause','resume','restart','status','resolve','test','test-mode','test-mode-stop']);
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

test('test mode reads a read-only plan, simulates to the officer, and can be stopped',async()=>{
 const replies=[],started=[],stopped=[];
 const socket={connected:true,timeout:()=>({emit:(event,payload,callback)=>{
  assert.equal(event,'guildsync:membership-dm');
  assert.deepEqual(payload,{guildId:'1',action:'test-plan',actorId:'officer'});
  callback(null,{ok:true,result:{members:[{userId:'10',name:'Alice'},{userId:'20',name:'Zed'}],config:{template:'Hi {name}'}}});
 }})};
 const mode={start:(actor,options)=>started.push([actor,options]),deliverOne:async()=>({status:'sent',member:{name:'Alice'}}),
  stop:()=>{stopped.push(true);return true;},isRunning:()=>false};
 const interaction={guildId:'1',memberPermissions:{has:()=>true},user:{id:'officer'},client:{membershipDMTestMode:mode},
  options:{getSubcommand:()=>'test-mode',getUser:()=>null,getString:()=>null},deferReply:async()=>{},editReply:async reply=>replies.push(reply)};
 await execute(interaction,socket);
 assert.deepEqual(started,[['officer',{members:2}]]);
 assert.match(replies[0].content,/every 30 seconds/);
 assert.match(replies[0].content,/Alice/);
 assert.deepEqual(replies[0].allowedMentions.parse,[]);
 interaction.options.getSubcommand=()=>'test-mode-stop';
 await execute(interaction,socket);
 assert.equal(stopped.length,1);
 assert.match(replies[1],/stopped/i);
});
