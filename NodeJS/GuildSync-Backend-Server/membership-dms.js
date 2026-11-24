import {randomUUID} from 'node:crypto';
import {withEsoIdentityLock,esoAccountKey} from './eso-account-identity.js';
export {dmConfig} from './membership-dm-config.js';

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
  const eligible=(state,member,days)=>!state.preferences[member.id]&&!state.history[member.id]?.uncertain&&
    (!state.history[member.id]?.sentAt||now()-state.history[member.id].sentAt>=days*86400);
  function expire(state) {
    for(const job of state.campaign?.queue||[])if(job.status==='sending'&&job.claimedAt+120<=now()){
      job.status='uncertain';state.history[job.userId]={...state.history[job.userId],uncertain:true,deliveryId:job.id};
      state.campaign.nextAt=Math.max(state.campaign.nextAt,now()+delay());
    }
  }
  return {
    start(state,members,days,restart=false) {
      state.history??={};state.preferences??={};state.events??=[];state.deliveries??={};
      expire(state);
      if(state.campaign?.queue.some(q=>q.status==='sending'))throw Error('A DM is still being sent. Wait for its result before restarting.');
      if(state.campaign&&['running','paused'].includes(state.campaign.status)&&!restart)throw Error('A campaign already exists. Resume it or explicitly restart.');
      const seen=new Set();
      const queue=members.filter(m=>!seen.has(m.id)&&seen.add(m.id)&&eligible(state,m,days))
        .sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'})||a.id.localeCompare(b.id))
        .map(m=>({id:randomUUID(),userId:m.id,name:m.name,status:'pending'}));
      state.campaign={id:randomUUID(),status:queue.length?'running':'complete',queue,nextAt:now()+delay(),startedAt:now(),lastAttempted:null,lastSent:null};
      rememberPace(state);
      for(const job of queue){job.campaignId=state.campaign.id;state.deliveries[job.id]=job;}
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
        state.history[job.userId]={...state.history[job.userId],lastAttemptAt:now(),deliveryId:job.id};
        return job;
      }
      campaign.status='complete';return null;
    },
    finish(state,id,token,result) {
      const job=state.deliveries[id];
      if(!job||job.status!=='sending'||job.token!==token)throw Error('This DM delivery claim is no longer active.');
      if(!['sent','failed','skipped','uncertain'].includes(result.status))throw Error('Invalid DM outcome.');
      job.status=result.status;job.detail=String(result.detail||'').slice(0,255);job.messageId=result.messageId||null;
      if(job.isTest)return job;
      const history=state.history[job.userId]??={};
      if(result.status!=='skipped'){rememberPace(state);state.campaign.nextAt=now()+delay();}
      if(result.status==='sent'){
        if(!job.messageId)throw Error('A confirmed Discord message ID is required.');
        history.sentAt=now();history.uncertain=false;
        state.campaign.lastSent={userId:job.userId,name:job.name,at:now()};
      }
      if(result.status==='uncertain')history.uncertain=true;
      if(result.status==='skipped')state.campaign.nextAt=now();
      return job;
    }
  };
}

export async function membershipDMManaged(db,guildId,userId) {
  const [rows]=await db.execute('SELECT state_json FROM guildsync_membership_dm_state WHERE guild_id=?',[guildId]);
  if(!rows[0])return false;
  const state=JSON.parse(rows[0].state_json);
  const history=state.history?.[userId];
  // Only a confirmed contact, an ambiguous delivery or a recorded preference
  // replaces the older onboarding reminder. A failed or skipped attempt never
  // reached the member, so onboarding must still be able to.
  return Boolean(state.preferences?.[userId]||history?.sentAt||history?.uncertain);
}

