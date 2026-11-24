import test from 'node:test';
import assert from 'node:assert/strict';
import {data,execute} from './discord-reminders.js';
test('command registers all campaign controls and an explicit required test recipient',()=>{
 const command=data.toJSON();assert.equal(command.name,'discord-reminders');
 assert.deepEqual(command.options.map(o=>o.name),['start','pause','resume','restart','status','test']);
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
