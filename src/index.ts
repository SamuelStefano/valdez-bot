import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first');

import { Client, GatewayIntentBits, ChatInputCommandInteraction, REST, Routes } from 'discord.js';
import { config } from './config';
import { logger } from './utils/logger';
import {
  setupAutoPresence,
  evaluateAllGuilds,
  startVoiceWatchdog,
  dropGuildVoice,
} from './modules/voiceManager';
import { setupVoiceTracker } from './modules/voiceTracker';
import { setupLiveCounter } from './modules/liveCounter';
import { loadAllSettings, forgetGuild } from './modules/guildSettings';
import {
  loadLicenses,
  getLicense,
  dropLicenseCache,
  ensureOwnerLicense,
  setOwnerResolver,
} from './modules/licensing';
import { track } from './modules/telemetry';
import { clearExpiredNotice } from './modules/billingNotice';
import { sendOnboarding } from './modules/onboarding';
import { initMusicModal, handleMusicButton } from './modules/musicModal';
import { handleClipButton } from './modules/clipPublisher';
import { logSpotifyStatus } from './utils/spotifyApi';
import { startHealthServer, startHeartbeat } from './utils/health';
import { startSupabaseSync } from './modules/supabaseSync';
import { startWeeklyRecap } from './modules/weeklyRecap';

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
import * as assinatura from './commands/assinatura';
import * as feedback from './commands/feedback';
import * as clear from './commands/clear';

const commands = new Map<string, { execute: (i: ChatInputCommandInteraction) => Promise<void> }>();
commands.set('ping', ping);
commands.set('horas', horas);
commands.set('leaderboard', leaderboard);
commands.set('replay', replay);
commands.set('clip', clip);
commands.set('play', playCmd);
commands.set('music', music);
commands.set('call', call);
commands.set('config', configCmd);
commands.set('privacidade', privacidade);
commands.set('assinatura', assinatura);
commands.set('feedback', feedback);
commands.set('clear', clear);

const allCommandsData = [
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
  assinatura.data.toJSON(),
  feedback.data.toJSON(),
  clear.data.toJSON(),
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
  loadAllSettings();
  setOwnerResolver((guildId) => client.guilds.cache.get(guildId)?.ownerId ?? null);
  loadLicenses();
  if (config.seedGuildId) ensureOwnerLicense(config.seedGuildId);

  try {
    const rest = new REST({ version: '10' }).setToken(config.token);
    await rest.put(Routes.applicationCommands(config.clientId), { body: allCommandsData });
    logger.info(`Slash commands registered globally (${client.guilds.cache.size} servidores)`);

    // Os comandos guild-scoped da versão single-server continuam registrados e
    // apareceriam duplicados ao lado dos globais.
    if (config.seedGuildId) {
      await rest.put(Routes.applicationGuildCommands(config.clientId, config.seedGuildId), { body: [] });
      logger.info(`Comandos guild-scoped antigos limpos em ${config.seedGuildId}`);
    }
  } catch (err) {
    logger.error('Failed to register slash commands', err);
  }

  setupVoiceTracker(client);
  setupLiveCounter(client);
  setupAutoPresence(client);
  initMusicModal(client);
  startHeartbeat(client);
  evaluateAllGuilds(client);
  startVoiceWatchdog(client);
  startSupabaseSync(client);
  startWeeklyRecap(client);
});

client.on('guildCreate', async (guild) => {
  logger.info(`[GUILD] entrei em ${guild.name} (${guild.id})`);
  // Ler a licença já cria o teste de 14 dias — o servidor novo nunca cai no bot
  // sem plano nenhum.
  const license = getLicense(guild.id);
  clearExpiredNotice(guild.id);
  track(guild.id, 'guild_join', { detail: license.plan });
  await sendOnboarding(guild);
});

// Removeram o bot: solta conexão, buffer e configuração em vez de manter estado
// de um servidor que não existe mais pra ele.
client.on('guildDelete', (guild) => {
  logger.info(`[GUILD] removido de ${guild.name} (${guild.id})`);
  track(guild.id, 'guild_leave');
  dropGuildVoice(guild.id);
  forgetGuild(guild.id);
  dropLicenseCache(guild.id);
  clearExpiredNotice(guild.id);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('music:')) {
      try {
        await handleMusicButton(interaction);
      } catch (err: any) {
        logger.error(`Music button error: ${err?.message}`);
      }
    } else if (interaction.customId.startsWith('clip:')) {
      try {
        await handleClipButton(interaction);
      } catch (err: any) {
        logger.error(`Clip button error: ${err?.message}`);
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
