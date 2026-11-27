import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('./guildsync-database-actions.js',import.meta.url),'utf8');
function fn(name){const start=source.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`,'m'));assert.ok(start>=0,name);const tail=source.slice(start);const end=tail.slice(1).search(/^(?:export )?(?:async )?function /m);return (end<0?tail:tail.slice(0,end+1)).replace(/^export /,'');}
function context(link_status='candidate'){
 const links=[{eso_account_name:'Auleric',discord_user_id:'42',link_status,link_method:link_status==='linked'?'exact':'fuzzy',auto_link_blocked:link_status==='blocked'?1:0,match_confidence:88}];
 const db={execute:async sql=>[sql.includes('FROM guildsync_roster_members')?[{account_name:'Auleric',rank:'Member'}]:sql.includes('FROM discord_members')?[{discord_id:'42',username:'joey123',server_nickname:'Auleric (Joey)'}]:links]};
 const ctx=vm.createContext({resolveEsoAccountName:async(_,name)=>name,
  loadMemberLinkOptOuts:async()=>({discordIds:new Set(),esoKeys:new Set()}),
  esoAccountKey:s=>String(s??'').trim().replace(/^@+/,'').toLowerCase()});
 vm.runInContext(['normalizeRosterAccountName','normalizeMemberLinkName','getDiscordNameCandidates','levenshteinDistance','fuzzyNameScore','loadMemberLinkInputs','getMemberLinkPairKey','buildExistingLinkMaps','isMemberLinkPairBlocked','isMemberLinkPairLinked','isMemberLinkPairAutoUpgradeable','getMemberLinkOptions'].map(fn).join('\n'),ctx);
 return {ctx,db,links};
}
test('Auleric (Joey) remains a strong fuzzy match without treating the suffix as an exact identity',()=>{const {ctx}=context();assert.equal(ctx.fuzzyNameScore('@Auleric','Auleric (Joey)'),88);});
for(const status of ['candidate','blocked'])test(`manual search can select an existing ${status} pair in either direction`,async()=>{const {ctx,db}=context(status);assert.equal((await ctx.getMemberLinkOptions(db,{mode:'discord-to-eso',discordUserId:'42'}))[0]?.account_name,'Auleric');assert.equal((await ctx.getMemberLinkOptions(db,{mode:'eso-to-discord',accountName:'@Auleric'}))[0]?.discord_id,'42');});
test('renaming Discord does not downgrade a confirmed exact link or override a block',()=>{for(const status of ['linked','blocked']){const {ctx,links}=context(status);assert.equal(ctx.isMemberLinkPairAutoUpgradeable(ctx.buildExistingLinkMaps(links),'Auleric','42',88),false);}});

test('auto-link pass creates the 88% nickname candidate and preserves confirmed links on rename',async()=>{
 for(const status of ['new','linked','blocked']){
  const {ctx,db,links}=context(status);if(status==='new')links.length=0;
  const writes=[];Object.assign(ctx,{getBestDiscordNameMatch:undefined,loadMemberLinkOptOuts:async()=>({discordIds:new Set(),esoKeys:new Set()}),esoAccountKey:s=>s.toLowerCase(),upsertMemberLink:async(_,link)=>writes.push(link),removeWeakerMemberAutoLinkCandidates:async()=>{}});
  vm.runInContext(fn('getBestDiscordNameMatch')+'\n'+fn('runMemberAutoLinkingUnlocked'),ctx);
  const result=await ctx.runMemberAutoLinkingUnlocked(db);
  if(status==='new'){assert.equal(result.candidates,1);assert.equal(writes[0].matchConfidence,88);assert.equal(writes[0].discordUserId,'42');}
  else assert.equal(writes.length,0);
 }
});
