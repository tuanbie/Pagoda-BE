import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, type WebSocket } from 'ws';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_MESSAGE_BYTES, type ClientMsg } from '@sontu/shared';
import { config } from './config.ts';
import { metrics, renderMetrics } from './metrics.ts';
import { RoomManager } from './room/RoomManager.ts';
import { MemoryDirectory, type Directory } from './directory/Directory.ts';
import { TokenBucket } from './net/TokenBucket.ts';
import { registerFeedback } from './feedback/feedback.ts';
import { clientIp, isAdmin } from './auth.ts';

const app = Fastify({
  logger: {
    level: config.logLevel,
    // No personal data in logs: Fastify's default request log carries the client IP and port,
    // and query strings can carry tokens. Keep only the method and the path.
    serializers: { req: (req: { method?: string; url?: string }) => ({ method: req.method, url: (req.url ?? '').split('?')[0] }) },
  },
  // trust only the proxy we talk to (1 hop): req.ip is then the last X-Forwarded-For entry,
  // the one our proxy wrote; anything a client put in front of it is ignored
  trustProxy: config.trustProxy ? (_addr: string, hop: number) => hop < 1 : false,
  // slow or stalled HTTP requests are cut off (websockets are unaffected once upgraded)
  requestTimeout: 30_000,
  bodyLimit: 64 * 1024,
});
const rooms = new RoomManager();

let directory: Directory = new MemoryDirectory();
if (config.redisUrl) {
  const { RedisDirectory } = await import('./directory/RedisDirectory.ts');
  directory = new RedisDirectory(config.redisUrl, config.nodeId);
  // host only: a Redis URL usually carries the password
  const redisHost = (() => {
    try {
      return new URL(config.redisUrl).host;
    } catch {
      return 'configured';
    }
  })();
  app.log.info({ redis: redisHost }, 'using redis room directory');
}
const publishDirectory = () =>
  directory.publish(rooms.directory()).catch((err) => app.log.warn({ err }, 'directory publish failed'));
setInterval(publishDirectory, 1000).unref();
await publishDirectory();

// ---------------- HTTP ----------------
if (!config.allowedOrigins.length && (config.onVercel || process.env.NODE_ENV === 'production'))
  app.log.warn('ALLOWED_ORIGINS is empty: any website can open websockets to this server. Set it to the frontend origin(s).');

// baseline security headers on every response
app.addHook('onSend', async (_req, reply) => {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-frame-options', 'DENY');
});

// CORS: the frontend may be served from another origin (e.g. a Vercel domain)
app.addHook('onRequest', async (req, reply) => {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = !config.allowedOrigins.length || config.allowedOrigins.includes(origin);
  if (!allowed) return;
  reply.header('access-control-allow-origin', config.allowedOrigins.length ? origin : '*');
  reply.header('vary', 'origin');
  if (req.method === 'OPTIONS') {
    reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    reply.header('access-control-allow-headers', 'content-type');
    reply.header('access-control-max-age', '86400');
    return reply.code(204).send();
  }
});

registerFeedback(app);

app.get('/api/health', async () => ({ ok: true, node: config.nodeId, players: rooms.playerCount }));

app.get('/api/rooms', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  // own rooms are always fresh; others come from the shared directory
  const local = rooms.directory();
  const others = (await directory.list()).filter((r) => r.node !== config.nodeId);
  return { rooms: [...local, ...others].sort((a, b) => a.num - b.num), node: config.nodeId };
});

app.get('/metrics', async (req, reply) => {
  if (!config.metricsPublic && !isAdmin(req)) return reply.code(403).send();
  reply.type('text/plain');
  return renderMetrics({ players: rooms.playerCount, rooms: rooms.rooms.size });
});

/** Same policy as the frontend's vercel.json: no inline or third-party scripts, no framing. */
const FRONTEND_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self' https: wss:; media-src 'self' blob:; worker-src 'self' blob:; manifest-src 'self'; " +
  "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

if (config.staticDir && existsSync(config.staticDir)) {
  await app.register(fastifyStatic, {
    root: resolve(config.staticDir),
    cacheControl: false,
    setHeaders(res, path) {
      // hashed assets are immutable; html must revalidate
      if (/[\\/]assets[\\/]/.test(path)) res.header('cache-control', 'public, max-age=31536000, immutable');
      else if (path.endsWith('.html')) {
        res.header('cache-control', 'no-cache');
        res.header('content-security-policy', FRONTEND_CSP);
      }
      else res.header('cache-control', 'public, max-age=3600');
    },
  });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api') ? reply.code(404).send() : reply.sendFile('index.html')));
}

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
const connPerIp = new Map<string, number>();

app.server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (!url.pathname.endsWith('/ws') && !url.pathname.startsWith('/api/server')) return socket.destroy();
  const origin = req.headers.origin ?? '';
  if (config.allowedOrigins.length && !config.allowedOrigins.includes(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  const ip = clientIp(req.headers['x-forwarded-for'], req.socket.remoteAddress);
  if ((connPerIp.get(ip) ?? 0) >= config.maxConnPerIp) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip, url.searchParams));
});

function onConnection(ws: WebSocket, ip: string, params: URLSearchParams) {
  metrics.connections++;
  connPerIp.set(ip, (connPerIp.get(ip) ?? 0) + 1);
  const num = (k: string) => {
    const v = params.get(k);
    return v === null || v === '' ? undefined : Number(v);
  };
  const joined = rooms.join(ws, params.get('room'), params.get('token'), params.get('name') ?? '', {
    x: num('x'),
    z: num('z'),
    adj: num('a'),
    noun: num('n'),
    tint: num('c'),
  });
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
// Run directly (`node dist/main.js`) → listen on a port. Imported by a serverless
// wrapper (Vercel `api/server.js`) → just hand over the ready http.Server.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ node: config.nodeId, ws: config.publicWsUrl, cap: config.roomCapacity }, 'Tịnh Tâm Tự node ready');
} else await app.ready();
export const server = app.server;

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
