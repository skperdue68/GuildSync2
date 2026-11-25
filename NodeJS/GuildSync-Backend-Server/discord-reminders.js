import {randomUUID} from 'node:crypto';
import {esoAccountKey, withEsoIdentityLock} from './eso-account-identity.js';

// Reminder management is an officer tool: the caller must hold the Consigliere or
// Kingpin Discord role, matching the guild ranks the bot already recognizes.
const officerRoleNames=['consigliere','consiglieri','consiglieres','kingpin','kingpins'];
const officerRoleKey=value=>String(value||'').trim().toLowerCase().replace(/[^a-z0-9]/g,'');
export const isOfficerRoleName=name=>officerRoleNames.includes(officerRoleKey(name));
export function hasOfficerRole(roles,memberRoleIds) {
  const held=new Set((memberRoleIds||[]).map(id=>String(id)));
  return (roles||[]).some(role=>held.has(String(role.role_id))&&isOfficerRoleName(role.role_name));
}

export function reminderInterval(value) {
  if (value === null || value === '' || !Number.isInteger(Number(value)) || Number(value)<1 || Number(value)>365) {
    throw Error('Reminder interval must be a whole number from 1 to 365 days.');
  }
  return Number(value);
}

export function selectReminderRecipients(rows, intervalDays, now=new Date()) {
  const cutoff=now.getTime()-reminderInterval(intervalDays)*86400000;
  const groups=new Map();
  for(const row of rows) {
    const key=esoAccountKey(row.account_name);
    if(!key)continue;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(row);
  }
  const result=[];
  for(const group of groups.values()) {
    if(group.some(r=>Number(r.in_roster)!==1 || Number(r.discord_opt_out)===1 || r.link_status==='linked' || r.pending_request_id))continue;
    if(group.some(r=>[r.reminder_exported_at,r.reminder_sent_at].some(value=>value && (!Number.isFinite(new Date(value).getTime()) || new Date(value).getTime()>cutoff))))continue;
    const row=group[0];
    const candidate=group.filter(r=>r.link_status==='candidate').sort((a,b)=>Number(b.match_confidence||0)-Number(a.match_confidence||0))[0];
    result.push({recipient:`@${String(row.account_name).trim().replace(/^@+/,'')}`,rank:row.rank||'',
      candidateDiscordId:String(candidate?.discord_user_id||''),
      candidateDiscordName:String(candidate?.discord_username||candidate?.discord_display_name||candidate?.discord_server_nickname||''),
      memberId:row.member_id||''});
  }
  return result.sort((a,b)=>a.recipient.localeCompare(b.recipient));
}

// A test mail must read like the real one, so it uses the tester's own roster
// rank instead of a placeholder. Fall back to the sending account, then blank.
export function testRecipientRank(rows, recipient, sendingAccount) {
  const ranks=new Map(rows.map(row=>[esoAccountKey(row.account_name),String(row.rank_name??row.rank??'').trim()]));
  return ranks.get(esoAccountKey(recipient))||ranks.get(esoAccountKey(sendingAccount))||'';
}

