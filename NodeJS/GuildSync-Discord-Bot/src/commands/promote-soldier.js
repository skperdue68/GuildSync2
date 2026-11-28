import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  MessageFlags,
  PermissionFlagsBits
} from 'discord.js';

import { discordErrorSummary, membershipDMRequest } from '../membership-dms.js';
import { Log } from '../helper.js';

// The recruit-tier roles a Soldier promotion replaces.
export const RECRUIT_ROLES = [
  { id: '800103448339152956', name: 'Associate' },
  { id: '1527366158645465088', name: 'Gangster' },
  { id: '1575052436274544754', name: 'Neighbor' }
];
export const SOLDIER_ROLE_ID = '800103404848414720';

export const SOLDIER_DM = 'Hello! You may have noticed that you’ve been promoted in guild and on Discord to Soldier in Alphabet Mafia. Congratulations! This means that you can now deposit items in the guild bank if you’d like, but please check our guidelines on what sort of items we need before you do. We hope you continue to enjoy your time in Alphabet Mafia!';

export const data = new ContextMenuCommandBuilder()
  .setName('Promote - Soldier')
  .setType(ApplicationCommandType.User)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles);

// Nothing is changed when the officer clicks: the roles and the reminder are
// applied together when the membership DM queue reaches this promotion.
export function planPromotion(member) {
  if (member.user.bot) throw Error('Bots cannot be promoted.');
  if (member.manageable === false) {
    throw Error("The bot's highest role is below this member's roles, so it cannot change them.");
  }

  const held = RECRUIT_ROLES.filter((role) => member.roles.cache.has(role.id));
  const alreadySoldier = member.roles.cache.has(SOLDIER_ROLE_ID);

  if (!held.length && !alreadySoldier) {
    return { status: 'not-recruit', removeRoleIds: [], addRoleId: SOLDIER_ROLE_ID };
  }
  if (alreadySoldier) {
    return { status: 'already-soldier', removeRoleIds: [], addRoleId: SOLDIER_ROLE_ID };
  }
  return { status: 'queued', removeRoleIds: held.map((role) => role.id), addRoleId: SOLDIER_ROLE_ID };
}

export function promotionSummary(member, plan) {
  const who = `<@${member.id}>`;
  if (plan.status === 'not-recruit') {
    return `Nothing changed: ${who} does not have Associate, Gangster or Neighbor.`;
  }
  if (plan.status === 'already-soldier') {
    return `${who} is already a Soldier.`;
  }
  return `Promotion queued for ${who}. The role change and reminder DM go out together at the next membership DM slot, and you will get a DM receipt.`;
}

export async function execute(interaction, socket) {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'Use this command inside the server.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    const member = await interaction.guild.members.fetch(interaction.targetId);
    const plan = planPromotion(member);

    if (plan.status !== 'queued') {
      await interaction.editReply({ content: promotionSummary(member, plan), allowedMentions: { parse: [] } });
      return;
    }

    try {
      await membershipDMRequest(socket, interaction.guildId, 'queue-promotion', {
        userId: member.id,
        requesterId: interaction.user.id,
        content: SOLDIER_DM,
        removeRoleIds: plan.removeRoleIds,
        addRoleId: plan.addRoleId
      });
      await interaction.editReply({ content: promotionSummary(member, plan), allowedMentions: { parse: [] } });
    } catch (error) {
      await interaction.editReply({
        content: `Nothing was changed: the promotion could not be queued (${error.message}).`,
        allowedMentions: { parse: [] }
      });
    }
  } catch (error) {
    Log(`Promote - Soldier failed: ${error.message}`);
    await interaction.editReply({
      content: `Promotion failed: ${discordErrorSummary(error, error.message)}`,
      allowedMentions: { parse: [] }
    });
  }
}
