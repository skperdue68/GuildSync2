import {ActionRowBuilder,ButtonBuilder,ButtonStyle,EmbedBuilder,ModalBuilder,TextInputBuilder,TextInputStyle,Events} from 'discord.js';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createFileDMIntake,createMemoryDMIntake,membershipIntakeKey} from './membership-dm-intake.js';

const nonce=id=>createHash('sha256').update(String(id)).digest('hex').slice(0,24);
const safeText=value=>String(value||'').replace(/([\\`*_~|<>])/g,'\\$1');
const choices=[['eso',"I'm in Alphabet Mafia — link my ESO login"],['community',"I still play ESO, but I'm not in Alphabet Mafia"],['not_playing','I no longer play ESO — keep me on Discord'],['remove','Request removal'],['other','Other response']];
export function membershipDMMessage(job,config,{name,guildName}={}) {
  const suggestion=String(job.suggestedEsoAccountName||'').trim().replace(/^@+/,'');
  const suggestionLine=suggestion?`\n\nWe think your ESO account may be @${safeText(suggestion)}. If that’s yours, you can confirm it with the link button below; otherwise, send us the correct name.`:'';
  const forwardNotice='Your responses will be forwarded to guild officers.';
  const footer=(config.template.includes(forwardNotice)?'':'\n\n'+forwardNotice)
    +(job.isTest?'\n\nThis is a test; replies will not change account links, preferences or roles.':'');
  const marker=job.isTest?':test':'';
  const content=(job.isTest?'[TEST] ':'')+config.template.replace('{suggested_link}',suggestionLine)
    .replace(/\{(name|guild)\}/g,(_,key)=>safeText(key==='name'?name:guildName))+footer;
  if(content.length>2000)throw Error('Rendered membership DM exceeds Discord’s message limit.');
  return {content,allowedMentions:{parse:[]},nonce:nonce(job.id),enforceNonce:true,
    components:[new ActionRowBuilder().addComponents(choices.map(([choice,label])=>new ButtonBuilder()
      .setCustomId(`gs-membership${marker}:${job.id}:${choice}`).setLabel(label).setStyle(choice==='eso'?ButtonStyle.Primary:ButtonStyle.Secondary)))]};
}

export function membershipDMRequest(socket,guildId,action,payload={}) {
  return new Promise((resolve,reject)=>{
    if(!socket.connected)return reject(Error('GuildSync backend is disconnected.'));
    socket.timeout(30000).emit('guildsync:membership-dm',{guildId,action,...payload},(error,response)=>{
      if(error)return reject(error);
      if(!response?.ok)return reject(Object.assign(Error(response?.message||'Membership DM request failed.'),{code:response?.code}));
      resolve(response.result);
    });
  });
}

export function membershipChoiceSummary(choice) {
  if(choice==='eso')return 'provided an ESO login';
  if(choice==='community')return 'still plays ESO but is not in the guild; staying on Discord';
  if(choice==='not_playing')return 'no longer plays ESO; staying on Discord';
  if(choice==='remove')return 'asked to be removed from the Discord server';
  return 'other response';
}

// A stored preference can come from a member's own DM reply or from an officer
// marking them as not playing ESO / not in the guild in the member link window.
export function membershipPreferenceLabel(value) {
  if(value==='not_playing')return 'does not play ESO';
  if(value==='community')return 'not in the ESO guild';
  if(value==='opt_out')return 'do not contact';
  return String(value||'');
}

export function formatMembershipStatus({campaign,member,recentFailures=[]}={}) {
  const who=value=>value?`${value.name} (<t:${value.at}:f>)`:'None';
  const lines=campaign?[
    `Campaign: ${campaign.status}`,
    `Last attempted: ${who(campaign.lastAttempted)}`,
    `Last sent: ${who(campaign.lastSent)}`,
    `Remaining: ${campaign.remaining}; uncertain: ${campaign.uncertain}`,
    `Next scheduled attempt: <t:${campaign.nextAt}:f>`
  ]:['No membership DM campaign has been started.'];
  if(member)lines.push(`User ${member.userId}: last confirmed DM ${member.history?.sentAt?`<t:${member.history.sentAt}:f>`:'Never'}; ${member.preference?`preference: ${membershipPreferenceLabel(member.preference)}`:'preference: None'}${member.history?.uncertain?'; delivery uncertain—review before retrying':''}${!member.history?.sentAt&&member.history?.status?`; last attempt ${member.history.status}${member.history.reason?`: ${safeText(member.history.reason)}`:''}`:''}`);
  if(member?.lastResponse)lines.push(`Last response: ${membershipChoiceSummary(member.lastResponse.choice)}${member.lastResponse.accountName?` — ESO @${safeText(member.lastResponse.accountName)}`:''}${member.lastResponse.at?` (<t:${member.lastResponse.at}:f>)`:''}`);
  if(campaign?.uncertainMembers?.length)lines.push(`Uncertain deliveries: ${campaign.uncertainMembers.map(entry=>`${safeText(entry.name)} (${entry.userId})`).join(', ')}. Resolve each with /membership-dm resolve.`);
  // Failed, uncertain and skipped attempts keep their reason and time, so an
  // officer can see which members never received a DM instead of only that the
  // last send did not match.
  const failures=(recentFailures||[]).filter(entry=>['failed','uncertain','skipped'].includes(entry.status)).slice(0,10);
  if(failures.length)lines.push(`Recent failures and skips (${failures.length}):`,...failures.map(entry=>
    `• ${safeText(entry.name||'Unknown member')} (${entry.userId}) — ${entry.status}: ${safeText(entry.reason||'no reason recorded')}${entry.at?` at <t:${entry.at}:f>`:''}`));
  return lines.join('\n');
}

const fenceText=value=>String(value||'').replace(/```/g,"'''");
// The embed's left bar carries the result, so an officer reads the outcome at a glance.
const replyColors={linked:0x57f287,saved:0x5865f2,removal:0xed4245,review:0xfee75c,test:0x99aab5};
const replyTone=event=>event.isTest?'test':event.result?.status==='linked'?'linked'
 :event.result?.removal?.status==='declined'?'review'
 :event.choice==='remove'?'removal':['community','not_playing'].includes(event.choice)?'saved':'review';
function replyFacts(event,guildName) {
 const typed=String(event.text||'').trim();
 if(event.choice==='eso'){
  const account=String(event.result?.accountName||'').trim().replace(/^@+/,'')||typed.replace(/^@+/,'');
  const login=account?`I'm in ${safeText(guildName)} — my ESO login is @${fenceText(account)}`:'';
  if(event.result?.status==='linked')return {summary:`Linked ESO account${account?` @${safeText(account)}`:''}`,outcome:`Linked to${account?` @${safeText(account)}`:' the ESO account'}`,box:login};
  // The backend separates "no such current member" from "more than one match", so
  // officers know why this answer needs them instead of a generic review notice.
  const roster=event.result?.rosterMatch;
  return {summary:'ESO account submitted for officer review',
    outcome:roster==='missing'?'Name not found on the current ESO roster — officer review needed'
      :roster==='ambiguous'?'Name matches more than one roster member — officer review needed'
      :'ESO account submitted for officer review',box:login};
 }
 if(event.choice==='community')return {summary:`Still plays ESO, not in ${safeText(guildName)}`,outcome:'Preference saved — membership DMs stopped',box:''};
 if(event.choice==='not_playing')return {summary:'No longer plays ESO — staying on Discord',outcome:'Preference saved — membership DMs stopped',box:''};
 if(event.choice==='remove'){
  // The card reports the kick the bot actually attempted, not just the request.
  const removal=event.result?.removal||null;
  // Declining is a decision to stay, so the officers are told and nothing is removed.
  if(removal?.status==='declined')return {summary:'Asked to be removed, then chose to stay',
    outcome:'Not removed — the member declined the confirmation. Officers decide any follow-up.',box:''};
  const outcome=removal?.status==='kicked'?'Removed from the server (reason: User Request)'
   :removal?.status==='gone'?'Already left the server'
   :removal?.status==='failed'?`Removal recorded — the bot could not remove them: ${safeText(removal.reason||'unknown reason').replace(/\.+$/,'')}. Officer action needed.`
   :'Removal requested — an officer still needs to remove them';
  return {summary:'Asked to be removed from the Discord server',outcome,box:''};
 }
 return {summary:'Sent another response',outcome:'Response forwarded',box:typed};
}
const FIELD_LIMIT=1024;
// The nickname is set by the bot from a submitted ESO name when the roster match is
// unique and the name is not linked elsewhere. The card says exactly what happened.
function nicknameSummary(nickname) {
 if(!nickname)return '';
 if(nickname.status==='set')return `Set to @${safeText(nickname.name||'')}`;
 return `Not changed — ${safeText(nickname.reason||'the name could not be verified')}`;
}
// The officer-facing embed card: the member's display name is the title, a bold
// summary opens the description, and the routing facts are fields. The same
// renderer serves live forwarding and an on-demand repost of a stored reply.
export function membershipReplyMessage(event,{guildName='Guild',repostedBy='',nonceKey}={}) {
 const {summary,outcome,box:boxText}=replyFacts(event,guildName);
 const name=safeText(event.name||`User ${event.userId}`);
 const embed=new EmbedBuilder().setColor(replyColors[replyTone(event)])
  .setAuthor({name:event.isTest?'[TEST] Membership DM response':'Membership DM response'})
  .setTitle(name).setDescription(`**${summary}**`)
  .setFooter({text:'GuildSync'}).setTimestamp(new Date(event.at*1000))
  .addFields({name:'Server',value:safeText(guildName).slice(0,FIELD_LIMIT),inline:true},
   {name:'Discord',value:`${name} (${event.userId})`.slice(0,FIELD_LIMIT),inline:true});
 const payload={allowedMentions:{parse:[]},nonce:nonce(nonceKey||('forward-'+event.eventId)),enforceNonce:true,embeds:[embed]};
 if(boxText){
  // A field holds 1024 characters, so a long answer is clipped inside a closed
  // code block and the untouched text rides along as an attachment.
  const text=fenceText(boxText),room=FIELD_LIMIT-('```text\n'.length+'\n```'.length+1);
  const shown=text.length<=room?text:text.slice(0,room)+'…';
  embed.addFields({name:'Member response',value:'```text\n'+shown+'\n```',inline:false});
  if(shown!==text)payload.files=[{attachment:Buffer.from(text,'utf8'),name:`membership-response-${event.eventId||'reply'}.txt`}];
 }
 embed.addFields({name:'Outcome',value:(event.isTest?'Test response — nothing changed':outcome).slice(0,FIELD_LIMIT),inline:false});
 if(event.roleNote)embed.addFields({name:'Community role',value:String(event.roleNote).replace(/^\n+/,'').slice(0,FIELD_LIMIT),inline:false});
 if(event.result?.nickname)embed.addFields({name:'Server nickname',value:nicknameSummary(event.result.nickname).slice(0,FIELD_LIMIT),inline:false});
 if(repostedBy)embed.addFields({name:'Reposted by',value:safeText(repostedBy).slice(0,FIELD_LIMIT),inline:false});
 return payload;
}
export function createMembershipDMWorker({client,guildId,request,log=console.log,intake=createMemoryDMIntake()}) {
  let busy=false;
  async function deliver({job,config}) {
    const finish=result=>request('finish',{deliveryId:job.id,token:job.token,result});
    let member,payload;
    try {
      const guild=await client.guilds.fetch(guildId);
      try{member=await guild.members.fetch(job.userId);}catch(error){
        if(error.code===10007){await finish({status:'skipped',detail:'No longer in the Discord server.'});return false;}throw error;
      }
      if(member.user.bot){await finish({status:'skipped',detail:'Bot account.'});return false;}
      const validation=await request('validate',{deliveryId:job.id,token:job.token});
      if(!validation.valid){await finish({status:'skipped',detail:'No longer eligible or campaign paused.'});return false;}
      payload=membershipDMMessage(job,config,{name:member.displayName,guildName:guild.name});
    }catch(error){
      // Nothing has reached the member yet, so a lookup, validation or rendering
      // failure is a definite failure and can never be an uncertain delivery.
      try{await finish({status:'failed',detail:error.message});}catch(finishError){log('Membership DM result could not be saved: '+finishError.message);}
      log(`Membership DM ${job.id} could not be prepared: ${error.message}`);
      return {status:'failed',detail:error.message};
    }
    try {
      const message=await member.send(payload);
      // A failed finish acknowledgement must never turn an already delivered DM
      // into a retryable failure. The backend will retain its uncertain claim.
      try{await finish({status:'sent',messageId:message.id});}
      catch(error){log(`Membership DM ${job.id} was delivered (${message.id}), but its confirmation needs review: ${error.message}`);}
      return {status:'sent',messageId:message.id};
    }catch(error){
      // Discord API rejection proves failure; network/unknown outcomes may have
      // delivered successfully and are deliberately not retried automatically.
      const definite=Number.isInteger(error.code)&&error.code>=10000;
      try{await finish({status:definite?'failed':'uncertain',detail:error.message});}catch(finishError){log('Membership DM result could not be saved: '+finishError.message);}
      log(`Membership DM ${job.id}: ${error.message}`);
      return {status:definite?'failed':'uncertain',detail:error.message};
    }
  }
  async function sendNext() {
    // Eligibility skips incur no 10–15 minute pause. The database chooses the
    // next eligible record; only an actual attempt consumes the paced slot.
    for(let skipped=0;skipped<100;skipped++){
      const work=await request('claim');
      if(!work.job)return;
      if(await deliver(work))return;
    }
  }
  async function forwardOne() {
    const {event}=await request('claim-forward');
    if(!event)return;
    let success=event.forwardStatus==='sent',roleSuccess=!event.roleId||['sent','superseded'].includes(event.roleStatus);
    let guild=null;
    try{guild=await client.guilds.fetch(guildId);}catch{}
    try {
      let roleNote='';
      if(!roleSuccess){
        try{
          const member=await guild.members.fetch(event.userId);
          if(event.roleAction==='remove')await member.roles.remove(event.roleId,'GuildSync membership response');
          else await member.roles.add(event.roleId,'GuildSync membership response');
          roleSuccess=true;
        }catch(error){roleNote=`\nCommunity role update failed: ${String(error.message).slice(0,300)}`;}
      }
      if(success)return;
      const destination=event.destinationType==='user'?await client.users.fetch(event.destinationId):await client.channels.fetch(event.destinationId);
      if(event.destinationType==='channel'&&destination?.guildId!==guildId)throw Error('Reply destination must be in the configured Discord server.');
      if(typeof destination?.send!=='function')throw Error('Reply destination cannot receive messages.');
      let displayName=event.name;
      try{displayName=(await guild?.members?.fetch?.(event.userId))?.displayName||displayName;}catch{}
      const guildName=guild?.name||String(guildId);
      await destination.send(membershipReplyMessage({...event,name:displayName,roleNote},{guildName,nonceKey:'forward-'+event.eventId}));
      success=true;
    }catch(error){log('Membership reply forwarding will retry: '+error.message);}
    finally{await request('finish-forward',{eventId:event.eventId,token:event.token,success,roleSuccess});}
  }
  async function saveResponse(payload) {
    await intake.put({payload,guildId});
    try{
      const result=await request('response',payload);await intake.remove(payload.eventId);return result;
    }catch(error){
      if(error.code==='NO_MEMBERSHIP_DM'){await intake.remove(payload.eventId);throw error;}
      log('Membership reply saved locally for retry: '+error.message);
      return {queued:true,message:'Your response is saved and will be forwarded when GuildSync reconnects.'};
    }
  }
  async function retryIntake() {
    // An answer is replayed before the Discord outcome it belongs to, so the outcome
    // attaches to the queued event in the same pass and the officer card is correct.
    const order=event=>event.kind==='outcome'?1:0;
    const events=(await intake.list()).filter(event=>event.guildId===guildId)
      .sort((a,b)=>order(a)-order(b));
    for(const event of events){
      const action=event.kind==='outcome'?'outcome':event.kind==='removal-declined'?'removal-declined':'response';
      try{
        await request(action,event.payload);
      }catch(error){
        if(error.code==='NO_MEMBERSHIP_DM'||error.code==='STALE_OUTCOME'){
          await intake.remove(membershipIntakeKey(event));continue;
        }
        throw error;
      }
      await intake.remove(membershipIntakeKey(event));
    }
  }
  async function repost({response,destinationType,destinationId},officerName) {
    const guild=await client.guilds.fetch(guildId);
    const destination=destinationType==='user'?await client.users.fetch(destinationId):await client.channels.fetch(destinationId);
    if(destinationType==='channel'&&destination?.guildId!==guildId)throw Error('Reply destination must be in the configured Discord server.');
    if(typeof destination?.send!=='function')throw Error('Reply destination cannot receive messages.');
    return destination.send(membershipReplyMessage(response,{guildName:guild?.name||String(guildId),repostedBy:officerName,
      nonceKey:`repost-${response.userId}-${response.at}-${Date.now()}`}));
  }
  // Test deliveries carry a marker in every button, so the bot knows a confirmation
  // came from a test DM even when the backend cannot be reached to say so.
  const removeConfirmRow=(deliveryId,marker='')=>new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gs-membership-confirm${marker}:${deliveryId}:remove`).setLabel('Yes, remove me').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`gs-membership-cancel${marker}:${deliveryId}:remove`).setLabel('Keep me on the server').setStyle(ButtonStyle.Secondary));
  // A nickname is the member's own identity, so it is offered as a choice. Declining
  // still records the ESO answer and link.
  const nameConsentRow=(deliveryId,name,marker='')=>new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gs-membership-rename${marker}:${deliveryId}:eso:${name}`).setLabel('Yes, change my nickname').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gs-membership-keepname${marker}:${deliveryId}:eso:${name}`).setLabel('No, keep my name').setStyle(ButtonStyle.Secondary));
  // The requested audit reason is the only text a moderator sees in Discord's audit log.
  async function kickForRemoval(userId) {
    try {
      const guild=await client.guilds.fetch(guildId);
      const member=await guild.members.fetch(userId);
      await member.kick('User Request');
      return {status:'kicked'};
    } catch(error) {
      if(error?.code===10007)return {status:'gone'};
      if(error?.code===50013)return {status:'failed',reason:'The bot needs Kick Members and a role above this member.'};
      return {status:'failed',reason:String(error?.message||'The kick failed.').slice(0,300)};
    }
  }
  // Discord allows duplicate nicknames, so the guild itself has to be checked before
  // renaming: no other member may already use the submitted name.
  async function nicknameIsTaken(guild,userId,name) {
    const wanted=String(name||'').trim().replace(/^@+/,'').toLowerCase();
    if(!wanted)return true;
    let members=guild.members.cache;
    if(!members?.size)members=await guild.members.fetch();
    return [...members.values()].some(member=>String(member.id)!==String(userId)
      &&[member.nickname,member.displayName,member.user?.username,member.user?.globalName]
        .some(value=>String(value||'').trim().replace(/^@+/,'').toLowerCase()===wanted));
  }
  async function setNicknameForEso(userId,name) {
    try {
      const guild=await client.guilds.fetch(guildId);
      const member=await guild.members.fetch(userId);
      if(guild.ownerId&&String(guild.ownerId)===String(userId))return {status:'skipped',reason:'The server owner’s nickname cannot be changed.'};
      if(await nicknameIsTaken(guild,userId,name))return {status:'skipped',reason:'Another member already uses that name.'};
      await member.setNickname(name,'GuildSync membership DM: ESO account name');
      return {status:'set',name};
    } catch(error) {
      if(error?.code===10007)return {status:'skipped',reason:'No longer in the Discord server.'};
      if(error?.code===50013)return {status:'failed',reason:'The bot needs Manage Nicknames and a role above this member.'};
      return {status:'failed',reason:String(error?.message||'The nickname could not be set.').slice(0,300)};
    }
  }
  // The kick or rename has already happened in Discord, so its report must survive a
  // dropped backend: it is queued on disk and replayed before the officer card.
  async function reportOutcome(eventId,outcome) {
    const payload={eventId,...outcome};
    try { await request('outcome',payload); }
    catch(error) {
      if(error.code==='STALE_OUTCOME'){log('Membership Discord outcome was stale: '+error.message);return;}
      try {
        await intake.put({kind:'outcome',payload,guildId});
        log('Membership Discord outcome saved locally for retry: '+error.message);
      } catch(storeError) {
        log('Membership Discord outcome could not be saved: '+storeError.message);
      }
    }
  }
  // A declined removal is still worth telling the officers about, so it is queued too.
  async function declineRemoval(payload) {
    const message='You are still on the server. Officers will see that you asked to be removed and then chose to stay.';
    try { await request('removal-declined',payload); return message; }
    catch(error) {
      if(error.code==='NO_MEMBERSHIP_DM'||error.code==='STALE_OUTCOME')return 'You are still on the server.';
      try { await intake.put({kind:'removal-declined',payload,guildId}); return message+' Your answer is saved for retry.'; }
      catch(storeError) { log('Membership removal decline could not be saved: '+storeError.message);return 'You are still on the server.'; }
    }
  }
  async function interaction(interaction) {
    const match=/^gs-membership(-confirm|-cancel|-rename|-keepname)?(?::(test))?:([0-9a-f-]{36}):(eso|community|not_playing|remove|other)(?::([A-Za-z0-9_-]{1,32}))?$/i.exec(interaction.customId||'');
    if(!match||interaction.inGuild?.())return false;
    const [,step,marker,deliveryId,choice,consentName]=match,isTest=marker==='test',markerSuffix=isTest?':test':'';
    try{
      // Removal is the only irreversible answer, so it asks once more before the bot
      // kicks anyone. Nothing is recorded or changed until the member confirms.
      if(interaction.isButton()&&step==='-cancel'){
        if(isTest){
          await interaction.reply({content:'No changes were made. You are still on the server; test answers are not recorded.',allowedMentions:{parse:[]}});
          return true;
        }
        await interaction.deferReply();
        await interaction.editReply(await declineRemoval({deliveryId,userId:interaction.user.id,eventId:interaction.id}));
        return true;
      }
      if(interaction.isButton()&&!step&&choice==='remove'){
        await interaction.reply({content:'This removes you from the Discord server and cannot be undone here. Confirm only if you want to leave.',
          components:[removeConfirmRow(deliveryId,markerSuffix)],allowedMentions:{parse:[]}});
        return true;
      }
      // The typed ESO name is offered as a nickname choice before anything is saved,
      // so a declined rename never changes the member's name.
      if(interaction.isModalSubmit()&&choice==='eso'&&!step){
        const typed=String(interaction.fields.getTextInputValue('response')||'').trim().replace(/^@+/,'');
        const name=typed.replace(/[^A-Za-z0-9_-]/g,'').slice(0,32);
        if(name){
          await interaction.reply({content:`Your ESO answer is sent to the officers either way. We recommend matching your Discord nickname to ${name} so members recognize you, but it is not required. Shall we set it for you?`,
            components:[nameConsentRow(deliveryId,name,markerSuffix)],allowedMentions:{parse:[]}});
          return true;
        }
      }
      if(interaction.isButton()&&!step&&(choice==='eso'||choice==='other')){
        const input=new TextInputBuilder().setCustomId('response').setLabel(choice==='eso'?'Your ESO login (include @)':'Your response')
          .setStyle(choice==='eso'?TextInputStyle.Short:TextInputStyle.Paragraph).setRequired(true).setMaxLength(choice==='eso'?64:4000);
        await interaction.showModal(new ModalBuilder().setCustomId(interaction.customId).setTitle(choice==='eso'?'Link your Alphabet Mafia account':'Membership response')
          .addComponents(new ActionRowBuilder().addComponents(input)));
        return true;
      }
      if(!interaction.isButton()&&!interaction.isModalSubmit())return false;
      await interaction.deferReply();
      const consent=step==='-rename'?true:step==='-keepname'?false:undefined;
      const result=await saveResponse({deliveryId,choice,userId:interaction.user.id,eventId:interaction.id,
        text:consent===undefined?(interaction.isModalSubmit()?interaction.fields.getTextInputValue('response'):''):consentName,
        ...(consent===undefined?{}:{nicknameConsent:consent})});
      let note='';
      // Test deliveries are known from the button itself, so a confirmed removal still
      // kicks while the backend is unreachable; the report is queued for replay.
      if(step==='-confirm'&&choice==='remove'&&!isTest&&!result?.duplicate
        &&(result?.status==='removal requested'||result?.queued)){
        const removal=await kickForRemoval(interaction.user.id);
        await reportOutcome(interaction.id,{removal});
        note=removal.status==='kicked'?' You have been removed from the server at your request.'
          :removal.status==='gone'?' You were already no longer in the server.'
          :' Your request was recorded; an officer will finish the removal.';
      }
      if(choice==='eso'&&consent!==false){
        const rename=result?.rename;
        if(rename?.allowed){
          const nickname=await setNicknameForEso(interaction.user.id,rename.name);
          await reportOutcome(interaction.id,{nickname});
          note=nickname.status==='set'?` Your server nickname is now @${nickname.name}.`
            :` Your nickname was not changed: ${nickname.reason}`;
        } else if(rename&&!rename.allowed){
          note=` Your nickname was not changed: ${rename.reason}`;
        }
      } else if(choice==='eso'&&consent===false){
        note=' Your server nickname was left unchanged; your ESO answer was still saved.';
      }
      await interaction.editReply(`${result?.message||'Your response has been sent to the guild officers.'}${note}`);
      return true;
    }catch(error){
      const content='Could not save this response: '+error.message;
      if(interaction.deferred||interaction.replied)await interaction.editReply(content).catch(()=>{});
      else await interaction.reply({content}).catch(()=>{});
      return true;
    }
  }
  return {sendNext,forwardOne,repost,interaction,retryIntake,
    async test(actorId,targetId){const work=await request('test',{actorId,targetId});return deliver(work);},
    async tick(){
      if(busy||!client.isReady()||!guildId)return;
      busy=true;
      try{await retryIntake();await forwardOne();await sendNext();}catch(error){log('Membership DM worker: '+error.message);}finally{busy=false;}
    }
  };
}

export function startMembershipDMWorker({client,socket,guildId,log=console.log}) {
  const worker=createMembershipDMWorker({client,guildId,log,intake:createFileDMIntake(String(process.env.GUILDSYNC_MEMBERSHIP_DM_SPOOL_DIR||'').trim()||fileURLToPath(new URL('../data/membership-dm-intake',import.meta.url))),
    request:(action,payload)=>membershipDMRequest(socket,guildId,action,payload)});
  const interaction=value=>{worker.interaction(value).catch(error=>log(error.message));};
  client.on(Events.InteractionCreate,interaction);
  const timer=setInterval(()=>{if(socket.connected)worker.tick();},15000);timer.unref?.();
  return {...worker,stop(){clearInterval(timer);client.off(Events.InteractionCreate,interaction);}};
}
