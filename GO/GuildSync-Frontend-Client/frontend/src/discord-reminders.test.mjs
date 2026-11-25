import test from 'node:test';
import assert from 'node:assert/strict';
import {exportReminderBatch,syncReminderAcks,flushReminderWrites,getPendingReminderWrites,clearPendingReminderWrites,createDiscordReminderControls} from './discord-reminders.js';

test('queues a reminder while ESO runs and writes it after ESO closes',async()=>{
 clearPendingReminderWrites();
 const calls=[];let running=true;
 const request=async payload=>{calls.push(payload.action);return payload.action==='prepare'?{ok:true,records:[{requestId:'r'}]}:{ok:true};};
 const bridge={
  WriteDiscordReminderQueue:async()=>({ok:!running,message:running?'ESO is currently running. Discord reminders were not written yet.':'Written 1'}),
  GetESORunningStatus:async()=>({running})
 };
 const queued=await exportReminderBatch({request,bridge,batchId:'b',account:'@A',world:'NA Megaserver'});
 assert.equal(queued.queued,true);
 assert.deepEqual(calls,['prepare']);
 assert.equal(getPendingReminderWrites().length,1);
 const waiting=await flushReminderWrites({request,bridge});
 assert.equal(waiting.waiting,true);
 assert.deepEqual(calls,['prepare']);
 running=false;
 const flushed=await flushReminderWrites({request,bridge});
 assert.equal(flushed.written,1);
 assert.deepEqual(calls,['prepare','exported']);
 assert.equal(getPendingReminderWrites().length,0);
});
test('reminder write watcher retains queued work while ESO detection is unknown',async()=>{
 clearPendingReminderWrites();
 let failed=true,writes=0;
 const request=async payload=>payload.action==='prepare'?{ok:true,records:[{requestId:'r'}]}:{ok:true};
 const bridge={GetESORunningStatus:async()=>({running:false,error:failed?'pgrep failed':''}),
  WriteDiscordReminderQueue:async()=>{writes++;return failed?{ok:false,message:'GuildSync could not determine whether ESO is running. SavedVariables writes are paused.'}:{ok:true,message:'Written'};}};
 const queued=await exportReminderBatch({request,bridge,batchId:'unknown',account:'@A',world:'NA Megaserver'});
 assert.equal(queued.queued,true);assert.equal(writes,1);
 const waiting=await flushReminderWrites({request,bridge});
 assert.equal(waiting.waiting,true);assert.equal(writes,1);assert.equal(getPendingReminderWrites().length,1);
 failed=false;await flushReminderWrites({request,bridge});
 assert.equal(writes,2);assert.equal(getPendingReminderWrites().length,0);
});
test('a failed detector bridge call does not flush queued reminder writes',async()=>{
 clearPendingReminderWrites();let writes=0;
 const request=async payload=>payload.action==='prepare'?{ok:true,records:[{requestId:'r'}]}:{ok:true};
 const bridge={GetESORunningStatus:async()=>{throw Error('Detector unavailable');},WriteDiscordReminderQueue:async()=>{writes++;return {ok:false,message:'Close ESO completely'};}};
 await exportReminderBatch({request,bridge,batchId:'bridge-error',account:'@A',world:'NA Megaserver'});
 const waiting=await flushReminderWrites({request,bridge});
 assert.equal(waiting.waiting,true);assert.equal(writes,1);
 clearPendingReminderWrites();
});
test('records the export only after SavedVariables write succeeds',async()=>{
 clearPendingReminderWrites();
 const calls=[];
 const request=async payload=>{calls.push(payload.action);return payload.action==='prepare'?{ok:true,records:[{requestId:'r'}]}:{ok:true};};
 const bridge={WriteDiscordReminderQueue:async()=>{calls.push('write');return {ok:true,message:'Written'};}};
 await exportReminderBatch({request,bridge,batchId:'b',account:'@A',world:'NA Megaserver'});
 assert.deepEqual(calls,['prepare','write','exported']);
 assert.equal(getPendingReminderWrites().length,0);
});
test('a failed server confirmation preserves a retryable batch and explains that the file was written',async()=>{
 clearPendingReminderWrites();
 const request=async p=>p.action==='prepare'?{ok:true,records:[]}:{ok:false,message:'offline'};
 await assert.rejects(()=>exportReminderBatch({request,bridge:{WriteDiscordReminderQueue:async()=>({ok:true})},batchId:'b',account:'@A',world:'NA Megaserver'}),/written.*retry/i);
});
test('ack sync sends bounded chunks and reports collection errors',async()=>{
 const acks=Array.from({length:501},(_,i)=>({requestId:String(i)}));let sizes=[];
 await syncReminderAcks({CollectDiscordReminderSavedVars:async()=>({ok:true,acks})},async p=>{sizes.push(p.acks.length);return {ok:true};});
 assert.deepEqual(sizes,[250,250,1]);
 await assert.rejects(()=>syncReminderAcks({CollectDiscordReminderSavedVars:async()=>({ok:false,message:'invalid Lua'})},async()=>({ok:true})),/invalid Lua/);
});
test('acknowledged requests are removed from the add-on mailAck table',async()=>{
 clearPendingReminderWrites();
 const cleaned=[];
 const bridge={
  CollectDiscordReminderSavedVars:async()=>({ok:true,acks:[{requestId:'a',status:'sent'},{requestId:'b',status:'failed'}]}),
  CleanupDiscordReminderMailAcks:async ids=>{cleaned.push(ids);return {ok:true,removedCount:2};}};
 const request=async payload=>({ok:true,confirmed:payload.acks.map(ack=>ack.requestId)});
 const data=await syncReminderAcks(bridge,request);
 assert.deepEqual(cleaned,[['a','b']]);
 assert.equal(data.cleaned,2);
 clearPendingReminderWrites();
});
test('a cleanup refusal never discards the uploaded acknowledgements',async()=>{
 clearPendingReminderWrites();
 const bridge={
  CollectDiscordReminderSavedVars:async()=>({ok:true,acks:[{requestId:'a',status:'sent'}]}),
  CleanupDiscordReminderMailAcks:async()=>({ok:true,removedCount:0,pendingCount:1,message:'ESO is running.'})};
 const request=async()=>({ok:true,confirmed:['a']});
 const data=await syncReminderAcks(bridge,request);
 assert.equal(data.cleaned,0);
 clearPendingReminderWrites();
});
test('acks upload even when ESO refuses a cancelled queue rewrite',async()=>{
 clearPendingReminderWrites();
 const calls=[];
 const bridge={
  CollectDiscordReminderSavedVars:async()=>({ok:true,acks:[{requestId:'c',status:'sent'}],queued:[{requestId:'c'}]}),
  WriteDiscordReminderQueue:async()=>({ok:false,message:'Close ESO completely before writing Discord reminders.'})};
 const request=async payload=>{
  calls.push(payload.action);
  return payload.action==='reconcile'
    ?{ok:true,records:[{requestId:'c',batchId:'b',sendingAccount:'@A',worldName:'NA Megaserver',status:'cancelled'}]}
    :{ok:true};
 };
 const data=await syncReminderAcks(bridge,request);
 assert.deepEqual(calls,['acknowledge','reconcile']);
 assert.equal(data.deferred,1);
 const pending=getPendingReminderWrites();
 assert.equal(pending.length,1);
 assert.equal(pending[0].batchId,'b');
 assert.deepEqual(pending[0].records.map(record=>record.status),['cancelled']);
 clearPendingReminderWrites();
});
test('a genuine queue rewrite failure still surfaces after the acks are saved',async()=>{
 clearPendingReminderWrites();
 const calls=[];
 const bridge={
  CollectDiscordReminderSavedVars:async()=>({ok:true,acks:[{requestId:'c',status:'sent'}],queued:[{requestId:'c'}]}),
  WriteDiscordReminderQueue:async()=>({ok:false,message:'sending account @Absent is absent'})};
 const request=async payload=>{calls.push(payload.action);return payload.action==='reconcile'
  ?{ok:true,records:[{requestId:'c',batchId:'b',sendingAccount:'@A',worldName:'NA Megaserver',status:'cancelled'}]}
  :{ok:true};};
 await assert.rejects(()=>syncReminderAcks(bridge,request),/sending account/);
 assert.deepEqual(calls,['acknowledge','reconcile']);
 assert.equal(getPendingReminderWrites().length,0);
});
test('test export keeps its explicit recipient and normal write/confirmation ordering',async()=>{
 clearPendingReminderWrites();
 let prepare;
 await exportReminderBatch({request:async payload=>{if(payload.action==='prepare')prepare=payload;return {ok:true,records:[]};},
  bridge:{WriteDiscordReminderQueue:async()=>({ok:true})},batchId:'b',account:'@Officer',world:'NA Megaserver',testRecipient:'@Tester'});
 assert.equal(prepare.testRecipient,'@Tester');
});

test('sync summarizes saved delivery results for the file watcher',async()=>{
 clearPendingReminderWrites();
 const controls=createDiscordReminderControls({
  request:async payload=>payload.action==='access'?{ok:true,officer:true}:{ok:true},
  bridge:{WriteDiscordReminderQueue:async()=>({ok:true}),
   CollectDiscordReminderSavedVars:async()=>({ok:true,acks:[{status:'sent'},{status:'sent'},{status:'failed'},{status:'uncertain'}]})},
  canEdit:()=>true,changed:async()=>{}});
 assert.equal(await controls.sync(),null);
 await controls.refreshAccess();
 assert.deepEqual(await controls.sync(),{acks:4,sent:2,failed:1,uncertain:1,deferred:0,cleaned:0});
});
