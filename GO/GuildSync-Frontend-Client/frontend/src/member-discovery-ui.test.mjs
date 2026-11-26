import {discordDisplayName,renderDiscordNames} from './member-discovery.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
for(const path of ['./main.js','../../../../NodeJS/GuildSync-Backend-Server/web/src/main.js']){
 const source=readFileSync(new URL(path,import.meta.url),'utf8');
 function fn(name){const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert.ok(start>=0,name);const tail=source.slice(start);const end=tail.slice(1).search(/^(?:async )?function /m);return end<0?tail:tail.slice(0,end+1);}
 test(`${path}: selecting a main tab dismisses history and navigates, even to the current tab`,()=>{
  for(const next of ['discord-members','eso-members','more','settings']){
   let closed=0,renders=0,cancelled=0;const ctx=vm.createContext({GUILDSYNC_TABS:[{id:'discord-members'},{id:'eso-members'},{id:'more'},{id:'settings'}],activeGuildSyncTab:'discord-members',discordHistoryDialogOpen:true,rosterHistoryDialogOpen:false,bankingHistoryDialogOpen:false,isBlockingModalOpen:options=>!options?.ignoreHistory,closeHistoryDialogsForNavigation(){closed++;},memberHistoryFallback:{cancel(){cancelled++;}},refreshActiveTabData(){},renderGuildSyncTabLayout(){renders++;}});
   vm.runInContext(fn('navigateGuildSyncTab'),ctx);ctx.navigateGuildSyncTab(next);assert.equal(ctx.activeGuildSyncTab,next);assert.equal(closed,1);assert.equal(cancelled,1);assert.equal(renders,1);
  }
 });
 test(`${path}: confirmation and editing dialogs still block tab changes`,()=>{const ctx=vm.createContext({GUILDSYNC_TABS:[{id:'settings'}],activeGuildSyncTab:'discord-members',isBlockingModalOpen:()=>true});vm.runInContext(fn('navigateGuildSyncTab'),ctx);ctx.navigateGuildSyncTab('settings');assert.equal(ctx.activeGuildSyncTab,'discord-members');});
 test(`${path}: Discord choices show every name and emphasize the matching name in either direction`,()=>{
  const member={discord_id:'42',username:'joey123',global_name:'Joey',server_nickname:'Auleric (Joey)'};
  for(const mode of ['discord-to-eso','eso-to-discord']){
   const ctx=vm.createContext({memberLinkDialogContext:{mode,discordUserId:'42'},discordMembers:[member],formatDiscordMatchFieldName:()=> 'Server Nickname',renderDiscordNames,escapeHtml:String,escapeAttribute:String});
   vm.runInContext(fn('renderMemberLinkDialogOption'),ctx);const html=ctx.renderMemberLinkDialogOption({...member,account_name:'Auleric',rank:'Member',confidence:88,matchField:'discord_server_nickname'});
   assert.match(html,/Username:<\/span> <span>joey123/);assert.match(html,/Global Name:<\/span> <span>Joey/);assert.match(html,/member-name-match-fuzzy[^>]*>Auleric \(Joey\)/);
  }
 });
 test(`${path}: display-name sorting and row retain the three individual names`,()=>{
  const ctx=vm.createContext({discordDisplayName,getDiscordMemberAvatarURL:()=>'',getMemberSortName:discordDisplayName,discordRoles:[],getDiscordMemberColor:()=> '#fff',escapeHtml:String,escapeAttribute:String,getInitials:()=> 'A',renderMemberHistoryButton:()=>'',renderMemberLinkStatusButton:()=>''});
  vm.runInContext(fn('getDiscordSortValue')+'\n'+fn('renderDiscordMemberRow'),ctx);const member={discord_id:'42',server_nickname:'Auleric (Joey)',global_name:'Joey',username:'joey123'};
  assert.equal(ctx.getDiscordSortValue(member,'display_name'),'Auleric (Joey)');const html=ctx.renderDiscordMemberRow(member);assert.equal((html.match(/<td[ >]/g)||[]).length,7);assert.match(html,/<td>joey123<\/td>/);assert.match(html,/<td>Joey<\/td>/);assert.match(html,/<td>Auleric \(Joey\)<\/td>/);
 });
 test(`${path}: closing history for navigation invalidates every request and timer`,()=>{
  const cleared=[];const ctx=vm.createContext({clearTimeout:id=>cleared.push(id),rosterHistorySearchTimer:1,discordHistorySearchTimer:2,bankingHistorySearchTimer:3,rosterHistorySearchGeneration:0,rosterHistoryLoadGeneration:0,discordHistorySearchGeneration:0,discordHistoryLoadGeneration:0,bankingHistoryGeneration:0,esoAccountRename:{reset(){}}});
  vm.runInContext(fn('closeHistoryDialogsForNavigation'),ctx);ctx.closeHistoryDialogsForNavigation();assert.deepEqual(cleared,[1,2,3]);for(const key of ['rosterHistorySearchGeneration','rosterHistoryLoadGeneration','discordHistorySearchGeneration','discordHistoryLoadGeneration','bankingHistoryGeneration'])assert.equal(ctx[key],1);assert.equal(ctx.rosterHistoryDialogOpen,false);assert.equal(ctx.discordHistoryDialogOpen,false);assert.equal(ctx.bankingHistoryDialogOpen,false);
 });

}
