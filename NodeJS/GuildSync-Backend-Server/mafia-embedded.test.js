import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('./mafia/embedded.js',import.meta.url),'utf8');
function fixture(query,readyState='complete'){
 const moved=[],classes=[];const nodes={'follow-button':{id:'follow-button'},'refresh-button':{id:'refresh-button'},'embedded-actions':{append(...items){moved.push(...items);}}};let ready;
 const document={readyState,documentElement:{classList:{add:name=>classes.push(name)}},getElementById:id=>nodes[id],addEventListener:(name,fn)=>{assert.equal(name,'DOMContentLoaded');ready=fn;}};
 vm.runInNewContext(source,{URL,document,window:{location:{href:'https://mafia.perdues.me/'+query}}});return {moved,classes,nodes,ready:()=>ready?.()};
}
test('standalone and other query values leave the website untouched',()=>{for(const query of ['', '?embedded=0','?embedded=true','?other=1']){const f=fixture(query);assert.deepEqual(f.classes,[]);assert.deepEqual(f.moved,[]);}});
test('embedded=1 hides branding through a scoped class and moves existing controls in order',()=>{const f=fixture('?embedded=1');assert.deepEqual(f.classes,['guild-chat-embedded']);assert.deepEqual(f.moved,[f.nodes['follow-button'],f.nodes['refresh-button']]);});
test('embedded layout waits for body controls while setting its class before paint',()=>{const f=fixture('?embedded=1','loading');assert.deepEqual(f.classes,['guild-chat-embedded']);assert.equal(f.moved.length,0);f.ready();assert.equal(f.moved[0],f.nodes['follow-button']);});
