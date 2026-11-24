import {ActionRowBuilder,ButtonBuilder,ButtonStyle,ModalBuilder,TextInputBuilder,TextInputStyle,Events} from 'discord.js';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createFileDMIntake,createMemoryDMIntake} from './membership-dm-intake.js';

const nonce=id=>createHash('sha256').update(String(id)).digest('hex').slice(0,24);
const safeText=value=>String(value||'').replace(/([\\`*_~|<>])/g,'\\$1');
const choices=[['eso','Provide my ESO account'],['community','Not in guild; keep Discord'],['not_playing','No longer play ESO; stay'],['other','Other response']];
export function membershipDMMessage(job,config,{name,guildName}) {
  const content=(job.isTest?'[TEST] ':'')+config.template.replace(/\{(name|guild)\}/g,(_,key)=>safeText(key==='name'?name:guildName))+
    '\n\nYour answers and DM replies are forwarded to guild officers.'+(job.isTest?' This is a test; replies will not change account links, preferences or roles.':'');
  if(content.length>2000)throw Error('Rendered membership DM exceeds Discord’s message limit.');
  return {content,allowedMentions:{parse:[]},nonce:nonce(job.id),enforceNonce:true,
    components:[new ActionRowBuilder().addComponents(choices.map(([choice,label])=>new ButtonBuilder()
      .setCustomId(`gs-membership:${job.id}:${choice}`).setLabel(label).setStyle(choice==='eso'?ButtonStyle.Primary:ButtonStyle.Secondary)))]};
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

export function formatMembershipStatus({campaign,member}={}) {
  const who=value=>value?`${value.name} (<t:${value.at}:f>)`:'None';
  const lines=campaign?[
    `Campaign: ${campaign.status}`,
    `Last attempted: ${who(campaign.lastAttempted)}`,
    `Last sent: ${who(campaign.lastSent)}`,
    `Remaining: ${campaign.remaining}; uncertain: ${campaign.uncertain}`,
    `Next scheduled attempt: <t:${campaign.nextAt}:f>`
  ]:['No membership DM campaign has been started.'];
  if(member)lines.push(`User ${member.userId}: last confirmed DM ${member.history?.sentAt?`<t:${member.history.sentAt}:f>`:'Never'}; preference: ${member.preference||'None'}${member.history?.uncertain?'; delivery uncertain—review before retrying':''}`);
  if(campaign?.uncertainMembers?.length)lines.push(`Uncertain deliveries: ${campaign.uncertainMembers.map(entry=>`${safeText(entry.name)} (${entry.userId})`).join(', ')}. Resolve each with /discord-reminders resolve.`);
  return lines.join('\n');
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
    try {
      let roleNote='';
      if(!roleSuccess){
        try{
          const guild=await client.guilds.fetch(guildId),member=await guild.members.fetch(event.userId);
          if(event.roleAction==='remove')await member.roles.remove(event.roleId,'GuildSync membership response');
          else await member.roles.add(event.roleId,'GuildSync membership response');
          roleSuccess=true;
        }catch(error){roleNote=`\nCommunity role update failed: ${String(error.message).slice(0,300)}`;}
      }
      if(success)return;
      const destination=event.destinationType==='user'?await client.users.fetch(event.destinationId):await client.channels.fetch(event.destinationId);
      if(event.destinationType==='channel'&&destination?.guildId!==guildId)throw Error('Reply destination must be in the configured Discord server.');
      if(typeof destination?.send!=='function')throw Error('Reply destination cannot receive messages.');
      const header=`${event.isTest?'[TEST] ':''}GuildSync membership reply\nServer: ${guildId}\nDiscord: ${safeText(event.name)} (${event.userId})\nChoice: ${event.choice}\nOutcome: ${event.result.status}${event.result.accountName?' — ESO @'+safeText(event.result.accountName):''}\nReceived: <t:${event.at}:f>\nDelivery: ${event.deliveryId}\nResponse: ${event.eventId}${roleNote}`;
      const full=`${header}\n\n${event.text||'(No text supplied)'}`;
      const content=full.length<=1950?full:header+'\n\n'+String(event.text).slice(0,Math.max(0,1750-header.length))+'\n[Full response attached]';
      await destination.send({content,allowedMentions:{parse:[]},nonce:nonce('forward-'+event.eventId),enforceNonce:true,
        ...(full.length>1950?{files:[{attachment:Buffer.from(full,'utf8'),name:`membership-response-${event.eventId}.txt`}]}:{})});
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
      return {message:'Your response is saved and will be forwarded when GuildSync reconnects.'};
    }
  }
  async function retryIntake() {
    for(const event of await intake.list()){
      if(event.guildId!==guildId)continue;
      try{await request('response',event.payload);await intake.remove(event.payload.eventId);}
      catch(error){if(error.code==='NO_MEMBERSHIP_DM')await intake.remove(event.payload.eventId);else throw error;}
    }
  }
  async function interaction(interaction) {
    const match=/^gs-membership:([0-9a-f-]{36}):(eso|community|not_playing|other)$/i.exec(interaction.customId||'');
    if(!match||interaction.inGuild?.())return false;
    const [,deliveryId,choice]=match;
    try{
      if(interaction.isButton()&&(choice==='eso'||choice==='other')){
        const input=new TextInputBuilder().setCustomId('response').setLabel(choice==='eso'?'Your ESO account name (include @)':'Your response')
          .setStyle(choice==='eso'?TextInputStyle.Short:TextInputStyle.Paragraph).setRequired(true).setMaxLength(choice==='eso'?64:4000);
        await interaction.showModal(new ModalBuilder().setCustomId(interaction.customId).setTitle(choice==='eso'?'Link your ESO account':'Membership response')
          .addComponents(new ActionRowBuilder().addComponents(input)));
        return true;
      }
      if(!interaction.isButton()&&!interaction.isModalSubmit())return false;
      await interaction.deferReply();
      const result=await saveResponse({deliveryId,choice,userId:interaction.user.id,eventId:interaction.id,
        text:interaction.isModalSubmit()?interaction.fields.getTextInputValue('response'):''});
      await interaction.editReply(result.message);
      return true;
    }catch(error){
      const content='Could not save this response: '+error.message;
      if(interaction.deferred||interaction.replied)await interaction.editReply(content).catch(()=>{});
      else await interaction.reply({content}).catch(()=>{});
      return true;
    }
  }
  async function message(message) {
    if(message.guild||message.author?.bot)return false;
    const attachments=Array.from(message.attachments?.values?.()||[]).map(file=>`${file.name||'Attachment'}: ${file.url}`).join('\n');
    const text=[message.content||'',attachments].filter(Boolean).join('\n');
    if(!text)return false;
    try{
      const result=await saveResponse({userId:message.author.id,eventId:message.id,choice:'text',text,replyTo:message.reference?.messageId});
      await message.reply({content:result.message,allowedMentions:{parse:[]}});
      return true;
    }catch(error){
      if(!error.message.includes('No membership DM'))log('Could not save membership DM reply: '+error.message);
      return false;
    }
  }
  return {sendNext,forwardOne,interaction,message,retryIntake,
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
  const message=value=>{worker.message(value).catch(error=>log(error.message));};
  client.on(Events.InteractionCreate,interaction);client.on(Events.MessageCreate,message);
  const timer=setInterval(()=>{if(socket.connected)worker.tick();},15000);timer.unref?.();
  return {...worker,stop(){clearInterval(timer);client.off(Events.InteractionCreate,interaction);client.off(Events.MessageCreate,message);}};
}
