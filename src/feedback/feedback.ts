import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FEEDBACK_MAX, type FeedbackInput } from '@sontu/shared';

/**
 * Private feedback for the developer: visitors post what should be improved.
 *
 * No personal data is kept. An entry holds only the kind, the message, the UI
 * language and the time: no name, contact or IP address is stored or logged.
 * Entries older than RETENTION_DAYS are deleted. Entries written by older
 * versions (which also stored name, contact and IP) are scrubbed in place.
 *
 * Reading is only allowed from the machine itself (localhost) or with ADMIN_KEY
 * in the Authorization header (Bearer, or Basic with the key as password),
 * never in the URL, so the key does not end up in access logs or browser history.
 */
const FILE = process.env.FEEDBACK_FILE ?? 'data/feedback.jsonl';
const REDIS_KEY = 'sontu:feedback';
const KEEP = 5000;
export const RETENTION_DAYS = 365;
const RETENTION_MS = RETENTION_DAYS * 86_400_000;

interface Entry {
  at: string;
  kind: FeedbackInput['kind'];
  message: string;
  locale: string;
}
/** keep only the non-personal fields (drops name / contact / ip from old entries) */
const toEntry = (o: Record<string, unknown>): Entry => ({
  at: String(o.at ?? ''),
  kind: (['bug', 'idea', 'other'] as const).includes(o.kind as never) ? (o.kind as Entry['kind']) : 'other',
  message: String(o.message ?? ''),
  locale: String(o.locale ?? ''),
});
const hasPersonal = (o: Record<string, unknown>) => 'name' in o || 'contact' in o || 'ip' in o;
const expired = (e: Entry, now: number) => !(Date.parse(e.at) > now - RETENTION_MS);
// serverless hosts (Vercel) have no durable disk → use Redis when it is configured
let redis: import('ioredis').Redis | null = null;
async function store() {
  if (!process.env.REDIS_URL || process.env.FEEDBACK_FILE) return null;
  if (!redis) {
    const { Redis } = await import('ioredis');
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
    redis.on('error', () => {});
  }
  return redis;
}
const ADMIN_KEY = process.env.ADMIN_KEY ?? '';
const WINDOW_MS = 10 * 60_000;
const PER_WINDOW = 5;
/** rate limit, keyed by a salted hash of the IP; memory only, the salt changes on every start */
const recent = new Map<string, number[]>();
const SALT = randomBytes(16);
const ipKey = (ip: string) => createHash('sha256').update(SALT).update(ip).digest('base64url');

