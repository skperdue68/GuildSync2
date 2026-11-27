import {randomUUID} from 'node:crypto';
import {withEsoIdentityLock,esoAccountKey} from './eso-account-identity.js';
import {recordDiscordMemberHistoryEvent} from './discord-member-history.js';

// The Discord history row keeps the member's answer readable without exposing
// the whole forwarded message.
function responseHistoryText(choice,text,result={}) {
  const account=result.accountName?`@${String(result.accountName).trim().replace(/^@+/,'')}`:'';
  if(choice==='eso')return result.status==='linked'
    ?`Linked ESO account ${account}`
    :`ESO account ${account||String(text||'').trim()}${result.rosterMatch==='missing'
      ?' was not found on the current roster; officer review needed':' submitted for officer review'}`;
  if(choice==='community')return 'Still plays ESO but is not in the ESO guild; staying on Discord — account reminders stopped';
  if(choice==='not_playing')return 'Does not play ESO; staying on Discord — account reminders stopped';
  if(choice==='remove')return 'Asked to be removed from the Discord server — membership DMs stopped';
  return `Other response: ${String(text||'').trim().slice(0,300)}`;
}

// Officers can mark a Discord member as "does not play ESO / not in the ESO guild"
// from the member link window. It writes the same preference a DM response writes,
// so the campaign, its send-time validation and onboarding reminders all honour it.
function preferenceHistoryText(value) {
  if(value==='opt_out')return 'Marked as “does not play ESO or is not in the ESO guild”; membership DMs stopped';
  if(value==='not_playing')return 'Marked as “does not play ESO”; membership DMs stopped';
  if(value==='community')return 'Marked as “not in the ESO guild”; membership DMs stopped';
  return 'Membership DM contact preference cleared; membership DMs are allowed again';
}
import {dmConfig} from './membership-dm-config.js';
export {dmConfig};

// A removal request and an ESO nickname are carried out in Discord seconds after the
// answer is stored. The officer card waits out this grace period so it reports what
// actually happened instead of claiming an officer still has to act.
const OUTCOME_GRACE_SECONDS=45;
const REMOVAL_STATUSES=new Set(['kicked','gone','failed','declined']);
const NICKNAME_STATUSES=new Set(['set','skipped','failed','declined']);
const outcomeText=value=>String(value??'').trim().slice(0,300);

// The roster normally stores the bare account name, but an older snapshot can keep the
// @ a member types in game. Stripping a leading @ from the stored name and from the
// answer leaves one comparison, so either spelling finds the same current member.
const ROSTER_LOOKUP=`SELECT account_name FROM guildsync_roster_members
  WHERE in_roster=1 AND LOWER(TRIM(LEADING '@' FROM TRIM(account_name)))=?`;
const rosterLookupArgs=value=>{
  const bare=esoAccountKey(value);
  return bare?[bare]:null;
};
// Saying the name was not found is more useful than a generic review notice: the
// member learns an officer will still look, instead of guessing whether it saved.
const ROSTER_NOT_FOUND='I cannot find that member name in Alphabet Mafia currently, but I will have an officer review your reply.';
const ROSTER_AMBIGUOUS='That name matches more than one current Alphabet Mafia member, so an officer will review your reply.';

// The bot reports what Discord did; only known outcomes and bounded text are kept,
// and a removal can never be attached to an ESO answer or the other way round.
export function cleanMembershipOutcome(value) {
  if(!value||typeof value!=='object')return null;
  const removal=value.removal&&REMOVAL_STATUSES.has(String(value.removal.status))
    ?{status:String(value.removal.status),reason:outcomeText(value.removal.reason)||null}:null;
  const nickname=value.nickname&&NICKNAME_STATUSES.has(String(value.nickname.status))
    ?{status:String(value.nickname.status),name:outcomeText(value.nickname.name)||null,
      reason:outcomeText(value.nickname.reason)||null}:null;
  return removal||nickname?{removal,nickname}:null;
}

// One row per member keeps the per-guild JSON small: send dates, the last
// delivery outcome and its reason live in guildsync_membership_dm_results, so
// the document no longer grows with every attempt.
export const MEMBERSHIP_DM_RESULTS_TABLE=`CREATE TABLE IF NOT EXISTS guildsync_membership_dm_results (
    guild_id VARCHAR(32) NOT NULL,discord_user_id VARCHAR(32) NOT NULL,
    display_name VARCHAR(255) NOT NULL DEFAULT '',status VARCHAR(16) NOT NULL,reason VARCHAR(255) DEFAULT NULL,
    delivery_id CHAR(36) DEFAULT NULL,message_id VARCHAR(32) DEFAULT NULL,campaign_id CHAR(36) DEFAULT NULL,
    attempted_at BIGINT DEFAULT NULL,sent_at BIGINT DEFAULT NULL,uncertain TINYINT(1) NOT NULL DEFAULT 0,
    updated_at DATETIME(3) NOT NULL,PRIMARY KEY (guild_id,discord_user_id),
    INDEX idx_membership_dm_result_status (guild_id,status,attempted_at),
    INDEX idx_membership_dm_result_delivery (guild_id,delivery_id)
  ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`;

