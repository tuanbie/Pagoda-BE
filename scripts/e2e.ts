/**
 * End-to-end protocol test. Boots a real node (capacity 3) and drives it with raw websocket clients.
 *   npm run e2e -w backend
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import type { ServerMsg, WelcomeMsg } from '@sontu/shared';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
  env: { ...process.env, PORT: String(PORT), ROOM_CAPACITY: '3', MIN_ROOMS: '1', LOG_LEVEL: 'warn' },
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
  check('out-of-world position is clamped', !!clamp && clamp.u!.find((u) => u[0] === a.hi.id)![1] <= 66);

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

  check('welcome carries DJ state', typeof a.hi.dj?.s === 'number');
  a.send({ t: 'dj', s: 3 });
  check('song request is queued for everyone', !!(await b.wait('dj', (m) => m.d.q.some(([s, by]) => s === 3 && by === a.hi.id))));
  a.send({ t: 'dj', s: 4 });
  await sleep(150);
  check('one queued request per person', !b.inbox.some((m) => m.t === 'dj' && m.d.q.length > 1));

  a.send({ t: 'inc' });
  b.send({ t: 'inc' });
  const inc = await b.wait('inc', (m) => m.s.cur === a.hi.id && m.s.q[0] === b.hi.id);
  check('incense queue: A at censer, B waiting', !!inc);
  a.send({ t: 'incx' });
  check('leaving queue promotes next', !!(await b.wait('inc', (m) => m.s.cur === b.hi.id)));

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
