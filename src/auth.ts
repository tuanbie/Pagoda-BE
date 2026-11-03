import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';

/**
 * Who may read private endpoints (feedback inbox, /metrics):
 * - the machine itself (direct localhost connection, not through a proxy), except on Vercel,
 *   where every request reaches the function through Vercel's own proxy;
 * - anyone presenting ADMIN_KEY in the Authorization header: `Bearer <key>` or
 *   `Basic base64(<any user>:<key>)`. Never in the URL, where it would land in logs and history.
 */
const ADMIN_KEY = process.env.ADMIN_KEY ?? '';

function keyFrom(req: FastifyRequest): string {
  const h = req.headers.authorization ?? '';
  if (/^bearer /i.test(h)) return h.slice(7).trim();
  if (/^basic /i.test(h)) {
    const raw = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
    return raw.slice(raw.indexOf(':') + 1);
  }
  return '';
}

const sameKey = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function isAdmin(req: FastifyRequest): boolean {
  const local =
    !config.onVercel &&
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') &&
    !req.headers['x-forwarded-for'];
  const key = keyFrom(req);
  return local || (!!ADMIN_KEY && !!key && sameKey(key, ADMIN_KEY));
}

/**
 * Client IP for per-IP limits. Behind a trusted proxy we take the LAST X-Forwarded-For entry:
 * that is the address our own proxy saw. Earlier entries come from the client and can be forged.
 * (Vercel overwrites the header with the real client address, so last = first there.)
 */
export function clientIp(xff: string | string[] | undefined, socketAddr: string | undefined): string {
  const h = Array.isArray(xff) ? xff.join(',') : xff;
  const last = config.trustProxy && h ? h.split(',').at(-1)?.trim() : '';
  return last || socketAddr || '?';
}
