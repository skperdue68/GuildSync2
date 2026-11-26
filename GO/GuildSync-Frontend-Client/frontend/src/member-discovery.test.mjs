import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {discordDisplayName,renderDiscordNames,createMemberHistoryFallback} from './member-discovery.js';
test('Discord server display name falls back nickname, global name, username, ID',()=>{
 assert.equal(discordDisplayName({server_nickname:'Auleric (Joey)',global_name:'Joey',username:'joey123'}),'Auleric (Joey)');
 assert.equal(discordDisplayName({server_nickname:' ',global_name:'Joey',username:'joey123'}),'Joey');
 assert.equal(discordDisplayName({username:'joey123'}),'joey123');assert.equal(discordDisplayName({discord_id:'42'}),'42');
});
test('all three names are labelled and only the matched field is highlighted, including fuzzy matches',()=>{
 const html=renderDiscordNames({username:'joey123',global_name:'Joey',server_nickname:'Auleric (Joey)'},{matchField:'discord_server_nickname',fuzzy:true});
 assert.match(html,/Username/);assert.match(html,/Global Name/);assert.match(html,/Server Nickname/);assert.match(html,/member-name-match-fuzzy[^>]*>Auleric \(Joey\)<\/mark>/);assert.equal((html.match(/<mark /g)||[]).length,1);
 assert.match(renderDiscordNames({username:'<script>'},{matchField:'discord_username'}),/&lt;script&gt;/);assert.doesNotMatch(renderDiscordNames({}),/<mark /);
});
function fixture(){let callback,ctx={query:'Auleric',tab:'discord-members',session:1,eligible:true};let resolve;const opened=[];let calls=0;const controller=createMemberHistoryFallback({context:()=>ctx,request:()=>{calls++;return new Promise(r=>resolve=r);},open:(...args)=>opened.push(args),setTimer:cb=>{callback=cb;return 1;},clearTimer:()=>{callback=null;}});return {controller,opened,get calls(){return calls;},run:async()=>callback?.(),respond:r=>resolve(r),set:value=>ctx={...ctx,...value}};}
test('empty visible results open history with query and matches after lookup',async()=>{const f=fixture();f.controller.schedule('discord');const pending=f.run();f.respond({ok:true,matches:[{discord_id:'42',event_count:2}]});await pending;assert.equal(f.opened[0][0],'discord');assert.equal(f.opened[0][1].query,'Auleric');assert.equal(f.opened[0][1].matches[0].discord_id,'42');});
test('no history, errors and current visible results do not interrupt search',async()=>{for(const response of [{ok:true,matches:[]},{ok:false,matches:[{}]}]){const f=fixture();f.controller.schedule('discord');const pending=f.run();f.respond(response);await pending;assert.equal(f.opened.length,0);}const f=fixture();f.set({eligible:false});f.controller.schedule('discord');await f.run();assert.equal(f.calls,0);});
test('late responses cannot open history after query, tab or session changes or cancellation',async()=>{for(const change of [{query:'Someone else'},{tab:'settings'},{session:2},{eligible:false},null]){const f=fixture();f.controller.schedule('discord');const pending=f.run();if(change)f.set(change);else f.controller.cancel();f.respond({ok:true,matches:[{discord_id:'42'}]});await pending;assert.equal(f.opened.length,0);}});

test('lookup waits for an in-progress member refresh, then uses the completed list',async()=>{const f=fixture();f.set({loading:true});f.controller.schedule('roster');const waiting=f.run();assert.equal(f.calls,0);await waiting;f.set({loading:false});const pending=f.run();f.respond({ok:true,matches:[{account_name:'Auleric'}]});await pending;assert.equal(f.opened.length,1);});

test('desktop and web use identical member discovery behavior',()=>{assert.equal(readFileSync(new URL('./member-discovery.js',import.meta.url),'utf8'),readFileSync(new URL('../../../../NodeJS/GuildSync-Backend-Server/web/src/member-discovery.js',import.meta.url),'utf8'));});
