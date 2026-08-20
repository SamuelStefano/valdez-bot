import { REST, Routes } from 'discord.js';
import { config } from './config';
import { commandPayload } from './commands/registry';

const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
  try {
    console.log(`Registering ${commandPayload.length} slash commands globally...`);
    await rest.put(Routes.applicationCommands(config.clientId), { body: commandPayload });
    console.log('Slash commands registered!');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
})();
