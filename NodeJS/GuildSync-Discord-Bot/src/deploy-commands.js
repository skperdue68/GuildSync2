import 'dotenv/config';
import { REST, Routes } from 'discord.js';

import * as discordReminders from './commands/discord-reminders.js';
import * as roles from './commands/roles.js';
import * as raffle from './commands/raffle.js';
import * as tickets from './commands/tickets.js';
import * as trader from './commands/trader.js';
import * as highlights from './commands/highlights.js';
import { createGsaCommandData, createGsrCommandData, createGsrAliasCommandData } from './commands/gsa-raffle.js';
import { staleTraderReasons, subcommandNames } from './command-registration.js';

// Guild-scoped commands. /trader is deliberately not in this list: Discord
// does not merge a guild command with a global one of the same name, it shows
// both, so registering it in both places gives you two identical /trader
// entries in the picker.

// /membership-dm replaced /discord-reminders and no longer ships the simulated
// test mode. A stale definition or a survivor in Discord would put the old names
// back, so deployment fails before Discord is touched and checks the read-back.
const reminderCommandName = 'membership-dm';
const retiredReminderCommands = ['discord-reminders'];
const retiredReminderSubcommands = ['test-mode', 'test-mode-stop'];
const reminderDefinition = discordReminders.data.toJSON();

const guildCommands = [
  reminderDefinition,
  roles.data.toJSON(),
  raffle.data.toJSON(),
  tickets.data.toJSON(),
  highlights.data.toJSON(),
  createGsaCommandData().toJSON(),
  createGsrCommandData().toJSON(),
  createGsrAliasCommandData().toJSON(),
];

const traderDefinition = trader.data.toJSON();
const traderSubcommands = subcommandNames(traderDefinition);
const globalCommands = [traderDefinition];

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_GUILD_ID) {
  console.error('Missing DISCORD_TOKEN, DISCORD_CLIENT_ID, or DISCORD_GUILD_ID in .env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

try {
  // A definition that still ships the retired subcommand would re-register the
  // thing this deploy exists to remove, so fail before touching Discord.
  if (traderSubcommands.includes('test')) {
    throw new Error('The /trader definition still declares the retired test subcommand; remove it before deploying.');
  }

  if (reminderDefinition.name !== reminderCommandName) {
    throw new Error(`The membership DM definition registers /${reminderDefinition.name}; it must be /${reminderCommandName}.`);
  }

  const shippedReminderSubcommands = subcommandNames(reminderDefinition);
  const shippedRetiredReminder = retiredReminderSubcommands.filter((name) => shippedReminderSubcommands.includes(name));
  if (shippedRetiredReminder.length) {
    throw new Error(
      `The /${reminderCommandName} definition still declares the retired ${shippedRetiredReminder.join(', ')}; remove it before deploying.`
    );
  }

  console.log('Registering GuildSync slash commands...');

  // Unregister before registering. Both PUTs below replace their command set
  // wholesale, so anything not in the lists above disappears; the explicit
  // deletes cover the cases that matter - an earlier deploy put /trader in the
  // guild as well, and a global /trader that still lists /trader test.
  const existingGuildCommands = await rest.get(
    Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
  );

  const retiredGuildNames = new Set(['trader', ...retiredReminderCommands]);

  for (const command of existingGuildCommands.filter(({ name }) => retiredGuildNames.has(name))) {
    await rest.delete(
      Routes.applicationGuildCommand(DISCORD_CLIENT_ID, DISCORD_GUILD_ID, command.id)
    );
    console.log(`Removed the retired or leftover guild-scoped /${command.name}.`);
  }

  const existingGlobalCommands = await rest.get(Routes.applicationCommands(DISCORD_CLIENT_ID));

  for (const command of existingGlobalCommands.filter(({ name }) => name === 'trader')) {
    const reasons = staleTraderReasons(command, traderDefinition);
    if (!reasons.length) continue;

    await rest.delete(Routes.applicationCommand(DISCORD_CLIENT_ID, command.id));
    console.log(`Removed the global /trader: ${reasons.join('; ')}.`);
  }

  await rest.put(
    Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
    { body: guildCommands }
  );

  // /trader is global only: that is what makes it work in DMs, and it reaches
  // every server the bot is in. This PUT replaces the whole global command set,
  // which also removes the retired global /sales command.
  await rest.put(
    Routes.applicationCommands(DISCORD_CLIENT_ID),
    { body: globalCommands }
  );

  // Read both sets back, so a put that did not land, a definition that still
  // offers /trader test, a subcommand whose options drifted (the count option
  // being the case that prompted this), or a leftover guild copy is reported
  // here instead of being discovered by typing the command.
  const registeredGlobal = await rest.get(Routes.applicationCommands(DISCORD_CLIENT_ID));
  const registeredTrader = registeredGlobal.find(({ name }) => name === 'trader');
  const staleReasons = staleTraderReasons(registeredTrader, traderDefinition);

  const registeredGuild = await rest.get(
    Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
  );
  const strayGuildTrader = registeredGuild.find(({ name }) => name === 'trader');
  const registeredReminders = registeredGuild.find(({ name }) => name === reminderCommandName);
  const staleReminderSubcommands = retiredReminderSubcommands.filter((name) => subcommandNames(registeredReminders).includes(name));
  const staleReminderCommands = registeredGuild.filter(({ name }) => retiredReminderCommands.includes(name)).map(({ name }) => `/${name}`);

  if (staleReasons.length) {
    throw new Error(`Global /trader is not registered as expected: ${staleReasons.join('; ')}.`);
  }

  if (strayGuildTrader) {
    throw new Error('A guild-scoped /trader is still registered; remove it so the picker shows a single /trader.');
  }

  if (!registeredReminders) {
    throw new Error(`/${reminderCommandName} is not registered; the guild command set was not replaced.`);
  }

  if (staleReminderCommands.length) {
    throw new Error(`${staleReminderCommands.join(', ')} is still registered; the guild command set was not replaced.`);
  }

  if (staleReminderSubcommands.length) {
    throw new Error(`/${reminderCommandName} still offers the retired ${staleReminderSubcommands.join(', ')}; the guild command set was not replaced.`);
  }

  console.log(
    `Registered ${registeredGuild.length} guild commands (${registeredGuild.map(({ name }) => `/${name}`).join(', ')}) ` +
    `and the global /trader (${traderSubcommands.map((name) => `/trader ${name}`).join(', ')}).`
  );
  console.log('Read back from Discord: /membership-dm with no test mode, no /discord-reminders, and no guild-scoped /trader. A global change can take up to an hour to reach clients.');
} catch (error) {
  console.error('Failed to register slash commands:');
  console.error(error);
  process.exit(1);
}
