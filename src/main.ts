import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, type WebSocket } from 'ws';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAX_MESSAGE_BYTES, type ClientMsg } from '@sontu/shared';
import { config } from './config.ts';
import { metrics, renderMetrics } from './metrics.ts';
import { RoomManager } from './room/RoomManager.ts';
import { MemoryDirectory, type Directory } from './directory/Directory.ts';
import { TokenBucket } from './net/TokenBucket.ts';

const app = Fastify({ logger: { level: config.logLevel }, trustProxy: config.trustProxy });
const rooms = new RoomManager();

let directory: Directory = new MemoryDirectory();
if (config.redisUrl) {
  const { RedisDirectory } = await import('./directory/RedisDirectory.ts');
  directory = new RedisDirectory(config.redisUrl, config.nodeId);
  app.log.info({ redis: config.redisUrl }, 'using redis room directory');
}
const publishDirectory = () =>
  directory.publish(rooms.directory()).catch((err) => app.log.warn({ err }, 'directory publish failed'));
setInterval(publishDirectory, 1000).unref();
await publishDirectory();

// ---------------- HTTP ----------------
app.get('/api/health', async () => ({ ok: true, node: config.nodeId, players: rooms.playerCount }));

app.get('/api/rooms', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  // own rooms are always fresh; others come from the shared directory
  const local = rooms.directory();
  const others = (await directory.list()).filter((r) => r.node !== config.nodeId);
  return { rooms: [...local, ...others].sort((a, b) => a.num - b.num), node: config.nodeId };
});

app.get('/metrics', async (_req, reply) => {
  reply.type('text/plain');
  return renderMetrics({ players: rooms.playerCount, rooms: rooms.rooms.size });
});

if (config.staticDir && existsSync(config.staticDir)) {
  await app.register(fastifyStatic, {
    root: resolve(config.staticDir),
    cacheControl: false,
    setHeaders(res, path) {
      // hashed assets are immutable; html must revalidate
      if (/[\\/]assets[\\/]/.test(path)) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      else if (path.endsWith('.html')) res.setHeader('cache-control', 'no-cache');
      else res.setHeader('cache-control', 'public, max-age=3600');
    },
  });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api') ? reply.code(404).send() : reply.sendFile('index.html')));
}

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
const connPerIp = new Map<string, number>();

app.server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (!url.pathname.endsWith('/ws')) return socket.destroy();
  const origin = req.headers.origin ?? '';
  if (config.allowedOrigins.length && !config.allowedOrigins.includes(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  const fwd = config.trustProxy ? (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() : undefined;
  const ip = fwd || req.socket.remoteAddress || '?';
  if ((connPerIp.get(ip) ?? 0) >= config.maxConnPerIp) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip, url.searchParams));
});

function onConnection(ws: WebSocket, ip: string, params: URLSearchParams) {
  metrics.connections++;
  connPerIp.set(ip, (connPerIp.get(ip) ?? 0) + 1);
  const joined = rooms.join(ws, params.get('room'), params.get('token'), params.get('name') ?? '');
  const release = () => {
    metrics.connections--;
    const n = (connPerIp.get(ip) ?? 1) - 1;
    if (n <= 0) connPerIp.delete(ip);
    else connPerIp.set(ip, n);
  };
  if (!joined.ok) {
    ws.send(JSON.stringify({ t: 'full', room: joined.room }));
    ws.close(4001, 'room full');
    ws.on('close', release);
    return;
  }
  const { room, player } = joined;
  const bucket = new TokenBucket(30, 60); // 30 msg/s sustained, bursts of 60
  let strikes = 0;
  let alive = true;

  ws.on('message', (raw, isBinary) => {
    metrics.messagesIn++;
    if (isBinary || !bucket.take()) {
      metrics.dropped++;
      if (++strikes > 200) {
        metrics.kicked++;
        ws.close(4008, 'rate limit');
      }
      return;
    }
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return void ws.close(4002, 'bad json');
    }
    if (!msg || typeof msg !== 'object' || !rooms.handle(room, player, msg)) {
      metrics.kicked++;
      ws.close(4003, 'bad message');
    }
  });
  ws.on('pong', () => (alive = true));
  const heartbeat = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 20_000);
  ws.on('close', () => {
    clearInterval(heartbeat);
    rooms.leave(room, player);
    release();
  });
  ws.on('error', () => ws.terminate());
}

rooms.start();
await app.listen({ port: config.port, host: config.host });
app.log.info({ node: config.nodeId, ws: config.publicWsUrl, cap: config.roomCapacity }, 'Sơn Tự node ready');

// ---------------- graceful shutdown ----------------
let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  rooms.shutdown('restart');
  rooms.stop();
  await directory.close();
  wss.close();
  await app.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
