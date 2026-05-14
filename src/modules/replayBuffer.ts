import { VoiceConnection, EndBehaviorType } from '@discordjs/voice';
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

// Per-user circular buffers storing raw Opus packets
const userBuffers = new Map<string, UserBuffer>();

// Active recording sessions: userId -> { startedAt, extraPackets }
const activeRecordings = new Map<string, {
  triggeredBy: string;
  startedAt: number;
  extraPackets: Map<string, OpusPacket[]>;
}>();

export function startBuffering(connection: VoiceConnection) {
  const receiver = connection.receiver;

  receiver.speaking.on('start', (userId: string) => {
    if (userBuffers.get(userId)?.isSubscribed) return;

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    const buf = getUserBuffer(userId);
    buf.isSubscribed = true;

    opusStream.on('data', (chunk: Buffer) => {
      const packet: OpusPacket = {
        data: Buffer.from(chunk),
        timestamp: Date.now(),
      };

      // Add to circular buffer
      buf.packets.push(packet);

      // Trim buffer to keep only last N seconds
      const cutoff = Date.now() - config.replayBufferSeconds * 1000;
      while (buf.packets.length > 0 && buf.packets[0].timestamp < cutoff) {
        buf.packets.shift();
      }

      // If there's an active recording, also store in extra packets
      for (const [, recording] of activeRecordings) {
        if (!recording.extraPackets.has(userId)) {
          recording.extraPackets.set(userId, []);
        }
        recording.extraPackets.get(userId)!.push(packet);
      }
    });

    opusStream.on('error', (err) => {
      logger.error(`Opus stream error for user ${userId}:`, err);
      buf.isSubscribed = false;
    });

    opusStream.on('close', () => {
      buf.isSubscribed = false;
    });
  });

  logger.info('Replay buffer active — buffering last 2 minutes');
}

function getUserBuffer(userId: string): UserBuffer {
  if (!userBuffers.has(userId)) {
    userBuffers.set(userId, { packets: [], isSubscribed: false });
  }
  return userBuffers.get(userId)!;
}

/**
 * Get the buffered Opus packets for all users (last N seconds).
 * Returns a map of userId -> OpusPacket[]
 */
export function getBufferSnapshot(): Map<string, OpusPacket[]> {
  const snapshot = new Map<string, OpusPacket[]>();
  for (const [userId, buf] of userBuffers) {
    if (buf.packets.length > 0) {
      snapshot.set(userId, [...buf.packets]);
    }
  }
  return snapshot;
}

/**
 * Start a recording session. Captures the current buffer + continues recording.
 */
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

/**
 * Stop a recording session. Returns buffer snapshot + recorded packets.
 */
export function stopRecording(sessionId: string): Map<string, OpusPacket[]> | null {
  const recording = activeRecordings.get(sessionId);
  if (!recording) return null;

  activeRecordings.delete(sessionId);

  // Merge: buffer snapshot from when recording started + extra packets
  const merged = new Map<string, OpusPacket[]>();

  // Get buffer packets that were before recording started
  for (const [userId, buf] of userBuffers) {
    const bufferPackets = buf.packets.filter(p => p.timestamp <= recording.startedAt);
    if (bufferPackets.length > 0) {
      merged.set(userId, [...bufferPackets]);
    }
  }

  // Add extra packets recorded after start
  for (const [userId, packets] of recording.extraPackets) {
    const existing = merged.get(userId) || [];
    merged.set(userId, [...existing, ...packets]);
  }

  logger.info(`Recording stopped (session: ${sessionId})`);
  return merged;
}

export function getActiveRecordings(): Map<string, { triggeredBy: string; startedAt: number }> {
  return activeRecordings as any;
}

export function clearBuffer() {
  userBuffers.clear();
}

export { OpusPacket };
