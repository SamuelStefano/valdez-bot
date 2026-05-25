import { VoiceConnection, EndBehaviorType, VoiceReceiver } from '@discordjs/voice';
import { config } from '../config';
import { logger } from '../utils/logger';

interface OpusPacket {
  data: Buffer;
  timestamp: number;
}

interface UserBuffer {
  packets: OpusPacket[];
  isSubscribed: boolean;
}

interface ActiveRecording {
  triggeredBy: string;
  startedAt: number;
  extraPackets: Map<string, OpusPacket[]>;
}

const userBuffers = new Map<string, UserBuffer>();
const activeRecordings = new Map<string, ActiveRecording>();

let isBuffering = false;
let trimInterval: NodeJS.Timeout | null = null;
let activeReceiver: VoiceReceiver | null = null;
let speakingHandler: ((userId: string) => void) | null = null;

function windowMs() {
  return config.replayBufferSeconds * 1000;
}

function trimUser(buf: UserBuffer, cutoff: number) {
  while (buf.packets.length > 0 && buf.packets[0].timestamp < cutoff) {
    buf.packets.shift();
  }
}

function trimExtra(packets: OpusPacket[], cutoff: number) {
  while (packets.length > 0 && packets[0].timestamp < cutoff) {
    packets.shift();
  }
}

export function startBuffering(connection: VoiceConnection) {
  // Idempotent: a reconnect creates a NEW receiver, so always tear down the old
  // attachment before re-attaching — otherwise the new connection is never read.
  if (isBuffering) resetBuffering();
  isBuffering = true;

  // Evict packets that fell out of the window even while a user is silent.
  // Without this, someone who spoke then went quiet keeps stale packets forever.
  trimInterval = setInterval(() => {
    const now = Date.now();
    for (const buf of userBuffers.values()) trimUser(buf, now - windowMs());
    const recCutoff = now - config.maxRecordingSeconds * 1000;
    for (const rec of activeRecordings.values()) {
      for (const packets of rec.extraPackets.values()) trimExtra(packets, recCutoff);
    }
  }, 5_000);

  const receiver = connection.receiver;
  activeReceiver = receiver;

  // Log when anyone starts speaking
  speakingHandler = (userId: string) => {
    logger.info(`[BUFFER] User ${userId} started speaking`);

    if (userBuffers.get(userId)?.isSubscribed) return;

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    const buf = getUserBuffer(userId);
    buf.isSubscribed = true;
    let packetCount = 0;

    opusStream.on('data', (chunk: Buffer) => {
      packetCount++;
      if (packetCount === 1) {
        logger.info(`[BUFFER] First packet from ${userId}, size: ${chunk.length} bytes`);
      }

      const packet: OpusPacket = {
        data: Buffer.from(chunk),
        timestamp: Date.now(),
      };

      buf.packets.push(packet);

      // Trim buffer to keep only last N seconds
      trimUser(buf, Date.now() - windowMs());

      // Active recordings — capped at maxRecordingSeconds so a forgotten
      // /replay start can't grow the buffer until the container OOMs.
      const recCutoff = Date.now() - config.maxRecordingSeconds * 1000;
      for (const recording of activeRecordings.values()) {
        if (!recording.extraPackets.has(userId)) {
          recording.extraPackets.set(userId, []);
        }
        const extra = recording.extraPackets.get(userId)!;
        extra.push(packet);
        trimExtra(extra, recCutoff);
      }
    });

    opusStream.on('error', (err) => {
      logger.error(`[BUFFER] Stream error for ${userId}:`, err);
      buf.isSubscribed = false;
    });

    opusStream.on('close', () => {
      logger.info(`[BUFFER] Stream closed for ${userId}`);
      buf.isSubscribed = false;
    });
  };

  receiver.speaking.on('start', speakingHandler);

  logger.info(`[BUFFER] Replay buffer started — buffering last ${config.replayBufferSeconds}s`);
}

export function resetBuffering() {
  isBuffering = false;
  if (trimInterval) {
    clearInterval(trimInterval);
    trimInterval = null;
  }
  if (activeReceiver && speakingHandler) {
    activeReceiver.speaking.off('start', speakingHandler);
  }
  activeReceiver = null;
  speakingHandler = null;
  userBuffers.clear();
  activeRecordings.clear();
}

function getUserBuffer(userId: string): UserBuffer {
  if (!userBuffers.has(userId)) {
    userBuffers.set(userId, { packets: [], isSubscribed: false });
  }
  return userBuffers.get(userId)!;
}

export function getBufferSnapshot(): Map<string, OpusPacket[]> {
  const cutoff = Date.now() - windowMs();
  const snapshot = new Map<string, OpusPacket[]>();
  for (const [userId, buf] of userBuffers) {
    const recent = buf.packets.filter(p => p.timestamp >= cutoff);
    if (recent.length > 0) {
      snapshot.set(userId, recent);
    }
  }
  logger.info(`[BUFFER] Snapshot: ${snapshot.size} users, ${Array.from(snapshot.values()).reduce((sum, p) => sum + p.length, 0)} packets`);
  return snapshot;
}

export function startRecording(triggeredBy: string): string {
  const sessionId = `rec_${Date.now()}`;
  activeRecordings.set(sessionId, {
    triggeredBy,
    startedAt: Date.now(),
    extraPackets: new Map(),
  });
  logger.info(`Recording started by ${triggeredBy} (session: ${sessionId})`);
  return sessionId;
}

export function stopRecording(sessionId: string): Map<string, OpusPacket[]> | null {
  const recording = activeRecordings.get(sessionId);
  if (!recording) return null;

  activeRecordings.delete(sessionId);

  const merged = new Map<string, OpusPacket[]>();

  const windowStart = recording.startedAt - windowMs();
  for (const [userId, buf] of userBuffers) {
    const bufferPackets = buf.packets.filter(
      p => p.timestamp >= windowStart && p.timestamp < recording.startedAt
    );
    if (bufferPackets.length > 0) {
      merged.set(userId, [...bufferPackets]);
    }
  }

  for (const [userId, packets] of recording.extraPackets) {
    const existing = merged.get(userId) || [];
    merged.set(userId, [...existing, ...packets]);
  }

  logger.info(`Recording stopped (session: ${sessionId}), ${merged.size} users captured`);
  return merged;
}

export function getActiveRecordings(): Map<string, Pick<ActiveRecording, 'triggeredBy' | 'startedAt'>> {
  return activeRecordings;
}

export { OpusPacket };
