import test from 'node:test';
import assert from 'node:assert/strict';
import {createDMCampaignEngine,dmConfig,membershipDMManaged} from './membership-dms.js';

function fixture(random=()=>0) {
 let time=10000000;
 const engine=createDMCampaignEngine({now:()=>time,random});
 const state={history:{},preferences:{},events:[]};
 const advance=seconds=>time+=seconds;
 const members=[{id:'2',name:'Zebra'},{id:'3',name:'alice'},{id:'1',name:'Alice'}];
 return {engine,state,advance,members};
}
test('alphabetic queue, cooldown skips without delay, persistent interval and no catch-up bursts',()=>{
 const {engine,state,advance,members}=fixture();
 state.history['1']={sentAt:10000000};
 engine.start(state,members,30);
 assert.equal(engine.claim(state,members,30),null);
 advance(600);let job=engine.claim(state,members,30);
 assert.equal(job.userId,'3');assert.equal(state.campaign.lastAttempted.name,'alice');
 engine.finish(state,job.id,job.token,{status:'sent',messageId:'m'});
 assert.equal(state.history['3'].sentAt,10000600);
 assert.equal(engine.claim(state,members,30),null);
 advance(100000);job=engine.claim(state,members,30);assert.equal(job.userId,'2');
 engine.finish(state,job.id,job.token,{status:'failed'});
 assert.ok(state.campaign.nextAt>=10101200);
});
test('random bounds, pause/resume and stale sends are uncertain instead of resent',()=>{
 for(const [random,delay]of [[()=>0,600],[()=>0.999999,900]]) {
  const {engine,state,advance,members}=fixture(random);
  engine.start(state,members,30);assert.equal(state.campaign.nextAt,10000000+delay);
  engine.pause(state);advance(2000);assert.equal(engine.claim(state,members,30),null);
  engine.resume(state);assert.equal(engine.claim(state,members,30),null);
  advance(delay);const job=engine.claim(state,members,30);assert.ok(job);
  advance(1000);const next=engine.claim(state,members,30);
  assert.notEqual(next?.id,job.id);assert.equal(state.campaign.queue[0].status,'uncertain');
 }
});
test('nonmembers, opt-outs and recently sent users are rechecked at delivery time',()=>{
 const {engine,state,advance,members}=fixture();engine.start(state,members,30);advance(600);
 state.preferences['1']='community';state.history['3']={sentAt:10000599};
 const job=engine.claim(state,members,30);assert.equal(job.userId,'2');
 engine.finish(state,job.id,job.token,{status:'skipped'});
 assert.equal(state.campaign.nextAt,10000600);
});
test('restart retains send history and community preferences',()=>{
 const {engine,state,advance,members}=fixture();engine.start(state,members,30);advance(600);
 const job=engine.claim(state,members,30);engine.finish(state,job.id,job.token,{status:'sent',messageId:'m'});
 state.preferences['3']='not_playing';engine.start(state,members,30,true);
 assert.deepEqual(state.campaign.queue.map(q=>q.userId),['2']);
});
test('config rejects missing destination and invalid cooldown, renders supported placeholders only',()=>{
 assert.throws(()=>dmConfig({GUILDSYNC_MEMBERSHIP_DM_ENABLED:'true'}));
 assert.throws(()=>dmConfig({GUILDSYNC_MEMBERSHIP_DM_REPEAT_DAYS:'0'}));
 assert.equal(dmConfig({}).repeatDays,30);
});
test('next slot is paced from actual successful completion, not an earlier claim',()=>{
 const {engine,state,advance,members}=fixture();engine.start(state,members,30);advance(600);
 const job=engine.claim(state,members,30);advance(100);
 engine.finish(state,job.id,job.token,{status:'sent',messageId:'message'});
 assert.equal(state.campaign.nextAt,10001300);
});
test('only confirmed, ambiguous or preferred contacts suppress onboarding reminders',async()=>{
 const managed=state=>membershipDMManaged({execute:async()=>[[{state_json:JSON.stringify(state)}]]},'1','10');
 assert.equal(await managed({history:{10:{lastAttemptAt:1,deliveryId:'job'}},preferences:{}}),false);
 assert.equal(await managed({history:{10:{uncertain:false}},preferences:{},campaign:{queue:[{userId:'10',status:'pending'}]}}),false);
 assert.equal(await managed({history:{10:{sentAt:1}},preferences:{}}),true);
 assert.equal(await managed({history:{10:{uncertain:true}},preferences:{}}),true);
 assert.equal(await managed({history:{},preferences:{10:'community'}}),true);
});
