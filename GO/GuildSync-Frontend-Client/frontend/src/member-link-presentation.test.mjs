import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {renderDiscordNames,getMemberLinkMatchStrength,observeMemberLinkSummary} from './member-discovery.js';

test('presentation uses the same 82% fuzzy-candidate threshold and distinguishes weak scores',()=>{
 for(const [score,strength] of [[100,'exact'],[88,'fuzzy'],[82,'fuzzy'],[81,'low'],[43,'low'],[0,'none'],[NaN,'none']])assert.equal(getMemberLinkMatchStrength(score),strength);
 const weak=renderDiscordNames({server_nickname:'Auleric'},{matchField:'server_nickname',lowSimilarity:true});assert.match(weak,/Low similarity/);assert.doesNotMatch(weak,/Fuzzy match|member-name-match-fuzzy/);
});
test('sticky search offset follows summary height and releases its observer on rerender',()=>{
 let height=190,headerHeight=92,callback,disconnected=false;const observed=[];const values=[];const summary={getBoundingClientRect:()=>({height})};const header={getBoundingClientRect:()=>({height:headerHeight})};const body={querySelector:selector=>selector==='.member-link-current-section'?summary:header,style:{setProperty:(...args)=>values.push(args)}};
 class Observer{constructor(cb){callback=cb;}observe(target){observed.push(target);}disconnect(){disconnected=true;}}
 const stop=observeMemberLinkSummary(body,{ResizeObserverClass:Observer});assert.deepEqual(observed,[summary,header]);assert.deepEqual(values.at(-2),['--member-link-search-height','92px']);assert.deepEqual(values.at(-1),['--member-link-summary-height','190px']);height=120;headerHeight=80;callback();assert.deepEqual(values.at(-2),['--member-link-search-height','80px']);assert.deepEqual(values.at(-1),['--member-link-summary-height','120px']);stop();assert.equal(disconnected,true);
});
for(const path of ['./main.js','../../../../NodeJS/GuildSync-Backend-Server/web/src/main.js']){
 const source=readFileSync(new URL(path,import.meta.url),'utf8');
 function fn(name){const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert.ok(start>=0,name);const tail=source.slice(start);const end=tail.slice(1).search(/^(?:async )?function /m);return end<0?tail:tail.slice(0,end+1);}
 test(`${path}: 43% choices say low similarity without claiming a match`,()=>{
  const ctx=vm.createContext({getMemberLinkMatchStrength,renderDiscordNames,memberLinkDialogContext:{mode:'eso-to-discord'},formatDiscordMatchFieldName:()=> 'Server Nickname',escapeHtml:String,escapeAttribute:String});
  vm.runInContext(fn('renderMemberLinkDialogOption'),ctx);const html=ctx.renderMemberLinkDialogOption({discord_id:'42',server_nickname:'Auleric',confidence:43,matchField:'discord_server_nickname'});
  assert.match(html,/Low similarity/);assert.match(html,/Compared with Server Nickname/);assert.doesNotMatch(html,/Fuzzy match|Matched on|member-name-match-fuzzy/);assert.match(html,/data-member-link-option-value="42"/);
 });
 test(`${path}: strong suggestions and weak manual alternatives are separate groups`,()=>{
  const ctx=vm.createContext({getMemberLinkMatchStrength,canManageGuildSyncLinks:()=>true,memberLinkDialogLoading:false,memberLinkDialogError:'',memberLinkDialogOptions:[{account_name:'Onlesi',confidence:43},{account_name:'Auleric',confidence:88}],memberLinkDialogContext:{mode:'discord-to-eso',discordUserId:'42'},getMemberLinksForDialog:()=>[],normalizeMemberLinkName:s=>s.toLowerCase(),memberLinkPairKeyFromLink:()=>'',getMemberLinkOptionSortName:o=>o.account_name,renderMemberLinkDialogOption:o=>`<button>${o.account_name}</button>`});
  vm.runInContext(fn('renderMemberLinkDialogOptions'),ctx);const html=ctx.renderMemberLinkDialogOptions();assert.match(html,/data-member-link-option-group="suggested"/);assert.match(html,/data-member-link-option-group="other"/);assert.ok(html.indexOf('Auleric')<html.indexOf('Onlesi'));assert.match(html,/manual linking/i);
 });
 test(`${path}: searching weak alternatives keeps manual targets available and hides empty groups`,()=>{
  const rows=[{dataset:{memberLinkOptionSearch:'Auleric'},classList:{remove(){}}},{dataset:{memberLinkOptionSearch:'Onlesi'},classList:{remove(){}}}];const groups=rows.map(row=>({querySelectorAll:()=>[row]}));const empty={hidden:true};
  const ctx=vm.createContext({memberLinkDialogSearchTerm:'Onlesi',normalizeSimpleMemberName:s=>s.toLowerCase(),document:{querySelectorAll:selector=>selector==='[data-member-link-option-group]'?groups:rows,querySelector:()=>empty}});
  vm.runInContext(fn('applyMemberLinkSuggestionFilter'),ctx);ctx.applyMemberLinkSuggestionFilter();assert.equal(rows[1].hidden,false);assert.equal(groups[0].hidden,true);assert.equal(groups[1].hidden,false);assert.equal(empty.hidden,true);
  ctx.memberLinkDialogSearchTerm='Nobody';ctx.applyMemberLinkSuggestionFilter();assert.equal(groups.every(group=>group.hidden),true);assert.equal(empty.hidden,false);
 });

}
