import {DEFAULT_MEMBERSHIP_DM} from './membership-dm-config.js';
import {COMMUNITY_HIGHLIGHT_IDS} from './community-statistics.js';
// Only these operational settings may be displayed or overridden. Never accept arbitrary env keys.
const configurationHelp={
 "GUILDSYNC_MEMBERSHIP_DM_ENABLED": {section:"Sending",help:"Allows an officer to start or resume the alphabetical Discord membership DM campaign. Turning this on alone does not start a campaign. Pause it with /discord-reminders pause; one DM already in flight may finish."},
 "GUILDSYNC_MEMBERSHIP_DM_REPEAT_DAYS": {section:"Sending",help:"Minimum whole days since a member’s last confirmed membership DM before another campaign may contact them. Defaults to 30 days. Recent contacts are skipped immediately; actual attempts remain 10–15 minutes apart."},
 "GUILDSYNC_MEMBERSHIP_DM_MESSAGE": {section:"Message",help:"Text sent above the four response buttons. Use {name} for the member’s current display name and {guild} for the Discord server name. A fixed notice explains that replies are forwarded to guild officers."},
 "GUILDSYNC_MEMBERSHIP_DM_DESTINATION_TYPE": {section:"Reply forwarding",help:"Choose whether membership responses go to a Discord channel in this server or directly to a Discord user. Configure the corresponding numeric destination ID below."},
 "GUILDSYNC_MEMBERSHIP_DM_DESTINATION_ID": {section:"Reply forwarding",help:"Numeric Discord channel or user ID receiving the response, sender identity, submitted ESO account and linking outcome. The bot must be able to send there. Failed forwarding is retained for retry."},
 "GUILDSYNC_MEMBERSHIP_DM_COMMUNITY_ROLE_ID": {section:"Community preference",help:"Optional numeric role ID added when a member chooses to remain on Discord without guild membership or without playing ESO. Blank records the preference without role changes. The bot needs Manage Roles and a higher role position."},
 "GUILDSYNC_VOICE_MUTE_ENABLED": {
  "section": "Access and permissions",
  "help": "Allows authenticated desktop users with an allowed Discord role to hold a shortcut to mute lower-ranked members in their current voice channel. Turning it off ends temporary sessions; confirmed moderator mutes remain."
 },
 "GUILDSYNC_VOICE_MUTE_ALLOWED_ROLE_IDS": {
  "section": "Access and permissions",
  "help": "Comma-separated Discord role names or numeric IDs allowed to request a channel mute, for example Kingpin, Consigliere. Names match case-insensitively; omit @. Blank permits nobody. Approved GuildSync Viewer, User or Admin access, or a standalone Discord voice login, is required."
 },
 "GUILDSYNC_VOICE_MUTE_RANK_ROLE_IDS": {
  "section": "Rank protection",
  "help": "Guild rank role names or numeric IDs from lowest to highest, separated by commas. Names match case-insensitively; omit @. Leave blank to discover Gangsters through Kingpin by name. Equal, higher and unknown ranks are never muted; decorative roles are ignored."
 },
 "GUILDSYNC_ONBOARDING_ENABLED": {
  "section": "Access and promotion",
  "help": "Turns member onboarding on or off. Only members joining after it is enabled are watched for a missing ESO link."
 },
 "GUILDSYNC_ONBOARDING_PROMOTION_ENABLED": {
  "section": "Access and promotion",
  "help": "Removes Gangsters from linked members. Adds Associates only when they have no higher guild role; existing higher roles are preserved."
 },
 "GUILDSYNC_ONBOARDING_PROMOTION_NOTIFY_ENABLED": {
  "section": "Access and promotion",
  "help": "Sends the linked member a promotion notification after onboarding processes their ESO link."
 },
 "GUILDSYNC_ONBOARDING_REMINDER_ENABLED": {
  "section": "Unlinked member reminders",
  "help": "Sends one reminder to a watched new member who still has no ESO link when the reminder delay expires."
 },
 "GUILDSYNC_ONBOARDING_REMINDER_HOURS": {
  "section": "Unlinked member reminders",
  "help": "Hours after joining before an unlinked new member receives their one-time reminder. This does not affect raffle reminders."
 },
 "GUILDSYNC_ONBOARDING_CHANNEL_ID": {
  "section": "Delivery and role matching",
  "help": "Discord channel used for onboarding notifications and reminders. Private threads are created here, with a public thread in the same channel as fallback."
 },
 "GUILDSYNC_ONBOARDING_NOTIFICATION_MODE": {
  "section": "Delivery and role matching",
  "help": "Chooses a private thread for the member or a message in the configured channel/thread. If private threads are unavailable, delivery falls back to a public thread in that channel."
 },
 "GUILDSYNC_ONBOARDING_GANGSTER_ROLE_ID": {
  "section": "Delivery and role matching",
  "help": "Role removed after an ESO link is created. Leave blank to discover the Gangsters role by name; use a role name or ID to select it explicitly. Names are case insensitive; omit @."
 },
 "GUILDSYNC_ONBOARDING_ASSOCIATE_ROLE_ID": {
  "section": "Delivery and role matching",
  "help": "Role granted to a linked Gangster who has no higher guild role. Leave blank to discover Associates by name, or supply its Discord role name or ID. Names are case insensitive; omit @."
 },
 "GUILDSYNC_ONBOARDING_PROMOTION_MESSAGE": {
  "section": "Member messages",
  "help": "Text sent after a member is linked and promoted. Use the placeholders below to include the member mention, ESO name, and role."
 },
 "GUILDSYNC_ONBOARDING_REMINDER_MESSAGE": {
  "section": "Member messages",
  "help": "Text sent once to an unlinked new member after the reminder delay. Include {mention} to ping the member and explain how to match their ESO name."
 },
 "GUILDSYNC_RAFFLE_ANNOUNCEMENTS_ENABLED": {
  "section": "Schedule and destination",
  "help": "Enables raffle announcements and scheduled raffle reminders. Archive notifications are controlled separately below."
 },
 "GUILDSYNC_RAFFLE_CHANNEL_ID": {
  "section": "Schedule and destination",
  "help": "Discord channel receiving raffle announcements and deadline reminders. Use the channel ID rather than its display name."
 },
 "GUILDSYNC_RAFFLE_INTERVAL_HOURS": {
  "section": "Schedule and destination",
  "help": "Hours between recurring raffle announcements while raffle sales are open. Suspended while purchase-triggered updates are enabled; the saved interval resumes when that option is disabled."
 },
 "GUILDSYNC_RAFFLE_ANNOUNCE_ON_PURCHASE": {
  "section": "Schedule and destination",
  "help": "Updates public raffle values when recorded ticket purchases change. While enabled, recurring interval and prize milestone announcements are suspended; disabling restores those saved settings. Bonus and sales-closing deadline reminders remain separate."
 },
 "GUILDSYNC_RAFFLE_BIWEEKLY_THRESHOLD": {
  "section": "Prize milestones",
  "help": "Gold interval used for Bi-Weekly raffle prize milestone announcements. Suspended while purchase-triggered updates are enabled; this saved threshold resumes when that option is disabled."
 },
 "GUILDSYNC_RAFFLE_MONTHLY_THRESHOLD": {
  "section": "Prize milestones",
  "help": "Gold interval used for 50/50 raffle prize milestone announcements. Suspended while purchase-triggered updates are enabled; this saved threshold resumes when that option is disabled."
 },
 "GUILDSYNC_RAFFLE_BONUS_REMINDER_HOURS": {
  "section": "Deadline reminders",
  "help": "Hours before a bonus deadline to send a reminder. Enter one or more positive hours separated by commas, such as 24, 1. This does not change bonus eligibility."
 },
 "GUILDSYNC_RAFFLE_SALES_CLOSE_REMINDER_HOURS": {
  "section": "Deadline reminders",
  "help": "Hours before raffle sales close to send a reminder. Enter one or more positive hours separated by commas; this does not change the raffle draw date."
 },
 "GUILDSYNC_RAFFLE_ARCHIVE_ANNOUNCEMENTS_ENABLED": {
  "section": "",
  "help": "Posts a notification with archive and working-sheet links after a raffle archive completes. This does not enable or disable archiving itself."
 },
 "GUILDSYNC_RAFFLE_ARCHIVE_CHANNEL_IDS": {
  "section": "",
  "help": "Discord channels or threads receiving archive notifications. Enter their IDs separated by commas."
 },
 "GUILDSYNC_GOOGLE_SHEETS_ENABLED": {
  "section": "",
  "help": "Enables ordinary automatic writes of eligible raffle purchases to the working spreadsheet. Purchases continue to be recorded in the database when disabled."
 },
 "GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_ENABLED": {
  "section": "",
  "help": "Enables scheduled archive/reset and reload after a raffle ends. This is separate from ordinary spreadsheet writes and manual archive commands."
 },
 "GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_DELAY_HOURS": {
  "section": "",
  "help": "Hours after the raffle ends before automatic rollover can archive, reset, and reload the working raffle sheets."
 },
 "GUILDSYNC_DEPOSIT_MAIL_BONUS_NUDGE_ENABLED": {
  "section": "",
  "help": "Sends the early-purchase nudge on a receipt when a raffle has bonuses and the purchase missed a higher percentage. The nudge names the percentage and its deadline, and each member receives it at most once per raffle. Turn it off to stop the footer without changing how bonus tickets are earned or mailed."
 },
 "GUILDSYNC_COMMUNITY_TRADER_WINDOW": {
  "section": "",
  "help": "Time base for the Market Moguls and Pack Mules trader cards. Raffle counts the same 50/50 span the two buyer cards use, from the previous draw to this raffle's draw; 14 days counts back from each refresh. The two buyer cards always follow the raffle."
 },
 "GUILDSYNC_COMMUNITY_TRADER_TOP_LIMIT": {
  "section": "",
  "help": "Members listed on each guild trader card, from 1 to 25. The default is the top 5. Other highlights keep their own size."
 },
 "GUILDSYNC_COMMUNITY_TRADER_GOLD_VISIBILITY": {
  "section": "",
  "help": "Who sees gold amounts on the trader cards. Users shows them to approved users and admins and withholds them from read-only viewers; Admins shows them only to admins; Never withholds them from everyone. Unrecognised roles and the Discord bot never receive amounts."
 },
 "GUILDSYNC_COMMUNITY_HIDDEN_HIGHLIGHTS": {
  "section": "",
  "help": "Card ids to remove from Community Highlights, comma separated, for example trader-visitor-buyers,guild-joins. Blank shows every card. Valid ids: guild-joins, discord-joins, longest-member, newest-member, discord-busiest, discord-posts, discord-reactions, tickets-biweekly, tickets-monthly, raffle-bonus, raffle-spending, trader-sales, trader-items, trader-member-buyers, trader-visitor-buyers."
 },
 "GUILDSYNC_COMMUNITY_BUYER_RAFFLE_LINGER_HOURS": {
  "section": "",
  "help": "Hours a closed 50/50 raffle stays on the Guild Regulars and Window Shoppers cards after its draw so its buyer standings can still be quoted. After that, the next community statistics refresh shows the new raffle. A draw is one hour after ticket sales close. Set 0 to switch at the draw itself. The default is 1 hour; enter 0 to 168."
 },
 "GUILDSYNC_DEPOSIT_MAIL_SUBJECT_TEMPLATE": {
  "section": "",
  "help": "Subject used for ESO raffle deposit receipt mail. Use the placeholders below to include purchase or raffle details."
 },
 "GUILDSYNC_DEPOSIT_MAIL_BODY_TEMPLATE": {
  "section": "",
  "help": "Body used for ESO raffle deposit receipt mail. {bonus_note_block} is the built-in combined section: the bonus deadline, percentage, bonus tickets, total, the rest of the bonus schedule and any note, with one blank line above the transaction ID whether or not those lines are present. {bonus_block} adds the bonus details alone; a missing bonus block is appended automatically. {bonus_upsell} adds the early-purchase nudge when the raffle has bonuses and the purchase missed a higher bonus percentage; it names that percentage and its deadline, and it is appended at the bottom of the body when the template omits it."
 }
};
const define=(owner,group,key,label,type,defaultValue,extra={})=>({owner,group,key,label,type,defaultValue,...configurationHelp[key],...extra});
const onboarding=(key,label,type,value,extra)=>define('bot','Member onboarding','GUILDSYNC_ONBOARDING_'+key,label,type,value,extra);
const raffle=(key,label,type,value,extra)=>define('bot','Raffle announcements','GUILDSYNC_RAFFLE_'+key,label,type,value,extra);
export const configurationCatalog=[
 define('backend','Discord membership DMs','GUILDSYNC_MEMBERSHIP_DM_ENABLED','Enable officer-initiated membership DMs','boolean',false),
 define('backend','Discord membership DMs','GUILDSYNC_MEMBERSHIP_DM_REPEAT_DAYS','Minimum days between membership DMs','number',30,{min:1,max:365}),
 define('backend','Discord membership DMs','GUILDSYNC_MEMBERSHIP_DM_MESSAGE','Membership DM message','template',DEFAULT_MEMBERSHIP_DM,{placeholders:['name','guild'],maxLength:1500}),
 define('backend','Discord membership DMs','GUILDSYNC_MEMBERSHIP_DM_DESTINATION_TYPE','Forward replies to','select','channel',{options:['channel','user']}),
 define('backend','Discord membership DMs','GUILDSYNC_MEMBERSHIP_DM_DESTINATION_ID','Reply destination user or channel ID','id',''),
 define('backend','Discord membership DMs','GUILDSYNC_MEMBERSHIP_DM_COMMUNITY_ROLE_ID','Optional community role ID','id',''),
 define('bot','Voice channel mute','GUILDSYNC_VOICE_MUTE_ENABLED','Enable voice channel hotkey mute','boolean',false),
 define('bot','Voice channel mute','GUILDSYNC_VOICE_MUTE_ALLOWED_ROLE_IDS','Allowed requester roles (names or IDs, comma separated)','roles',''),
 define('bot','Voice channel mute','GUILDSYNC_VOICE_MUTE_RANK_ROLE_IDS','Guild rank roles (names or IDs, lowest to highest)','roles',''),
 onboarding('ENABLED','Enable member onboarding','boolean',false),
 onboarding('PROMOTION_ENABLED','Promote linked Gangsters to Associates','boolean',true),
 onboarding('PROMOTION_NOTIFY_ENABLED','Notify members after promotion','boolean',true),
 onboarding('REMINDER_ENABLED','Send unlinked member reminders','boolean',true),
 onboarding('REMINDER_HOURS','Reminder delay (hours)','number',24,{min:0.01,max:8760}),
 onboarding('CHANNEL_ID','Notification channel ID','id',''),
 onboarding('NOTIFICATION_MODE','Notification delivery','select','private_thread',{options:['private_thread','channel']}),
 onboarding('GANGSTER_ROLE_ID','Gangsters role name or ID (blank: discover by name)','role',''),
 onboarding('ASSOCIATE_ROLE_ID','Associates role name or ID (blank: discover by name)','role',''),
 onboarding('PROMOTION_MESSAGE','Promotion message','template','{mention}, your Discord account is now linked to ESO account **{eso_name}**. You have been promoted to {associate_role} and should now have full server access.',{placeholders:['mention','eso_name','associate_role','hours'],maxLength:1800}),
 onboarding('REMINDER_MESSAGE','Unlinked member reminder','template','{mention}, please update your Discord server nickname to match your ESO account name so GuildSync can link your accounts and grant full server access.',{placeholders:['mention','eso_name','associate_role','hours'],maxLength:1800}),
 raffle('ANNOUNCEMENTS_ENABLED','Enable raffle announcements','boolean',true),
 raffle('CHANNEL_ID','Raffle announcement channel ID','id',''),
 raffle('INTERVAL_HOURS','Announcement interval (hours)','number',48,{min:0.01,max:8760}),
 raffle('ANNOUNCE_ON_PURCHASE','Update raffle values when ticket purchases are recorded','boolean',false),
 raffle('BIWEEKLY_THRESHOLD','Bi-Weekly prize milestone (gold)','number',200000,{min:1,max:1000000000000}),
 raffle('MONTHLY_THRESHOLD','50/50 prize milestone (gold)','number',500000,{min:1,max:1000000000000}),
 raffle('BONUS_REMINDER_HOURS','Bonus reminder lead hours (comma separated)','hours','1'),
 raffle('SALES_CLOSE_REMINDER_HOURS','Sales closing reminder lead hours (comma separated)','hours','2'),
 define('bot','Archive notifications','GUILDSYNC_RAFFLE_ARCHIVE_ANNOUNCEMENTS_ENABLED','Enable archive notifications','boolean',true),
 define('bot','Archive notifications','GUILDSYNC_RAFFLE_ARCHIVE_CHANNEL_IDS','Archive notification channel IDs (comma separated)','ids',''),
 define('backend','Spreadsheet automation','GUILDSYNC_GOOGLE_SHEETS_ENABLED','Enable ordinary spreadsheet writes','boolean',false),
 define('backend','Spreadsheet automation','GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_ENABLED','Enable automatic raffle rollover','boolean',false),
 define('backend','Spreadsheet automation','GUILDSYNC_GOOGLE_SHEETS_ROLLOVER_DELAY_HOURS','Rollover delay (hours)','number',4,{min:0,max:8760}),
 define('backend','Community highlights','GUILDSYNC_COMMUNITY_BUYER_RAFFLE_LINGER_HOURS','Keep a closed 50/50 raffle on the buyer cards (hours)','number',1,{min:0,max:168}),
 define('backend','Community highlights','GUILDSYNC_COMMUNITY_TRADER_WINDOW','Trader card time base','select','raffle',{options:['raffle','14 days']}),
 define('backend','Community highlights','GUILDSYNC_COMMUNITY_TRADER_TOP_LIMIT','Members listed per trader card','number',5,{min:1,max:25}),
 define('backend','Community highlights','GUILDSYNC_COMMUNITY_TRADER_GOLD_VISIBILITY','Who sees trader gold','select','user',{options:['user','admin','never']}),
 define('backend','Community highlights','GUILDSYNC_COMMUNITY_HIDDEN_HIGHLIGHTS','Hidden highlight cards (ids, comma separated)','cards',''),
 define('backend','Receipt messages','GUILDSYNC_DEPOSIT_MAIL_BONUS_NUDGE_ENABLED','Send the early-purchase nudge','boolean',true),
define('backend','Receipt messages','GUILDSYNC_DEPOSIT_MAIL_SUBJECT_TEMPLATE','Receipt subject','template','Raffle ticket deposit received',{maxLength:200,placeholders:['recipient','amount','ticket_quantity','event_id','related_transaction_id','ticket_type','ticket_type_raw','transaction_type','account_name','display_name','deposit_amount','raw_amount','raw_deposit_amount','tickets','purchased_tickets','gold_cost','raw_ticket_gold_cost','raw_gold_cost','purchase_date','data_source','event_datetime','event_timestamp','raffle_datetime_eastern','raffle_date_time_eastern','raffle_datetime','mail_request_id','mail_batch_id','ticket_gold_cost','bonus_percent','bonus_tickets','total_tickets','bonus_deadline','bonus_label','bonus_schedule','bonus_block','bonus_note_block','bonus_upsell','bonus_upsell_tickets','bonus_upsell_deadline','note','note_block']}),
 define('backend','Receipt messages','GUILDSYNC_DEPOSIT_MAIL_BODY_TEMPLATE','Receipt body','template','Hi {recipient},\n\nThank you for supporting Alphabet Mafia!\n\nWe received your guild bank deposit of {amount} gold.\nTicket Credit Earned: {ticket_quantity}\n{bonus_note_block}\nTransaction ID: {event_id}\n\n-- Alphabet Mafia',{maxLength:10000,placeholders:['recipient','amount','ticket_quantity','event_id','related_transaction_id','ticket_type','ticket_type_raw','transaction_type','account_name','display_name','deposit_amount','raw_amount','raw_deposit_amount','tickets','purchased_tickets','gold_cost','raw_ticket_gold_cost','raw_gold_cost','purchase_date','data_source','event_datetime','event_timestamp','raffle_datetime_eastern','raffle_date_time_eastern','raffle_datetime','mail_request_id','mail_batch_id','ticket_gold_cost','bonus_percent','bonus_tickets','total_tickets','bonus_deadline','bonus_label','bonus_schedule','bonus_block','bonus_note_block','bonus_upsell','bonus_upsell_tickets','bonus_upsell_deadline','note','note_block']})
];
const byKey=new Map(configurationCatalog.map(item=>[item.key,item]));
const recordKey='admin_configuration';
function typed(item,value){
 if(item.type==='boolean'){if(value===true||typeof value==='string'&&value.trim().toLowerCase()==='true')return true;if(value===false||typeof value==='string'&&value.trim().toLowerCase()==='false')return false;throw Error(item.label+' must be true or false.');}
 if(item.type==='number'){const n=Number(value);if(String(value).trim()===''||!Number.isFinite(n)||n<item.min||n>item.max || (item.key.endsWith('DELAY_HOURS')&&!Number.isSafeInteger(n*3600)))throw Error(item.label+' is outside its allowed range.');if(item.key.endsWith('THRESHOLD')&&!Number.isSafeInteger(n))throw Error(item.label+' must be a whole number.');return n;}
 if(typeof value!=='string')throw Error(item.label+' must be text.');
 const text=item.type==='template'?value:value.trim();
 if(text.length>(item.maxLength || 2000))throw Error(item.label+' is too long.');
 if(item.type==='id' && text && !/^\d+$/.test(text))throw Error(item.label+' must be a Discord ID.');
 if(item.type==='ids' && text && text.split(',').some(id=>!/^\d+$/.test(id.trim())))throw Error(item.label+' must contain comma-separated Discord IDs.');
 if(item.type==='role' && text && /[,\x00-\x1f\x7f@]/.test(text))throw Error(item.label+' must be one role name or ID without @.');
 if(item.type==='roles' && text && text.split(',').some(ref=>!ref.trim()||/[\x00-\x1f\x7f]/.test(ref)||ref.trim().startsWith('@')||ref.includes('<@')))throw Error(item.label+' must contain comma-separated role names or IDs without @.');
 if(item.type==='hours' && (!text || text.split(',').some(v=>!v.trim() || !Number.isFinite(Number(v))||Number(v)<=0||Number(v)>8760)))throw Error(item.label+' must contain positive hours.');
 if(item.type==='cards' && text && text.split(',').some(id=>!COMMUNITY_HIGHLIGHT_IDS.includes(id.trim().toLowerCase())))throw Error(item.label+' must contain comma-separated card ids.');
 if(item.type==='select'&&!item.options.includes(text))throw Error('Invalid '+item.label+'.');
 if(item.type==='template'&&!text.trim())throw Error(item.label+' cannot be blank; use the .env default instead.');
 if(item.type==='template')for(const match of text.matchAll(/\{([^{}]+)\}/g))if(!item.placeholders.includes(match[1]))throw Error('Unknown placeholder: '+match[1]);
 return text;
}
export function createConfigurationService(db,{env=process.env,onApply=()=>{},applyAtBoundary=async fn=>fn()}={}){
 const baseline=Object.fromEntries(configurationCatalog.filter(i=>i.owner==='backend').map(i=>[i.key,env[i.key]]));
 let current={revision:0,overrides:{},botDefaults:{}};
 const defaultFor=(i,record=current)=>{const raw=i.owner==='backend'?baseline[i.key]:record.botDefaults[i.key];return typed(i,raw===undefined||raw===null||raw===''?i.defaultValue:raw);};
 const effective=(i,record=current)=>Object.hasOwn(record.overrides,i.key)?record.overrides[i.key]:defaultFor(i,record);
 const validate=record=>{
  for(const [key,value] of Object.entries(record.overrides)){const item=byKey.get(key);if(!item)throw Error('Unknown configuration setting: '+key);typed(item,value);}
  const get=k=>effective(byKey.get(k),record);
  if(get('GUILDSYNC_MEMBERSHIP_DM_ENABLED')&&!get('GUILDSYNC_MEMBERSHIP_DM_DESTINATION_ID'))throw Error('Select a reply destination before enabling membership DMs.');
  if(!Number.isInteger(Number(get('GUILDSYNC_MEMBERSHIP_DM_REPEAT_DAYS'))))throw Error('Membership DM repeat interval must be whole days.');
  if(get('GUILDSYNC_ONBOARDING_ENABLED')&&(get('GUILDSYNC_ONBOARDING_REMINDER_ENABLED')||(get('GUILDSYNC_ONBOARDING_PROMOTION_ENABLED')&&get('GUILDSYNC_ONBOARDING_PROMOTION_NOTIFY_ENABLED')))&&!get('GUILDSYNC_ONBOARDING_CHANNEL_ID'))throw Error('Select an onboarding notification channel before enabling notifications.');
 };
 const apply=async()=>applyAtBoundary(()=>{for(const item of configurationCatalog.filter(i=>i.owner==='backend')){
  if(Object.hasOwn(current.overrides,item.key))env[item.key]=String(current.overrides[item.key]);
  else if(baseline[item.key]===undefined)delete env[item.key];else env[item.key]=baseline[item.key];
 }onApply(current);});
 const read=async connection=>{const [rows]=await connection.execute('SELECT value FROM guildsync_settings WHERE setting_key = ? FOR UPDATE',[recordKey]);return rows.length?JSON.parse(rows[0].value):{revision:0,overrides:{},botDefaults:{}};};
 const view=()=>({revision:current.revision,botDefaultsReported:!!current.botReportedAt,settings:configurationCatalog.map(i=>({...i,value:effective(i),defaultValue:defaultFor(i),source:Object.hasOwn(current.overrides,i.key)?'GuildSync override':'.env'}))});
 const mutate=async fn=>{const connection=await db.getConnection();let next;try{await connection.beginTransaction();next=await read(connection);await fn(next);await connection.execute('INSERT INTO guildsync_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',[recordKey,JSON.stringify(next)]);await connection.commit();}catch(error){await connection.rollback();throw error;}finally{connection.release();}current=next;await apply();return view();};
 return {async initialize(){await db.execute('INSERT IGNORE INTO guildsync_settings (setting_key, value) VALUES (?, \'{"revision":0,"overrides":{},"botDefaults":{}}\')',[recordKey]);current=await read(db);validate(current);await apply();return view();},view,
 async save(input){return mutate(async next=>{if(input?.revision!==next.revision)throw Error('Configuration changed. Reload before saving.');if(!input.changes||typeof input.changes!=='object'||Array.isArray(input.changes))throw Error('Provide configuration changes.');for(const [key,value]of Object.entries(input.changes)){const i=byKey.get(key);if(!i)throw Error('Unknown configuration setting: '+key);if(value===null)delete next.overrides[key];else next.overrides[key]=typed(i,value);}validate(next);next.revision++;});},
 async registerBotDefaults(defaults){return mutate(async next=>{for(const[key,value]of Object.entries(defaults)){const i=byKey.get(key);if(!i||i.owner!=='bot')throw Error('Only bot configuration defaults may be reported.');next.botDefaults[key]=typed(i,value);}next.botReportedAt=new Date().toISOString();validate(next);});},
 async botConfiguration(){return {revision:current.revision,keys:configurationCatalog.filter(i=>i.owner==='bot').map(i=>({key:i.key,defaultValue:i.defaultValue})),overrides:Object.fromEntries(Object.entries(current.overrides).filter(([key])=>byKey.get(key)?.owner==='bot'))};}
 };
}
