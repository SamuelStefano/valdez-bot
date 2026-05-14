import { Client, GatewayIntentBits, ChatInputCommandInteraction, REST, Routes } from 'discord.js';
import { config } from './config';
import { logger } from './utils/logger';
import { joinChannel } from './modules/voiceManager';
import { setupVoiceTracker } from './modules/voiceTracker';
import { startBuffering } from './modules/replayBuffer';

// Commands
import * as ping from './commands/ping';
import * as horas from './commands/horas';
import * as leaderboard from './commands/leaderboard';
import * as replay from './commands/replay';
import * as playCmd from './commands/play';
import * as music from './commands/music';

const commands = new Map<string, { execute: (i: ChatInputCommandInteraction) => Promise<void> }>();
commands.set('ping', ping);
commands.set('horas', horas);
commands.set('leaderboard', leaderboard);
commands.set('replay', replay);
commands.set('play', playCmd);
commands.set('music', music);

const allCommandsData = [
  ping.data.toJSON(),
  horas.data.toJSON(),
  leaderboard.data.toJSON(),
  replay.data.toJSON(),
  playCmd.data.toJSON(),
  music.data.toJSON(),
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once('ready', async () => {
  logger.info(`Valdez online como ${client.user?.tag}`);

  // Register slash commands on startup
  try {
    const rest = new REST({ version: '10' }).setToken(config.token);
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body: allCommandsData }
    );
    logger.info('Slash commands registered');
  } catch (err) {
    logger.error('Failed to register slash commands', err);
  }

  // Setup voice tracking
  setupVoiceTracker(client);

  // Join voice channel and start buffering
  const connection = await joinChannel(client);
  if (connection) {
    startBuffering(connection);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    logger.error(`Command error (${interaction.commandName}):`, err);
    const reply = { content: '❌ Erro ao executar comando.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down...');
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Shutting down...');
  client.destroy();
  process.exit(0);
});

client.login(config.token);