export async function initializeMembershipDMs(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS guildsync_membership_dm_state (
    guild_id VARCHAR(32) NOT NULL PRIMARY KEY,state_json LONGTEXT NOT NULL
  ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await db.query(`CREATE TABLE IF NOT EXISTS guildsync_membership_dm_responses (
    guild_id VARCHAR(32) NOT NULL,discord_user_id VARCHAR(32) NOT NULL,
    display_name VARCHAR(255) NOT NULL DEFAULT '',eso_account_name VARCHAR(255) DEFAULT NULL,
    choice VARCHAR(20) NOT NULL,response_text LONGTEXT NOT NULL,responded_at DATETIME(3) NOT NULL,
    PRIMARY KEY (guild_id,discord_user_id),INDEX idx_membership_dm_response_choice (guild_id,choice)
  ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
}

// The per-guild JSON keeps only operational state. Fully forwarded responses live in
// guildsync_membership_dm_responses, so settled events and old delivery claims are
// dropped instead of accumulating for the life of the guild.
export function pruneMembershipState(state,{maxEvents=200,maxDeliveries=1000}={}) {
  const settled=event=>event.forwardStatus==='sent'&&['sent','superseded'].includes(event.roleStatus);
  if(state.events?.length>maxEvents) {
    let excess=state.events.length-maxEvents;
    state.events=state.events.filter(event=>{
      if(excess>0&&settled(event)){excess--;return false;}
      return true;
    });
  }
  const ids=Object.keys(state.deliveries||{});
  if(ids.length>maxDeliveries) {
    const removable=ids.filter(id=>['sent','failed','skipped'].includes(state.deliveries[id].status))
      .sort((left,right)=>(state.deliveries[left].claimedAt||0)-(state.deliveries[right].claimedAt||0));
    for(const id of removable.slice(0,ids.length-maxDeliveries))delete state.deliveries[id];
  }
  return state;
}

export function createMembershipDMService(db,{configuration,upsertLink,authorizeOfficer,now=()=>Math.floor(Date.now()/1000),random=Math.random}={}) {
  const engine=createDMCampaignEngine({now,random,pace:()=>configuration()});
  async function atomic(guildId,fn) {
    return withEsoIdentityLock(db,async connection=>{
      await connection.beginTransaction();
      try{
        await connection.execute('INSERT IGNORE INTO guildsync_membership_dm_state(guild_id,state_json) VALUES(?,?)',[guildId,JSON.stringify({history:{},preferences:{},events:[],deliveries:{}})]);
        const [rows]=await connection.execute('SELECT state_json FROM guildsync_membership_dm_state WHERE guild_id=? FOR UPDATE',[guildId]);
        const state=JSON.parse(rows[0].state_json);
        // JSON round-trips lose queue/delivery object identity; restore it.
        if(state.campaign)state.campaign.queue=state.campaign.queue.map(job=>state.deliveries[job.id]||job);
        const result=await fn(state,connection,configuration());
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
        return {campaign:c?{id:c.id,status:c.status,lastAttempted:c.lastAttempted,lastSent:c.lastSent,nextAt:c.nextAt,
          remaining:c.queue.filter(q=>q.status==='pending').length,uncertain:c.queue.filter(q=>q.status==='uncertain').length,
          uncertainMembers:c.queue.filter(q=>q.status==='uncertain').map(q=>({userId:q.userId,name:q.name})).slice(0,25)}:null,
          member:targetId?{userId:targetId,history:state.history[targetId]||null,preference:state.preferences[targetId]||null,
            lastResponse:await lastResponse(connection,guildId,targetId)}:null};
      });
    },
    async test(guildId,actorId,userId) {
      if(!await authorizeOfficer(actorId)||!/^\d+$/.test(String(userId)))throw Error('An approved officer and Discord test recipient are required.');
      return atomic(guildId,(state,_connection,config)=>{
        if(!config.destinationId)throw Error('Configure the reply destination before testing membership DMs.');
        const job={id:randomUUID(),campaignId:'test',userId,name:'Test recipient',isTest:true,status:'sending',token:randomUUID(),claimedAt:now(),
          destinationId:config.destinationId,destinationType:config.destinationType};
        state.deliveries[job.id]=job;state.testHistory??={};state.testHistory[userId]={deliveryId:job.id,at:now()};
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
        const history=state.history?.[key]||{};
        const deliveries=Object.values(state.deliveries||{}).filter(job=>job.userId===key&&!job.isTest)
          .sort((a,b)=>(b.claimedAt||0)-(a.claimedAt||0));
        const queued=state.campaign?.queue.find(job=>job.userId===key&&!job.isTest);
        const uncertainJobs=deliveries.filter(job=>job.status==='uncertain'),queuedUncertain=queued?.status==='uncertain';
        if(!(history.uncertain||uncertainJobs.length||queuedUncertain))throw Error('This member has no uncertain membership DM to resolve.');
        if(outcome==='sent') {
          for(const job of uncertainJobs){job.status='sent';job.detail='Officer confirmed the DM arrived.';}
          if(queuedUncertain)queued.status='sent';
          state.history[key]={...history,sentAt:now(),uncertain:false};
          if(state.campaign&&queued)state.campaign.lastSent={userId:key,name:queued.name,at:now()};
          return {message:'Recorded the membership DM as delivered. This member is not contacted again until the repeat interval passes.'};
        }
        for(const job of uncertainJobs){job.status='failed';job.detail='Officer confirmed the DM was not delivered.';}
        state.history[key]={...history,uncertain:false};
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
      const job=state.deliveries[id];
      return {valid:Boolean(job?.status==='sending'&&job.token===token&&(job.isTest || (config.enabled&&state.campaign?.status==='running'&&
        !state.preferences[job.userId]&&!state.history[job.userId]?.uncertain&&
        (!state.history[job.userId]?.sentAt||now()-state.history[job.userId].sentAt>=config.repeatDays*86400)&&
        (await candidates(connection)).some(m=>m.id===job.userId))))};
    });},
    async finish(guildId,id,token,result){return atomic(guildId,state=>engine.finish(state,id,token,result));},
    async response(guildId,{userId,deliveryId,eventId,choice,text=''}) {
      if(!['eso','community','not_playing','other'].includes(choice)||String(text).length>10000||!/^\d+$/.test(String(eventId)))throw Error('Invalid membership response.');
      return atomic(guildId,async(state,connection,config)=>{
        // Only the exact DM button or form a member pressed can answer a campaign;
        // an unrelated message is never attributed to the latest delivery.
        const job=state.deliveries[deliveryId];
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
