import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first');

import { createHash } from 'node:crypto';
import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import { config } from './config';
import { dbStatements } from './utils/database';
import { logger } from './utils/logger';
import {
  setupAutoPresence,
  evaluateAllGuilds,
  startVoiceWatchdog,
  dropGuildVoice,
} from './modules/voiceManager';
import { setupVoiceTracker, closeStaleSessions, markAlive } from './modules/voiceTracker';
import { setupLiveCounter, dropGuildCounter } from './modules/liveCounter';
import { dropGuildMusic } from './modules/musicPlayer';
import { setupCallAnnounce, dropGuildAnnounce } from './modules/callAnnounce';
import { setupHighlightDetector, dropGuildHighlights } from './modules/highlightDetector';
import { dropGuildRewards } from './modules/roleRewards';
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
import { sweepOrphanRecordings } from './utils/audioExporter';
import { startSupabaseSync, markGuildLeft } from './modules/supabaseSync';
import { startWeeklyRecap } from './modules/weeklyRecap';
import { startYtHealthWatchdog } from './modules/ytHealth';

import { handleHelpSelect } from './commands/help';
import { commandHandlers, commandPayload } from './commands/registry';

// Todo PUT global republica os comandos e invalida o cache dos clientes, que
// passam a responder "This command is outdated" até atualizarem sozinhos. Como
// o bot registrava a cada boot, qualquer restart cobrava esse pedágio dos
// usuários — então só republica quando o payload realmente muda.
const COMMANDS_HASH_KEY = 'commands_hash';

function payloadHash(payload: unknown): number {
  return parseInt(createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 13), 16);
}

function readMeta(key: string): number | undefined {
  return (dbStatements.getMeta.get(key) as { value: number } | undefined)?.value;
}

async function syncCommands(client: Client): Promise<void> {
  const hash = payloadHash(commandPayload);
  if (readMeta(COMMANDS_HASH_KEY) === hash) {
    logger.info(`Slash commands inalterados (${commandPayload.length}) — nada a registrar`);
    return;
  }

  const rest = new REST({ version: '10' }).setToken(config.token);
  await rest.put(Routes.applicationCommands(config.clientId), { body: commandPayload });
  dbStatements.setMeta.run(COMMANDS_HASH_KEY, hash);
  logger.info(
    `Slash commands registrados globalmente (${commandPayload.length} comandos, ${client.guilds.cache.size} servidores)`
  );

  // Os comandos guild-scoped da versão single-server continuam registrados e
  // apareceriam duplicados ao lado dos globais.
  if (config.seedGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.seedGuildId), { body: [] });
    logger.info(`Comandos guild-scoped antigos limpos em ${config.seedGuildId}`);
  }
}

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
    await syncCommands(client);
  } catch (err) {
    logger.error('Failed to register slash commands', err);
  }

  setupVoiceTracker(client);
  setupLiveCounter(client);
  setupCallAnnounce(client);
  setupHighlightDetector(client);
  setupAutoPresence(client);
  initMusicModal(client);
  startHeartbeat(client);
  evaluateAllGuilds(client);
  startVoiceWatchdog(client);
  startSupabaseSync(client);
  startWeeklyRecap(client);
  startYtHealthWatchdog();
  sweepOrphanRecordings();
  setInterval(sweepOrphanRecordings, 3600_000).unref();
});

client.on('guildCreate', async (guild) => {
  logger.info(`[GUILD] entrei em ${guild.name} (${guild.id})`);
  // Servidor novo entra no gratuito: sem teste, sem licença gravada.
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
  markGuildLeft(guild.id);
  dropGuildVoice(guild.id);
  dropGuildMusic(guild.id);
  dropGuildCounter(guild.id);
  dropGuildAnnounce(guild.id);
  dropGuildHighlights(guild.id);
  dropGuildRewards(guild.id);
  forgetGuild(guild.id);
  dropLicenseCache(guild.id);
  clearExpiredNotice(guild.id);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'help:cat') {
      try {
        await handleHelpSelect(interaction);
      } catch (err: any) {
        logger.error(`Help select error: ${err?.message}`);
      }
    }
    return;
  }

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

  const command = commandHandlers.get(interaction.commandName);
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
  try {
    markAlive();
    closeStaleSessions();
  } catch (err: any) {
    logger.error(`Falha ao fechar sessões no shutdown: ${err?.message}`);
  }
  healthServer.close();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(config.token);