export async function initializeDiscordReminders(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS guildsync_discord_reminder_members (
    member_id CHAR(36) NOT NULL PRIMARY KEY, discord_opt_out TINYINT(1) NOT NULL DEFAULT 0,
    reminder_exported_at DATETIME(3) DEFAULT NULL, reminder_sent_at DATETIME(3) DEFAULT NULL
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await db.query(`CREATE TABLE IF NOT EXISTS guildsync_discord_reminder_batches (
    batch_id CHAR(36) NOT NULL PRIMARY KEY, officer_id VARCHAR(32) NOT NULL,
    created_at DATETIME(3) NOT NULL, exported_at DATETIME(3) DEFAULT NULL,
    sending_account VARCHAR(64) NOT NULL, world_name VARCHAR(64) NOT NULL,
    guild_id VARCHAR(32) NOT NULL, guild_name VARCHAR(255) NOT NULL,
    INDEX idx_discord_reminder_officer (officer_id)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await db.query(`CREATE TABLE IF NOT EXISTS guildsync_discord_reminder_requests (
    request_id CHAR(36) NOT NULL PRIMARY KEY, batch_id CHAR(36) NOT NULL, member_id CHAR(36) NOT NULL,
    record_json LONGTEXT NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'prepared',
    sent_at DATETIME(3) DEFAULT NULL, detail VARCHAR(255) NOT NULL DEFAULT '',test_message TINYINT(1) NOT NULL DEFAULT 0,
    INDEX idx_discord_reminder_batch (batch_id), INDEX idx_discord_reminder_member (member_id,status)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await db.execute('INSERT IGNORE INTO guildsync_settings (setting_key,value) VALUES (?,?)',['discord_reminder_interval_days','30']);
}

// The installation owns one ESO guild. Stable member IDs retain opt-outs/history
// even when a roster snapshot deletes departed members or an account is renamed.
export function createDiscordReminders(db,{guildId='',guildName='',now=()=>new Date()}={}) {
  async function interval(connection=db) {
    const [rows]=await connection.execute('SELECT value FROM guildsync_settings WHERE setting_key=?',['discord_reminder_interval_days']);
    return reminderInterval(rows[0]?.value??30);
  }
  async function roster(connection=db) {
    const [rows]=await connection.execute(`SELECT r.account_name,r.rank_name AS rank,r.in_roster,m.member_id,
      s.discord_opt_out,s.reminder_exported_at,s.reminder_sent_at,
      l.link_status,l.discord_user_id,l.discord_username,l.discord_display_name,l.discord_server_nickname,l.match_confidence,
      (SELECT q.request_id FROM guildsync_discord_reminder_requests q WHERE q.member_id=m.member_id
        AND q.test_message=0 AND q.status IN ('prepared','exported','uncertain','failed') LIMIT 1) AS pending_request_id
      FROM guildsync_roster_members r
      LEFT JOIN guildsync_eso_account_aliases a ON a.alias_key=LOWER(TRIM(LEADING '@' FROM TRIM(r.account_name)))
      LEFT JOIN guildsync_eso_members m ON m.member_id=a.member_id
      LEFT JOIN guildsync_discord_reminder_members s ON s.member_id=m.member_id
      LEFT JOIN guildsync_member_links l ON LOWER(TRIM(LEADING '@' FROM TRIM(l.eso_account_name)))=LOWER(TRIM(LEADING '@' FROM TRIM(r.account_name)))
      WHERE r.in_roster=1`);
    return rows;
  }
  async function identity(connection,account) {
    const key=esoAccountKey(account);
    const [existing]=await connection.execute('SELECT member_id FROM guildsync_eso_account_aliases WHERE alias_key=?',[key]);
    if(existing[0])return existing[0].member_id;
    const id=randomUUID(),name=String(account).trim().replace(/^@+/,'');
    await connection.execute('INSERT INTO guildsync_eso_members(member_id,current_name,name_key) VALUES(?,?,?)',[id,name,key]);
    await connection.execute('INSERT INTO guildsync_eso_account_aliases(alias_key,account_name,member_id) VALUES(?,?,?)',[key,name,id]);
    return id;
  }
  async function transaction(fn) {
    return withEsoIdentityLock(db,async connection=>{
      await connection.beginTransaction();
      try {
        // Serialize preparation/config changes across all officers and processes.
        await connection.execute('SELECT value FROM guildsync_settings WHERE setting_key=? FOR UPDATE',['discord_reminder_interval_days']);
        const value=await fn(connection);await connection.commit();return value;
      }catch(error){await connection.rollback();throw error;}
    });
  }
  async function batch(connection,batchId,officerId) {
    const [batches]=officerId===null
      ?await connection.execute('SELECT * FROM guildsync_discord_reminder_batches WHERE batch_id=?',[batchId])
      :await connection.execute('SELECT * FROM guildsync_discord_reminder_batches WHERE batch_id=? AND officer_id=?',[batchId,officerId]);
    if(!batches[0])throw Error('This reminder batch was not found for your account.');
    const [requests]=await connection.execute('SELECT * FROM guildsync_discord_reminder_requests WHERE batch_id=?',[batchId]);
    return {...batches[0],records:requests.map(r=>({...JSON.parse(r.record_json),status:r.status,detail:r.detail}))};
  }
  async function validatedBatch(connection,batchId,officerId) {
    const data=await batch(connection,batchId,officerId);
    const current=await roster(connection);
    const eligible=new Set(selectReminderRecipients(current.map(row=>({...row,pending_request_id:null,
      reminder_exported_at:null,reminder_sent_at:null})),1,now()).map(row=>esoAccountKey(row.recipient)));
    for(const record of data.records) {
      if(record.isTest||record.status==='sent'||record.status==='cancelled')continue;
      if(!eligible.has(esoAccountKey(record.recipient))) {
        await connection.execute("UPDATE guildsync_discord_reminder_requests SET status='cancelled',detail=? WHERE request_id=?",['No longer eligible for a Discord reminder.',record.requestId]);
        record.status='cancelled';
      }
    }
    return data;
  }
  return {
    async decorate(members) {
      const [states]=await db.execute(`SELECT m.current_name AS account_name,s.* FROM guildsync_discord_reminder_members s
        JOIN guildsync_eso_members m ON m.member_id=s.member_id`);
      const byName=new Map(states.map(s=>[esoAccountKey(s.account_name),s]));
      return members.map(member=>{const state=byName.get(esoAccountKey(member.account_name));return {...member,
        discord_opt_out:Boolean(Number(state?.discord_opt_out)),reminder_exported_at:state?.reminder_exported_at||null,
        reminder_sent_at:state?.reminder_sent_at||null};});
    },
    async overview(officerId) {
      const days=await interval();
      const [batches]=await db.execute(`SELECT batch_id,created_at,exported_at,sending_account,world_name FROM guildsync_discord_reminder_batches
        WHERE officer_id=? ORDER BY created_at DESC LIMIT 20`,[officerId]);
      return {intervalDays:days,recipients:selectReminderRecipients(await roster(),days,now()),batches,guildId,guildName};
    },
    async configure(days) {days=reminderInterval(days);await transaction(c=>c.execute('UPDATE guildsync_settings SET value=? WHERE setting_key=?',[String(days),'discord_reminder_interval_days']));return {intervalDays:days};},
    async optOut(account,optOut,{actorId='',actorName=''}={}) {
      if(typeof optOut!=='boolean'||!esoAccountKey(account))throw Error('An ESO account and a yes/no opt-out value are required.');
      return transaction(async c=>{
        const [members]=await c.execute("SELECT account_name,rank_name FROM guildsync_roster_members WHERE LOWER(TRIM(LEADING '@' FROM account_name))=? AND in_roster=1",[esoAccountKey(account)]);
        if(!members[0])throw Error('The account is not on the current roster.');
        const id=await identity(c,members[0].account_name);
        await c.execute(`INSERT INTO guildsync_discord_reminder_members(member_id,discord_opt_out) VALUES(?,?)
          ON DUPLICATE KEY UPDATE discord_opt_out=VALUES(discord_opt_out)`,[id,optOut?1:0]);
        // A member who does not use Discord cannot be connected to one, so a pair
        // found for them is not a real link and is removed with the opt-out. A pair
        // an officer deliberately blocked or unlinked is that officer's decision,
        // not a match result, so it is kept and still shows as restricted.
        const [links]=optOut
          ?await c.execute("DELETE FROM guildsync_member_links WHERE LOWER(TRIM(LEADING '@' FROM eso_account_name))=? AND auto_link_blocked=0 AND COALESCE(link_method,'')<>'manual_unlink' AND link_status NOT IN ('blocked','unlinked')",[esoAccountKey(account)])
          :[{affectedRows:0}];
        const linksRemoved=Number(links?.affectedRows||0);
        // Roster history answers "why is this member no longer linked?".
        if(linksRemoved>0)try{
          let officer=String(actorName||'').trim();
          if(actorId)try{
            const [officers]=await c.execute("SELECT eso_account_name FROM guildsync_member_links WHERE discord_user_id=? AND link_status='linked' ORDER BY updated_at DESC LIMIT 1",[String(actorId)]);
            officer=String(officers[0]?.eso_account_name||officer).trim().replace(/^@+/,'')||officer;
          }catch{}
          await c.execute("INSERT IGNORE INTO guildsync_roster_events(event_id,account_name,event_type,rank_name,event_timestamp,officer_account_name) VALUES(?,?,?,?,?,?)",["linkrm-"+randomUUID().replace(/-/g,'').slice(0,24),
            String(members[0].account_name||'').trim().replace(/^@+/,''),'Discord link removed',members[0].rank_name?String(members[0].rank_name).slice(0,20):null,
            String(Math.floor(now().getTime()/1000)),officer?officer.slice(0,64):null]);
        }catch{}
        return {account_name:members[0].account_name,discord_opt_out:optOut,links_removed:linksRemoved};
      });
    },
    async prepare(officerId,{sendingAccount,worldName,batchId,testRecipient}) {
      if(!/^@[^\s@]{2,63}$/.test(String(sendingAccount||'')) || !['NA Megaserver','EU Megaserver'].includes(worldName))throw Error('Select the sending ESO account and NA or EU Megaserver.');
      if(!/^[0-9a-f-]{36}$/i.test(String(batchId||'')))throw Error('A unique batch ID is required.');
      if(!guildId)throw Error('Configure GUILDSYNC_ESO_GUILD_ID before exporting Discord reminders.');
      return transaction(async c=>{
        const [existing]=await c.execute('SELECT batch_id FROM guildsync_discord_reminder_batches WHERE batch_id=?',[batchId]);
        if(existing.length)return validatedBatch(c,batchId,officerId);
        if(testRecipient&&!/^@[^\s@]{2,63}$/.test(testRecipient))throw Error('Provide a valid ESO test recipient, starting with @.');
        let recipients;
        if(testRecipient){
          const [ranks]=await c.execute(`SELECT account_name,rank_name FROM guildsync_roster_members
            WHERE in_roster=1 AND LOWER(TRIM(LEADING '@' FROM account_name)) IN (?,?)`,[esoAccountKey(testRecipient),esoAccountKey(sendingAccount)]);
          recipients=[{recipient:testRecipient,rank:testRecipientRank(ranks,testRecipient,sendingAccount),memberId:'',candidateDiscordId:'',candidateDiscordName:'',isTest:true}];
        } else recipients=selectReminderRecipients(await roster(c),await interval(c),now());
        if(!recipients.length)throw Error('No roster members currently qualify for a reminder.');
        const created=now();
        await c.execute(`INSERT INTO guildsync_discord_reminder_batches(batch_id,officer_id,created_at,sending_account,world_name,guild_id,guild_name)
          VALUES(?,?,?,?,?,?,?)`,[batchId,officerId,created,sendingAccount,worldName,guildId,guildName]);
        for(const recipient of recipients) {
          const memberId=recipient.isTest?'test':recipient.memberId||await identity(c,recipient.recipient);
          const record={...recipient,memberId,requestId:randomUUID(),batchId,guildId,guildName,sendingAccount,worldName,createdAt:created.toISOString()};
          await c.execute('INSERT INTO guildsync_discord_reminder_requests(request_id,batch_id,member_id,record_json,test_message) VALUES(?,?,?,?,?)',[record.requestId,batchId,memberId,JSON.stringify(record),record.isTest?1:0]);
        }
        return batch(c,batchId,officerId);
      });
    },
    async getBatch(officerId,batchId){return transaction(c=>validatedBatch(c,batchId,officerId));},
    async reconcile(ids) {
      if(!Array.isArray(ids)||ids.length>1000)throw Error('Invalid local reminder IDs.');
      return transaction(async c=>{
        const records=[],seen=new Set();
        for(const id of new Set(ids.map(String))) {
          const [rows]=await c.execute('SELECT batch_id FROM guildsync_discord_reminder_requests WHERE request_id=?',[id]);
          if(!rows[0]||seen.has(rows[0].batch_id))continue;
          seen.add(rows[0].batch_id);
          const data=await validatedBatch(c,rows[0].batch_id,null);
          if(String(data.guild_id)!==guildId)continue;
          records.push(...data.records.filter(r=>r.status==='cancelled'&&ids.includes(r.requestId)));
        }
        return {records};
      });
    },
    async exported(officerId,batchId) {
      return transaction(async c=>{
        const data=await batch(c,batchId,officerId);
        if(data.exported_at)return {exportedAt:data.exported_at};
        const at=now();
        await c.execute('UPDATE guildsync_discord_reminder_batches SET exported_at=? WHERE batch_id=?',[at,batchId]);
        for(const record of data.records) {
          if(record.isTest||record.status==='cancelled')continue;
          await c.execute(`INSERT INTO guildsync_discord_reminder_members(member_id,reminder_exported_at) VALUES(?,?)
            ON DUPLICATE KEY UPDATE reminder_exported_at=VALUES(reminder_exported_at)`,[record.memberId,at]);
        }
        await c.execute("UPDATE guildsync_discord_reminder_requests SET status='exported' WHERE batch_id=? AND status='prepared'",[batchId]);
        return {exportedAt:at};
      });
    },
    // Clears only the ESO reminder-mail records. Roster links, other saved
    // variables and the Discord membership DM campaign are untouched.
    async reset() {
      return transaction(async c=>{
        const [requests]=await c.execute('DELETE FROM guildsync_discord_reminder_requests');
        const [batches]=await c.execute('DELETE FROM guildsync_discord_reminder_batches');
        const [members]=await c.execute('DELETE FROM guildsync_discord_reminder_members');
        return {deletedRequests:Number(requests?.affectedRows||0),deletedBatches:Number(batches?.affectedRows||0),
          deletedMembers:Number(members?.affectedRows||0)};
      });
    },
    async acknowledge(officerId,acks) {
      if(!Array.isArray(acks)||acks.length>1000)throw Error('Invalid reminder acknowledgements.');
      return transaction(async c=>{
        let processed=0;
        const confirmed=[];
        for(const ack of acks) {
          if(!['sent','failed','uncertain'].includes(ack.status))throw Error('Invalid mail status.');
          const [known]=await c.execute('SELECT guild_id FROM guildsync_discord_reminder_batches WHERE batch_id=?',[String(ack.batchId||'')]);
          if(!known[0] || String(known[0].guild_id)!==guildId)continue;
          const data=await batch(c,String(ack.batchId||''),null);
          const record=data.records.find(r=>r.requestId===ack.requestId);
          if(!record || record.guildId!==String(ack.guildId) || record.worldName!==ack.worldName || esoAccountKey(record.sendingAccount)!==esoAccountKey(ack.sendingAccount))throw Error('Acknowledgement does not match its reminder request.');
          // Already settled rows need no update, but their saved acknowledgement has
          // been delivered and can be removed from the add-on file.
          if(record.status==='sent'){confirmed.push(record.requestId);continue;}
          if(record.status==='cancelled'&&ack.status!=='sent'){confirmed.push(record.requestId);continue;}
          const sent=ack.status==='sent'?new Date(typeof ack.sentAt==='number'?ack.sentAt*1000:ack.sentAt):null;
          if(sent && (!Number.isFinite(sent.getTime()) || sent>now() || sent<new Date(data.created_at)))throw Error('Invalid confirmed send timestamp.');
          await c.execute('UPDATE guildsync_discord_reminder_requests SET status=?,sent_at=?,detail=? WHERE request_id=?',[ack.status,sent,String(ack.detail||'').slice(0,255),ack.requestId]);
          if(sent&&!record.isTest) {
            await c.execute(`INSERT INTO guildsync_discord_reminder_members(member_id,reminder_sent_at) VALUES(?,?)
              ON DUPLICATE KEY UPDATE reminder_sent_at=GREATEST(COALESCE(reminder_sent_at,VALUES(reminder_sent_at)),VALUES(reminder_sent_at))`,[record.memberId,sent]);
            // Roster history answers "were they asked to set up Discord, and when?".
            // The event id is derived from the request so repeated acknowledgements
            // of the same reminder are ignored instead of duplicated.
            await c.execute(`INSERT IGNORE INTO guildsync_roster_events(event_id,account_name,event_type,rank_name,event_timestamp,officer_account_name)
              VALUES(?,?,?,?,?,?)`,[`reminder-${String(record.requestId).replace(/-/g,'').slice(0,23)}`,
              String(record.recipient||'').trim().replace(/^@+/,''),'Discord reminder sent',
              record.rank?String(record.rank).slice(0,20):null,String(Math.floor(sent.getTime()/1000)),
              record.sendingAccount?String(record.sendingAccount).trim().replace(/^@+/,''):null]);
          }
          processed++;
          confirmed.push(ack.requestId);
        }
        return {processed,confirmed};
      });
    }
  };
}

export function registerDiscordReminderSocket(socket,service,{authorize,officerAccess,onLinksChanged}={}) {
  socket.on('guildsync:discord-reminders',async(payload={},callback)=>{
    try {
      if(!socket.guildSyncAuthenticated || !socket.guildSyncUser?.discord_user_id || socket.guildSyncAuthType==='discord-bot')throw Error('User or Admin access is required.');
      const role=await authorize(socket);
      if(!['user','admin'].includes(role))throw Error('User or Admin access is required.');
      const officer=Boolean(await officerAccess?.(socket));
      if(payload.action==='access'){callback?.({ok:true,officer});return;}
      // Community opt-outs stay available to any approved User; campaign data is officer-only.
      if(payload.action!=='opt-out'&&!officer)throw Error('Only members with the Consigliere or Kingpin role can manage Discord reminders.');
      const id=socket.guildSyncUser.discord_user_id;
      let result;
      switch(payload.action){
        case 'preview':result=await service.overview(id);break;
        case 'configure':result=await service.configure(payload.intervalDays);break;
        case 'opt-out':
          result=await service.optOut(payload.accountName,payload.optOut,{actorId:id,
            actorName:[socket.guildSyncUser.display_name,socket.guildSyncUser.global_name,socket.guildSyncUser.username].find(value=>String(value||'').trim())||''});
          // The removal changes both member lists, so approved clients refresh them now.
          if(result.links_removed)await onLinksChanged?.();
          break;
        case 'prepare':result=await service.prepare(id,payload);break;
        case 'batch':result=await service.getBatch(id,payload.batchId);break;
        case 'exported':result=await service.exported(id,payload.batchId);break;
        case 'acknowledge':result=await service.acknowledge(id,payload.acks);break;
        case 'reconcile':result=await service.reconcile(payload.requestIds);break;
        case 'reset':result=await service.reset();break;
        default:throw Error('Unknown Discord reminder action.');
      }
      callback?.({ok:true,...result});
    }catch(error){callback?.({ok:false,message:error.message||'Discord reminder operation failed.'});}
  });
}
