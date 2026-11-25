import test from 'node:test';
import assert from 'node:assert/strict';
import {createMembershipDMTestMode} from './membership-dm-test-mode.js';

test('test mode cycles the plan and DMs only the officer without backend writes',async()=>{
 const calls=[],dms=[],timers=[];
 const request=async(action,payload)=>{
  calls.push([action,payload]);
  return {members:[{userId:'10',name:'Alice'},{userId:'20',name:'Zed'}],config:{template:'Hello {name} from {guild}.'}};
 };
 const client={isReady:()=>true,guilds:{fetch:async()=>({name:'Alphabet Mafia'})},
  users:{fetch:async id=>({id,send:async payload=>{dms.push({id,payload});return {id:'m'+dms.length};}})}};
 const mode=createMembershipDMTestMode({client,guildId:'1',request,log:()=>{},
  setIntervalFn:fn=>{timers.push(fn);return {unref(){}};},clearIntervalFn:()=>{}});
 mode.start('officer',{members:2});
 const first=await mode.deliverOne(),second=await mode.deliverOne();
 assert.equal(first.member.name,'Alice');
 assert.equal(second.member.name,'Zed');
 assert.equal(dms.length,2);
 assert.equal(dms[0].id,'officer');
 assert.match(dms[0].payload.content,/^Test mode 1 of 2 — this is what Alice \(10\) would receive\./);
 assert.match(dms[0].payload.content,/Alphabet Mafia/);
 assert.match(dms[1].payload.content,/^Test mode 2 of 2 — this is what Zed \(20\) would receive\./);
 assert.equal(mode.status().lastMember,'Zed');
 assert.equal(mode.status().sent,2);
 assert.ok(calls.every(([action])=>action==='test-plan'));
 assert.equal(timers.length,1);
 assert.equal(mode.isRunning(),true);
 assert.equal(mode.stop(),true);
 assert.equal(mode.isRunning(),false);
 assert.equal((await mode.deliverOne()).status,'stopped');
});
