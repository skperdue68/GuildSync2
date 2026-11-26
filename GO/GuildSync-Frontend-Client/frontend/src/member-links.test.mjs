import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
for(const path of ['./main.js','../../../../NodeJS/GuildSync-Backend-Server/web/src/main.js']){
 const source=readFileSync(new URL(path,import.meta.url),'utf8');
 function fn(name){const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert.ok(start>=0,name);const tail=source.slice(start);const end=tail.slice(1).search(/^(?:async )?function /m);return end<0?tail:tail.slice(0,end+1);}
 test(`${path}: existing fuzzy/blocked targets remain selectable`,()=>{
  for(const status of ['candidate','blocked']){
   const ctx=vm.createContext({canManageGuildSyncLinks:()=>true,memberLinkDialogLoading:false,memberLinkDialogError:'',memberLinkDialogOptions:[{account_name:'Auleric',confidence:88}],memberLinkDialogContext:{mode:'discord-to-eso',discordUserId:'42'},getMemberLinksForDialog:()=>[{link_status:status}],memberLinkPairKeyFromLink:()=> 'auleric::42',normalizeMemberLinkName:s=>s.toLowerCase(),getMemberLinkOptionSortName:o=>o.account_name,renderMemberLinkDialogOption:o=>`<button>${o.account_name}</button>`});
   vm.runInContext(fn('renderMemberLinkDialogOptions'),ctx);assert.match(ctx.renderMemberLinkDialogOptions(),/<button>Auleric<\/button>/);
  }
 });
 test(`${path}: link broadcasts refresh contact preferences even when the ack already updated links`,()=>{
  let loads=0;const ctx=vm.createContext({desktopSupport:{},memberLinks:[],shouldRefreshMemberLinksView:()=>true,updateMemberLinksView(){},loadMembershipDMPreferences(){loads++;}});
  vm.runInContext(fn('handleMemberLinksUpdated'),ctx);ctx.handleMemberLinksUpdated({links:[]});assert.equal(loads,1);
 });
 test(`${path}: preference refresh updates roster views with the modal closed`,async()=>{
  let renders=0;const ctx=vm.createContext({socket:{connected:true},isAuthenticatedSession:()=>true,membershipDMPreferenceLoadPromise:null,membershipDMPreferences:{42:'old'},emitSocketWithAck:async()=>({ok:true,preferences:{}}),memberLinkDialogOpen:false,shouldRefreshMemberLinksView:()=>true,updateMemberLinksView(){renders++;}});
  vm.runInContext(fn('loadMembershipDMPreferences'),ctx);await ctx.loadMembershipDMPreferences();assert.equal(renders,1);assert.equal(Object.keys(ctx.membershipDMPreferences).length,0);
 });
 test(`${path}: a forced preference reload waits for stale requests and coalesces duplicate refreshes`,async()=>{
  const resolvers=[];const ctx=vm.createContext({socket:{connected:true},isAuthenticatedSession:()=>true,membershipDMPreferenceLoadPromise:null,membershipDMPreferences:{},emitSocketWithAck:()=>new Promise(resolve=>resolvers.push(resolve)),shouldRefreshMemberLinksView:()=>false});
  vm.runInContext(fn('loadMembershipDMPreferences'),ctx);
  const first=ctx.loadMembershipDMPreferences();const forced=ctx.loadMembershipDMPreferences({force:true});const duplicate=ctx.loadMembershipDMPreferences({force:true});
  assert.equal(resolvers.length,1);resolvers[0]({ok:true,preferences:{42:'community'}});await first;
  await new Promise(resolve=>setImmediate(resolve));assert.equal(resolvers.length,2);
  resolvers[1]({ok:true,preferences:{}});await Promise.all([forced,duplicate]);assert.equal(Object.keys(ctx.membershipDMPreferences).length,0);
 });
 test(`${path}: manual linking sends the same account/Discord pair from either roster`,async()=>{
  for(const mode of ['discord-to-eso','eso-to-discord']){
   let payload,updates=0,closed=false;const ctx=vm.createContext({memberLinkDialogContext:{mode,esoAccountName:'Auleric',discordUserId:'42'},emitSocketWithAck:async(_,value)=>{payload=value;return {ok:true,links:[{link_status:'linked'}]};},handleMemberLinksUpdated(){updates++;},addSystemMessage(){},TRANSIENT_MESSAGE_TTL_MS:1,closeMemberLinkDialog(){closed=true;},formatError:String,renderGuildSyncTabLayout(){}});
   vm.runInContext(fn('selectMemberLinkDialogOption'),ctx);await ctx.selectMemberLinkDialogOption(mode==='discord-to-eso'?'Auleric':'42');assert.equal(payload.esoAccountName,'Auleric');assert.equal(payload.discordUserId,'42');assert.equal(updates,1);assert.equal(closed,true);
  }
 });

}

