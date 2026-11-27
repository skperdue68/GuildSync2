import test from 'node:test';
import assert from 'node:assert/strict';
import {createGuildChatPanel,GUILD_CHAT_URL,GUILD_CHAT_EMBED_URL} from './guild-chat-panel.js';
test('desktop embeds the explicit layout but opens the original site in the browser once',async()=>{
 const calls=[];const panel=createGuildChatPanel({openExternal:async url=>calls.push(url)});const html=panel.render();assert.match(html,/title="Alphabet Mafia guild chat archive"/);assert.ok(html.includes(`src="${GUILD_CHAT_EMBED_URL}"`));assert.match(html,/Open in browser/);
 let click,wires=0;const button={addEventListener:(_,handler)=>{click=handler;wires++;}};const root={querySelector:()=>button};panel.wire(root);panel.wire(root);await click();assert.equal(wires,1);assert.deepEqual(calls,[GUILD_CHAT_URL]);assert.equal(new URL(calls[0]).search,'');
});
test('web uses a safe new-tab link to the unmodified site',()=>{const html=createGuildChatPanel({web:true}).render();assert.match(html,/Open in new tab/);assert.ok(html.includes(`href="${GUILD_CHAT_URL}"`));assert.match(html,/target="_blank"/);assert.match(html,/rel="noopener noreferrer"/);});
test('desktop browser launch failure is reported without removing the embedded view',async()=>{let click,error;const panel=createGuildChatPanel({openExternal:async()=>{throw Error('Unavailable');},onError:err=>error=err});panel.wire({querySelector:()=>({addEventListener:(_,handler)=>click=handler})});await click();assert.equal(error.message,'Unavailable');assert.match(panel.render(),/<iframe/);});
