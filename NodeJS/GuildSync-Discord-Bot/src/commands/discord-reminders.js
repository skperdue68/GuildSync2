import {SlashCommandBuilder,MessageFlags} from 'discord.js';
import {membershipDMRequest,formatMembershipStatus} from '../membership-dms.js';
import {syncDiscordRolesAndMembers} from '../discord-sync.js';

const safeLine=value=>String(value??'').replace(/[\n\r]/g,' ').slice(0,120);

// Campaign controls belong to guild officers: members holding the Consigliere or
// Kingpin Discord role. The approved GuildSync User/Admin check below still applies.
const officerRoles=new Set(['consigliere','consiglieri','consiglieres','kingpin','kingpins']);
const roleKey=value=>String(value||'').trim().toLowerCase().replace(/[^a-z0-9]/g,'');
export const isReminderOfficer=member=>Boolean(member?.roles?.cache?.some?.(role=>officerRoles.has(roleKey(role.name))));

export const data=new SlashCommandBuilder().setName('discord-reminders')
  .setDescription('Manage the slow GuildSync membership DM campaign (Consigliere or Kingpin).')
  .addSubcommand(s=>s.setName('start').setDescription('Start an alphabetical campaign for eligible unlinked Discord members.'))
  .addSubcommand(s=>s.setName('pause').setDescription('Pause new campaign DMs.'))
  .addSubcommand(s=>s.setName('resume').setDescription('Resume the saved campaign without a catch-up burst.'))
  .addSubcommand(s=>s.setName('restart').setDescription('Build a fresh campaign; preserve send dates and community preferences.'))
  .addSubcommand(s=>s.setName('status').setDescription('Show progress, last recipient and next attempt.').addUserOption(o=>o.setName('user').setDescription('Also show this member’s send date and preference.')))
  .addSubcommand(s=>s.setName('resolve').setDescription('Record whether an uncertain DM arrived, or make the member eligible again.')
    .addUserOption(o=>o.setName('user').setDescription('Member whose membership DM delivery is uncertain.').setRequired(true))
    .addStringOption(o=>o.setName('outcome').setDescription('Whether the membership DM arrived.').setRequired(true)
      .addChoices({name:'Delivered',value:'sent'},{name:'Not delivered; allow retry',value:'retry'})))
  .addSubcommand(s=>s.setName('test').setDescription('Send one labelled test DM immediately; do not change normal cooldowns.').addUserOption(o=>o.setName('user').setDescription('Discord server member to receive the test.').setRequired(true)))
  .addSubcommand(s=>s.setName('test-mode').setDescription('DM yourself a simulated membership DM every 30 seconds; nothing is saved.'))
  .addSubcommand(s=>s.setName('test-mode-stop').setDescription('Stop the membership DM simulation.'));

export async function execute(interaction,socket) {
  await interaction.deferReply({flags:[MessageFlags.Ephemeral]});
  if(!interaction.guildId||!isReminderOfficer(interaction.member)){
    await interaction.editReply('Use this command in the configured server with the Consigliere or Kingpin role and approved GuildSync User/Admin access.');return;
  }
  const command=interaction.options.getSubcommand(),target=interaction.options.getUser('user');
  try{
    if(command==='resolve'){
      const result=await membershipDMRequest(socket,interaction.guildId,'resolve',{actorId:interaction.user.id,userId:target.id,outcome:interaction.options.getString('outcome')});
      await interaction.editReply({content:result.message,allowedMentions:{parse:[]}});
      return;
    }
    if(command==='test'){
      if(!interaction.client.membershipDM)throw Error('Membership DM worker is unavailable.');
      const outcome=await interaction.client.membershipDM.test(interaction.user.id,target.id);
      await interaction.editReply(outcome?.status==='sent'?`Test DM sent to ${target.username}. Its responses will be marked as tests.`:`Test DM outcome: ${outcome?.status||'skipped'}. ${outcome?.detail||'Check bot logs and the recipient’s DM settings.'}`);
      return;
    }
    if(command==='test-mode-stop'){
      const mode=interaction.client.membershipDMTestMode;
      const stopped=Boolean(mode?.stop());
      await interaction.editReply(stopped?'Membership DM test mode stopped. No data was changed.':'Membership DM test mode is not running.');
      return;
    }
    if(command==='test-mode'){
      const mode=interaction.client.membershipDMTestMode;
      if(!mode)throw Error('Membership DM test mode is unavailable.');
      const plan=await membershipDMRequest(socket,interaction.guildId,'test-plan',{actorId:interaction.user.id});
      if(!plan.members?.length)throw Error('No unlinked members are available to simulate.');
      mode.start(interaction.user.id,{members:plan.members.length});
      let first;
      try{first=await mode.deliverOne();}
      catch(error){mode.stop();throw Error(`Test mode stopped: ${error.message}`);}
      await interaction.editReply({content:`Test mode started. A simulated membership DM is sent to you every 30 seconds, cycling through ${plan.members.length} unlinked member(s). Each message is numbered and names the member it simulates, for example “Test mode 2 of 5 — this is what Alice (1234567890) would receive”. Nothing is saved. Stop with /discord-reminders test-mode-stop.`+(first.status==='sent'?` First simulation: ${first.member.name}.`:` First simulation: ${first.status}.`),allowedMentions:{parse:[]}});
      return;
    }
    if(command==='start'||command==='restart'){
      await membershipDMRequest(socket,interaction.guildId,'command',{actorId:interaction.user.id,command:'status'});
      await syncDiscordRolesAndMembers(interaction.guild,socket);
    }
    const result=await membershipDMRequest(socket,interaction.guildId,'command',{actorId:interaction.user.id,command,targetId:target?.id});
    const testMode=interaction.client.membershipDMTestMode?.status?.();
    const testLine=testMode?.running?`\nTest mode: running — ${testMode.sent} simulated message(s) sent${testMode.lastMember?`; last simulated member: ${safeLine(testMode.lastMember)}`:''}. Stop with /discord-reminders test-mode-stop.`:'';
    await interaction.editReply({content:formatMembershipStatus(result)+testLine,allowedMentions:{parse:[]}});
  }catch(error){await interaction.editReply('Membership DMs: '+error.message);}
}
