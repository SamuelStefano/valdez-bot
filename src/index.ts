import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first');

import { Client, GatewayIntentBits, ChatInputCommandInteraction, REST, Routes } from 'discord.js';
import { config } from './config';
import { logger } from './utils/logger';
import { setupAutoPresence, evaluatePresence } from './modules/voiceManager';
import { setupVoiceTracker } from './modules/voiceTracker';
import { initMusicModal, handleMusicButton } from './modules/musicModal';
import { logSpotifyStatus } from './utils/spotifyApi';
import { startHealthServer, startHeartbeat } from './utils/health';

import * as ping from './commands/ping';
import * as horas from './commands/horas';
import * as leaderboard from './commands/leaderboard';
import * as replay from './commands/replay';
import * as playCmd from './commands/play';
import * as music from './commands/music';
import * as call from './commands/call';

const commands = new Map<string, { execute: (i: ChatInputCommandInteraction) => Promise<void> }>();
commands.set('ping', ping);
commands.set('horas', horas);
commands.set('leaderboard', leaderboard);
commands.set('replay', replay);
commands.set('play', playCmd);
commands.set('music', music);
commands.set('call', call);

const allCommandsData = [
  ping.data.toJSON(),
  horas.data.toJSON(),
  leaderboard.data.toJSON(),
  replay.data.toJSON(),
  playCmd.data.toJSON(),
  music.data.toJSON(),
  call.data.toJSON(),
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// CRITICAL: Prevent unhandled error crashes
client.on('error', (err) => {
  logger.error('Client error (caught):', err.message);
});

process.on('unhandledRejection', (err: any) => {
  logger.error('Unhandled rejection (caught):', err?.message || err);
});

process.on('uncaughtException', (err: any) => {
  logger.error('Uncaught exception (caught):', err?.message || err);
});

client.once('ready', async () => {
  logger.info(`Valdez online como ${client.user?.tag}`);

  logSpotifyStatus();

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

  setupVoiceTracker(client);
  setupAutoPresence(client);
  initMusicModal(client);
  startHeartbeat(client);
  evaluatePresence(client);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('music:')) {
      try {
        await handleMusicButton(interaction);
      } catch (err: any) {
        logger.error(`Music button error: ${err?.message}`);
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err: any) {
    logger.error(`Command error (${interaction.commandName}): ${err?.message}`);
    try {
      const msg = { content: '❌ Erro ao executar comando.' };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(msg);
      } else {
        await interaction.reply(msg);
      }
    } catch {
      // Interaction expired, nothing we can do
    }
  }
});

// Start health server before login so /health answers 503 (not connection
// refused) while the gateway is still connecting — avoids autoheal crashloops
// when Discord login is slow on boot.
const healthServer = startHealthServer(client);

function shutdown() {
  logger.info('Shutting down...');
  healthServer.close();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(config.token);
