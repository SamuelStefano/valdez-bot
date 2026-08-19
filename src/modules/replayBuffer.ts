import { VoiceConnection, EndBehaviorType, VoiceReceiver } from '@discordjs/voice';
import { config } from '../config';
import { logger } from '../utils/logger';
import { hasOptedOut } from './guildSettings';
import { limits } from './licensing';

interface OpusPacket {
  data: Buffer;
  timestamp: number;
}

interface UserBuffer {
  packets: OpusPacket[];
  isSubscribed: boolean;
}

type OpusStream = ReturnType<VoiceReceiver['subscribe']>;

interface ActiveRecording {
  triggeredBy: string;
  startedAt: number;
  extraPackets: Map<string, OpusPacket[]>;
}

// Todo o estado de buffer é por servidor. Enquanto era singleton de módulo, um
// segundo servidor sobrescrevia o receiver do primeiro e os dois clipavam o
// áudio errado — é o que impedia o bot de rodar em mais de uma guild.
interface GuildBuffer {
  userBuffers: Map<string, UserBuffer>;
  activeRecordings: Map<string, ActiveRecording>;
  trimInterval: NodeJS.Timeout | null;
  receiver: VoiceReceiver | null;
  speakingHandler: ((userId: string) => void) | null;
  openStreams: Set<OpusStream>;
  lastActivityAt: number;
}

const guilds = new Map<string, GuildBuffer>();

function state(guildId: string): GuildBuffer {
  let g = guilds.get(guildId);
  if (!g) {
    g = {
      userBuffers: new Map(),
      activeRecordings: new Map(),
      trimInterval: null,
      receiver: null,
      speakingHandler: null,
      openStreams: new Set(),
      lastActivityAt: 0,
    };
    guilds.set(guildId, g);
  }
  return g;
}

// Timestamp of the last speaking/packet event, or 0 when not buffering. The
// voice watchdog uses this to detect a silently-dead receiver (connection stays
// Ready but Discord stops delivering audio) and force a rejoin.
export function getLastActivityAt(guildId: string): number {
  return guilds.get(guildId)?.lastActivityAt ?? 0;
}

export function isBuffering(guildId: string): boolean {
  return !!guilds.get(guildId)?.receiver;
}

// A janela é o próprio plano: guardar 30 min de call custa memória, então quem
// paga mais guarda mais.
function windowMs(guildId: string) {
  return limits(guildId).bufferSeconds * 1000;
}

function trimPackets(packets: OpusPacket[], cutoff: number) {
  while (packets.length > 0 && packets[0].timestamp < cutoff) {
    packets.shift();
  }
}

export function startBuffering(guildId: string, connection: VoiceConnection) {
  // Idempotent: a reconnect creates a NEW receiver, so always tear down the old
  // attachment before re-attaching — otherwise the new connection is never read.
  if (isBuffering(guildId)) resetBuffering(guildId);

  const g = state(guildId);
  g.lastActivityAt = Date.now();

  // Evict packets that fell out of the window even while a user is silent.
  // Without this, someone who spoke then went quiet keeps stale packets forever.
  g.trimInterval = setInterval(() => {
    const now = Date.now();
    for (const buf of g.userBuffers.values()) trimPackets(buf.packets, now - windowMs(guildId));
    const recCutoff = now - config.maxRecordingSeconds * 1000;
    for (const rec of g.activeRecordings.values()) {
      for (const packets of rec.extraPackets.values()) trimPackets(packets, recCutoff);
    }
  }, 5_000);

  const receiver = connection.receiver;
  g.receiver = receiver;

  g.speakingHandler = (userId: string) => {
    g.lastActivityAt = Date.now();

    // Quem deu opt-out nunca entra no buffer: o áudio dele não é guardado nem
    // por um instante, em vez de ser filtrado só na hora de exportar.
    if (hasOptedOut(guildId, userId)) return;

    logger.info(`[BUFFER] ${guildId}: user ${userId} started speaking`);

    if (g.userBuffers.get(userId)?.isSubscribed) return;

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    g.openStreams.add(opusStream);

    const buf = getUserBuffer(g, userId);
    buf.isSubscribed = true;
    let packetCount = 0;

    opusStream.on('data', (chunk: Buffer) => {
      g.lastActivityAt = Date.now();

      // Opt-out no meio da fala: o stream já está aberto, então corta aqui em vez
      // de seguir gravando num buffer órfão até o usuário parar de falar.
      if (hasOptedOut(guildId, userId)) {
        opusStream.destroy();
        return;
      }

      packetCount++;
      if (packetCount === 1) {
        logger.info(`[BUFFER] ${guildId}: first packet from ${userId}, size: ${chunk.length} bytes`);
      }

      const packet: OpusPacket = {
        data: Buffer.from(chunk),
        timestamp: Date.now(),
      };

      buf.packets.push(packet);

      // Trim buffer to keep only last N seconds
      trimPackets(buf.packets, Date.now() - windowMs(guildId));

      // Active recordings — capped at maxRecordingSeconds so a forgotten
      // /replay start can't grow the buffer until the container OOMs.
      const recCutoff = Date.now() - config.maxRecordingSeconds * 1000;
      for (const recording of g.activeRecordings.values()) {
        if (!recording.extraPackets.has(userId)) {
          recording.extraPackets.set(userId, []);
        }
        const extra = recording.extraPackets.get(userId)!;
        extra.push(packet);
        trimPackets(extra, recCutoff);
      }
    });

    opusStream.on('error', (err) => {
      logger.error(`[BUFFER] ${guildId}: stream error for ${userId}:`, err);
      buf.isSubscribed = false;
    });

    opusStream.on('close', () => {
      logger.info(`[BUFFER] ${guildId}: stream closed for ${userId}`);
      buf.isSubscribed = false;
      g.openStreams.delete(opusStream);
    });
  };

  receiver.speaking.on('start', g.speakingHandler);

  logger.info(`[BUFFER] ${guildId}: replay buffer started — last ${limits(guildId).bufferSeconds}s`);
}

