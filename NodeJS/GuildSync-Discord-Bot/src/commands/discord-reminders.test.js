import test from 'node:test';
import assert from 'node:assert/strict';
import {data,execute,isReminderOfficer} from './discord-reminders.js';
test('command registers all campaign controls and an explicit required test recipient',()=>{
 const command=data.toJSON();assert.equal(command.name,'membership-dm');
 assert.deepEqual(command.options.map(o=>o.name),['start','pause','resume','restart','status','resolve','repost','test']);
 assert.equal(command.options.find(o=>o.name==='test').options[0].required,true);
});
test('test command sends only to the chosen user and reports the real outcome',async()=>{
 const calls=[],replies=[];
 const interaction={guildId:'1',member:{roles:{cache:[{name:'Kingpin'}]}},user:{id:'officer'},
  options:{getSubcommand:()=>'test',getUser:()=>({id:'10',username:'Target'})},
  client:{membershipDM:{test:async(...args)=>{calls.push(args);return {status:'sent'};}}},
  deferReply:async()=>{},editReply:async reply=>replies.push(reply)};
 await execute(interaction,{});assert.deepEqual(calls,[['officer','10']]);assert.match(replies[0],/Test DM sent to Target/);
 interaction.member={roles:{cache:[{name:'Soldiers'}]}};await execute(interaction,{});assert.equal(calls.length,1);
});
test('resolve records whether an uncertain DM arrived and reports the outcome',async()=>{
 const resolve=data.toJSON().options.find(o=>o.name==='resolve');
 assert.equal(resolve.options.find(o=>o.name==='user').required,true);
 assert.deepEqual(resolve.options.find(o=>o.name==='outcome').choices.map(choice=>choice.value),['sent','retry']);
 const replies=[];
 const socket={connected:true,timeout:()=>({emit:(event,payload,callback)=>{assert.equal(event,'guildsync:membership-dm');
  assert.deepEqual(payload,{guildId:'1',action:'resolve',actorId:'officer',userId:'10',outcome:'retry'});
  callback(null,{ok:true,result:{message:'Cleared the uncertain delivery and requeued this member for the current campaign.'}});}})};
 const interaction={guildId:'1',member:{roles:{cache:[{name:'Kingpin'}]}},user:{id:'officer'},
  options:{getSubcommand:()=>'resolve',getUser:()=>({id:'10'}),getString:()=>'retry'},
  deferReply:async()=>{},editReply:async reply=>replies.push(reply)};
 await execute(interaction,socket);
 assert.match(replies[0].content,/requeued/);assert.deepEqual(replies[0].allowedMentions.parse,[]);
});

test('repost asks the backend for the stored reply and sends it in the card format',async()=>{
 const calls=[],replies=[];
 const socket={connected:true,timeout:()=>({emit:(event,payload,callback)=>{calls.push(payload);
  callback(null,{ok:true,result:{response:{userId:'10',name:'Member',choice:'other',text:'Hi',at:100,result:{status:'review'}},destinationType:'channel',destinationId:'99'}});}})};
 const interaction={guildId:'1',member:{displayName:'Officer',roles:{cache:[{name:'Consigliere'}]}},user:{id:'officer',username:'officer'},
  options:{getSubcommand:()=>'repost',getUser:()=>({id:'10',username:'Target'})},
  client:{membershipDM:{repost:async(result,name)=>{calls.push([result,name]);return {id:'200'};}}},
  deferReply:async()=>{},editReply:async reply=>replies.push(reply)};
 await execute(interaction,socket);
 assert.deepEqual(calls[0],{guildId:'1',action:'repost',actorId:'officer',userId:'10'});
 assert.equal(calls[1][1],'Officer');
 assert.match(replies[0].content,/Reposted Target's latest stored membership reply/);
});

test('a Discord error from a membership command is reported in plain words',async()=>{
 const replies=[];
 const socket={connected:true,timeout:()=>({emit:(event,payload,callback)=>callback(null,{ok:true,
  result:{response:{userId:'10',name:'Member',choice:'other',text:'',at:1,result:{status:'review'}},
    destinationType:'channel',destinationId:'99'}})})};
 const interaction={guildId:'1',member:{displayName:'Officer',roles:{cache:[{name:'Kingpin'}]}},user:{id:'officer',username:'officer'},
  options:{getSubcommand:()=>'repost',getUser:()=>({id:'10',username:'Target'})},
  client:{membershipDM:{repost:async()=>{throw Object.assign(Error('DiscordAPIError[10003]: Unknown Channel'),{code:10003});}}},
  deferReply:async()=>{},editReply:async reply=>replies.push(reply)};
 await execute(interaction,socket);
 assert.match(replies[0],/cannot reach that channel or role/);
 assert.doesNotMatch(replies[0],/DiscordAPIError|10003/);
});
test('reminder commands require the Consigliere or Kingpin role',async()=>{
 assert.equal(isReminderOfficer({roles:{cache:[{name:' consigliere '}]}}),true);
 assert.equal(isReminderOfficer({roles:{cache:[{name:'Kingpins'}]}}),true);
 for(const name of ['Soldiers','Capo','Associates','Decorative',undefined])assert.equal(isReminderOfficer({roles:{cache:[{name}]}}),false);
 assert.equal(isReminderOfficer(undefined),false);
 assert.equal(data.toJSON().default_member_permissions,undefined);
 const replies=[];
 const interaction={guildId:'1',member:{roles:{cache:[{name:'Capo'}]}},user:{id:'10'},
  options:{getSubcommand:()=>'status',getUser:()=>null},client:{membershipDM:{test:async()=>{throw Error('must not run');}}},
  deferReply:async()=>{},editReply:async reply=>replies.push(reply)};
 await execute(interaction,{});assert.match(replies[0],/Consigliere or Kingpin role/);
});