export function createDMCampaignEngine({now=()=>Math.floor(Date.now()/1000),random=Math.random,pace=()=>null}={}) {
  // The live membership DM settings decide this random window. Without a pace the
  // defaults stay 10–15 minutes, which existing states and tests rely on.
  const paceBounds=()=>{
    const value=pace()||{},min=Number(value.minSeconds),max=Number(value.maxSeconds);
    const low=Number.isFinite(min)&&min>0?min:600,high=Number.isFinite(max)&&max>=low?max:Math.max(low,900);
    return [low,high];
  };
  const delay=()=>{const [min,max]=paceBounds();return min+Math.floor(Math.max(0,Math.min(.999999999,random()))*(max-min+1));};
  const rememberPace=state=>{const [min,max]=paceBounds();if(state.campaign){state.campaign.paceMin=min;state.campaign.paceMax=max;}};
  // A faster saved window shortens (never extends) the wait already scheduled, so
  // the change reaches the campaign that is currently running.
  function applyPace(state) {
    const campaign=state.campaign;
    if(!campaign)return;
    const [min,max]=paceBounds();
    if(campaign.paceMin===min&&campaign.paceMax===max)return;
    const next=now()+delay();
    campaign.paceMin=min;campaign.paceMax=max;
    campaign.nextAt=Math.max(now(),Math.min(Number(campaign.nextAt)||next,next));
  }
  const eligible=(state,member,days)=>{
    const record=state.results?.[member.id];
    return !state.preferences[member.id]&&!record?.uncertain&&
      (!record?.sentAt||now()-record.sentAt>=days*86400);
  };
  function expire(state) {
    for(const job of state.campaign?.queue||[])if(job.status==='sending'&&job.claimedAt+120<=now()){
      job.status='uncertain';
      state.results??={};
      const reason='No delivery result was recorded in time.';
      const record=state.results[job.userId]??(state.results[job.userId]={});
      Object.assign(record,{status:'uncertain',uncertain:true,reason,
        deliveryId:job.id,name:record.name||job.name,attemptedAt:record.attemptedAt||job.claimedAt||null});
      // A claim that never reports back is still an attempt the member may have
      // received, so the transaction records it as uncertain history below.
      state.expiredClaims??=[];
      state.expiredClaims.push({discordId:String(job.userId),reason});
      state.campaign.nextAt=Math.max(state.campaign.nextAt,now()+delay());
    }
  }
  return {
    start(state,members,days,restart=false) {
      state.results??={};state.preferences??={};state.events??=[];
      expire(state);
      if(state.campaign?.queue.some(q=>q.status==='sending'))throw Error('A DM is still being sent. Wait for its result before restarting.');
      if(state.campaign&&['running','paused'].includes(state.campaign.status)&&!restart)throw Error('A campaign already exists. Resume it or explicitly restart.');
      const seen=new Set();
      const queue=members.filter(m=>!seen.has(m.id)&&seen.add(m.id)&&eligible(state,m,days))
        .sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'})||a.id.localeCompare(b.id))
        .map(m=>({id:randomUUID(),userId:m.id,name:m.name,status:'pending',suggestedEsoAccountName:String(m.suggestedEsoAccountName||'').trim()}));
      state.campaign={id:randomUUID(),status:queue.length?'running':'complete',queue,nextAt:now()+delay(),startedAt:now(),lastAttempted:null,lastSent:null};
      rememberPace(state);
      for(const job of queue)job.campaignId=state.campaign.id;
      return state.campaign;
    },
    pause(state){if(!state.campaign)throw Error('No campaign has been started.');state.campaign.status='paused';},
    resume(state){if(!state.campaign)throw Error('No campaign has been started.');applyPace(state);state.campaign.status='running';rememberPace(state);state.campaign.nextAt=Math.max(state.campaign.nextAt,now()+delay());},
    claim(state,members,days) {
      applyPace(state);
      expire(state);
      const campaign=state.campaign;
      if(!campaign||campaign.status!=='running'||campaign.nextAt>now()||campaign.queue.some(q=>q.status==='sending'))return null;
      const present=new Map(members.map(m=>[m.id,m]));
      for(const job of campaign.queue)if(job.status==='pending'){
        if(!present.has(job.userId)||!eligible(state,present.get(job.userId),days)){job.status='skipped';continue;}
        job.status='sending';job.token=randomUUID();job.claimedAt=now();
        campaign.lastAttempted={userId:job.userId,name:job.name,at:now()};campaign.nextAt=now()+delay();
        state.results??={};
        const record=state.results[job.userId]??(state.results[job.userId]={});
        Object.assign(record,{status:'sending',reason:null,deliveryId:job.id,campaignId:campaign.id,attemptedAt:now(),name:job.name});
        job.suggestedEsoAccountName=String(present.get(job.userId)?.suggestedEsoAccountName||job.suggestedEsoAccountName||'').trim();
        return job;
      }
      campaign.status='complete';return null;
    },
    finish(state,id,token,result) {
      // Campaign claims live on the queue; only a test DM is looked up separately.
      const job=state.campaign?.queue?.find(entry=>entry.id===id)||state.testDeliveries?.[id];
      if(!job||job.status!=='sending'||job.token!==token)throw Error('This DM delivery claim is no longer active.');
      if(!['sent','failed','skipped','uncertain'].includes(result.status))throw Error('Invalid DM outcome.');
      job.status=result.status;job.detail=String(result.detail||'').slice(0,255);job.messageId=result.messageId||null;
      if(job.isTest)return job;
      state.results??={};
      const record=state.results[job.userId]??(state.results[job.userId]={});
      record.status=result.status;record.reason=job.detail||null;record.uncertain=result.status==='uncertain';
      record.deliveryId=job.id;record.name=record.name||job.name;
      if(result.status==='sent'){
        if(!job.messageId)throw Error('A confirmed Discord message ID is required.');
        record.sentAt=now();record.messageId=job.messageId;
        if(state.campaign)state.campaign.lastSent={userId:job.userId,name:job.name,at:now()};
      }
      if(result.status!=='skipped'){
        rememberPace(state);
        if(state.campaign)state.campaign.nextAt=now()+delay();
      }
      if(result.status==='skipped'&&state.campaign)state.campaign.nextAt=now();
      return job;
    }
  };
}

export async function membershipDMManaged(db,guildId,userId) {
  const [rows]=await db.execute('SELECT state_json FROM guildsync_membership_dm_state WHERE guild_id=?',[guildId]);
  if(!rows[0])return false;
  const state=JSON.parse(rows[0].state_json);
  const [results]=await db.execute('SELECT sent_at,uncertain FROM guildsync_membership_dm_results WHERE guild_id=? AND discord_user_id=?',[guildId,userId]);
  const result=results[0];
  // Only a confirmed contact, an ambiguous delivery or a recorded preference
  // replaces the older onboarding reminder. A failed or skipped attempt never
  // reached the member, so onboarding must still be able to.
  return Boolean(state.preferences?.[userId]||result?.sent_at||result?.uncertain);
}

// A confirmed ESO↔Discord link proves the member is reachable on Discord: an exact
// automatic match, an officer's manual link, or the member's own accurate reply.
// Fuzzy candidates are never confirmed and change nothing.
const confirmedLinkMethods=new Set(['exact','manual','dm-self-report']);
export const isConfirmedMemberLink=(linkStatus,linkMethod)=>String(linkStatus||'').toLowerCase()==='linked'
  &&confirmedLinkMethods.has(String(linkMethod||'').trim().toLowerCase());

// Linking clears the answers that hid the member's linked state: the roster "does not
// use Discord" opt-out, the membership preference that stops DMs and paints both link
// dots purple, and the configured community ("Neighbors") role. Only the bot can remove
// a Discord role, so the removal joins the reply-forwarding queue it already drains.
export async function clearMembershipContactForConfirmedLink(db,{discordUserId,esoAccountName,method,
  configuration=()=>dmConfig(process.env),now=()=>Math.floor(Date.now()/1000)}={}) {
  const userId=String(discordUserId??'').trim();
  const accountKey=esoAccountKey(esoAccountName);
  if(!/^\d+$/.test(userId)||!accountKey||!confirmedLinkMethods.has(String(method||'').trim().toLowerCase()))
    return {cleared:false,rosterOptOutCleared:false,preferenceCleared:false,roleQueued:false};
  return withEsoIdentityLock(db,async connection=>{
    // The roster checkbox is keyed by the stable ESO identity, so a renamed account
    // still clears the answer it gave before the rename.
    const [rosterState]=await connection.execute(`UPDATE guildsync_discord_reminder_members state
      JOIN guildsync_eso_account_aliases alias ON alias.member_id=state.member_id
      SET state.discord_opt_out=0 WHERE alias.alias_key=? AND state.discord_opt_out=1`,[accountKey]);
    const result={cleared:false,rosterOptOutCleared:Boolean(rosterState?.affectedRows),
      preferenceCleared:false,roleQueued:false};
    if(result.rosterOptOutCleared)result.cleared=true;
    const [settings]=await connection.execute("SELECT value FROM guildsync_settings WHERE setting_key='discord_guild_id'");
    const guildId=String(settings[0]?.value||'').trim();
    if(!guildId)return result;
    const [rows]=await connection.execute('SELECT state_json FROM guildsync_membership_dm_state WHERE guild_id=?',[guildId]);
    if(!rows[0])return result;
    const state=JSON.parse(rows[0].state_json);
    state.preferences??={};state.events??=[];
    const preference=state.preferences[userId]||'';
    const roleId=String(configuration()?.communityRoleId||'').trim();
    if(preference){delete state.preferences[userId];result.preferenceCleared=true;result.cleared=true;}
    if(roleId){
      // A queued "add" from an earlier answer would undo the removal, so only the
      // newest role action for this member survives.
      for(const event of state.events)if(String(event.userId)===userId&&event.roleStatus==='pending')event.roleStatus='superseded';
      state.events.push({eventId:randomUUID(),deliveryId:null,userId,name:'',choice:'linked',text:'',at:now(),
        result:{status:'linked'},isTest:false,roleId,roleAction:'remove',roleStatus:'pending',forwardStatus:'sent',retryAt:now()});
      result.roleQueued=true;result.cleared=true;
    }
    if(!result.cleared)return result;
    await connection.execute('UPDATE guildsync_membership_dm_state SET state_json=? WHERE guild_id=?',[JSON.stringify(state),guildId]);
    try{
      await recordDiscordMemberHistoryEvent(connection,{discordId:userId,eventType:'membership_dm_preference',
        fieldName:'membership_dm',source:'guildsync',at:new Date(now()*1000),
        newValue:'ESO and Discord accounts linked'
          +(result.preferenceCleared?' — membership contact preference cleared':'')
          +(result.rosterOptOutCleared?' — roster “does not use Discord” cleared':'')
          +(result.roleQueued?' — community role removal queued':'')});
    }catch{}
    return result;
  });
}

