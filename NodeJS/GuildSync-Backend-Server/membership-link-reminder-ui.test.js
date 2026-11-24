import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const clients=['./web/src','../../GO/GuildSync-Frontend-Client/frontend/src'];
const functions=['getRosterMemberByAccount','getMemberLinkReminderOptOut','getMemberLinkButtonData',
  'renderMemberLinkStatusButton','getMemberLinkDialogEsoAccount','formatReminderHistoryValue','renderMemberLinkReminderSection'];
function sourceFunction(source,name) {
 const start=source.indexOf(`function ${name}(`);assert.notEqual(start,-1,name);
 const end=source.indexOf('\n}',start);return source.slice(start,end+2);
}
const clean=value=>String(value||'').replace(/^@+/,'').trim().toLowerCase();
for(const client of clients) {
 const source=readFileSync(new URL(`${client}/main.js`,import.meta.url),'utf8').replaceAll('\r\n','\n');
 test(`${client}: the link dot turns purple for “Does not use Discord” and the link window shows reminder details`,()=>{
  const rosterMembers=[{account_name:'@Alice',discord_opt_out:true,reminder_exported_at:'2026-11-20T10:00:00Z',reminder_sent_at:null},
   {account_name:'@Bob',discord_opt_out:false,reminder_exported_at:null,reminder_sent_at:null}];
  const memberLinks=[{eso_account_name:'@Alice',discord_user_id:'123',link_status:'linked'},
   {eso_account_name:'@Bob',discord_user_id:'456',link_status:'linked'}];
  const context=vm.createContext({rosterMembers,memberLinks,memberLinkDialogContext:null,normalizeMemberLinkName:clean,
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
  context.memberLinkDialogContext={mode:'discord-to-eso',discordUserId:'123'};
  assert.match(context.renderMemberLinkReminderSection(),/data-member-link-reminder-opt-out="@Alice"/);
  context.memberLinkDialogContext={mode:'eso-to-discord',esoAccountName:'@Nobody'};
  assert.equal(context.renderMemberLinkReminderSection(),'');
 });
}
