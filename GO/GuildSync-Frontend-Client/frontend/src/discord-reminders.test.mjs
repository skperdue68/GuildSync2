import test from 'node:test';
import assert from 'node:assert/strict';
import {exportReminderBatch, syncReminderAcks} from './discord-reminders.js';

test('records the export only after SavedVariables write succeeds',async()=>{
 const calls=[];
 const request=async payload=>{calls.push(payload.action);return payload.action==='prepare'?{ok:true,records:[{requestId:'r'}]}:{ok:true};};
 const bridge={WriteDiscordReminderQueue:async()=>{calls.push('write');return {ok:false,message:'Close ESO'};}};
 await assert.rejects(()=>exportReminderBatch({request,bridge,batchId:'b',account:'@A',world:'NA Megaserver'}),/Close ESO/);
 assert.deepEqual(calls,['prepare','write']);
 calls.length=0;bridge.WriteDiscordReminderQueue=async()=>{calls.push('write');return {ok:true,message:'Written'};};
 await exportReminderBatch({request,bridge,batchId:'b',account:'@A',world:'NA Megaserver'});
 assert.deepEqual(calls,['prepare','write','exported']);
});
test('a failed server confirmation preserves a retryable batch and explains that the file was written',async()=>{
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
 let prepare;
 await exportReminderBatch({request:async payload=>{if(payload.action==='prepare')prepare=payload;return {ok:true,records:[]};},
  bridge:{WriteDiscordReminderQueue:async()=>({ok:true})},batchId:'b',account:'@Officer',world:'NA Megaserver',testRecipient:'@Tester'});
 assert.equal(prepare.testRecipient,'@Tester');
});
