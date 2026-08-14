import { REST, Routes } from 'discord.js';
import { config } from './config';

import * as ping from './commands/ping';
import * as horas from './commands/horas';
import * as leaderboard from './commands/leaderboard';
import * as replay from './commands/replay';
import * as clip from './commands/clip';
import * as playCmd from './commands/play';
import * as music from './commands/music';
import * as call from './commands/call';
import * as configCmd from './commands/config';
import * as privacidade from './commands/privacidade';

const commands = [
  ping.data.toJSON(),
  horas.data.toJSON(),
  leaderboard.data.toJSON(),
  replay.data.toJSON(),
  clip.data.toJSON(),
  playCmd.data.toJSON(),
  music.data.toJSON(),
  call.data.toJSON(),
  configCmd.data.toJSON(),
  privacidade.data.toJSON(),
];

const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
  try {
    console.log(`Registering ${commands.length} slash commands globally...`);
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    console.log('Slash commands registered!');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
})();
