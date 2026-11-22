import {calculateRaffleBonus, selectPurchasePolicy} from './raffle-bonus.js';
import {monthlySalesEndAtOrAfter, previousMonthlySalesEnd} from './raffle-schedule.js';

const LEADERBOARD_LIMIT=5;
// Seller cards use rolling windows measured back from each request time, not calendar
// periods. The two buyer cards follow the 50/50 raffle instead.
const TRADER_WINDOW_SECONDS=14*24*60*60;
// A closed 50/50 raffle keeps its buyer standings on the cards until the configured
// linger passes after its draw, so they can still be quoted; the next refresh after
// that shows the new raffle. Administrators change this live; one hour is the default.
export const DEFAULT_BUYER_RAFFLE_LINGER_HOURS=1;
// Raffles draw one hour after ticket sales close. The buyer cards hand over from one
// raffle to the next at that draw, not at the earlier cutoff.
export const RAFFLE_DRAW_AFTER_SALES_SECONDS=60*60;
export const MAX_BUYER_RAFFLE_LINGER_HOURS=168;
export function buyerRaffleLingerSeconds(env=process.env){
 const raw=env?.GUILDSYNC_COMMUNITY_BUYER_RAFFLE_LINGER_HOURS;
 const hours=Number(raw);
 return String(raw ?? '').trim()!==''&&Number.isFinite(hours)&&hours>=0&&hours<=MAX_BUYER_RAFFLE_LINGER_HOURS
  ? Math.round(hours*3600) : DEFAULT_BUYER_RAFFLE_LINGER_HOURS*3600;
}
function buyerRaffleLingerNote(seconds){
 if(!seconds)return 'A closed raffle is replaced at the next refresh.';
 const hours=seconds/3600;
 const text=Number.isInteger(hours)?String(hours):hours.toFixed(1);
 return `A closed raffle stays listed for ${text} hour${hours===1?'':'s'}, then resets to the next one.`;
}
const positive=n=>Number.isFinite(Number(n))?Math.max(0,Number(n)):0;
const label=r=>r.server_nickname||r.global_name||r.username||r.account_name||r.discord_id||'Unknown';
const typeOf=t=>['monthly','50/50','5050'].includes(String(t).toLowerCase())?'monthly':['biweekly','bi-weekly','bi weekly'].includes(String(t).toLowerCase())?'biweekly':null;
function leaders(rows,key,value){const totals=new Map();for(const r of rows){const id=String(key(r)||'').toLowerCase();if(!id)continue;const previous=totals.get(id)||{name:label(r),value:0,detail:''};previous.value+=value(r);totals.set(id,previous);}return [...totals.values()].filter(r=>r.value>0).sort((a,b)=>b.value-a.value||a.name.localeCompare(b.name)).slice(0,LEADERBOARD_LIMIT);}
// The 50/50 raffle period the buyer cards count: counting starts at the previous draw and
// runs to this raffle's own draw, so each raffle stands alone instead of sliding forward
// day by day. A draw is one hour after its sales cutoff, so a raffle counts from 8 PM
// Eastern on the previous draw date to 8 PM Eastern on its own. Adding the configured
// linger to the draw is what keeps a just-closed raffle readable until the linger expires.
export function buyerRaffleWindow(now=Math.floor(Date.now()/1000),env=process.env){
 const lingerSeconds=buyerRaffleLingerSeconds(env);
 const cutoff=monthlySalesEndAtOrAfter(Number(now)-RAFFLE_DRAW_AFTER_SALES_SECONDS-lingerSeconds+1);
 const drawTime=cutoff+RAFFLE_DRAW_AFTER_SALES_SECONDS;
 return {type:'monthly',cutoff,drawTime,salesEnd:drawTime,
  salesStart:previousMonthlySalesEnd(cutoff)+RAFFLE_DRAW_AFTER_SALES_SECONDS+1,lingerSeconds};
}
export async function initializeCommunityStatisticsSchema(db){
 await db.query(`CREATE TABLE IF NOT EXISTS guildsync_community_statistics_metadata (metadata_key VARCHAR(64) PRIMARY KEY, metadata_value VARCHAR(64) NOT NULL)`);
 await db.query(`INSERT IGNORE INTO guildsync_community_statistics_metadata (metadata_key,metadata_value) VALUES ('tracking_since', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ'))`);
 await db.query(`CREATE TABLE IF NOT EXISTS guildsync_discord_interactions (interaction_id VARCHAR(32) PRIMARY KEY, guild_id VARCHAR(32) NOT NULL, discord_id VARCHAR(32) NOT NULL, display_name VARCHAR(255) NOT NULL, interaction_type VARCHAR(16) NOT NULL, interaction_name VARCHAR(100) NOT NULL, recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_community_interactions_actor (discord_id)) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
 await db.query(`CREATE TABLE IF NOT EXISTS guildsync_discord_activity (guild_id VARCHAR(32) NOT NULL, event_key VARCHAR(64) NOT NULL, discord_id VARCHAR(32) NOT NULL, display_name VARCHAR(255) NOT NULL, activity_type VARCHAR(16) NOT NULL, recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (guild_id,event_key), INDEX idx_community_activity_actor (discord_id,activity_type)) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
 await db.query(`INSERT IGNORE INTO guildsync_community_statistics_metadata (metadata_key,metadata_value) VALUES ('discord_activity_since', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ'))`);
}
export function buildCommunityStatistics({now=Math.floor(Date.now()/1000),trackingSince=null,roster=[],rosterEvents=[],discordMembers=[],discordHistory=[],activity=[],banking=[],windows=[],traderSales=[],bonusPolicies=[],bonusOverrides=[],env=process.env,viewerRole=null}={}){
 const highlights=[];
 const membershipIds=new Set(['guild-joins','discord-joins']);
 const add=(id,title,description,unit,rows,options={})=>{
   const card={id,title,description,unit,rows,...options};
   // Keep the two membership sources at the end as other highlights are added.
   const membershipIndex=highlights.findIndex(item=>membershipIds.has(item.id));
   if(!membershipIds.has(id)&&membershipIndex>=0)highlights.splice(membershipIndex,0,card);
   else highlights.push(card);
 };
 // Prefer each member's current server nickname; names recorded with the event are the fallback.
 const currentNames=new Map(discordMembers.map(m=>[String(m.discord_id),m]));
 const withCurrentNames=rows=>rows.map(r=>{const m=currentNames.get(String(r.discord_id));return m?{...r,server_nickname:m.server_nickname||r.server_nickname,global_name:m.global_name||r.global_name,username:m.username||r.username}:r;});
 add('guild-joins','ESO guild: most recorded joins','Recorded ESO guild join events. Rejoins count again; retained history may be incomplete.','joins',leaders(rosterEvents.filter(r=>r.event_type==='joined'),r=>r.account_name,()=>1));
 add('discord-joins','Discord server: most recorded joins','Live Discord server join records only; bulk imports excluded. First discovery during an update can appear as a join.','joins',leaders(withCurrentNames(discordHistory.filter(r=>r.event_type==='joined_server'&&r.source==='live_event')),r=>r.discord_id,()=>1));
 // A roster snapshot timestamp can be the import date. Only an actual recorded join establishes tenure.
 const current=roster.filter(r=>Number(r.in_roster)===1);const tenure=current.flatMap(r=>{const joins=rosterEvents.filter(e=>e.account_name.toLowerCase()===r.account_name.toLowerCase()&&e.event_type==='joined').map(e=>Number(e.event_timestamp)).filter(t=>t>0&&t<=now);if(!joins.length)return [];const joined=Math.max(...joins);const departed=rosterEvents.some(e=>String(e.account_name).toLowerCase()===r.account_name.toLowerCase()&&['left','kicked'].includes(e.event_type)&&Number(e.event_timestamp)>=joined&&Number(e.event_timestamp)<=now);if(departed)return [];return [{name:r.account_name,value:Math.floor((now-joined)/86400),detail:'Latest recorded join: '+new Date(joined*1000).toISOString()}];});
 const missingJoins=current.filter(r=>!rosterEvents.some(e=>String(e.account_name).toLowerCase()===String(r.account_name).toLowerCase()&&e.event_type==='joined'&&Number(e.event_timestamp)>0&&Number(e.event_timestamp)<=now)).length;
 const joinCoverage=`${missingJoins} of ${current.length} current members have no recorded join date. Import dates are excluded.`;
 add('longest-member','Longest membership with a known join date','Days since the latest recorded join. '+joinCoverage,'days',[...tenure].sort((a,b)=>b.value-a.value||a.name.localeCompare(b.name)).slice(0,LEADERBOARD_LIMIT));
 add('newest-member','Newest recorded current members','Current ESO members with a recorded join. '+joinCoverage,'days',[...tenure].sort((a,b)=>a.value-b.value||b.detail.localeCompare(a.detail)||a.name.localeCompare(b.name)).slice(0,LEADERBOARD_LIMIT));
 const recordedActivity=withCurrentNames(activity).filter(r=>['post','reaction'].includes(r.activity_type)&&Number(r.activity_timestamp)>=now-30*86400&&Number(r.activity_timestamp)<=now);
 add('discord-busiest','Busiest Discord Users','Recorded posts plus emoji reactions given in the last 30 days. Bots excluded; offline or missed events are not backfilled.','actions',leaders(recordedActivity,r=>r.discord_id,r=>positive(r.activity_count)));
 add('discord-posts','Most Posts','New Discord posts recorded in the last 30 days; bots and system messages excluded.','posts',leaders(recordedActivity.filter(r=>r.activity_type==='post'),r=>r.discord_id,r=>positive(r.activity_count)));
 add('discord-reactions','Most Reactions Given','Emoji reactions given in the last 30 days, including likes. Each member/message/emoji counts once; removing a reaction does not subtract it.','reactions',leaders(recordedActivity.filter(r=>r.activity_type==='reaction'),r=>r.discord_id,r=>positive(r.activity_count)));
 const purchases=banking.filter(r=>typeOf(r.type)&&positive(r.purchasedTickets)>0&&Number(r.time)>0&&Number(r.time)<=now).map(r=>({...r,account_name:r.displayName}));
 for(const w of windows){const rows=purchases.filter(r=>typeOf(r.type)===w.type&&Number(r.time)>=w.salesStart&&Number(r.time)<=w.salesEnd);add('tickets-'+w.type,'Current '+(w.type==='monthly'?'50/50':'Bi-weekly')+' ticket purchasers (Top '+LEADERBOARD_LIMIT+')','Purchased tickets only; bonus tickets excluded.','tickets',leaders(rows,r=>r.displayName,r=>positive(r.purchasedTickets)));}
 // Bonus tickets actually earned in the raffles currently on sale: participation and
 // the bonus cost, scored with the same per-purchase policy the receipts use. Manual
 // ticket entries already carry a discretionary count and are left out.
 const bonusRows=windows.map(w=>{
  const label=w.type==='monthly'?'50/50':'Bi-Weekly';
  const rowsInWindow=purchases.filter(r=>typeOf(r.type)===w.type&&Number(r.time)>=w.salesStart&&Number(r.time)<=w.salesEnd&&positive(r.purchasedTickets)>0&&!/^manual/i.test(String(r.dataSource||'')));
  const override=bonusOverrides.find(o=>o.type===w.type&&Number(o.salesEnd)===Number(w.salesEnd));
  const buyers=new Set(rowsInWindow.map(r=>String(r.displayName||'').trim().toLowerCase()).filter(Boolean));
  const earning=new Set();
  let bonusTickets=0;
  for(const r of rowsInWindow){
   const policy=override||selectPurchasePolicy(bonusPolicies,w.type,Number(r.time));
   if(!policy?.enabled||!Array.isArray(policy.tiers))continue;
   const result=calculateRaffleBonus({purchasedTickets:positive(r.purchasedTickets),purchaseTimestamp:Number(r.time),salesStart:w.salesStart,salesEnd:w.salesEnd,tiers:policy.tiers,enabled:true});
   if(!(result.bonusTickets>0))continue;
   bonusTickets+=result.bonusTickets;
   earning.add(String(r.displayName||'').trim().toLowerCase());
  }
  return {name:label,value:bonusTickets,detail:buyers.size
   ? `${earning.size} of ${buyers.size} buyers earned bonus tickets`
   : 'No ticket buyers yet in this raffle'};
 });
 if(bonusRows.length)add('raffle-bonus','Bonus Tickets Awarded (current raffles)','Early-purchase bonus tickets earned in each raffle currently on sale, scored with the bonus settings in force when each purchase was made. Manual ticket entries are excluded.','bonus tickets',bonusRows);
 const spending=r=>{const n=positive(r.amount),digit=Math.trunc(n)%10;return [1,3].includes(digit)&&n>digit?n-digit:n;};
 const recentPurchases=purchases.filter(r=>Number(r.time)>=now-90*86400);
 add('raffle-spending','Raffle spending (last 90 days, Top '+LEADERBOARD_LIMIT+')','Recorded ticket purchases in the last 90 days across both raffles, excluding +1/+3 markers; retained banking history only.','gold',leaders(recentPurchases,r=>r.displayName,spending));
 // Trader gold is shown to approved users and admins; a read-only viewer gets the same
 // rankings with the amounts withheld. Only the server decides, from the authenticated role.
 const showTraderGold=['user','admin'].includes(String(viewerRole||'').toLowerCase());
 const goldUnit=showTraderGold?'gold':'';
 const withGold=rows=>showTraderGold?rows:rows.map(r=>({name:r.name}));
 const goldNote=shown=>shown?'Gold amounts are listed.':'Gold amounts are not listed.';
 const traderWindow=seconds=>traderSales.filter(r=>Number(r.event_timestamp)>=now-seconds&&Number(r.event_timestamp)<=now);
 const nameAs=(rows,field)=>rows.map(r=>({...r,account_name:String(r[field]||r[field+'_original']||'').trim()}));
 const earned=r=>positive(r.net)||positive(r.price);
 const recentSales=nameAs(traderWindow(TRADER_WINDOW_SECONDS),'seller');
 const tradedSales=recentSales.filter(r=>positive(r.quantity)>0);
 // Card titles carry a little guild-market flavour; each description still spells out
 // exactly what is counted, so the theme never replaces the meaning.
 add('trader-sales','Market Moguls (last 14 days, Top '+LEADERBOARD_LIMIT+')','Highest gold earned on guild trader sales in the last 14 days. '+goldNote(showTraderGold),goldUnit,withGold(leaders(tradedSales,r=>r.account_name,earned)),showTraderGold?{}:{hideValue:true});
 add('trader-items','Pack Mules (last 14 days, Top '+LEADERBOARD_LIMIT+')','Most items sold through the guild trader in the last 14 days, totalled by quantity.','items',leaders(tradedSales,r=>r.account_name,r=>positive(r.quantity)));
 // Buyer rankings over the 50/50 raffle period: members are matched on both sides, outsiders by buyer only.
 const members=new Set(current.map(r=>String(r.account_name||'').trim().toLowerCase()).filter(Boolean));
 const isMember=name=>members.has(String(name||'').trim().toLowerCase());
 const buyerOf=row=>row.buyer||row.buyer_original;
 // Buyers count within the current 50/50 raffle, from the previous cutoff to this one.
 const raffleWindow=buyerRaffleWindow(now,env);
 const raffleEnd=Math.min(now,raffleWindow.salesEnd);
 const buyerSales=traderSales.filter(r=>Number(r.event_timestamp)>=raffleWindow.salesStart&&Number(r.event_timestamp)<=raffleEnd);
 const lingerNote=buyerRaffleLingerNote(raffleWindow.lingerSeconds);
 // Rank by what the buyer paid (price), not the seller's post-tax proceeds.
 const topBuyers=rows=>withGold(leaders(nameAs(rows,'buyer'),r=>r.account_name,r=>positive(r.price)));
 add('trader-member-buyers','Guild Regulars (current 50/50 raffle, Top '+LEADERBOARD_LIMIT+')','Gold spent by current guild members on items listed by another current member during the current 50/50 raffle, from the previous draw to now. '+goldNote(showTraderGold)+' '+lingerNote,goldUnit,topBuyers(buyerSales.filter(r=>isMember(r.seller)&&isMember(buyerOf(r)))),showTraderGold?{}:{hideValue:true});
 add('trader-visitor-buyers','Window Shoppers (current 50/50 raffle, Top '+LEADERBOARD_LIMIT+')','Gold spent at the guild trader during the current 50/50 raffle by buyers who are not current guild members, whoever listed the item. '+goldNote(showTraderGold)+' '+lingerNote,goldUnit,topBuyers(buyerSales.filter(r=>!isMember(buyerOf(r)))),showTraderGold?{}:{hideValue:true});
 return {
  generatedAt:new Date(now*1000).toISOString(),
  trackingSince,
  notes:['Membership and raffle history may be incomplete; these are recorded totals, not all-time claims.','Imported Discord snapshots are not actual joins. Live first discoveries can also appear as joins. Snapshot-only ESO dates are excluded; missing departures/rejoins can still affect recorded tenure.','Discord activity counts new posts and emoji reactions given in channels the bot can access; bots, DMs, system posts, and historical scans are excluded. Older last-seen values cannot reconstruct these totals.','Only event keys, guild/user IDs, display names, action type and collection time are stored; no message text or attachments. Activity records are retained until explicitly removed.'],
  overview:[
   {label:'Current ESO members',value:current.length},
   {label:'Current Discord members',value:discordMembers.length},
   {label:'Discord activity (last 30 days)',value:recordedActivity.reduce((n,r)=>n+positive(r.activity_count),0)},
   {label:'Raffle spending (last 90 days, gold)',value:recentPurchases.reduce((n,r)=>n+spending(r),0)}
  ],
  highlights
 };
}
export function registerCommunityStatisticsSocket(socket, {
  db, loadBanking, loadWindows = async () => [], loadBonusPolicies = async () => ({policies:[],overrides:[]}),
  authorizeViewer, now = () => Math.floor(Date.now() / 1000)
}) {
  socket.on('guildsync:request-community-statistics', async (payload, callback) => {
    if (typeof payload === 'function') callback = payload;
    const reply = response => typeof callback === 'function'
      ? callback(response) : socket.emit('guildsync:community-statistics', response);
    if (!socket.guildSyncAuthenticated || !['viewer', 'user', 'admin'].includes(socket.guildSyncUser?.role)
      || socket.guildSyncAuthType === 'discord-bot') {
      return reply({ok: false, message: 'Approved GuildSync access is required.'});
    }
    try {
      if (authorizeViewer && !await authorizeViewer(socket)) return reply({ok:false,message:'Approved GuildSync access is required.'});
      const selections = [
        'account_name,in_roster FROM guildsync_roster_members',
        'account_name,event_type,event_timestamp FROM guildsync_roster_events',
        'discord_id,username,global_name,server_nickname FROM discord_members',
        'discord_id,username,event_type,source FROM discord_member_history'
      ];
      const [roster, rosterEvents, discordMembers, discordHistory] = await Promise.all(
        selections.map(async selection => (await db.execute(`SELECT ${selection}`))[0])
      );
      const time = now();
      const [activity] = await db.execute(`
        SELECT discord_id, activity_type, MAX(display_name) AS username, COUNT(*) AS activity_count, UNIX_TIMESTAMP(recorded_at) AS activity_timestamp
        FROM guildsync_discord_activity
        WHERE recorded_at >= FROM_UNIXTIME(?) AND recorded_at <= FROM_UNIXTIME(?)
        GROUP BY discord_id, activity_type, recorded_at
      `, [time - 30*86400, time]);
      const [meta] = await db.execute(`
        SELECT metadata_value FROM guildsync_community_statistics_metadata WHERE metadata_key = 'discord_activity_since'
      `);
      // One fetch covers every trader card; event_datetime is the indexed pre-filter and
      // the builder applies each card's window on event_timestamp. The buyer cards span a
      // whole 50/50 raffle, which can be longer than the 14-day seller window.
      const traderFetchStart = Math.min(time - TRADER_WINDOW_SECONDS, buyerRaffleWindow(time).salesStart);
      const [banking, windows, [traderSales], bonus] = await Promise.all([
        loadBanking(db), loadWindows(db, time),
        db.execute(`
          SELECT seller, buyer, buyer_original, quantity, net, price, event_timestamp
          FROM guildsync_trader_entries
          WHERE event_datetime >= FROM_UNIXTIME(?) AND event_datetime <= FROM_UNIXTIME(?)
        `, [traderFetchStart, time]),
        loadBonusPolicies(db).catch(() => ({policies:[],overrides:[]}))
      ]);
      reply({ok: true, report: buildCommunityStatistics({
        now: time, trackingSince: meta[0]?.metadata_value || null,
        roster, rosterEvents, discordMembers, discordHistory, activity, banking, windows, traderSales,
        viewerRole: socket.guildSyncUser?.role || null,
        bonusPolicies: bonus?.policies || [], bonusOverrides: bonus?.overrides || []
      })});
    } catch {
      reply({ok: false, message: 'Community statistics could not be loaded.'});
    }
  });

  socket.on('guildsync:record-discord-activity', async (payload = {}, callback) => {
    payload = payload && typeof payload === 'object' ? payload : {};
    const reply = response => { if (typeof callback === 'function') callback(response); };
    if (!socket.guildSyncAuthenticated || socket.guildSyncAuthType !== 'discord-bot'
      || !socket.guildSyncBot?.guild_id || String(payload.guildId) !== String(socket.guildSyncBot.guild_id)) {
      return reply({ok:false,message:'Authenticated guild bot required.'});
    }
    if (!/^[a-f0-9]{64}$/.test(String(payload.eventKey)) || !/^\d{1,32}$/.test(String(payload.userId))
      || !['post','reaction'].includes(payload.type)) {
      return reply({ok:false,message:'Invalid activity metadata.'});
    }
    try {
      await db.execute(`INSERT IGNORE INTO guildsync_discord_activity
        (guild_id,event_key,discord_id,display_name,activity_type) VALUES (?,?,?,?,?)`,
        [String(payload.guildId),payload.eventKey,String(payload.userId),String(payload.displayName || payload.userId).slice(0,255),payload.type]);
      reply({ok:true});
    } catch (error) {
      console.error(`Discord community activity database write failed: ${error.message}`);
      reply({ok:false,message:'Activity could not be recorded; check backend logs.'});
    }
  });

  // Retain the old receiver during upgrades; older command records do not enter activity rankings.
  socket.on('guildsync:record-discord-interaction', async (payload = {}, callback) => {
    payload = payload && typeof payload === 'object' ? payload : {};
    const reply = response => { if (typeof callback === 'function') callback(response); };
    if (!socket.guildSyncAuthenticated || socket.guildSyncAuthType !== 'discord-bot'
      || !socket.guildSyncBot?.guild_id || String(payload.guildId) !== String(socket.guildSyncBot.guild_id)) {
      return reply({ok: false, message: 'Authenticated guild bot required.'});
    }
    if (!/^\d{1,32}$/.test(String(payload.interactionId)) || !/^\d{1,32}$/.test(String(payload.userId))
      || !['slash', 'button', 'select', 'modal'].includes(payload.type)) {
      return reply({ok: false, message: 'Invalid interaction metadata.'});
    }
    try {
      await db.execute(`
        INSERT IGNORE INTO guildsync_discord_interactions
          (interaction_id,guild_id,discord_id,display_name,interaction_type,interaction_name)
        VALUES (?,?,?,?,?,?)
      `, [
        String(payload.interactionId), String(payload.guildId), String(payload.userId),
        String(payload.displayName || payload.userId).slice(0, 255), payload.type,
        payload.type === 'slash' ? String(payload.name || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 100) : payload.type
      ]);
      reply({ok: true});
    } catch {
      reply({ok: false, message: 'Interaction could not be recorded.'});
    }
  });
}
