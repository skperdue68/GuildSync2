import {SlashCommandBuilder,PermissionFlagsBits,MessageFlags} from 'discord.js';
import {membershipDMRequest,formatMembershipStatus} from '../membership-dms.js';
import {syncDiscordRolesAndMembers} from '../discord-sync.js';

export const data=new SlashCommandBuilder().setName('discord-reminders')
  .setDescription('Manage the slow GuildSync membership DM campaign.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(s=>s.setName('start').setDescription('Start an alphabetical campaign for eligible unlinked Discord members.'))
  .addSubcommand(s=>s.setName('pause').setDescription('Pause new campaign DMs.'))
  .addSubcommand(s=>s.setName('resume').setDescription('Resume the saved campaign without a catch-up burst.'))
  .addSubcommand(s=>s.setName('restart').setDescription('Build a fresh campaign; preserve send dates and community preferences.'))
  .addSubcommand(s=>s.setName('status').setDescription('Show progress, last recipient and next attempt.').addUserOption(o=>o.setName('user').setDescription('Also show this member’s send date and preference.')))
  .addSubcommand(s=>s.setName('test').setDescription('Send one labelled test DM immediately; do not change normal cooldowns.').addUserOption(o=>o.setName('user').setDescription('Discord server member to receive the test.').setRequired(true)));

export async function execute(interaction,socket) {
  await interaction.deferReply({flags:[MessageFlags.Ephemeral]});
  if(!interaction.guildId||!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)){
    await interaction.editReply('Use this command in the configured server with Manage Server permission and approved GuildSync User/Admin access.');return;
  }
  const command=interaction.options.getSubcommand(),target=interaction.options.getUser('user');
  try{
    if(command==='test'){
      if(!interaction.client.membershipDM)throw Error('Membership DM worker is unavailable.');
      const outcome=await interaction.client.membershipDM.test(interaction.user.id,target.id);
      await interaction.editReply(outcome?.status==='sent'?`Test DM sent to ${target.username}. Its responses will be marked as tests.`:`Test DM outcome: ${outcome?.status||'skipped'}. ${outcome?.detail||'Check bot logs and the recipient’s DM settings.'}`);
      return;
    }
    if(command==='start'||command==='restart'){
      await membershipDMRequest(socket,interaction.guildId,'command',{actorId:interaction.user.id,command:'status'});
      await syncDiscordRolesAndMembers(interaction.guild,socket);
    }
    const result=await membershipDMRequest(socket,interaction.guildId,'command',{actorId:interaction.user.id,command,targetId:target?.id});
    await interaction.editReply({content:formatMembershipStatus(result),allowedMentions:{parse:[]}});
  }catch(error){await interaction.editReply('Membership DMs: '+error.message);}
}
