import 'dotenv/config';
import { REST, Routes } from 'discord.js';

import * as roles from './commands/roles.js';
import * as raffle from './commands/raffle.js';
import * as tickets from './commands/tickets.js';
import * as trader from './commands/trader.js';
import { createGsaCommandData, createGsrCommandData, createGsrAliasCommandData } from './commands/gsa-raffle.js';

const commands = [
  roles.data.toJSON(),
  raffle.data.toJSON(),
  tickets.data.toJSON(),
  createGsaCommandData().toJSON(),
  createGsrCommandData().toJSON(),
  createGsrAliasCommandData().toJSON(),
];

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

  await rest.put(
    Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
    { body: commands }
  );

  // Register /trader globally so it also works in DMs. Existing guild commands
  // stay guild-scoped and keep appearing immediately after deployment. This
  // PUT replaces the whole global command set, which removes the retired
  // global /sales command.
  await rest.put(
    Routes.applicationCommands(DISCORD_CLIENT_ID),
    { body: [trader.data.toJSON()] }
  );

  console.log('Slash commands registered successfully. Global /trader is available in servers and DMs.');
} catch (error) {
  console.error('Failed to register slash commands:');
  console.error(error);
  process.exit(1);
}
