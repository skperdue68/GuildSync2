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
  processPendingGuildSyncChatUpload:async()=>{},
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
  processPendingGuildSyncChatUpload:async()=>{},
  discordReminderControls:{sync:async()=>{reminderSyncs++;}},
  addSystemMessage:()=>{},updateBankingDataView:()=>{updates++;},formatError:String,TRANSIENT_MESSAGE_TTL_MS:0});
 vm.runInContext(source.slice(start,end),context);await context.refreshESORunningStatus();
 assert.equal(context.esoRunningStatus.running,running);assert.equal(context.esoRunningStatus.error,'');
 assert.equal(updates,1);assert.equal(writes,running?0:3);
 assert.equal(reminderSyncs,running?0:1);
});
