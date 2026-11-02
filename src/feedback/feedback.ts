import type { FastifyInstance, FastifyRequest } from 'fastify';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FEEDBACK_MAX, type FeedbackInput } from '@sontu/shared';

/**
 * Private feedback for the developer: visitors post what should be improved,
 * entries are appended to a JSONL file. Reading them is only allowed from the
 * machine itself (localhost) or with ADMIN_KEY.
 */
const FILE = process.env.FEEDBACK_FILE ?? 'data/feedback.jsonl';
const REDIS_KEY = 'sontu:feedback';
const KEEP = 5000;
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
const recent = new Map<string, number[]>();

/** keep newlines, drop other control / bidi characters, cap by code points */
function clean(s: unknown, max: number, multiline = false): string {
  if (typeof s !== 'string') return '';
  const re = multiline ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g : /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
  const out = s.replace(re, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return Array.from(out).slice(0, max).join('');
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function canRead(req: FastifyRequest) {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') && !req.headers['x-forwarded-for'];
  const key = (req.query as { key?: string }).key;
  return local || (!!ADMIN_KEY && key === ADMIN_KEY);
}

async function readAll() {
  const r = await store();
  if (r) return (await r.lrange(REDIS_KEY, 0, 999)).map((l) => JSON.parse(l) as FeedbackInput & { at: string; ip: string });
  try {
    return (await readFile(FILE, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as FeedbackInput & { at: string; ip: string })
      .reverse();
  } catch {
    return [];
  }
}

export function registerFeedback(app: FastifyInstance) {
  app.post('/api/feedback', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const ip = req.ip;
    const now = Date.now();
    const times = (recent.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (times.length >= PER_WINDOW) return reply.code(429).send({ ok: false, error: 'slow down' });
    const b = (req.body ?? {}) as Partial<FeedbackInput>;
    const message = clean(b.message, FEEDBACK_MAX, true);
    if (message.length < 3) return reply.code(400).send({ ok: false, error: 'message required' });
    const entry = {
      at: new Date(now).toISOString(),
      kind: (['bug', 'idea', 'other'] as const).includes(b.kind as never) ? b.kind : 'other',
      message,
      name: clean(b.name, 60),
      contact: clean(b.contact, 120),
      locale: clean(b.locale, 8),
      ip,
    };
    times.push(now);
    recent.set(ip, times);
    const r = await store();
    if (r) await r.multi().lpush(REDIS_KEY, JSON.stringify(entry)).ltrim(REDIS_KEY, 0, KEEP - 1).exec();
    else {
      await mkdir(dirname(FILE), { recursive: true });
      await appendFile(FILE, JSON.stringify(entry) + '\n', 'utf8');
    }
    req.log.info({ kind: entry.kind }, 'feedback received');
    return { ok: true };
  });

  app.get('/api/feedback', async (req, reply) => {
    if (!canRead(req)) return reply.code(403).send({ ok: false });
    return { ok: true, items: await readAll() };
  });

  // tiny read-only inbox page: http://localhost:8787/admin/feedback
  app.get('/admin/feedback', async (req, reply) => {
    if (!canRead(req)) return reply.code(403).type('text/plain').send('forbidden');
    const items = await readAll();
    const label = { bug: 'Lỗi', idea: 'Đề xuất', other: 'Khác' } as Record<string, string>;
    const rows = items
      .map(
        (f) => `<article><header><b>${esc(label[f.kind] ?? f.kind)}</b> · ${esc(new Date(f.at).toLocaleString('vi-VN'))}${f.name ? ` · ${esc(f.name)}` : ''}${f.contact ? ` · <a href="${/^\S+@\S+$/.test(f.contact) ? 'mailto:' : '#'}${esc(f.contact)}">${esc(f.contact)}</a>` : ''}${f.locale ? ` · ${esc(f.locale)}` : ''}</header><p>${esc(f.message).replace(/\n/g, '<br>')}</p></article>`,
      )
      .join('');
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Góp ý · Tịnh Tâm Tự</title>
<style>body{font-family:system-ui,sans-serif;background:#1f231d;color:#f5f1e6;margin:0;padding:24px 16px}main{max-width:760px;margin:auto}h1{font-weight:600}article{background:#2a2f27;border:1px solid #3b4136;border-radius:14px;padding:12px 16px;margin:10px 0}header{color:#d9b26a;font-size:13px}p{margin:8px 0 0;line-height:1.6}a{color:#9ed8ff}.empty{color:#a9a593}</style></head>
<body><main><h1>Góp ý từ người dùng (${items.length})</h1>${rows || '<p class="empty">Chưa có góp ý nào.</p>'}</main></body></html>`;
  });
}