export function resetBuffering(guildId: string) {
  const g = guilds.get(guildId);
  if (!g) return;

  g.lastActivityAt = 0;
  if (g.trimInterval) {
    clearInterval(g.trimInterval);
    g.trimInterval = null;
  }
  if (g.receiver && g.speakingHandler) {
    g.receiver.speaking.off('start', g.speakingHandler);
  }
  // Cada stream aberto segue empurrando pacotes pro UserBuffer que o clear()
  // logo abaixo desanexa do Map — vira memória que ninguém mais lê nem libera.
  for (const stream of g.openStreams) stream.destroy();
  g.openStreams.clear();
  g.receiver = null;
  g.speakingHandler = null;
  g.userBuffers.clear();
  g.activeRecordings.clear();
}

// Servidor removeu o bot: libera a memória em vez de manter o Map crescendo.
export function dropGuild(guildId: string) {
  resetBuffering(guildId);
  guilds.delete(guildId);
}

// Alguém deu opt-out agora: descarta o que já estava bufferizado dele.
export function forgetUser(guildId: string, userId: string) {
  const g = guilds.get(guildId);
  if (!g) return;
  g.userBuffers.delete(userId);
  for (const rec of g.activeRecordings.values()) rec.extraPackets.delete(userId);
}

function getUserBuffer(g: GuildBuffer, userId: string): UserBuffer {
  if (!g.userBuffers.has(userId)) {
    g.userBuffers.set(userId, { packets: [], isSubscribed: false });
  }
  return g.userBuffers.get(userId)!;
}

export function getBufferSnapshot(guildId: string, durationSec?: number): Map<string, OpusPacket[]> {
  const g = guilds.get(guildId);
  const requested = durationSec ?? config.defaultClipSeconds;
  // Cap at buffer capacity — can't snapshot more than we kept in memory.
  const effective = Math.min(requested, limits(guildId).bufferSeconds);
  const snapshot = new Map<string, OpusPacket[]>();
  if (!g) return snapshot;

  const cutoff = Date.now() - effective * 1000;
  for (const [userId, buf] of g.userBuffers) {
    const recent = buf.packets.filter((p) => p.timestamp >= cutoff);
    if (recent.length > 0) {
      snapshot.set(userId, recent);
    }
  }
  logger.info(`[BUFFER] ${guildId}: snapshot (${effective}s): ${snapshot.size} users`);
  return snapshot;
}

export function startRecording(guildId: string, triggeredBy: string): string {
  const sessionId = `rec_${Date.now()}`;
  state(guildId).activeRecordings.set(sessionId, {
    triggeredBy,
    startedAt: Date.now(),
    extraPackets: new Map(),
  });
  logger.info(`[BUFFER] ${guildId}: recording started by ${triggeredBy} (${sessionId})`);
  return sessionId;
}

export function stopRecording(guildId: string, sessionId: string): Map<string, OpusPacket[]> | null {
  const g = guilds.get(guildId);
  const recording = g?.activeRecordings.get(sessionId);
  if (!g || !recording) return null;

  g.activeRecordings.delete(sessionId);

  const merged = new Map<string, OpusPacket[]>();

  const windowStart = recording.startedAt - config.startLookbackSeconds * 1000;
  for (const [userId, buf] of g.userBuffers) {
    const bufferPackets = buf.packets.filter(
      (p) => p.timestamp >= windowStart && p.timestamp < recording.startedAt
    );
    if (bufferPackets.length > 0) {
      merged.set(userId, [...bufferPackets]);
    }
  }

  for (const [userId, packets] of recording.extraPackets) {
    const existing = merged.get(userId) || [];
    merged.set(userId, [...existing, ...packets]);
  }

  logger.info(`[BUFFER] ${guildId}: recording stopped (${sessionId}), ${merged.size} users`);
  return merged;
}

export function getActiveRecordings(
  guildId: string
): Map<string, Pick<ActiveRecording, 'triggeredBy' | 'startedAt'>> {
  return guilds.get(guildId)?.activeRecordings ?? new Map();
}

export { OpusPacket };
