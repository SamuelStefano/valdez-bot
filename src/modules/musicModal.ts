import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Message,
  MessageFlags,
  TextChannel,
} from 'discord.js';
import { logger } from '../utils/logger';
import {
  getQueue,
  isPaused,
  pause,
  previous,
  resume,
  setOnPlayerUpdate,
  skip,
  stop,
  toggleLoop,
} from './musicPlayer';

const BTN = {
  prev: 'music:prev',
  pauseResume: 'music:pauseResume',
  skip: 'music:skip',
  stop: 'music:stop',
  loop: 'music:loop',
};

// guildId → cached modal message
const modalMessages = new Map<string, Message>();
// guildId → channel where modal should appear (set quando o user roda /play)
const modalChannels = new Map<string, string>();
// guildId → debounce timer
const updateTimers = new Map<string, NodeJS.Timeout>();

let client: Client | null = null;

export function initMusicModal(c: Client) {
  client = c;
  setOnPlayerUpdate((guildId, event) => {
    if (event === 'trackRecovered' || event === 'trackFailed') void notice(guildId, event);
    scheduleUpdate(guildId);
  });
}

// Trocar de fonte no meio da fila é uma surpresa silenciosa: o card só mostra
// outro título e ninguém entende por quê.
async function notice(guildId: string, event: 'trackRecovered' | 'trackFailed'): Promise<void> {
  const channel = await getModalChannel(guildId);
  if (!channel) return;
  const content =
    event === 'trackRecovered'
      ? '🔁 O YouTube recusou essa faixa — peguei a mesma música no SoundCloud.'
      : '⏭️ O YouTube recusou essa faixa e não achei ela no SoundCloud. Pulando.';
  await channel.send({ content }).catch(() => {});
}

// Chamado pelo /play pra dizer onde o modal deve aparecer.
// Se mudou de canal desde o último /play, apaga o modal antigo.
export async function setMusicChannel(guildId: string, channelId: string) {
  const previous = modalChannels.get(guildId);
  if (previous && previous !== channelId) {
    const oldMsg = modalMessages.get(guildId);
    if (oldMsg) {
      try {
        await oldMsg.delete();
      } catch {
        /* já apagada ou sem permissão */
      }
      modalMessages.delete(guildId);
    }
  }
  modalChannels.set(guildId, channelId);
}

function scheduleUpdate(guildId: string) {
  const existing = updateTimers.get(guildId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    updateTimers.delete(guildId);
    void updateModal(guildId).catch((err) =>
      logger.error(`Music modal update failed: ${(err as Error).message}`),
    );
  }, 150);
  updateTimers.set(guildId, t);
}

async function getModalChannel(guildId: string): Promise<TextChannel | null> {
  if (!client) return null;
  const channelId = modalChannels.get(guildId);
  if (!channelId) return null;
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) return null;
  return ch as TextChannel;
}

function buildEmbed(guildId: string): EmbedBuilder {
  const q = getQueue(guildId);
  const paused = isPaused(guildId);

  if (!q.current) {
    return new EmbedBuilder()
      .setColor(0x2b2d31)
      .setTitle('🔇 Nada tocando')
      .setDescription('Use `/play <música>` para começar.');
  }

  const upNext = q.tracks
    .slice(0, 5)
    .map((t, i) => `\`${i + 1}.\` ${t.title} \`[${t.duration}]\``)
    .join('\n') || '_(fila vazia)_';

  const moreCount = q.tracks.length > 5 ? `\n_... e mais ${q.tracks.length - 5}_` : '';

  const embed = new EmbedBuilder()
    .setColor(paused ? 0xffaa00 : 0x1db954)
    .setTitle(paused ? '⏸️ Pausado' : '🎵 Tocando agora')
    .setDescription(`**[${q.current.title}](${q.current.url})**`)
    .addFields(
      { name: 'Duração', value: q.current.duration, inline: true },
      { name: 'Pedido por', value: q.current.requestedBy, inline: true },
      { name: 'Loop', value: q.loop ? '🔁 ativado' : '➡️ desativado', inline: true },
      { name: 'Próximas', value: upNext + moreCount },
    )
    .setFooter({ text: `Fila: ${q.tracks.length} música(s) • Histórico: ${q.history.length}` });

  if (q.current.thumbnail) embed.setThumbnail(q.current.thumbnail);
  return embed;
}

function buildButtons(guildId: string) {
  const q = getQueue(guildId);
  const paused = isPaused(guildId);
  const noCurrent = !q.current;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(BTN.prev)
      .setEmoji('⏮️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(q.history.length === 0),
    new ButtonBuilder()
      .setCustomId(BTN.pauseResume)
      .setEmoji(paused ? '▶️' : '⏸️')
      .setStyle(paused ? ButtonStyle.Success : ButtonStyle.Primary)
      .setDisabled(noCurrent),
    new ButtonBuilder()
      .setCustomId(BTN.skip)
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(noCurrent),
    new ButtonBuilder()
      .setCustomId(BTN.stop)
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(noCurrent),
    new ButtonBuilder()
      .setCustomId(BTN.loop)
      .setEmoji('🔁')
      .setStyle(q.loop ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(noCurrent),
  );
  return [row];
}

export async function updateModal(guildId: string) {
  const channel = await getModalChannel(guildId);
  if (!channel) return;

  const embed = buildEmbed(guildId);
  const components = buildButtons(guildId);
  const payload = { embeds: [embed], components };

  const cached = modalMessages.get(guildId);
  if (cached) {
    try {
      await cached.edit(payload);
      return;
    } catch {
      modalMessages.delete(guildId);
    }
  }

  // Try to find an existing modal in recent messages (e.g. after bot restart)
  try {
    const recent = await channel.messages.fetch({ limit: 20 });
    const own = recent.find(
      (m) => m.author.id === client?.user?.id && m.embeds[0]?.title?.includes('Tocando'),
    );
    if (own) {
      await own.edit(payload);
      modalMessages.set(guildId, own);
      return;
    }
  } catch {
    /* ignore */
  }

  const sent = await channel.send(payload);
  modalMessages.set(guildId, sent);
}

export async function handleMusicButton(interaction: ButtonInteraction) {
  if (!interaction.customId.startsWith('music:')) return;
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: '❌ Só funciona em servidor.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Defer so we don't show "interaction failed" while we work
  await interaction.deferUpdate().catch(() => undefined);

  switch (interaction.customId) {
    case BTN.prev: {
      const prev = previous(guildId);
      if (!prev) {
        await interaction.followUp({ content: '❌ Sem histórico.', flags: MessageFlags.Ephemeral });
      }
      break;
    }
    case BTN.pauseResume: {
      if (isPaused(guildId)) {
        resume(guildId);
      } else {
        pause(guildId);
      }
      break;
    }
    case BTN.skip: {
      const skipped = skip(guildId);
      if (!skipped) {
        await interaction.followUp({ content: '❌ Nada tocando.', flags: MessageFlags.Ephemeral });
      }
      break;
    }
    case BTN.stop: {
      stop(guildId);
      break;
    }
    case BTN.loop: {
      toggleLoop(guildId);
      break;
    }
  }

  // Player events already trigger updateModal via setOnPlayerUpdate;
  // force an extra refresh in case nothing changed (e.g. pause when paused).
  scheduleUpdate(guildId);
}
