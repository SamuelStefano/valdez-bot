import http from 'http';
import { Client } from 'discord.js';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { listConnections } from '../modules/voiceManager';
import { logger } from './logger';

const LIVE_VOICE = new Set<VoiceConnectionStatus>([
  VoiceConnectionStatus.Ready,
  VoiceConnectionStatus.Signalling,
  VoiceConnectionStatus.Connecting,
]);

export function startHealthServer(client: Client, port = Number(process.env.HEALTH_PORT) || 3000) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404);
      res.end();
      return;
    }

    const gatewayReady = client.isReady();
    const connections = listConnections();
    const voices = connections.map(([guildId, conn]) => ({
      guildId,
      status: conn.state.status,
      live: LIVE_VOICE.has(conn.state.status),
      // É o keepalive UDP que diz se a conexão está viva quando ninguém fala —
      // sem ele no /health não dá pra separar sala calada de receiver morto.
      udpPing: conn.ping.udp ?? null,
    }));

    const body = JSON.stringify({
      ok: gatewayReady,
      gatewayReady,
      ping: Number.isFinite(client.ws.ping) ? client.ws.ping : null,
      guilds: client.guilds.cache.size,
      voices,
      voiceLive: voices.some((v) => v.live),
      uptime: process.uptime(),
    });

    res.writeHead(gatewayReady ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(body);
  });

  server.on('error', (err) => logger.error(`[HEALTH] server error: ${err.message}`));
  server.listen(port, () => logger.info(`[HEALTH] listening on :${port}/health`));
  return server;
}

// Outbound dead-man's-switch: ping an external monitor (e.g. Healthchecks.io)
// every 60s while the gateway is up. If pings stop (bot down OR whole VPS down),
// the monitor alerts you — the only signal that survives the host dying.
export function startHeartbeat(client: Client) {
  const url = process.env.HEALTHCHECK_PING_URL;
  if (!url) {
    logger.info('[HEALTH] HEALTHCHECK_PING_URL unset — external heartbeat disabled');
    return;
  }
  setInterval(async () => {
    if (!client.isReady()) return;
    try {
      await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (err: any) {
      logger.warn(`[HEALTH] heartbeat ping failed: ${err?.message}`);
    }
  }, 60_000);
  logger.info('[HEALTH] external heartbeat enabled (60s)');
}
