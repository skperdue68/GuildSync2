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
  esoAccountKey:s=>String(s??'').trim().replace(/^@+/,'').toLowerCase(),
  MEMBER_LINK_CANDIDATE_THRESHOLD:82});
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

test('an accepted fuzzy link is never downgraded back to a candidate',()=>{
 const links=[{eso_account_name:'Auleric',discord_user_id:'42',link_status:'linked',link_method:'fuzzy',match_confidence:43,auto_link_blocked:0}];
 const {ctx}=context();
 assert.equal(ctx.isMemberLinkPairAutoUpgradeable(ctx.buildExistingLinkMaps(links),'Auleric','42',88),false);
});

test('the auto-link pass leaves an accepted fuzzy link linked',async()=>{
 const {ctx,db,links}=context('linked');
 links[0].link_method='fuzzy';links[0].match_confidence=43;
 const writes=[];Object.assign(ctx,{loadMemberLinkOptOuts:async()=>({discordIds:new Set(),esoKeys:new Set()}),esoAccountKey:s=>s.toLowerCase(),upsertMemberLink:async(_,link)=>writes.push(link),removeWeakerMemberAutoLinkCandidates:async()=>{}});
 vm.runInContext(fn('getBestDiscordNameMatch')+'\n'+fn('runMemberAutoLinkingUnlocked'),ctx);
 await ctx.runMemberAutoLinkingUnlocked(db);
 assert.equal(writes.length,0);
});

test('unlinking an approved fuzzy link hands the pair back to the matcher as a fuzzy candidate',async()=>{
 // Approving a candidate stores a confirmed link; removing that link must not block
 // the pair, it must let the matcher offer it again as the fuzzy candidate it was.
 const {ctx,links}=context('linked');
 links.splice(0,links.length,{eso_account_name:'Auleric',discord_user_id:'42',link_status:'linked',link_method:'manual',match_confidence:88,auto_link_blocked:0});
 const writes=[];
  Object.assign(ctx,{loadMemberLinkOptOuts:async()=>({discordIds:new Set(),esoKeys:new Set()}),esoAccountKey:s=>s.toLowerCase(),upsertMemberLink:async(_,link)=>writes.push(link),removeWeakerMemberAutoLinkCandidates:async()=>{},recordMemberLinkChange:async()=>null});
  vm.runInContext('const MEMBER_LINK_CANDIDATE_THRESHOLD = 82;\n'+[fn('manualUnlinkMemberUnlocked'),fn('getBestDiscordNameMatch'),fn('runMemberAutoLinkingUnlocked')].join('\n'),ctx);
 Object.assign(ctx,{runMemberAutoLinking:db=>ctx.runMemberAutoLinkingUnlocked(db)});
 const db={execute:async(sql)=>{
  const statement=sql.trim();
  if(/^DELETE/i.test(statement)){links.length=0;return [{affectedRows:1}];}
  if(/^UPDATE/i.test(statement))throw new Error('an approved fuzzy link must be removed, not blocked');
  if(sql.includes('FROM guildsync_member_links'))return [links];
  if(sql.includes('FROM guildsync_roster_members'))return [[{account_name:'Auleric',rank:'Member'}]];
  if(sql.includes('FROM discord_members'))return [[{discord_id:'42',username:'joey123',server_nickname:'Auleric (Joey)'}]];
  return [links];
 }};
 await ctx.manualUnlinkMemberUnlocked(db,{esoAccountName:'Auleric',discordUserId:'42'});
 assert.equal(writes.length,1);
 assert.equal(writes[0].linkStatus,'candidate');
 assert.equal(writes[0].linkMethod,'fuzzy');
 assert.equal(writes[0].discordUserId,'42');
});

test('accepting a fuzzy candidate stores an officer-confirmed manual link',async()=>{
 const ctx=vm.createContext({resolveEsoAccountName:async(_,name)=>name,upsertMemberLink:async(_,link)=>writes.push(link)});
 const writes=[];
 const db={execute:async()=>[[{eso_account_name:'Auleric',discord_user_id:'42',discord_username:'joey123',discord_display_name:'Joey',discord_server_nickname:'Auleric (Joey)',link_status:'candidate',match_confidence:88,match_field:'discord_server_nickname'}]]};
 vm.runInContext(fn('acceptMemberLinkCandidateUnlocked'),ctx);
 await ctx.acceptMemberLinkCandidateUnlocked(db,{esoAccountName:'Auleric',discordUserId:'42'});
 assert.equal(writes.length,1);
 assert.equal(writes[0].linkStatus,'linked');
 assert.equal(writes[0].linkMethod,'manual');
 assert.equal(writes[0].matchConfidence,88);
});
