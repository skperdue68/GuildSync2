import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('./main.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
const start=source.indexOf('async function refreshESORunningStatus(');
const end=source.indexOf('\n}',start)+2;
test('an unknown detector state blocks pending writes and refreshes the displayed error',async()=>{
 let writes=0,updates=0,reminderSyncs=0;
 const context=vm.createContext({esoRunningStatus:{running:true,message:''},
  GetESORunningStatus:async()=>({running:false,error:'pgrep failed',message:'GuildSync could not determine whether ESO is running.'}),
  flushPendingDepositMailAckCleanup:async()=>{writes++;},processPendingDepositMailBatches:async()=>{writes++;},
  flushPendingDiscordReminderAckCleanup:async()=>{writes++;},
  uploadGuildSyncChatFromFile:async()=>{},
  discordReminderControls:{sync:async()=>{reminderSyncs++;}},
  addSystemMessage:()=>{},updateBankingDataView:()=>{updates++;},formatError:String,TRANSIENT_MESSAGE_TTL_MS:0});
 vm.runInContext(source.slice(start,end),context);
 await context.refreshESORunningStatus();
 assert.equal(context.esoRunningStatus.running,true);assert.equal(context.esoRunningStatus.error,'pgrep failed');
 assert.equal(writes,0);assert.equal(updates,1);
 assert.equal(reminderSyncs,0);
});
for(const running of [true,false])test(`recovery from detection error to ${running?'running':'stopped'} refreshes status and resumes work only when stopped`,async()=>{
 let writes=0,updates=0,reminderSyncs=0;
 const context=vm.createContext({esoRunningStatus:{running:true,error:'old failure'},
  GetESORunningStatus:async()=>({running,message:running?'Running':'Stopped'}),
  flushPendingDepositMailAckCleanup:async()=>{writes++;},processPendingDepositMailBatches:async()=>{writes++;},
  flushPendingDiscordReminderAckCleanup:async()=>{writes++;},
  uploadGuildSyncChatFromFile:async()=>{},
  discordReminderControls:{sync:async()=>{reminderSyncs++;}},
  addSystemMessage:()=>{},updateBankingDataView:()=>{updates++;},formatError:String,TRANSIENT_MESSAGE_TTL_MS:0});
 vm.runInContext(source.slice(start,end),context);await context.refreshESORunningStatus();
 assert.equal(context.esoRunningStatus.running,running);assert.equal(context.esoRunningStatus.error,'');
 assert.equal(updates,1);assert.equal(writes,running?0:3);
 assert.equal(reminderSyncs,running?0:1);
});

const pollStart=source.indexOf('function startESOStatusPolling(');
const pollEnd=source.indexOf('\n}',pollStart)+2;
function startupChatContext(running){
 const uploads=[];const state={running:true,message:''};
 const context=vm.createContext({esoStatusPollTimer:null,ESO_STATUS_POLL_INTERVAL_MS:1000,
  window:{setInterval:()=>0},clearInterval:()=>{},esoRunningStatus:state,
  refreshESORunningStatus:async()=>{state.running=running;},
  getPendingDepositMailWriteCount:()=>0,processPendingDepositMailBatches:async()=>{},
  uploadGuildSyncChatFromFile:async()=>{uploads.push(1);}});
 vm.runInContext(source.slice(pollStart,pollEnd),context);
 return {context,uploads};
}
for(const running of [true,false])test(`startup polling ${running?'skips':'uploads'} stranded guild chat only after the ESO status is known`,async()=>{
 const {context,uploads}=startupChatContext(running);
 context.startESOStatusPolling();
 assert.equal(uploads.length,0);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(uploads.length,running?0:1);
});
test('socket connection startup leaves the guild chat upload to the ESO status poll',()=>{
 const begin=source.indexOf('function startSupportedDesktopConnection(');
 const body=source.slice(begin,source.indexOf('\n}',begin)+2);
 assert.ok(begin>0);
 assert.ok(!body.includes('uploadGuildSyncChatFromFile'));
});
