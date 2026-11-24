import test from 'node:test';
import assert from 'node:assert/strict';
import {exportReminderBatch,syncReminderAcks,flushReminderWrites,getPendingReminderWrites,clearPendingReminderWrites} from './discord-reminders.js';

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
test('test export keeps its explicit recipient and normal write/confirmation ordering',async()=>{
 clearPendingReminderWrites();
 let prepare;
 await exportReminderBatch({request:async payload=>{if(payload.action==='prepare')prepare=payload;return {ok:true,records:[]};},
  bridge:{WriteDiscordReminderQueue:async()=>({ok:true})},batchId:'b',account:'@Officer',world:'NA Megaserver',testRecipient:'@Tester'});
 assert.equal(prepare.testRecipient,'@Tester');
});
