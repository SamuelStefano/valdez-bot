import { REST, Routes } from 'discord.js';
import { config } from './config';

import * as ping from './commands/ping';
import * as horas from './commands/horas';
import * as leaderboard from './commands/leaderboard';
import * as replay from './commands/replay';
import * as playCmd from './commands/play';
import * as music from './commands/music';

const commands = [
  ping.data.toJSON(),
  horas.data.toJSON(),
  leaderboard.data.toJSON(),
  replay.data.toJSON(),
  playCmd.data.toJSON(),
  music.data.toJSON(),
];

const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
  try {
    console.log(`Registering ${commands.length} slash commands...`);

    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body: commands }
    );

    console.log('Slash commands registered!');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
})();
