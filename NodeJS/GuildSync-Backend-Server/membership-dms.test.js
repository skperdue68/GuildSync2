import test from 'node:test';
import assert from 'node:assert/strict';
import {createDMCampaignEngine,dmConfig,membershipDMManaged,pruneMembershipState} from './membership-dms.js';

function fixture(random=()=>0) {
 let time=10000000;
 const engine=createDMCampaignEngine({now:()=>time,random});
 const state={results:{},preferences:{},events:[]};
 const advance=seconds=>time+=seconds;
 const members=[{id:'2',name:'Zebra'},{id:'3',name:'alice'},{id:'1',name:'Alice'}];
 return {engine,state,advance,members};
}
test('alphabetic queue, cooldown skips without delay, persistent interval and no catch-up bursts',()=>{
 const {engine,state,advance,members}=fixture();
 state.results['1']={sentAt:10000000};
 engine.start(state,members,30);
 assert.equal(engine.claim(state,members,30),null);
 advance(600);let job=engine.claim(state,members,30);
 assert.equal(job.userId,'3');assert.equal(state.campaign.lastAttempted.name,'alice');
 engine.finish(state,job.id,job.token,{status:'sent',messageId:'m'});
 assert.equal(state.results['3'].sentAt,10000600);
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
 state.preferences['1']='community';state.results['3']={sentAt:10000599};
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
test('the default membership DM explains the status check, the no-removal promise and how to link',()=>{
 const template=dmConfig({}).template;
 assert.match(template,/Hello \{name\},/);
 assert.match(template,/updating our membership records/);
 assert.match(template,/Some areas may be reserved for current guild members/);
 assert.match(template,/provide your ESO account name, including @/);
 assert.match(template,/matching your Discord nickname/i);
 assert.match(template,/not required/);
 assert.match(template,/Your responses will be forwarded to guild officers\./);
 assert.match(template,/--\{guild\} Consigliere/);
 assert.match(template,/\{suggested_link\}/);
 assert.ok(template.length<=1500);
 assert.equal(dmConfig({GUILDSYNC_MEMBERSHIP_DM_MESSAGE:'Hi {suggested_link}'}).template,'Hi {suggested_link}');
 assert.throws(()=>dmConfig({GUILDSYNC_MEMBERSHIP_DM_MESSAGE:'Hi {secret}'}),/Unknown membership DM placeholder/);
});
test('a fuzzy candidate is offered with the DM and blank when there is none',()=>{
 const {engine,state,advance}=fixture();
 const members=[{id:'1',name:'Alice',suggestedEsoAccountName:'@Alice'},{id:'2',name:'Bob'}];
 engine.start(state,members,30);advance(600);
 const job=engine.claim(state,members,30);
 assert.equal(job.suggestedEsoAccountName,'@Alice');
 assert.equal(state.campaign.queue.find(entry=>entry.userId==='2').suggestedEsoAccountName,'');
});
test('next slot is paced from actual successful completion, not an earlier claim',()=>{
 const {engine,state,advance,members}=fixture();engine.start(state,members,30);advance(600);
 const job=engine.claim(state,members,30);advance(100);
 engine.finish(state,job.id,job.token,{status:'sent',messageId:'message'});
 assert.equal(state.campaign.nextAt,10001300);
});
test('settled responses are pruned so guild state stays bounded',()=>{
 const state={preferences:{},events:[]};
 for(let index=0;index<205;index++)state.events.push({eventId:String(index),forwardStatus:index<150?'sent':'pending',roleStatus:'sent'});
 pruneMembershipState(state);
 assert.equal(state.events.length,200);
 assert.equal(state.events[0].eventId,'5');
 assert.equal(state.events.at(-1).eventId,'204');
 const pending={preferences:{},events:Array.from({length:205},(_,index)=>({eventId:String(index),forwardStatus:'pending',roleStatus:'sent'}))};
 pruneMembershipState(pending);
 assert.equal(pending.events.length,205,'unforwarded responses are never dropped');
});
test('only confirmed, ambiguous or preferred contacts suppress onboarding reminders',async()=>{
 const managed=(state,result=null)=>membershipDMManaged({execute:async sql=>sql.startsWith('SELECT state_json')?[[{state_json:JSON.stringify(state)}]]:[[result].filter(Boolean)]},'1','10');
 assert.equal(await managed({preferences:{}},{sent_at:null,uncertain:0}),false);
 assert.equal(await managed({preferences:{},campaign:{queue:[{userId:'10',status:'pending'}]}}),false);
 assert.equal(await managed({preferences:{}},{sent_at:1,uncertain:0}),true);
 assert.equal(await managed({preferences:{}},{sent_at:null,uncertain:1}),true);
 assert.equal(await managed({preferences:{10:'community'}}),true);
});

test('membership DM pacing is configurable and a running campaign adopts a faster window',()=>{
 assert.equal(dmConfig({}).minSeconds,600);assert.equal(dmConfig({}).maxSeconds,900);
 assert.equal(dmConfig({GUILDSYNC_MEMBERSHIP_DM_MIN_SECONDS:'30',GUILDSYNC_MEMBERSHIP_DM_MAX_SECONDS:'30'}).minSeconds,30);
 assert.throws(()=>dmConfig({GUILDSYNC_MEMBERSHIP_DM_MIN_SECONDS:'0'}),/between 10 and 86400/);
 assert.throws(()=>dmConfig({GUILDSYNC_MEMBERSHIP_DM_MIN_SECONDS:'12.5'}),/whole number between 10 and 86400/);
 assert.throws(()=>dmConfig({GUILDSYNC_MEMBERSHIP_DM_MIN_SECONDS:'60',GUILDSYNC_MEMBERSHIP_DM_MAX_SECONDS:'30'}),/at least the minimum/);
 let pace={minSeconds:600,maxSeconds:900},time=1000;
 const engine=createDMCampaignEngine({now:()=>time,random:()=>0,pace:()=>pace});
 const state={history:{},preferences:{},events:[]},members=[{id:'1',name:'Alice'}];
 engine.start(state,members,30);assert.equal(state.campaign.nextAt,1600);
 pace={minSeconds:20,maxSeconds:20};time=1100;
 assert.equal(engine.claim(state,members,30),null);
 assert.equal(state.campaign.nextAt,1120,'a faster window shortens the pending wait');
 time=1120;const job=engine.claim(state,members,30);assert.equal(job.userId,'1');
 assert.equal(state.campaign.nextAt,1140);
 pace={minSeconds:600,maxSeconds:900};
 assert.equal(engine.claim(state,members,30),null);
 assert.equal(state.campaign.nextAt,1140,'a slower window never extends an existing wait');
});