/** keep newlines, drop other control / bidi characters, cap by code points */
function clean(s: unknown, max: number, multiline = false): string {
  if (typeof s !== 'string') return '';
  const re = multiline ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g : /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
  const out = s.replace(re, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return Array.from(out).slice(0, max).join('');
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** ADMIN_KEY from `Authorization: Bearer <key>` or `Basic base64(<any user>:<key>)` */
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

function canRead(req: FastifyRequest) {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') && !req.headers['x-forwarded-for'];
  const key = keyFrom(req);
  return local || (!!ADMIN_KEY && !!key && sameKey(key, ADMIN_KEY));
}

const parse = (l: string): Record<string, unknown> | null => {
  try {
    const o = JSON.parse(l) as unknown;
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * Delete expired entries and strip personal fields left by older versions.
 * Redis keeps the newest entry at the head, the JSONL file at the end.
 */
let scrubbed = false;
async function prune(now = Date.now()) {
  const r = await store();
  if (r) {
    // oldest entries sit at the tail
    for (let i = 0; i < KEEP; i++) {
      const last = await r.lindex(REDIS_KEY, -1);
      const o = last === null ? null : parse(last);
      if (last === null || (o && !expired(toEntry(o), now))) break;
      await r.rpop(REDIS_KEY);
    }
    if (!scrubbed) {
      const all = await r.lrange(REDIS_KEY, 0, KEEP - 1);
      for (let i = 0; i < all.length; i++) {
        const o = parse(all[i]);
        if (o && hasPersonal(o)) await r.lset(REDIS_KEY, i, JSON.stringify(toEntry(o)));
      }
      scrubbed = true;
    }
    return;
  }
  let text: string;
  try {
    text = await readFile(FILE, 'utf8');
  } catch {
    return;
  }
  const lines = text.split('\n').filter(Boolean);
  const keep = lines
    .map(parse)
    .filter((o): o is Record<string, unknown> => !!o && !expired(toEntry(o), now))
    .map((o) => JSON.stringify(toEntry(o)));
  if (keep.length !== lines.length || keep.some((l, i) => l !== lines[i])) await writeFile(FILE, keep.map((l) => l + '\n').join(''), 'utf8');
}

async function readAll(): Promise<Entry[]> {
  await prune();
  const r = await store();
  const raw = r
    ? await r.lrange(REDIS_KEY, 0, 999)
    : await readFile(FILE, 'utf8')
        .then((t) => t.split('\n').filter(Boolean).reverse())
        .catch(() => [] as string[]);
  return raw
    .map(parse)
    .filter((o): o is Record<string, unknown> => !!o)
    .map(toEntry);
}

export function registerFeedback(app: FastifyInstance) {
  app.post('/api/feedback', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const who = ipKey(req.ip);
    const now = Date.now();
    const times = (recent.get(who) ?? []).filter((t) => now - t < WINDOW_MS);
    if (times.length >= PER_WINDOW) return reply.code(429).send({ ok: false, error: 'slow down' });
    const b = (req.body ?? {}) as Partial<FeedbackInput>;
    const message = clean(b.message, FEEDBACK_MAX, true);
    if (message.length < 3) return reply.code(400).send({ ok: false, error: 'message required' });
    // only these four fields are ever stored; anything else in the body (name, contact…) is ignored
    const entry: Entry = toEntry({ at: new Date(now).toISOString(), kind: b.kind, message, locale: clean(b.locale, 8) });
    times.push(now);
    recent.set(who, times);
    if (recent.size > 10_000) for (const [k, v] of recent) if (now - v[v.length - 1] >= WINDOW_MS) recent.delete(k);
    const r = await store();
    if (r) await r.multi().lpush(REDIS_KEY, JSON.stringify(entry)).ltrim(REDIS_KEY, 0, KEEP - 1).exec();
    else {
      await mkdir(dirname(FILE), { recursive: true });
      await appendFile(FILE, JSON.stringify(entry) + '\n', 'utf8');
    }
    await prune(now);
    req.log.info({ kind: entry.kind }, 'feedback received');
    return { ok: true };
  });

  app.get('/api/feedback', async (req, reply) => {
    if (!canRead(req)) return reply.code(403).send({ ok: false });
    return { ok: true, items: await readAll() };
  });

  // tiny read-only inbox page: http://localhost:8787/admin/feedback
  // elsewhere the browser asks for a password: enter ADMIN_KEY (any user name)
  app.get('/admin/feedback', async (req, reply) => {
    if (!canRead(req)) return reply.code(401).header('www-authenticate', 'Basic realm="feedback", charset="UTF-8"').type('text/plain').send('unauthorized');
    const items = await readAll();
    const label = { bug: 'Lỗi', idea: 'Đề xuất', other: 'Khác' } as Record<string, string>;
    const rows = items
      .map(
        (f) => `<article><header><b>${esc(label[f.kind] ?? f.kind)}</b> · ${esc(new Date(f.at).toLocaleString('vi-VN'))}${f.locale ? ` · ${esc(f.locale)}` : ''}</header><p>${esc(f.message).replace(/\n/g, '<br>')}</p></article>`,
      )
      .join('');
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Góp ý · Tịnh Tâm Tự</title>
<style>body{font-family:system-ui,sans-serif;background:#1f231d;color:#f5f1e6;margin:0;padding:24px 16px}main{max-width:760px;margin:auto}h1{font-weight:600}article{background:#2a2f27;border:1px solid #3b4136;border-radius:14px;padding:12px 16px;margin:10px 0}header{color:#d9b26a;font-size:13px}p{margin:8px 0 0;line-height:1.6}a{color:#9ed8ff}.empty{color:#a9a593}</style></head>
<body><main><h1>Góp ý từ người dùng (${items.length})</h1>${rows || '<p class="empty">Chưa có góp ý nào.</p>'}</main></body></html>`;
  });
}
