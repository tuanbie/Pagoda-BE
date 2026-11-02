import { DEFAULT_ROOM_CAPACITY } from '@sontu/shared';

import { randomBytes } from 'node:crypto';

const env = process.env;
/** Vercel may run several instances of the same function: each needs its own id in the directory. */
const onVercel = !!env.VERCEL;
const int = (v: string | undefined, d: number) => (v && !Number.isNaN(+v) ? Math.floor(+v) : d);

export const config = {
  port: int(env.PORT, 8787),
  host: env.HOST ?? '0.0.0.0',
  /** Unique node id when running several instances behind the directory. */
  nodeId: env.NODE_ID ?? (onVercel ? 'v' + randomBytes(3).toString('hex') : 'n1'),
  onVercel,
  /** Room numbers shown to users start here (node 2 -> 101, ...). */
  roomNumberBase: int(env.ROOM_NUMBER_BASE, 0),
  /** URL clients use to reach this node's websocket (path or absolute ws(s)://). */
  publicWsUrl: env.PUBLIC_WS_URL ?? '/ws',
  roomCapacity: int(env.ROOM_CAPACITY, DEFAULT_ROOM_CAPACITY),
  /** Rooms kept warm even when empty. */
  minRooms: int(env.MIN_ROOMS, 2),
  /** Hard cap of rooms per node (protects memory / CPU). */
  maxRooms: int(env.MAX_ROOMS, 50),
  redisUrl: env.REDIS_URL ?? '',
  /** Built frontend to serve (production single-binary mode). */
  staticDir: env.STATIC_DIR ?? '',
  /** Comma-separated list of allowed Origins for websockets; empty = allow all (dev). */
  allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  /** Max simultaneous connections per IP. */
  maxConnPerIp: int(env.MAX_CONN_PER_IP, 20),
  /** Only trust X-Forwarded-For when running behind our own reverse proxy. */
  trustProxy: env.TRUST_PROXY === '1',
  logLevel: env.LOG_LEVEL ?? 'info',
};
