/**
 * End-to-end protocol test. Boots a real node (capacity 3) and drives it with raw websocket clients.
 *   npm run e2e -w backend
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { WebSocket } from 'ws';
import { CHURCH, CHURCH_CANDLES, CHURCH_SEATS, SEATS, pavilion, type RoomInfo, type ServerMsg, type WelcomeMsg } from '@sontu/shared';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const FEEDBACK_FILE = `/tmp/sontu-e2e-feedback-${process.pid}.jsonl`;
const ADMIN_KEY = 'e2e-admin-key';
// seed: one entry past the retention window, one recent entry written by an older version (with personal data)
mkdirSync(dirname(FEEDBACK_FILE), { recursive: true });
writeFileSync(
  FEEDBACK_FILE,
  [
    { at: new Date(Date.now() - 400 * 86_400_000).toISOString(), kind: 'bug', message: 'expired entry', locale: 'vi' },
    { at: new Date(Date.now() - 86_400_000).toISOString(), kind: 'idea', message: 'legacy entry', name: 'Old Name', contact: 'old@example.com', locale: 'vi', ip: '203.0.113.7' },
  ]
    .map((e) => JSON.stringify(e) + '\n')
    .join(''),
);
const server = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
  env: { ...process.env, PORT: String(PORT), ROOM_CAPACITY: '3', MIN_ROOMS: '1', LOG_LEVEL: 'warn', FEEDBACK_FILE, ADMIN_KEY },
  stdio: 'inherit',
});

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, info?: unknown) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? '✔' : '✘'} ${name}${ok || info === undefined ? '' : '  ' + JSON.stringify(info)}`);
}

class Bot {
  ws: WebSocket;
  inbox: ServerMsg[] = [];
  closed: number | null = null;
  hi!: WelcomeMsg;
  constructor(query = '') {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${query}`);
    this.ws.on('message', (d) => this.inbox.push(JSON.parse(d.toString())));
    this.ws.on('close', (code) => (this.closed = code));
  }
  async wait<T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true, ms = 2000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const i = this.inbox.findIndex((m) => m.t === t && pred(m as Extract<ServerMsg, { t: T }>));
      if (i >= 0) return this.inbox.splice(i, 1)[0] as Extract<ServerMsg, { t: T }>;
      await sleep(20);
    }
    return null;
  }
  async ready() {
    this.hi = (await this.wait('hi'))!;
    return this;
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(BASE + '/api/health')).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('server did not start');
}

try {
  await waitForServer();

  const a = await new Bot().ready();
  check('welcome has id, token, room', !!a.hi?.id && !!a.hi.token && a.hi.room.cap === 3);
  const b = await new Bot().ready();
  check('second client lands in same room', b.hi.room.id === a.hi.room.id);
  check('A sees B join in tick', !!(await a.wait('s', (m) => !!m.j?.some((p) => p[0] === b.hi.id))));

  a.send({ t: 'mv', x: 3, z: -4, r: 1.5, p: 2 });
  check('B receives A move', !!(await b.wait('s', (m) => !!m.u?.some((u) => u[0] === a.hi.id && u[1] === 3 && u[4] === 2))));

  a.send({ t: 'mv', x: 999, z: 0, r: 0, p: 0 });
  const clamp = await b.wait('s', (m) => !!m.u?.some((u) => u[0] === a.hi.id));
  check('out-of-world position is clamped', !!clamp && clamp.u!.find((u) => u[0] === a.hi.id)![1] <= 130);

  a.send({ t: 'seat', i: 2 });
  check('seat broadcast to others', !!(await b.wait('seat', (m) => m.i === 2 && m.id === a.hi.id)));
  b.send({ t: 'seat', i: 2 });
  check('occupied seat is refused', !!(await b.wait('seatno', (m) => m.i === 2)));

  // ---- names, chat, asking for a cushion ----
  b.send({ t: 'name', n: '  Minh\u202e  An  ' });
  check('rename is sanitised and broadcast', !!(await a.wait('nm', (m) => m.id === b.hi.id && m.n === 'Minh An')));
  a.send({ t: 'chat', m: 'Nam mô A Di Đà Phật 🙏' });
  check('chat is broadcast to the room', !!(await b.wait('chat', (m) => m.c[0] === a.hi.id && m.c[4].startsWith('Nam mô'))));
  for (let i = 0; i < 6; i++) a.send({ t: 'chat', m: 'spam ' + i });
  await sleep(300);
  check('chat flood is rate limited', b.inbox.filter((m) => m.t === 'chat').length <= 3);
  b.inbox = b.inbox.filter((m) => m.t !== 'chat');

  b.send({ t: 'sreq', i: 2 });
  check('owner receives seat request', !!(await a.wait('sreq', (m) => m.i === 2 && m.from === b.hi.id)));
  a.send({ t: 'sans', ok: false });
  check('declined request is reported', !!(await b.wait('sres', (m) => m.r === 'no')));
  b.send({ t: 'sreq', i: 2 });
  await a.wait('sreq');
  a.send({ t: 'sans', ok: true });
  check('accepted request reports ok', !!(await b.wait('sres', (m) => m.r === 'ok' && m.i === 2)));
  check('seat moves to the asker', !!(await a.wait('seat', (m) => m.i === 2 && m.id === b.hi.id)));
  b.send({ t: 'unseat' });
  a.send({ t: 'seat', i: 2 });
  await b.wait('seat', (m) => m.i === 2 && m.id === a.hi.id);

  // ---- people never spawn on top of each other ----
  {
    const pa = b.hi.players.find((p) => p[0] === a.hi.id)!;
    const pb = b.hi.players.find((p) => p[0] === b.hi.id)!;
    check('new visitors spawn apart (≥ 0.8 m)', Math.hypot(pa[3] - pb[3], pa[4] - pb[4]) >= 0.79, [pa[3], pa[4], pb[3], pb[4]]);
  }

  // ---- game tables (table 0 = xiangqi) ----
  check('welcome carries 6 game tables', a.hi.tables.length === 6 && a.hi.tables[0].g.kind === 'xiangqi');
  a.send({ t: 'tb', a: 'join', i: 0, side: 0 });
  b.send({ t: 'tb', a: 'join', i: 0, side: 1 });
  check('both players seated at the table', !!(await a.wait('tb', (m) => m.s.i === 0 && m.s.p[0] === a.hi.id && m.s.p[1] === b.hi.id)));
  b.send({ t: 'tb', a: 'move', i: 0, m: [19, 46] });
  a.send({ t: 'tb', a: 'move', i: 0, m: [1, 46] });
  a.send({ t: 'tb', a: 'move', i: 0, m: [64, 67] });
  const mv = await b.wait('tb', (m) => m.s.i === 0 && m.s.g.ply > 0);
  check('only the legal move on your turn is accepted', !!mv && mv.s.g.ply === 1 && JSON.stringify(mv.s.g.last) === '[64,67]', mv?.s.g);
  b.send({ t: 'tb', a: 'resign', i: 0 });
  check('resigning ends the game for the other side', !!(await a.wait('tb', (m) => m.s.i === 0 && m.s.g.result?.w === 0 && m.s.g.result.why === 'resign')));
  a.send({ t: 'tb', a: 'reset', i: 0 });
  check('new game after the result', !!(await b.wait('tb', (m) => m.s.i === 0 && m.s.g.ply === 0 && !m.s.g.result)));
  a.send({ t: 'tb', a: 'move', i: 0, m: [64, 67] });
  await b.wait('tb', (m) => m.s.i === 0 && m.s.g.ply === 1);
  b.send({ t: 'tb', a: 'leave', i: 0 });
  check('leaving mid-game forfeits', !!(await a.wait('tb', (m) => m.s.i === 0 && m.s.g.result?.why === 'left' && m.s.g.result.w === 0)));
  a.send({ t: 'tb', a: 'leave', i: 0 });
  await sleep(100);

  // ---- discussion hall channel: only people inside hear it ----
  // (B speaks: A is still rate-limited from the chat-flood test above)
  const talk = pavilion('talk');
  b.send({ t: 'mv', x: talk.x, z: talk.z, r: 0, p: 0 });
  await sleep(150);
  a.inbox = [];
  b.inbox = [];
  b.send({ t: 'chat', m: 'chỉ trong giảng đường', ch: 1 });
  check('speaker gets their discussion-hall message', !!(await b.wait('chat', (m) => m.c[6] === 1)));
  check('people outside the hall do not', !(await a.wait('chat', () => true, 300)));
  b.send({ t: 'mv', x: 3, z: 4, r: 1.5, p: 0 });
  await sleep(150);
  a.inbox = [];
  b.inbox = [];

  check('welcome carries the pond', Array.isArray(a.hi.fish));
  a.send({ t: 'fish' });
  a.send({ t: 'fish' });
  check('released fish is broadcast', !!(await b.wait('fish', (m) => m.id === a.hi.id)));
  await sleep(150);
  check('fish release is rate limited', !b.inbox.some((m) => m.t === 'fish'));

  check('welcome carries DJ state', typeof a.hi.dj?.s === 'number');
  a.send({ t: 'dj', s: 3 });
  check('song request is queued for everyone', !!(await b.wait('dj', (m) => m.d.q.some(([s, by]) => s === 3 && by === a.hi.id))));
  a.send({ t: 'dj', s: 4 });
  await sleep(150);
  check('one queued request per person', !b.inbox.some((m) => m.t === 'dj' && m.d.q.length > 1));

  a.send({ t: 'inc' });
  b.send({ t: 'inc' });
  const inc = await b.wait('inc', (m) => m.c === 0 && m.s.cur === a.hi.id && m.s.q[0] === b.hi.id);
  check('incense queue: A at censer, B waiting', !!inc);
  a.send({ t: 'incx' });
  check('leaving queue promotes next', !!(await b.wait('inc', (m) => m.c === 0 && m.s.cur === b.hi.id)));
  // every hall has its own censer and queue
  check('welcome lists one queue per censer (6)', a.hi.inc.length === 6);
  a.send({ t: 'inc', c: 3 });
  check('a hall censer has its own queue', !!(await b.wait('inc', (m) => m.c === 3 && m.s.cur === a.hi.id)));
  b.send({ t: 'inc', c: 3 });
  check('joining another censer leaves the first queue', !!(await a.wait('inc', (m) => m.c === 0 && m.s.cur === null)));
  a.send({ t: 'incx' });
  b.send({ t: 'incx' });
  await sleep(100);

  b.send({ t: 'ping', c: 123 });
  check('ping/pong', !!(await b.wait('pong', (m) => m.c === 123 && m.s > 0)));

  const c = await new Bot().ready();
  check('third client fills room (3/3)', c.hi.room.id === a.hi.room.id);
  const d = await new Bot().ready();
  check('fourth client auto-overflows to a new room', d.hi.room.id !== a.hi.room.id);
  const e = new Bot(`?room=${a.hi.room.id}`);
  check('explicit join into full room is rejected', !!(await e.wait('full')));

  const rooms = (await (await fetch(BASE + '/api/rooms')).json()) as { rooms: { id: string; count: number }[] };
  check('/api/rooms reports counts', rooms.rooms.find((r) => r.id === a.hi.room.id)?.count === 3, rooms);

  const name = [c.hi.players.find((p) => p[0] === c.hi.id)![1], c.hi.players.find((p) => p[0] === c.hi.id)![2]];
  const token = c.hi.token;
  c.ws.close();
  check('A sees C leave', !!(await a.wait('s', (m) => !!m.l?.includes(c.hi.id))));
  const c2 = await new Bot(`?token=${token}`).ready();
  const me = c2.hi.players.find((p) => p[0] === c2.hi.id)!;
  check('resume token keeps anonymous name', me[1] === name[0] && me[2] === name[1]);

  b.send({ t: 'mv', x: 'nope' });
  await sleep(300);
  check('malformed message disconnects', b.closed === 4003, b.closed);
  a.ws.close();
  check('seat freed when holder leaves', !!(await c2.wait('seat', (m) => m.i === 2 && m.id === null)));

  const cors = await fetch(BASE + '/api/rooms', { headers: { origin: 'https://pagoda.example' } });
  check('CORS header on /api', cors.headers.get('access-control-allow-origin') === '*');
  const h = await new Bot('?x=12.5&z=-3&a=4&n=7&c=2').ready();
  const hp = h.hi.players.find((p) => p[0] === h.hi.id)!;
  check('join hint restores spot + anonymous name', hp[3] === 12.5 && hp[4] === -3 && hp[1] === 4 && hp[2] === 7 && hp[7] === 2, hp);
  const bad = await new Bot('?x=9999&z=0&a=999').ready();
  const bp = bad.hi.players.find((p) => p[0] === bad.hi.id)!;
  check('bad hints are clamped / ignored', bp[3] <= 130 && bp[1] < 12);
  h.ws.close();
  bad.ws.close();

  // ---- the church: its own rooms, layout and seats ----
  const listOf = async (q: string) => ((await (await fetch(BASE + '/api/rooms' + q)).json()) as { rooms: RoomInfo[] }).rooms;
  const templeRooms = await listOf('');
  const churchRooms = await listOf('?place=church');
  check('room list without ?place shows only temple rooms', templeRooms.length > 0 && templeRooms.every((r) => r.place === 'pagoda'), templeRooms);
  check('?place=church lists church rooms', churchRooms.length > 0 && churchRooms.every((r) => r.place === 'church' && /-c\d+$/.test(r.id)), churchRooms);
  const ch = await new Bot('?place=church&name=Ch').ready();
  check('church visitor lands in a church room', /-c\d+$/.test(ch.hi.room.id) && Math.hypot(ch.hi.players.find((p) => p[0] === ch.hi.id)![3] - CHURCH.spawn.x, ch.hi.players.find((p) => p[0] === ch.hi.id)![4] - CHURCH.spawn.z) < 6);
  check('church welcome has one queue per candle stand, no game tables', ch.hi.inc.length === CHURCH_CANDLES.length && ch.hi.tables.length === 0);
  const pew = CHURCH_SEATS.length - 1;
  ch.send({ t: 'seat', i: pew });
  check('a church seat beyond the temple layout can be taken', !!(await ch.wait('seat', (m) => m.i === pew && m.id === ch.hi.id)) && pew !== SEATS.length - 1);
  const stale = await new Bot(`?place=church&room=${encodeURIComponent(a.hi.room.id)}`).ready();
  check('a temple room id is ignored when joining the church', /-c\d+$/.test(stale.hi.room.id));
  ch.send({ t: 'inc', c: 2 });
  check('church candle queue works', !!(await ch.wait('inc', (m) => m.c === 2 && m.s.cur === ch.hi.id)));
  ch.send({ t: 'inc', c: CHURCH_CANDLES.length });
  check('a candle stand index outside the church is ignored', !(await ch.wait('inc', (m) => m.c === CHURCH_CANDLES.length, 400)));
  const templeSeen = await a.wait('s', (m) => !!m.j?.some((p) => p[0] === ch.hi.id), 400);
  check('temple visitors do not see church visitors', !templeSeen);
  ch.ws.close();
  stale.ws.close();
  // leaving the temple and entering the church with the same resume token: name kept, temple spot not
  const tv = await new Bot('?name=Tv').ready();
  tv.send({ t: 'mv', x: 0, z: -62, r: 0, p: 0 });
  await sleep(200);
  const tvMe = tv.hi.players.find((p) => p[0] === tv.hi.id)!;
  tv.ws.close();
  await sleep(200);
  const tc = await new Bot(`?place=church&token=${tv.hi.token}`).ready();
  const tcMe = tc.hi.players.find((p) => p[0] === tc.hi.id)!;
  check(
    'a temple session resumed in the church spawns at the church spawn (name kept)',
    /-c\d+$/.test(tc.hi.room.id) && Math.hypot(tcMe[3] - CHURCH.spawn.x, tcMe[4] - CHURCH.spawn.z) < 6 && tcMe[1] === tvMe[1] && tcMe[2] === tvMe[2],
    [tcMe, CHURCH.spawn],
  );
  tc.ws.close();

  // ---- private feedback ----
  const post = (body: unknown) => fetch(BASE + '/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  check('feedback is accepted', (await post({ kind: 'idea', message: 'Thêm chức năng nghe pháp thoại\nnhé', name: 'Test', contact: 'a@b.c' })).status === 200);
  check('empty feedback is rejected', (await post({ kind: 'bug', message: '  ' })).status === 400);
  const inbox = (await (await fetch(BASE + '/api/feedback')).json()) as { items: Record<string, unknown>[] };
  check('feedback inbox readable from localhost (newlines kept)', inbox.items[0]?.message === 'Thêm chức năng nghe pháp thoại\nnhé' && inbox.items[0].kind === 'idea');
  check('feedback entries hold no personal data', inbox.items.every((e) => Object.keys(e).sort().join() === 'at,kind,locale,message'), inbox.items);
  const raw = readFileSync(FEEDBACK_FILE, 'utf8');
  check('no name, contact or IP is written to disk', !/"(name|contact|ip)"|Old Name|old@example\.com|203\.0\.113\.7|a@b\.c/.test(raw), raw);
  check('legacy entry kept but scrubbed', inbox.items.some((e) => e.message === 'legacy entry'));
  check('entries past the retention window are deleted', !inbox.items.some((e) => e.message === 'expired entry') && !raw.includes('expired entry'));
  const remote = { 'x-forwarded-for': '198.51.100.1' }; // not "local" any more
  check('admin key in the URL is not accepted', (await fetch(`${BASE}/api/feedback?key=${ADMIN_KEY}`, { headers: remote })).status === 403);
  check('admin key as a Bearer header is accepted', (await fetch(BASE + '/api/feedback', { headers: { ...remote, authorization: `Bearer ${ADMIN_KEY}` } })).status === 200);
  const page = await fetch(BASE + '/admin/feedback', { headers: remote });
  check('inbox page asks for a password', page.status === 401 && /^Basic /.test(page.headers.get('www-authenticate') ?? ''));
  const basic = 'Basic ' + Buffer.from(`admin:${ADMIN_KEY}`).toString('base64');
  check('inbox page opens with the key as Basic password', (await fetch(BASE + '/admin/feedback', { headers: { ...remote, authorization: basic } })).status === 200);
  check('a wrong key is refused', (await fetch(BASE + '/api/feedback', { headers: { ...remote, authorization: 'Bearer nope' } })).status === 403);
  const health = await fetch(BASE + '/api/health');
  check('security headers on responses', health.headers.get('x-content-type-options') === 'nosniff' && health.headers.get('x-frame-options') === 'DENY' && health.headers.get('referrer-policy') === 'no-referrer');
  check('inbox page forbids scripts (CSP)', /default-src 'none'/.test((await fetch(BASE + '/admin/feedback', { headers: { ...remote, authorization: basic } })).headers.get('content-security-policy') ?? ''));
  check('/metrics is private from outside', (await fetch(BASE + '/metrics', { headers: remote })).status === 403);
  check('/metrics opens with the admin key', (await fetch(BASE + '/metrics', { headers: { ...remote, authorization: `Bearer ${ADMIN_KEY}` } })).status === 200);
  for (let i = 0; i < 5; i++) await post({ kind: 'other', message: 'spam ' + i });
  check('feedback is rate limited per IP', (await post({ kind: 'other', message: 'one more' })).status === 429);

  const metrics = await (await fetch(BASE + '/metrics')).text();
  check('/metrics exposes prometheus counters', metrics.includes('sontu_players'));
  for (const bot of [c2, d]) bot.ws.close();
} catch (err) {
  console.error(err);
  failed++;
} finally {
  server.kill('SIGTERM');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