// A linked ESO account that has left the roster leaves its Discord member with no
// rank to compare, so the rank audit marks them the same way the officer checkbox
// does: "does not play ESO / not in Alphabet Mafia (stay on Discord)". The campaign,
// its send-time validation and onboarding all honour that preference, and both link
// dots turn purple, so the member is not chased for a link they already have.
// The link rows stay in place. Removing them would make the member look unlinked and
// put them straight back into the report, and keeping them lets the mark clear itself
// when the account is back on the roster. The stored marks remember which preferences
// GuildSync set, so an officer's own answer is never overwritten or cleared.
export async function reconcileOffRosterMemberMarks(db,{now=()=>Math.floor(Date.now()/1000)}={}) {
  const result={marked:0,cleared:0};
  return withEsoIdentityLock(db,async connection=>{
    const [settings]=await connection.execute("SELECT value FROM guildsync_settings WHERE setting_key='discord_guild_id'");
    const guildId=String(settings[0]?.value||'').trim();
    if(!guildId)return result;
    const [rows]=await connection.execute(`SELECT links.discord_user_id,
      COUNT(DISTINCT links.eso_account_name) AS linked_accounts,
      COUNT(DISTINCT roster.account_name) AS roster_accounts
      FROM guildsync_member_links links
      LEFT JOIN guildsync_roster_members roster
        ON LOWER(TRIM(LEADING '@' FROM TRIM(roster.account_name))) = LOWER(TRIM(LEADING '@' FROM TRIM(links.eso_account_name)))
        AND roster.in_roster = 1
      WHERE links.link_status = 'linked'
      GROUP BY links.discord_user_id`);
    const linked=new Map();
    for(const row of rows){
      const userId=String(row.discord_user_id??'').trim();
      if(/^\d+$/.test(userId))linked.set(userId,Number(row.roster_accounts)>0);
    }
    await connection.beginTransaction();
    try{
      await connection.execute('INSERT IGNORE INTO guildsync_membership_dm_state(guild_id,state_json) VALUES(?,?)',
        [guildId,JSON.stringify({preferences:{},events:[]})]);
      const [stateRows]=await connection.execute('SELECT state_json FROM guildsync_membership_dm_state WHERE guild_id=? FOR UPDATE',[guildId]);
      const state=JSON.parse(stateRows[0].state_json);
      state.preferences??={};state.offRosterMarks??={};
      const history=[];
      for(const [userId,onRoster] of linked){
        if(onRoster||state.preferences[userId])continue;
        state.preferences[userId]='opt_out';
        state.offRosterMarks[userId]=now();
        result.marked++;
        history.push({discordId:userId,newValue:'Marked as “does not play ESO or is not in the ESO guild”; membership DMs stopped — linked ESO account is not on the current roster'});
      }
      for(const userId of Object.keys(state.offRosterMarks)){
        if(linked.get(userId)!==true)continue;
        // Only the mark GuildSync set is cleared; a preference an officer changed in
        // the meantime is their decision to keep.
        if(state.preferences[userId]==='opt_out')delete state.preferences[userId];
        delete state.offRosterMarks[userId];
        result.cleared++;
        history.push({discordId:userId,newValue:'Linked ESO account is back on the roster — membership DMs are allowed again'});
      }
      if(result.marked||result.cleared){
        await connection.execute('UPDATE guildsync_membership_dm_state SET state_json=? WHERE guild_id=?',
          [JSON.stringify(state),guildId]);
        for(const event of history)try{
          await recordDiscordMemberHistoryEvent(connection,{discordId:event.discordId,eventType:'membership_dm_preference',
            fieldName:'membership_dm',source:'guildsync',at:new Date(now()*1000),newValue:event.newValue});
        }catch{}
      }
      await connection.commit();
    }catch(error){
      await connection.rollback();
      throw error;
    }
    return result;
  });
}

