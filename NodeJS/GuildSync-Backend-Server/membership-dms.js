import {randomUUID} from 'node:crypto';
import {withEsoIdentityLock,esoAccountKey} from './eso-account-identity.js';
import {recordDiscordMemberHistoryEvent} from './discord-member-history.js';

// The Discord history row keeps the member's answer readable without exposing
// the whole forwarded message.
function responseHistoryText(choice,text,result={}) {
  const account=result.accountName?`@${String(result.accountName).trim().replace(/^@+/,'')}`:'';
  if(choice==='eso')return result.status==='linked'
    ?`Linked ESO account ${account}`
    :`ESO account ${account||String(text||'').trim()} submitted for officer review`;
  if(choice==='community')return 'Community only; account reminders stopped';
  if(choice==='not_playing')return 'Not playing ESO; account reminders stopped';
  return `Other response: ${String(text||'').trim().slice(0,300)}`;
}
export {dmConfig} from './membership-dm-config.js';

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
        .map(m=>({id:randomUUID(),userId:m.id,name:m.name,status:'pending'}));
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
    const [rows]=await connection.execute(`SELECT d.discord_id AS id,COALESCE(NULLIF(d.server_nickname,''),NULLIF(d.global_name,''),d.username) AS name
      FROM discord_members d WHERE NOT EXISTS (SELECT 1 FROM guildsync_member_links l WHERE l.discord_user_id=d.discord_id AND l.link_status='linked')`);
    return rows;
  }
  async function autoLink(connection,userId,value) {
    const name=esoAccountKey(value);
    if(!name||name.length>64||/[\s@]/.test(name))return {status:'review',message:'That ESO account name needs officer review.'};
    const [rows]=await connection.execute("SELECT account_name FROM guildsync_roster_members WHERE in_roster=1 AND LOWER(TRIM(LEADING '@' FROM TRIM(account_name)))=?",[name]);
    if(rows.length!==1)return {status:'review',message:'No unique active roster match was found. Officers will review your reply.'};
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
  // Recent unsuccessful outcomes are the officer-facing answer to "who never got a
  // DM, and why". Failed, uncertain and skipped attempts are kept per member with
  // their reason and attempt time, and listed here newest first.
  async function recentFailures(connection,guildId) {
    const [rows]=await connection.execute(`SELECT discord_user_id,display_name,status,reason,attempted_at
      FROM guildsync_membership_dm_results WHERE guild_id=? AND status IN ('failed','uncertain','skipped')
      ORDER BY attempted_at DESC LIMIT 10`,[guildId]);
    return rows.map(row=>({userId:String(row.discord_user_id),name:row.display_name||'',status:row.status,
      reason:row.reason||'',at:row.attempted_at==null?null:Number(row.attempted_at)}));
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
        const failures=await recentFailures(connection,guildId);
        const record=targetId?state.results[targetId]:null;
        return {campaign:c?{id:c.id,status:c.status,lastAttempted:c.lastAttempted,lastSent:c.lastSent,nextAt:c.nextAt,
          remaining:c.queue.filter(q=>q.status==='pending').length,uncertain:c.queue.filter(q=>q.status==='uncertain').length,
          uncertainMembers:c.queue.filter(q=>q.status==='uncertain').map(q=>({userId:q.userId,name:q.name})).slice(0,25),
          recentFailures:failures}:null,recentFailures:failures,
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
    // Read-only list for the Discord test mode: same candidates the campaign would
    // contact, but nothing is written to state, history or deliveries.
    async testPlan(guildId,actorId) {
      if(!await authorizeOfficer(actorId))throw Error('Approved GuildSync User or Admin access is required.');
      const [rows]=await db.execute(`SELECT d.discord_id AS id,COALESCE(NULLIF(d.server_nickname,''),NULLIF(d.global_name,''),d.username) AS name
        FROM discord_members d WHERE NOT EXISTS (SELECT 1 FROM guildsync_member_links l WHERE l.discord_user_id=d.discord_id AND l.link_status='linked')`);
      return {members:rows.map(row=>({userId:String(row.id),name:row.name})),config:configuration()};
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
    async response(guildId,{userId,deliveryId,eventId,choice,text=''}) {
      if(!['eso','community','not_playing','other'].includes(choice)||String(text).length>10000||!/^\d+$/.test(String(eventId)))throw Error('Invalid membership response.');
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
        let result={status:'received',message:'Thank you. Your response will be forwarded to the guild officers.'};
        if(job.isTest)result={status:'test',message:'Test response received. No account link, preference or role was changed. Officers will receive this test response.'};
        else {
          if(choice==='eso'){result=await autoLink(connection,userId,text);if(result.status==='linked')delete state.preferences[userId];}
          if(choice==='community'||choice==='not_playing'){state.preferences[userId]=choice;result={status:choice,message:'Thank you. You can remain on Discord, and these account reminders will stop.'};}
        }
        if(!job.isTest&&(['community','not_playing'].includes(choice)||result.status==='linked')){
          for(const previous of state.events)if(previous.userId===userId&&previous.roleStatus==='pending')previous.roleStatus='superseded';
        }
        if(!job.isTest)await connection.execute(`INSERT INTO guildsync_membership_dm_responses(guild_id,discord_user_id,display_name,eso_account_name,choice,response_text,responded_at)
          VALUES(?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),eso_account_name=COALESCE(VALUES(eso_account_name),eso_account_name),
          choice=VALUES(choice),response_text=VALUES(response_text),responded_at=VALUES(responded_at)`,
          [guildId,userId,String(job.name||'').slice(0,255),result.accountName?String(result.accountName).slice(0,255):null,choice,String(text||'').slice(0,10000),new Date(now()*1000)]);
        if(!job.isTest)try{
          await recordDiscordMemberHistoryEvent(connection,{discordId:userId,eventType:'membership_dm_response',
            fieldName:'membership_dm_response',newValue:responseHistoryText(choice,text,result),source:'discord',at:new Date(now()*1000)});
        }catch{}
        state.events.push({eventId,deliveryId,userId,name:job.name,choice,text:String(text),at:now(),result,
          isTest:Boolean(job.isTest),destinationType:config.destinationId?config.destinationType:job.destinationType,destinationId:config.destinationId||job.destinationId,
          roleId:!job.isTest&&(['community','not_playing'].includes(choice)||result.status==='linked')?config.communityRoleId:'',
          roleAction:result.status==='linked'?'remove':'add',
          roleStatus:!job.isTest&&config.communityRoleId&&(['community','not_playing'].includes(choice)||result.status==='linked')?'pending':'sent',
          forwardStatus:'pending',retryAt:now()});
        pruneMembershipState(state);
        return result;
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

export function registerMembershipDMSocket(socket,service,{guildId,onLinked=async()=>{}}={}) {
  const actions={command:p=>service.command(guildId,p.actorId,p.command,p.targetId),test:p=>service.test(guildId,p.actorId,p.targetId),'test-plan':p=>service.testPlan(guildId,p.actorId),resolve:p=>service.resolve(guildId,p.actorId,p.userId,p.outcome),claim:()=>service.claim(guildId),
    validate:p=>service.validate(guildId,p.deliveryId,p.token),finish:p=>service.finish(guildId,p.deliveryId,p.token,p.result),
    response:async p=>{const result=await service.response(guildId,p);if(result.status==='linked')await onLinked();return result;},'claim-forward':()=>service.claimForward(guildId),
    'finish-forward':p=>service.finishForward(guildId,p.eventId,p.token,p.success,p.roleSuccess)};
  socket.on('guildsync:membership-dm',async(payload={},callback)=>{
    try{
      if(!socket.guildSyncAuthenticated||socket.guildSyncAuthType!=='discord-bot'||!guildId||socket.guildSyncBot?.guild_id!==guildId||payload.guildId!==guildId)throw Error('Authenticated bot for the configured Discord guild required.');
      if(!actions[payload.action])throw Error('Unknown membership DM action.');
      callback?.({ok:true,result:await actions[payload.action](payload)});
    }catch(error){callback?.({ok:false,message:error.message,code:error.code});}
  });
}
