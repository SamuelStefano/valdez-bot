import { VoiceConnection, EndBehaviorType, VoiceConnectionStatus } from '@discordjs/voice';
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

const userBuffers = new Map<string, UserBuffer>();

const activeRecordings = new Map<string, {
  triggeredBy: string;
  startedAt: number;
  extraPackets: Map<string, OpusPacket[]>;
}>();

let isBuffering = false;

export function startBuffering(connection: VoiceConnection) {
  if (isBuffering) return;
  isBuffering = true;

  const receiver = connection.receiver;

  // Log when anyone starts speaking
  receiver.speaking.on('start', (userId: string) => {
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
      const cutoff = Date.now() - config.replayBufferSeconds * 1000;
      while (buf.packets.length > 0 && buf.packets[0].timestamp < cutoff) {
        buf.packets.shift();
      }

      // Active recordings
      for (const [, recording] of activeRecordings) {
        if (!recording.extraPackets.has(userId)) {
          recording.extraPackets.set(userId, []);
        }
        recording.extraPackets.get(userId)!.push(packet);
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
  });

  // Re-attach buffer on reconnect
  connection.on('stateChange', (_oldState, newState) => {
    if (newState.status === VoiceConnectionStatus.Ready) {
      logger.info('[BUFFER] Connection ready, buffer active');
    }
  });

  logger.info(`[BUFFER] Replay buffer started — buffering last ${config.replayBufferSeconds}s`);
}

export function resetBuffering() {
  isBuffering = false;
  userBuffers.clear();
}

function getUserBuffer(userId: string): UserBuffer {
  if (!userBuffers.has(userId)) {
    userBuffers.set(userId, { packets: [], isSubscribed: false });
  }
  return userBuffers.get(userId)!;
}

export function getBufferSnapshot(): Map<string, OpusPacket[]> {
  const snapshot = new Map<string, OpusPacket[]>();
  for (const [userId, buf] of userBuffers) {
    if (buf.packets.length > 0) {
      snapshot.set(userId, [...buf.packets]);
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

  for (const [userId, buf] of userBuffers) {
    const bufferPackets = buf.packets.filter(p => p.timestamp <= recording.startedAt);
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

export function getActiveRecordings(): Map<string, { triggeredBy: string; startedAt: number }> {
  return activeRecordings as any;
}

export function clearBuffer() {
  userBuffers.clear();
}

export { OpusPacket };
