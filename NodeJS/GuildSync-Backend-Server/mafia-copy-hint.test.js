import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const html=readFileSync(new URL('./mafia/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('./mafia/styles.css',import.meta.url),'utf8');
test('copy instruction occupies the existing Message heading rather than a floating footer',()=>{
 const headings=html.match(/<thead>\s*<tr>([\s\S]*?)<\/tr>/)[1];assert.equal((headings.match(/<th\b/g)||[]).length,3);assert.match(headings,/class="row-hint"/);assert.match(headings,/Double-click a line to copy a link to it/);assert.equal((html.match(/class="row-hint"/g)||[]).length,1);assert.doesNotMatch(html,/<p class="row-hint"/);
});
test('hint uses ordinary header layout and remains visible in embedded mode',()=>{
 const rule=css.match(/\.row-hint\s*\{([^}]+)\}/)[1];assert.doesNotMatch(rule,/(?:^|;)\s*(?:position:\s*(fixed|absolute)|bottom:|transform:)/);assert.match(css,/\.message-column-heading\s*\{[^}]*justify-content:\s*space-between/);assert.doesNotMatch(css,/\.guild-chat-embedded \.row-hint\s*\{\s*display:\s*none/);
});
