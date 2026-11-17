import 'dotenv/config';
import { REST, Routes } from 'discord.js';

import * as roles from './commands/roles.js';
import * as raffle from './commands/raffle.js';
import * as tickets from './commands/tickets.js';
import * as trader from './commands/trader.js';
import { createGsaCommandData, createGsrCommandData, createGsrAliasCommandData } from './commands/gsa-raffle.js';

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

const globalCommands = [trader.data.toJSON()];

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
  console.log('Registering GuildSync slash commands...');

  // Unregister before registering. Both PUTs below replace their command set
  // wholesale, so anything not in the lists above disappears; the explicit
  // delete covers the case that matters here - an earlier deploy registered
  // /trader in the guild as well, and that copy shows up beside the global one.
  const existingGuildCommands = await rest.get(
    Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
  );

  for (const command of existingGuildCommands.filter(({ name }) => name === 'trader')) {
    await rest.delete(
      Routes.applicationGuildCommand(DISCORD_CLIENT_ID, DISCORD_GUILD_ID, command.id)
    );
    console.log(`Removed the leftover guild-scoped /${command.name}.`);
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

  console.log(`Registered ${guildCommands.length} guild commands and ${globalCommands.length} global command. /trader is global, so it works in server channels and DMs.`);
} catch (error) {
  console.error('Failed to register slash commands:');
  console.error(error);
  process.exit(1);
}