export async function initializeMembershipDMs(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS guildsync_membership_dm_state (
    guild_id VARCHAR(32) NOT NULL PRIMARY KEY,state_json LONGTEXT NOT NULL
  ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await db.query(MEMBERSHIP_DM_RESULTS_TABLE);
  await db.query(`CREATE TABLE IF NOT EXISTS guildsync_membership_dm_responses (
    guild_id VARCHAR(32) NOT NULL,discord_user_id VARCHAR(32) NOT NULL,
    display_name VARCHAR(255) NOT NULL DEFAULT '',eso_account_name VARCHAR(255) DEFAULT NULL,
    choice VARCHAR(20) NOT NULL,response_text LONGTEXT NOT NULL,responded_at DATETIME(3) NOT NULL,
    PRIMARY KEY (guild_id,discord_user_id),INDEX idx_membership_dm_response_choice (guild_id,choice)
  ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  // The kick and nickname outcomes are stored with the response so a repost shows
  // what Discord actually did, even after the queued event has been pruned.
  await db.query(`ALTER TABLE guildsync_membership_dm_responses
    ADD COLUMN IF NOT EXISTS removal_status VARCHAR(16) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS removal_reason VARCHAR(300) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS nickname_status VARCHAR(16) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS nickname_name VARCHAR(64) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS nickname_reason VARCHAR(300) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS roster_match VARCHAR(16) DEFAULT NULL`);
}

// The per-guild JSON keeps only operational state (the campaign queue, preferences
// and unforwarded replies). Per-member results live in the results table, so only
// settled replies are pruned here.
export function pruneMembershipState(state,{maxEvents=200}={}) {
  const settled=event=>event.forwardStatus==='sent'&&['sent','superseded'].includes(event.roleStatus);
  if(state.events?.length>maxEvents) {
    let excess=state.events.length-maxEvents;
    state.events=state.events.filter(event=>{
      if(excess>0&&settled(event)){excess--;return false;}
      return true;
    });
  }
  return state;
}

export function createMembershipDMService(db,{configuration,upsertLink,authorizeOfficer,now=()=>Math.floor(Date.now()/1000),random=Math.random}={}) {
  const engine=createDMCampaignEngine({now,random,pace:()=>configuration()});
  const fromRow=row=>({status:row.status,name:row.display_name||'',reason:row.reason||null,
    deliveryId:row.delivery_id||null,messageId:row.message_id||null,campaignId:row.campaign_id||null,
    attemptedAt:row.attempted_at==null?null:Number(row.attempted_at),sentAt:row.sent_at==null?null:Number(row.sent_at),
    uncertain:Boolean(row.uncertain)});
  async function loadResults(connection,guildId) {
    const [rows]=await connection.execute('SELECT * FROM guildsync_membership_dm_results WHERE guild_id=?',[guildId]);
    return Object.fromEntries(rows.map(row=>[String(row.discord_user_id),fromRow(row)]));
  }
  // Only rows touched by this transaction are written back, so a status call costs
  // one indexed read and a send costs a single upsert.
  async function saveResults(connection,guildId,before,results) {
    for(const [userId,record] of Object.entries(results)) {
      const previous=before[userId];
      if(previous&&JSON.stringify(previous)===JSON.stringify(record))continue;
      await connection.execute(`INSERT INTO guildsync_membership_dm_results(guild_id,discord_user_id,display_name,status,reason,
        delivery_id,message_id,campaign_id,attempted_at,sent_at,uncertain,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),status=VALUES(status),reason=VALUES(reason),
        delivery_id=VALUES(delivery_id),message_id=VALUES(message_id),campaign_id=VALUES(campaign_id),
        attempted_at=VALUES(attempted_at),sent_at=VALUES(sent_at),uncertain=VALUES(uncertain),updated_at=VALUES(updated_at)`,
        [guildId,userId,String(record.name||'').slice(0,255),String(record.status||'unknown').slice(0,16),
          record.reason?String(record.reason).slice(0,255):null,record.deliveryId||null,record.messageId||null,
          record.campaignId||null,record.attemptedAt??null,record.sentAt??null,record.uncertain?1:0,new Date(now()*1000)]);
    }
  }
  // Older states kept one entry per member and one entry per attempt inside the JSON.
  // Fold the send dates and uncertain flags into the results table once, then drop
  // them from the document so an existing guild shrinks on its next command.
  function migrateLegacyState(state,results) {
    for(const [userId,entry] of Object.entries(state.history||{})) {
      if(results[userId]||!entry)continue;
      const status=entry.uncertain?'uncertain':entry.sentAt?'sent':entry.lastAttemptAt?'failed':null;
      if(!status)continue;
      results[userId]={status,name:'',reason:null,deliveryId:entry.deliveryId||null,messageId:null,campaignId:null,
        attemptedAt:entry.lastAttemptAt||null,sentAt:entry.sentAt||null,uncertain:Boolean(entry.uncertain)};
    }
    delete state.history;
    state.testDeliveries??={};
    for(const [id,job] of Object.entries(state.deliveries||{}))if(job?.isTest&&!state.testDeliveries[id])state.testDeliveries[id]=job;
    delete state.deliveries;
  }
  async function atomic(guildId,fn) {
    return withEsoIdentityLock(db,async connection=>{
      await connection.beginTransaction();
      try{
        await connection.execute('INSERT IGNORE INTO guildsync_membership_dm_state(guild_id,state_json) VALUES(?,?)',[guildId,JSON.stringify({preferences:{},events:[]})]);
        const [rows]=await connection.execute('SELECT state_json FROM guildsync_membership_dm_state WHERE guild_id=? FOR UPDATE',[guildId]);
        const state=JSON.parse(rows[0].state_json);
        const results=await loadResults(connection,guildId);
        const before=structuredClone(results);
        migrateLegacyState(state,results);
        state.results=results;
        const result=await fn(state,connection,configuration());
        await saveResults(connection,guildId,before,results);
        // An expired claim becomes uncertain inside the same transaction, so its
        // member history note is written with the outcome and cannot drift.
        if(state.expiredClaims?.length){
          for(const claim of state.expiredClaims)try{
            await recordDiscordMemberHistoryEvent(connection,{discordId:claim.discordId,eventType:'membership_dm_uncertain',
              fieldName:'membership_dm',newValue:'Membership DM delivery uncertain: '+claim.reason,source:'guildsync',
              at:new Date(now()*1000)});
          }catch{}
          delete state.expiredClaims;
        }
        delete state.results;
        const encoded=JSON.stringify(state);
        if(encoded!==rows[0].state_json)await connection.execute('UPDATE guildsync_membership_dm_state SET state_json=? WHERE guild_id=?',[encoded,guildId]);
        await connection.commit();return result;
      }catch(error){await connection.rollback();throw error;}
    });
  }
  async function candidates(connection) {
    // A fuzzy candidate is not a link, but naming it in the DM saves the member
    // guessing their own ESO account name. The strongest candidate wins.
    const [rows]=await connection.execute(`SELECT d.discord_id AS id,COALESCE(NULLIF(d.server_nickname,''),NULLIF(d.global_name,''),d.username) AS name,
      (SELECT l.eso_account_name FROM guildsync_member_links l
        WHERE l.discord_user_id=d.discord_id AND l.link_status='candidate' AND l.auto_link_blocked=0
        ORDER BY l.match_confidence DESC, l.updated_at DESC LIMIT 1) AS suggested_eso_account_name
      FROM discord_members d WHERE NOT EXISTS (SELECT 1 FROM guildsync_member_links l WHERE l.discord_user_id=d.discord_id AND l.link_status='linked')`);
    return rows.map(row=>({...row,suggestedEsoAccountName:String(row.suggested_eso_account_name||'').trim()}));
  }
  async function autoLink(connection,userId,value) {
    const name=esoAccountKey(value),args=rosterLookupArgs(value);
    if(!name||name.length>64||/[\s@]/.test(name)||!args)return {status:'review',message:'That ESO account name needs officer review.'};
    const [rows]=await connection.execute(ROSTER_LOOKUP,args);
    if(!rows.length)return {status:'review',rosterMatch:'missing',message:ROSTER_NOT_FOUND};
    if(rows.length!==1)return {status:'review',rosterMatch:'ambiguous',message:ROSTER_AMBIGUOUS};
    const [links]=await connection.execute("SELECT * FROM guildsync_member_links WHERE LOWER(TRIM(LEADING '@' FROM TRIM(eso_account_name)))=? OR discord_user_id=?",[name,userId]);
    const same=links.find(l=>l.link_status==='linked'&&esoAccountKey(l.eso_account_name)===name&&l.discord_user_id===userId);
    if(same)return {status:'linked',accountName:rows[0].account_name,message:'Your accounts are already linked.'};
    if(links.some(l=>l.link_status==='linked'||Number(l.auto_link_blocked)))return {status:'review',message:'An existing link or officer restriction needs review. No link was changed.'};
    const [members]=await connection.execute('SELECT * FROM discord_members WHERE discord_id=?',[userId]);
    if(!members[0])return {status:'review',message:'Your Discord membership needs officer review.'};
    await upsertLink(connection,{esoAccountName:rows[0].account_name,discordUserId:userId,discordUsername:members[0].username,
      discordDisplayName:members[0].global_name,discordServerNickname:members[0].server_nickname,
      linkStatus:'linked',linkMethod:'dm-self-report',matchConfidence:100,matchReason:'Account name supplied by this Discord user in a membership DM.'});
    return {status:'linked',accountName:rows[0].account_name,message:'Your Discord and ESO accounts are now linked. Thank you!'};
  }
  async function lastResponse(connection,guildId,userId) {
    const [rows]=await connection.execute('SELECT choice,eso_account_name,responded_at FROM guildsync_membership_dm_responses WHERE guild_id=? AND discord_user_id=?',[guildId,userId]);
    const row=rows[0];
    return row?{choice:row.choice,accountName:row.eso_account_name||null,
      at:row.responded_at?Math.floor(new Date(row.responded_at).getTime()/1000):null}:null;
  }
  // A member who does not play ESO or is not in the guild cannot be connected to an
  // ESO account, so an existing pair is removed whenever that answer is recorded.
  // An officer's block or manual unlink is a decision, not a match result, so an
  // unavailable answer removes matches without overruling that officer.
  // A submitted ESO name may also become the member's server nickname, but only
  // when it is a unique active roster account and is not already linked to another
  // Discord member. The bot does the rename and reports the outcome back here.
  async function renameDecision(connection,userId,text) {
    const name=esoAccountKey(text),args=rosterLookupArgs(text);
    if(!name||name.length>32||/[\s@]/.test(name)||!args)return {allowed:false,reason:'That is not a usable ESO account name.'};
    const [rows]=await connection.execute(ROSTER_LOOKUP,args);
    if(!rows.length)return {allowed:false,reason:'That name is not on the current ESO roster.'};
    if(rows.length!==1)return {allowed:false,reason:'That name matches more than one current roster member.'};
    const canonical=String(rows[0].account_name||'').trim().replace(/^@+/,'');
    const [links]=await connection.execute("SELECT * FROM guildsync_member_links WHERE LOWER(TRIM(LEADING '@' FROM TRIM(eso_account_name)))=? OR discord_user_id=?",[name,userId]);
    const sameName=links.filter(link=>esoAccountKey(link.eso_account_name)===name);
    if(sameName.some(link=>Number(link.auto_link_blocked)))return {allowed:false,reason:'An officer restriction blocks that ESO account.'};
    if(sameName.some(link=>link.link_status==='linked'&&String(link.discord_user_id)!==String(userId)))
      return {allowed:false,reason:'That ESO account is already linked to another Discord member.'};
    return {allowed:true,name:canonical};
  }
  // The latest Discord outcome is written onto the stored response as well as the
  // queued event, so a repost can report it after the event is gone.
  async function saveResponseOutcome(connection,guildId,userId,result={}) {
    const removal=result.removal||{},nickname=result.nickname||{};
    await connection.execute(`UPDATE guildsync_membership_dm_responses SET
      removal_status=COALESCE(?,removal_status),removal_reason=COALESCE(?,removal_reason),
      nickname_status=COALESCE(?,nickname_status),nickname_name=COALESCE(?,nickname_name),
      nickname_reason=COALESCE(?,nickname_reason) WHERE guild_id=? AND discord_user_id=?`,
      [removal.status||null,removal.reason||null,nickname.status||null,nickname.name||null,
        nickname.reason||null,guildId,String(userId)]);
  }
  async function removeMemberLinks(connection,userId) {
    const [result]=await connection.execute("DELETE FROM guildsync_member_links WHERE discord_user_id=? AND auto_link_blocked=0 AND COALESCE(link_method,'')<>'manual_unlink' AND link_status NOT IN ('blocked','unlinked')",[String(userId)]);
    return Number(result?.affectedRows||0);
  }
  async function readPreferences(guildId) {
    const [rows]=await db.execute('SELECT state_json FROM guildsync_membership_dm_state WHERE guild_id=?',[guildId]);
    return rows[0]?JSON.parse(rows[0].state_json).preferences||{}:{};
  }
  return {
    async command(guildId,actorId,action,targetId) {
      if(!await authorizeOfficer(actorId))throw Error('Approved GuildSync User or Admin access is required.');
      return atomic(guildId,async(state,connection,config)=>{
        if(action!=='status'&&!config.enabled)throw Error('Enable membership DMs and configure their reply destination in GuildSync Admin first.');
        if(action==='start'||action==='restart')engine.start(state,await candidates(connection),config.repeatDays,action==='restart');
        else if(action==='pause')engine.pause(state);
        else if(action==='resume')engine.resume(state);
        else if(action!=='status')throw Error('Unknown membership DM command.');
        const c=state.campaign;
        const record=targetId?state.results[targetId]:null;
        return {campaign:c?{id:c.id,status:c.status,lastAttempted:c.lastAttempted,lastSent:c.lastSent,nextAt:c.nextAt,
          remaining:c.queue.filter(q=>q.status==='pending').length,uncertain:c.queue.filter(q=>q.status==='uncertain').length,
          uncertainMembers:c.queue.filter(q=>q.status==='uncertain').map(q=>({userId:q.userId,name:q.name})).slice(0,25)}:null,
          member:targetId?{userId:targetId,history:record?{lastAttemptAt:record.attemptedAt,sentAt:record.sentAt??null,
            uncertain:Boolean(record.uncertain),status:record.status,reason:record.reason||null,deliveryId:record.deliveryId||null}:null,
            result:record?{status:record.status,reason:record.reason||null,messageId:record.messageId||null,
              attemptedAt:record.attemptedAt??null,sentAt:record.sentAt??null,uncertain:Boolean(record.uncertain)}:null,
            preference:state.preferences[targetId]||null,
            lastResponse:await lastResponse(connection,guildId,targetId)}:null};
      });
    },
    async test(guildId,actorId,userId) {
      if(!await authorizeOfficer(actorId)||!/^\d+$/.test(String(userId)))throw Error('An approved officer and Discord test recipient are required.');
      return atomic(guildId,(state,_connection,config)=>{
        if(!config.destinationId)throw Error('Configure the reply destination before testing membership DMs.');
        const job={id:randomUUID(),campaignId:'test',userId,name:'Test recipient',isTest:true,status:'sending',token:randomUUID(),claimedAt:now(),
          destinationId:config.destinationId,destinationType:config.destinationType};
        state.testDeliveries??={};
        const ids=Object.keys(state.testDeliveries);
        if(ids.length>=50)for(const id of ids.slice(0,ids.length-49))delete state.testDeliveries[id];
        state.testDeliveries[job.id]=job;state.testHistory??={};state.testHistory[userId]={deliveryId:job.id,at:now()};
        return {job,config};
      });
    },
    // One member's preference plus the last delivery outcome and reply, so the member
    // link window can show that a DM went out and what the member answered.
    async memberSummary(guildId,userId) {
      const key=String(userId??'').trim();
      if(!/^\d+$/.test(key))throw Error('Choose a Discord member.');
      const preferences=await readPreferences(guildId);
      const [results]=await db.execute('SELECT status,reason,attempted_at,sent_at,uncertain FROM guildsync_membership_dm_results WHERE guild_id=? AND discord_user_id=?',[guildId,key]);
      const [responses]=await db.execute('SELECT choice,eso_account_name,responded_at FROM guildsync_membership_dm_responses WHERE guild_id=? AND discord_user_id=?',[guildId,key]);
      const row=results[0],response=responses[0];
      return {userId:key,preference:preferences[key]||'',
        result:row?{status:row.status,reason:row.reason||null,
          attemptedAt:row.attempted_at==null?null:Number(row.attempted_at),
          sentAt:row.sent_at==null?null:Number(row.sent_at),uncertain:Boolean(row.uncertain)}:null,
        lastResponse:response?{choice:response.choice,accountName:response.eso_account_name||null,
          at:response.responded_at?Math.floor(new Date(response.responded_at).getTime()/1000):null}:null};
    },
    async preferences(guildId) {
      return readPreferences(guildId);
    },
    // An empty value clears the preference. Any other value keeps the member out of
    // every campaign and DM send-time check until an officer clears it again.
    async setPreference(guildId,userId,value) {
      const key=String(userId??'').trim();
      if(!/^\d+$/.test(key)||!['','community','not_playing','opt_out'].includes(value))
        throw Error('Choose a Discord member and a membership contact preference.');
      return atomic(guildId,async(state,connection)=>{
        if(value)state.preferences[key]=value;else delete state.preferences[key];
        const linksRemoved=value?await removeMemberLinks(connection,key):0;
        try{
          await recordDiscordMemberHistoryEvent(connection,{discordId:key,eventType:'membership_dm_preference',
            fieldName:'membership_dm',newValue:preferenceHistoryText(value)+(linksRemoved?' — existing ESO/Discord link removed':''),
            source:'guildsync',at:new Date(now()*1000)});
        }catch{}
        return {userId:key,preference:value};
      });
    },
    async resolve(guildId,actorId,userId,outcome) {
      if(!await authorizeOfficer(actorId))throw Error('Approved GuildSync User or Admin access is required.');
      const key=String(userId??'').trim();
      if(!/^\d+$/.test(key)||!['sent','retry'].includes(outcome))throw Error('Choose a Discord member and whether their uncertain DM arrived.');
      return atomic(guildId,state=>{
        state.results??={};
        const record=state.results[key]||null;
        const queued=state.campaign?.queue.find(job=>job.userId===key&&!job.isTest);
        const queuedUncertain=queued?.status==='uncertain';
        if(!(record?.uncertain||queuedUncertain))throw Error('This member has no uncertain membership DM to resolve.');
        const entry=record??(state.results[key]={status:'uncertain',uncertain:true,name:queued?.name||'',
          deliveryId:queued?.id||null,campaignId:queued?.campaignId||null,attemptedAt:queued?.claimedAt||null});
        if(outcome==='sent') {
          if(queuedUncertain)queued.status='sent';
          Object.assign(entry,{status:'sent',uncertain:false,reason:'Officer confirmed the DM arrived.',sentAt:now()});
          if(state.campaign&&queued)state.campaign.lastSent={userId:key,name:queued.name,at:now()};
          return {message:'Recorded the membership DM as delivered. This member is not contacted again until the repeat interval passes.'};
        }
        Object.assign(entry,{status:'failed',uncertain:false,reason:'Officer confirmed the DM was not delivered.'});
        if(queuedUncertain){
          queued.status='pending';
          if(state.campaign.status==='complete')state.campaign.status='running';
          return {message:'Cleared the uncertain delivery and requeued this member for the current campaign.'};
        }
        return {message:'Cleared the uncertain delivery. This member is eligible for the next campaign.'};
      });
    },
    async repost(guildId,actorId,userId) {
      if(!await authorizeOfficer(actorId))throw Error('Approved GuildSync User or Admin access is required.');
      const key=String(userId??'').trim();
      if(!/^\d+$/.test(key))throw Error('Choose a Discord member whose stored membership reply to repost.');
      const [rows]=await db.execute(`SELECT * FROM guildsync_membership_dm_responses WHERE guild_id=? AND discord_user_id=?`,[guildId,key]);
      const row=rows[0];
      if(!row)throw Error('No stored membership reply was found for that member.');
      const config=configuration();
      if(!config.destinationId)throw Error('Configure a membership DM reply destination before reposting.');
      let status='review',accountName=row.eso_account_name?String(row.eso_account_name):null;
      if(row.choice==='eso'&&accountName){
        const account=accountName.trim().replace(/^@+/,'');
        const [links]=await db.execute("SELECT link_status FROM guildsync_member_links WHERE discord_user_id=? AND LOWER(TRIM(LEADING '@' FROM TRIM(eso_account_name)))=? LIMIT 1",[key,account.toLowerCase()]);
        if(links.some(link=>String(link.link_status)==='linked'))status='linked';
      }
      const removal=row.removal_status?{status:String(row.removal_status),reason:row.removal_reason||null}:null;
      const nickname=row.nickname_status?{status:String(row.nickname_status),name:row.nickname_name||null,reason:row.nickname_reason||null}:null;
      const rosterMatch=row.choice==='eso'&&row.roster_match?String(row.roster_match):null;
      return {response:{userId:key,name:row.display_name||'',choice:row.choice,text:row.response_text||'',
        at:Math.floor(new Date(row.responded_at).getTime()/1000),
        result:{status,accountName,...(rosterMatch?{rosterMatch}:{}),...(removal?{removal}:{}),...(nickname?{nickname}:{})}},
        destinationType:config.destinationType,destinationId:config.destinationId};
    },
    async claim(guildId){return atomic(guildId,async(state,connection,config)=>{
      const job=config.enabled?engine.claim(state,await candidates(connection),config.repeatDays):null;
      if(job){job.destinationId=config.destinationId;job.destinationType=config.destinationType;}
      return {job,config};
    });},
    async validate(guildId,id,token){return atomic(guildId,async(state,connection,config)=>{
      const job=state.campaign?.queue?.find(entry=>entry.id===id)||state.testDeliveries?.[id];
      const record=job?state.results?.[job.userId]:null;
      return {valid:Boolean(job?.status==='sending'&&job.token===token&&(job.isTest || (config.enabled&&state.campaign?.status==='running'&&
        !state.preferences[job.userId]&&!record?.uncertain&&
        (!record?.sentAt||now()-record.sentAt>=config.repeatDays*86400)&&
        (await candidates(connection)).some(m=>m.id===job.userId))))};
    });},
    async finish(guildId,id,token,result){return atomic(guildId,async(state,connection)=>{
      const job=engine.finish(state,id,token,result);
      // The DM outcome is already settled at this point; a history write must never
      // turn a confirmed send into a retryable failure.
      if(!job.isTest&&job.status==='sent')try{
        await recordDiscordMemberHistoryEvent(connection,{discordId:job.userId,eventType:'membership_dm_sent',
          fieldName:'membership_dm',newValue:'Membership DM delivered',source:'guildsync',at:new Date(now()*1000)});
      }catch{}
      if(!job.isTest&&['failed','uncertain'].includes(job.status))try{
        const reason=String(job.detail||'').trim().slice(0,300)||'No reason was recorded.';
        await recordDiscordMemberHistoryEvent(connection,{discordId:job.userId,
          eventType:job.status==='failed'?'membership_dm_failed':'membership_dm_uncertain',fieldName:'membership_dm',
          newValue:(job.status==='failed'?'Membership DM not delivered: ':'Membership DM delivery uncertain: ')+reason,
          source:'guildsync',at:new Date(now()*1000)});
      }catch{}
      return job;
    });},
    async response(guildId,{userId,deliveryId,eventId,choice,text='',nicknameConsent}) {
      if(!['eso','community','not_playing','remove','other'].includes(choice)||String(text).length>10000||!/^\d+$/.test(String(eventId)))throw Error('Invalid membership response.');
      return atomic(guildId,async(state,connection,config)=>{
        // Only the exact DM button or form a member pressed can answer a campaign;
        // an unrelated message is never attributed to the latest delivery. The
        // results table keeps the delivery ID even after the campaign queue moves on.
        const testJob=state.testDeliveries?.[deliveryId];
        const [recordUserId,record]=Object.entries(state.results||{}).find(([,row])=>row.deliveryId===deliveryId)||[];
        const job=testJob||(record?{id:deliveryId,userId:recordUserId,name:record.name,status:record.status,isTest:false,deliveryId}:null);
        if(!job||job.userId!==userId||!['sent','uncertain','sending'].includes(job.status))throw Object.assign(Error('No membership DM for this user was found.'),{code:'NO_MEMBERSHIP_DM'});
        const existing=state.events.find(e=>e.eventId===eventId);
        if(existing)return existing.result;
        // Pressing Request removal twice must not queue two kicks or two cards; the
        // first removal answer wins and the second press is told it was recorded.
        if(!job.isTest&&choice==='remove'){
          const previousRemoval=state.events.find(entry=>!entry.isTest&&entry.choice==='remove'
            &&entry.result?.removal?.status!=='declined'
            &&entry.deliveryId===deliveryId&&String(entry.userId)===String(userId));
          if(previousRemoval)return {...previousRemoval.result,duplicate:true};
        }
        let result={status:'received',message:'Thank you. Your response will be forwarded to the guild officers.'};
        if(job.isTest)result={status:'test',message:'Test response received. No account link, preference or role was changed. Officers will receive this test response.'};
        else {
          if(choice==='eso'){
            result=await autoLink(connection,userId,text);
            if(result.status==='linked')delete state.preferences[userId];
            result.rename=await renameDecision(connection,userId,text);
            // A member who keeps their own name is still linked; the card records
            // that the nickname change was offered and declined.
            if(nicknameConsent===false)result.nickname={status:'declined',
              reason:'The member chose to keep their current server nickname.'};
          }
          if(choice==='community'||choice==='not_playing'){
            state.preferences[userId]=choice;
            result={status:choice,message:'Thank you. You can remain on Discord, and these account reminders will stop.',
              linksRemoved:await removeMemberLinks(connection,userId)};
          }
          // A removal request is the member's decision to leave: stop contact, drop any
          // saved link, and forward the request so an officer removes them in Discord.
          if(choice==='remove'){
            state.preferences[userId]='opt_out';
            result={status:'removal requested',message:'Your request to be removed from the Discord server has been sent to the guild officers.',
              removal:{status:'pending'},linksRemoved:await removeMemberLinks(connection,userId)};
          }
        }
        if(!job.isTest&&(['community','not_playing','remove'].includes(choice)||result.status==='linked')){
          for(const previous of state.events)if(previous.userId===userId&&previous.roleStatus==='pending')previous.roleStatus='superseded';
        }
        // The roster result is stored with the answer, so a repost repeats the same
        // not-found or ambiguous wording after the queued event has been pruned.
        if(!job.isTest)await connection.execute(`INSERT INTO guildsync_membership_dm_responses(guild_id,discord_user_id,display_name,eso_account_name,choice,response_text,responded_at,roster_match)
          VALUES(?,?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),eso_account_name=COALESCE(VALUES(eso_account_name),eso_account_name),
          choice=VALUES(choice),response_text=VALUES(response_text),responded_at=VALUES(responded_at),roster_match=VALUES(roster_match)`,
          [guildId,userId,String(job.name||'').slice(0,255),result.accountName?String(result.accountName).slice(0,255):null,choice,String(text||'').slice(0,10000),new Date(now()*1000),result.rosterMatch?String(result.rosterMatch).slice(0,16):null]);
        if(!job.isTest&&(result.removal||result.nickname))await saveResponseOutcome(connection,guildId,userId,result);
        if(!job.isTest)try{
          await recordDiscordMemberHistoryEvent(connection,{discordId:userId,eventType:'membership_dm_response',
            fieldName:'membership_dm_response',newValue:responseHistoryText(choice,text,result)
              +(result.linksRemoved?' — existing ESO/Discord link removed':''),source:'discord',at:new Date(now()*1000)});
        }catch{}
        // The kick and the nickname are carried out by the bot immediately after
        // this call returns, so their events wait briefly for the reported outcome.
        const awaitingDiscordOutcome=!job.isTest&&!result.nickname
          &&(choice==='remove'||(choice==='eso'&&Boolean(result.rename?.allowed)));
        state.events.push({eventId,deliveryId,userId,name:job.name,choice,text:String(text),at:now(),result,
          isTest:Boolean(job.isTest),destinationType:config.destinationId?config.destinationType:job.destinationType,destinationId:config.destinationId||job.destinationId,
          roleId:!job.isTest&&(['community','not_playing'].includes(choice)||result.status==='linked')?config.communityRoleId:'',
          roleAction:result.status==='linked'?'remove':'add',
          roleStatus:!job.isTest&&config.communityRoleId&&(['community','not_playing'].includes(choice)||result.status==='linked')?'pending':'sent',
          forwardStatus:'pending',retryAt:now()+(awaitingDiscordOutcome?OUTCOME_GRACE_SECONDS:0)});
        pruneMembershipState(state);
        return result;
      });
    },
    // A member can change their mind at the confirmation. Nothing is kicked and no
    // preference or link changes; officers get a card saying the request was declined.
    async removalDeclined(guildId,{userId,deliveryId,eventId}={}) {
      const stale=message=>Object.assign(Error(message),{code:'STALE_OUTCOME'});
      if(!/^\d+$/.test(String(eventId)))throw stale('Invalid removal response.');
      return atomic(guildId,async(state,connection,config)=>{
        const testJob=state.testDeliveries?.[deliveryId];
        const [recordUserId,record]=Object.entries(state.results||{}).find(([,row])=>row.deliveryId===deliveryId)||[];
        const job=testJob||(record?{id:deliveryId,userId:recordUserId,name:record.name,status:record.status,isTest:false,deliveryId}:null);
        if(!job||String(job.userId)!==String(userId)||!['sent','uncertain','sending'].includes(job.status))
          throw Object.assign(Error('No membership DM for this user was found.'),{code:'NO_MEMBERSHIP_DM'});
        if(job.isTest)throw stale('Test responses never change the Discord server.');
        const existing=state.events.find(entry=>entry.eventId===eventId);
        if(existing)return existing.result;
        const result={status:'removal declined',removal:{status:'declined'},
          message:'You are still on the server. Officers will see that you asked to be removed and then chose to stay.'};
        await connection.execute(`INSERT INTO guildsync_membership_dm_responses(guild_id,discord_user_id,display_name,eso_account_name,choice,response_text,responded_at)
          VALUES(?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),choice=VALUES(choice),
          response_text=VALUES(response_text),responded_at=VALUES(responded_at)`,
          [guildId,String(userId),String(job.name||'').slice(0,255),null,'remove','',new Date(now()*1000)]);
        await saveResponseOutcome(connection,guildId,userId,{removal:{status:'declined',
          reason:'The member asked to be removed, then declined the confirmation.'}});
        try{
          await recordDiscordMemberHistoryEvent(connection,{discordId:userId,eventType:'membership_dm_response',
            fieldName:'membership_dm_response',newValue:'Asked to be removed, then declined the confirmation — not removed',
            source:'discord',at:new Date(now()*1000)});
        }catch{}
        state.events.push({eventId,deliveryId,userId:String(userId),name:job.name,choice:'remove',text:'',at:now(),result,
          isTest:false,destinationType:config.destinationId?config.destinationType:job.destinationType,
          destinationId:config.destinationId||job.destinationId,roleId:'',roleAction:'add',roleStatus:'sent',
          forwardStatus:'pending',retryAt:now()});
        pruneMembershipState(state);
        return result;
      });
    },
    // The bot reports what Discord actually did for a queued answer: the kick for a
    // removal request, or the nickname it set from a submitted ESO account name.
    async outcome(guildId,{eventId,removal,nickname}={}) {
      const clean=cleanMembershipOutcome({removal,nickname});
      // Every rejection here is permanent: the queued answer is gone or never
      // allowed this outcome, so a bot must drop its saved copy instead of retrying.
      const stale=message=>Object.assign(Error(message),{code:'STALE_OUTCOME'});
      if(!clean||!/^\d+$/.test(String(eventId)))throw stale('Invalid membership response outcome.');
      return atomic(guildId,async(state,connection)=>{
        const event=state.events.find(entry=>String(entry.eventId)===String(eventId));
        if(!event)throw stale('That membership response is no longer queued.');
        if(event.isTest)throw stale('Test responses never change the Discord server.');
        if(clean.removal&&event.choice!=='remove')throw stale('Removal outcomes only apply to removal requests.');
        if(clean.nickname&&event.choice!=='eso')throw stale('Nickname outcomes only apply to ESO account answers.');
        event.result={...event.result,...(clean.removal?{removal:clean.removal}:{}),...(clean.nickname?{nickname:clean.nickname}:{})};
        event.retryAt=now();
        await saveResponseOutcome(connection,guildId,event.userId,clean);
        const note=clean.removal
          ?clean.removal.status==='kicked'?'Removed from the Discord server (reason: User Request)'
            :clean.removal.status==='gone'?'Already left the Discord server'
            :'Removal could not be completed by the bot: '+(clean.removal.reason||'unknown reason')
          :clean.nickname.status==='set'?`Server nickname set to @${clean.nickname.name||'the submitted name'}`
            :`Server nickname not changed: ${clean.nickname.reason||'unknown reason'}`;
        try{
          await recordDiscordMemberHistoryEvent(connection,{discordId:event.userId,eventType:'membership_dm_outcome',
            fieldName:'membership_dm_outcome',newValue:note,source:'guildsync',at:new Date(now()*1000)});
        }catch{}
        return {ok:true,message:note};
      });
    },
    async claimForward(guildId){return atomic(guildId,(state,_connection,config)=>{
      if(state.forwardLeaseUntil>now())return {event:null};
      const event=state.events.find(e=>(e.forwardStatus!=='sent'||e.roleStatus==='pending')&&e.retryAt<=now());
      if(!event)return {event:null};
      if(event.forwardStatus!=='sent'&&config.destinationId){event.destinationId=config.destinationId;event.destinationType=config.destinationType;}
      if(event.roleStatus==='pending'){
        if(config.communityRoleId)event.roleId=config.communityRoleId;
        else event.roleStatus='superseded';
      }
      event.token=randomUUID();event.retryAt=now()+120;
      state.forwardToken=event.token;state.forwardLeaseUntil=now()+120;
      return {event};
    });},
    async finishForward(guildId,eventId,token,success,roleSuccess){return atomic(guildId,state=>{
      const event=state.events.find(e=>e.eventId===eventId&&e.token===token);
      if(!event)throw Error('Forwarding claim expired.');
      if(success)event.forwardStatus='sent';
      if(roleSuccess&&event.roleStatus==='pending')event.roleStatus='sent';
      if(state.forwardToken===token){state.forwardLeaseUntil=0;state.forwardToken=null;}
      pruneMembershipState(state);
      event.retryAt=now()+120;return {ok:true};
    });}
  };
}

export function registerMembershipDMSocket(socket,service,{guildId,onLinked=async()=>{},onLinksChanged=onLinked}={}) {
  const actions={command:p=>service.command(guildId,p.actorId,p.command,p.targetId),test:p=>service.test(guildId,p.actorId,p.targetId),resolve:p=>service.resolve(guildId,p.actorId,p.userId,p.outcome),repost:p=>service.repost(guildId,p.actorId,p.userId),claim:()=>service.claim(guildId),
    validate:p=>service.validate(guildId,p.deliveryId,p.token),finish:p=>service.finish(guildId,p.deliveryId,p.token,p.result),
    response:async p=>{
      const result=await service.response(guildId,p);
      // Linking and marking a member unavailable both change the link lists.
      if(result.status==='linked'||['community','not_playing','remove'].includes(p.choice))await onLinksChanged();
      return result;
    },    outcome:p=>service.outcome(guildId,p),
    'removal-declined':p=>service.removalDeclined(guildId,p),
    'claim-forward':()=>service.claimForward(guildId),
    'finish-forward':p=>service.finishForward(guildId,p.eventId,p.token,p.success,p.roleSuccess)};
  socket.on('guildsync:membership-dm',async(payload={},callback)=>{
    try{
      if(!socket.guildSyncAuthenticated||socket.guildSyncAuthType!=='discord-bot'||!guildId||socket.guildSyncBot?.guild_id!==guildId||payload.guildId!==guildId)throw Error('Authenticated bot for the configured Discord guild required.');
      if(!actions[payload.action])throw Error('Unknown membership DM action.');
      callback?.({ok:true,result:await actions[payload.action](payload)});
    }catch(error){callback?.({ok:false,message:error.message,code:error.code});}
  });
}

// The member link window is used by approved people who are not bot sockets, so the
// preference is read and written through its own user-authenticated action. The
// guild is the bot's Discord guild, resolved by the server and never sent by a client.
export function registerMembershipDMPreferenceSocket(socket,service,{resolveGuildId,authorize,onChanged}={}) {
  socket.on('guildsync:membership-dm-preferences',async(payload={},callback)=>{
    try{
      if(!socket.guildSyncAuthenticated||!socket.guildSyncUser?.discord_user_id||socket.guildSyncAuthType==='discord-bot')
        throw Error('Approved GuildSync access is required.');
      const role=await authorize(socket);
      if(!['viewer','user','admin'].includes(role))throw Error('Approved GuildSync access is required.');
      if(payload.action==='set'&&!['user','admin'].includes(role))throw Error('User or Admin access is required.');
      const guildId=String(await resolveGuildId?.()||'').trim();
      if(!guildId)throw Error('Connect the GuildSync Discord bot before changing membership DM preferences.');
      let result;
      if(payload.action==='list')result={preferences:await service.preferences(guildId)};
      else if(payload.action==='get')result=await service.memberSummary(guildId,payload.userId);
      else if(payload.action==='set'){
        result=await service.setPreference(guildId,payload.userId,payload.value);
        if(result.preference)await onChanged?.();
      }
      else throw Error('Unknown membership preference action.');
      callback?.({ok:true,...result});
    }catch(error){callback?.({ok:false,message:error.message});}
  });
}
