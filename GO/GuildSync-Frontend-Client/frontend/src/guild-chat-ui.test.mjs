import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGuildChatPanel} from './guild-chat-panel.js';
for(const path of ['./main.js','../../../../NodeJS/GuildSync-Backend-Server/web/src/main.js']){
 const source=readFileSync(new URL(path,import.meta.url),'utf8');
 function fn(name){const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert.ok(start>=0,name);const tail=source.slice(start);const end=tail.slice(1).search(/^(?:async )?function /m);return end<0?tail:tail.slice(0,end+1);}
 test(`${path}: Guild Chat follows roster and precedes banking without changing existing IDs`,()=>{const ctx=vm.createContext({});vm.runInContext(source.match(/const GUILDSYNC_TABS = \[[\s\S]*?\];/)[0]+'\nthis.tabs=GUILDSYNC_TABS;',ctx);assert.deepEqual(Array.from(ctx.tabs,x=>x.id),['discord-members','eso-members','guild-chat','more','settings','admin']);});
 test(`${path}: routine layout updates keep the iframe mounted and still update modal overlays`,()=>{
  let replacements=0,overlayUpdates=0,wires=0;const frame={id:'retained-frame'},overlays={set innerHTML(value){assert.equal(value,'modal');overlayUpdates++;}};
  const content={querySelector:selector=>selector==='.guild-chat-panel'?frame:selector==='.guild-chat-overlays'?overlays:null,set innerHTML(_){replacements++;}};
  const ctx={desktopSupport:{blocked:false},activeGuildSyncTab:'guild-chat',memberLinksReportDialogOpen:false,document:{querySelector:selector=>selector==='#guildSyncTabContent'?content:null},captureGuildSyncScrollPosition:()=>()=>{},renderGuildSyncTabOverlays:()=> 'modal',renderGuildSyncTabContent:()=> 'new panel',socket:null,guildSyncSession:null,memberLinks:[],memberLinksLoading:true,bankingEntries:[],raffleBonusSettings:{},raffleBonusSettingsRequested:true};
  for(const name of new Set([...source.matchAll(/\b(wire\w+|restore\w+|refresh\w+|captureMemberLinksReportScrollPosition)\(/g)].map(m=>m[1])))ctx[name]=()=>{};
  ctx.wireGuildChatPanel=()=>wires++;vm.createContext(ctx);vm.runInContext(fn('renderGuildSyncTabLayout'),ctx);ctx.renderGuildSyncTabLayout();ctx.renderGuildSyncTabLayout();assert.equal(replacements,0);assert.equal(overlayUpdates,2);assert.equal(wires,2);ctx.activeGuildSyncTab='settings';ctx.renderGuildSyncTabLayout();assert.equal(replacements,1);
 });
 test(`${path}: initial and restored chat views receive viewport sizing before further updates`,()=>{
  const toggles=[];let wires=0;const host={classList:{toggle:(name,on)=>toggles.push(['host',name,on])}};const content={classList:{toggle:(name,on)=>toggles.push(['content',name,on])},closest:()=>host};
  const ctx=vm.createContext({activeGuildSyncTab:'guild-chat',document:{querySelector:()=>content},guildChatPanel:{wire(){wires++;}}});vm.runInContext(fn('wireGuildChatPanel'),ctx);ctx.wireGuildChatPanel();assert.deepEqual(toggles,[['content','guild-chat-active',true],['host','guild-chat-active',true]]);ctx.activeGuildSyncTab='eso-members';ctx.wireGuildChatPanel();assert.deepEqual(toggles.slice(-2),[['content','guild-chat-active',false],['host','guild-chat-active',false]]);assert.equal(wires,2);
 });

}
test('desktop and web share the same iframe and external-link implementation',()=>{assert.equal(readFileSync(new URL('./guild-chat-panel.js',import.meta.url),'utf8'),readFileSync(new URL('../../../../NodeJS/GuildSync-Backend-Server/web/src/guild-chat-panel.js',import.meta.url),'utf8'));});
