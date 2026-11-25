import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const clients=['./web/src','../../GO/GuildSync-Frontend-Client/frontend/src'];
const functions=['getRosterMemberByAccount','getMemberLinkReminderOptOut','getMemberLinkButtonData',
  'renderMemberLinkStatusButton','getMemberLinkDialogEsoAccount','formatReminderHistoryValue','renderMemberLinkReminderSection',
  'membershipPreferenceLabel','membershipResponseLabel','getMembershipDMUserIdForContext','getMemberLinkMembershipPreference',
  'formatMembershipDMTime','membershipAttemptText','membershipResponseText','renderMemberLinkMembershipSection'];
const filterFunctions=['getMemberLinkRelationshipFilterStatus','memberLinkIsUnavailable','getDiscordMemberLinkFilterStatus',
  'getRosterMemberLinkFilterStatus','getMemberLinkStatusFilterLabel','getMemberLinkMembershipPreference',
  'getMembershipDMUserIdForContext','getMemberLinkReminderOptOut','getRosterMemberByAccount'];
function sourceFunction(source,name) {
 const start=source.indexOf(`function ${name}(`);assert.notEqual(start,-1,name);
 const end=source.indexOf('\n}',start);return source.slice(start,end+2);
}
function sourceLinkStatusFilters(source) {
 const start=source.indexOf('const MEMBER_LINK_STATUS_FILTERS = [');assert.notEqual(start,-1);
 const end=source.indexOf('\n];',start);return source.slice(start,end+3);
}
const clean=value=>String(value||'').replace(/^@+/,'').trim().toLowerCase();
for(const client of clients) {
 const source=readFileSync(new URL(`${client}/main.js`,import.meta.url),'utf8').replaceAll('\r\n','\n');
 test(`${client}: the link dot turns purple for “Does not use Discord” and the link window shows reminder details`,()=>{
  const rosterMembers=[{account_name:'@Alice',discord_opt_out:true,reminder_exported_at:'2026-11-20T10:00:00Z',reminder_sent_at:null},
   {account_name:'@Bob',discord_opt_out:false,reminder_exported_at:null,reminder_sent_at:null}];
  const memberLinks=[{eso_account_name:'@Alice',discord_user_id:'123',link_status:'linked'},
   {eso_account_name:'@Bob',discord_user_id:'456',link_status:'linked'}];
  const context=vm.createContext({rosterMembers,memberLinks,memberLinkDialogContext:null,membershipDMPreferences:{},membershipDMPreferenceSummary:null,normalizeMemberLinkName:clean,
   getMemberLinksByEsoAccount:name=>memberLinks.filter(link=>clean(link.eso_account_name)===clean(name)),
   getMemberLinksByDiscordUserId:id=>memberLinks.filter(link=>link.discord_user_id===String(id||'')),
   getPreferredMemberLink:links=>links[0]||null,canEditGuildSyncData:()=>true,escapeHtml:String,escapeAttribute:String});
  vm.runInContext(functions.map(name=>sourceFunction(source,name)).join('\n'),context);

  // The dot is the same control that opens the link window; only the state colour changes.
  const esoDot=context.renderMemberLinkStatusButton({mode:'eso-to-discord',esoAccountName:'@Alice'});
  assert.match(esoDot,/class="member-link-status-dot member-link-status-opt-out"/);
  assert.match(esoDot,/data-open-member-link-dialog="eso-to-discord"/);
  assert.match(esoDot,/data-member-link-value="@Alice"/);
  assert.match(esoDot,/aria-label="Does not use Discord"/);
  const discordDot=context.renderMemberLinkStatusButton({mode:'discord-to-eso',discordUserId:'123'});
  assert.match(discordDot,/member-link-status-opt-out/);
  assert.match(discordDot,/data-open-member-link-dialog="discord-to-eso"/);
  assert.match(context.renderMemberLinkStatusButton({mode:'eso-to-discord',esoAccountName:'@Bob'}),/member-link-status-linked/);
  assert.doesNotMatch(context.renderMemberLinkStatusButton({mode:'eso-to-discord',esoAccountName:'@Bob'}),/opt-out/);

  context.memberLinkDialogContext={mode:'eso-to-discord',esoAccountName:'@Alice'};
  const section=context.renderMemberLinkReminderSection();
  assert.match(section,/Guild Roster · Discord reminder/);
  assert.match(section,/Exported: /);
  assert.match(section,/Sent: Never/);
  assert.match(section,/data-member-link-reminder-opt-out="@Alice"/);
  assert.match(section,/checked/);
  assert.match(section,/Member indicates they do not use discord, they will not be prompted for their discord again\. Link dot changes to purple/);
  context.memberLinkDialogContext={mode:'discord-to-eso',discordUserId:'123'};
  assert.match(context.renderMemberLinkReminderSection(),/data-member-link-reminder-opt-out="@Alice"/);
  context.memberLinkDialogContext={mode:'eso-to-discord',esoAccountName:'@Nobody'};
  assert.equal(context.renderMemberLinkReminderSection(),'');
 });

 test(`${client}: a membership DM opt-out turns the link dot purple and the window shows the DM and reply`,()=>{
  const rosterMembers=[{account_name:'@Alice',discord_opt_out:false,reminder_exported_at:null,reminder_sent_at:null}];
  const memberLinks=[{eso_account_name:'@Alice',discord_user_id:'123',link_status:'linked'}];
  const context=vm.createContext({rosterMembers,memberLinks,memberLinkDialogContext:null,membershipDMPreferences:{'123':'opt_out'},membershipDMPreferenceSummary:null,normalizeMemberLinkName:clean,
   getMemberLinksByEsoAccount:name=>memberLinks.filter(link=>clean(link.eso_account_name)===clean(name)),
   getMemberLinksByDiscordUserId:id=>memberLinks.filter(link=>link.discord_user_id===String(id||'')),
   getPreferredMemberLink:links=>links[0]||null,canEditGuildSyncData:()=>true,escapeHtml:String,escapeAttribute:String});
  vm.runInContext(functions.map(name=>sourceFunction(source,name)).join('\n'),context);

  // A marked Discord member and the linked roster row both show the purple dot.
  const dot=context.renderMemberLinkStatusButton({mode:'discord-to-eso',discordUserId:'123'});
  assert.match(dot,/class="member-link-status-dot member-link-status-opt-out"/);
  assert.match(dot,/aria-label="Do not contact"/);
  assert.match(dot,/data-open-member-link-dialog="discord-to-eso"/);
  assert.match(context.renderMemberLinkStatusButton({mode:'eso-to-discord',esoAccountName:'@Alice'}),/member-link-status-opt-out/);

  context.memberLinkDialogContext={mode:'discord-to-eso',discordUserId:'123'};
  context.membershipDMPreferenceSummary={userId:'123',result:{status:'sent',attemptedAt:1700000000,sentAt:1700000100,uncertain:false},lastResponse:{choice:'not_playing',accountName:null,at:1700000200}};
  const section=context.renderMemberLinkMembershipSection();
  assert.match(section,/Discord · Membership DM/);
  assert.match(section,/data-member-link-membership-opt-out="123"/);
  assert.match(section,/checked/);
  assert.match(section,/No longer plays ESO; staying on Discord/);
  assert.match(section,/DM sent: /);
  assert.match(section,/Last attempt: sent/);

  context.memberLinkDialogContext={mode:'eso-to-discord',esoAccountName:'@Nobody'};
  assert.equal(context.renderMemberLinkMembershipSection(),'','the section needs a Discord member');
 });

 test(`${client}: the Link Unavailable filter covers both opt-outs`,()=>{
  const rosterMembers=[{account_name:'@Alice',discord_opt_out:true},
   {account_name:'@Bob',discord_opt_out:false},
   {account_name:'@Carol',discord_opt_out:false}];
  const memberLinks=[{eso_account_name:'@Alice',discord_user_id:'123',link_status:'linked'},
   {eso_account_name:'@Bob',discord_user_id:'456',link_status:'linked'}];
  const context=vm.createContext({rosterMembers,memberLinks,membershipDMPreferences:{'456':'opt_out'},normalizeMemberLinkName:clean,
   getMemberLinksByEsoAccount:name=>memberLinks.filter(link=>clean(link.eso_account_name)===clean(name)),
   getMemberLinksByDiscordUserId:id=>memberLinks.filter(link=>link.discord_user_id===String(id||''))});
  vm.runInContext(sourceLinkStatusFilters(source)+'\n'+filterFunctions.map(name=>sourceFunction(source,name)).join('\n'),context);

  assert.equal(context.getMemberLinkStatusFilterLabel('unavailable'),'Link Unavailable');

  // The roster checkbox and the Discord membership opt-out both make the link unavailable.
  assert.equal(context.getRosterMemberLinkFilterStatus({account_name:'@Alice'}),'unavailable');
  assert.equal(context.getRosterMemberLinkFilterStatus({account_name:'@Bob'}),'unavailable','linked Discord member marked do-not-contact');
  assert.equal(context.getRosterMemberLinkFilterStatus({account_name:'@Carol'}),'unlinked');
  assert.equal(context.getDiscordMemberLinkFilterStatus({discord_id:'456'}),'unavailable');
  assert.equal(context.getDiscordMemberLinkFilterStatus({discord_id:'123'}),'unavailable','their linked roster row is marked does-not-use-Discord');
  assert.equal(context.getDiscordMemberLinkFilterStatus({discord_id:'999'}),'unlinked');
 });
}
