import 'dotenv/config';
import { REST, Routes } from 'discord.js';

import * as roles from './commands/roles.js';
import * as raffle from './commands/raffle.js';
import * as tickets from './commands/tickets.js';
import * as trader from './commands/trader.js';
import { createGsaCommandData, createGsrCommandData, createGsrAliasCommandData } from './commands/gsa-raffle.js';
import { staleTraderReasons, subcommandNames } from './command-registration.js';

// Guild-scoped commands. /trader is deliberately not in this list: Discord
// does not merge a guild command with a global one of the same name, it shows
// both, so registering it in both places gives you two identical /trader
// entries in the picker.
const guildCommands = [
  roles.data.toJSON(),
  raffle.data.toJSON(),
  tickets.data.toJSON(),
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

  console.log('Registering GuildSync slash commands...');

  // Unregister before registering. Both PUTs below replace their command set
  // wholesale, so anything not in the lists above disappears; the explicit
  // deletes cover the cases that matter - an earlier deploy put /trader in the
  // guild as well, and a global /trader that still lists /trader test.
  const existingGuildCommands = await rest.get(
    Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
  );

  for (const command of existingGuildCommands.filter(({ name }) => name === 'trader')) {
    await rest.delete(
      Routes.applicationGuildCommand(DISCORD_CLIENT_ID, DISCORD_GUILD_ID, command.id)
    );
    console.log(`Removed the leftover guild-scoped /${command.name}.`);
  }

  const existingGlobalCommands = await rest.get(Routes.applicationCommands(DISCORD_CLIENT_ID));

  for (const command of existingGlobalCommands.filter(({ name }) => name === 'trader')) {
    const reasons = staleTraderReasons(command, traderSubcommands);
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
  // offers /trader test, or a leftover guild copy is reported here instead of
  // being discovered by typing the command.
  const registeredGlobal = await rest.get(Routes.applicationCommands(DISCORD_CLIENT_ID));
  const registeredTrader = registeredGlobal.find(({ name }) => name === 'trader');
  const staleReasons = staleTraderReasons(registeredTrader, traderSubcommands);

  const registeredGuild = await rest.get(
    Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
  );
  const strayGuildTrader = registeredGuild.find(({ name }) => name === 'trader');

  if (staleReasons.length) {
    throw new Error(`Global /trader is not registered as expected: ${staleReasons.join('; ')}.`);
  }

  if (strayGuildTrader) {
    throw new Error('A guild-scoped /trader is still registered; remove it so the picker shows a single /trader.');
  }

  console.log(
    `Registered ${registeredGuild.length} guild commands (${registeredGuild.map(({ name }) => `/${name}`).join(', ')}) ` +
    `and the global /trader (${traderSubcommands.map((name) => `/trader ${name}`).join(', ')}).`
  );
  console.log('Read back from Discord: no guild-scoped /trader and no /trader test. A global change can take up to an hour to reach clients.');
} catch (error) {
  console.error('Failed to register slash commands:');
  console.error(error);
  process.exit(1);
}
