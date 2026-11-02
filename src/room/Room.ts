import {
  CHAT_HISTORY,
  INCENSE_BURN_MS,
  INCENSE_OFFER_MS,
  INCENSE_SLOTS,
  INCENSE_WALK_MS,
  SEATS,
  SEAT_REQUEST_MS,
  SONGS,
  DJ_QUEUE_MAX,
  songDurationMs,
  type DjState,
  type ChatTuple,
  type IncenseState,
  type MoveTuple,
  type PlayerTuple,
  type Pose,
  type SeatAnswer,
  type ServerMsg,
  type StickTuple,
  type WelcomeMsg,
  PROTOCOL_VERSION,
} from '@sontu/shared';

/** Minimal transport surface so rooms are testable without real sockets. */
export interface Conn {
  send(data: string): void;
  close(code: number, reason: string): void;
  readonly bufferedAmount: number;
}

export interface Player {
  id: number;
  token: string;
  conn: Conn;
  name: string;
  adj: number;
  noun: number;
  tint: number;
  x: number;
  z: number;
  r: number;
  p: Pose;
  dirty: boolean;
  seat: number;
  /** set when a tick was dropped for backpressure -> next send is a full snapshot */
  needsFull: boolean;
  /** timestamps for cheap per-feature rate limits */
  lastName: number;
  lastRing: number;
  chatTokens: number;
  chatAt: number;
}

interface SeatRequest {
  from: number;
  owner: number;
  seat: number;
  until: number;
}

/** Above this many queued bytes we skip ticks for a slow client instead of buffering forever. */
const BACKPRESSURE_BYTES = 256 * 1024;

export class Room {
  readonly players = new Map<number, Player>();
  readonly seats: (number | null)[] = SEATS.map(() => null);
  private joins: PlayerTuple[] = [];
  private leaves: number[] = [];
  private incQueue: number[] = [];
  private incCur: number | null = null;
  private incPhase: 0 | 1 = 0;
  private incUntil = 0;
  private sticks = new Map<number, number>();
  private chatLog: ChatTuple[] = [];
  /** keyed by seat owner — an owner answers one request at a time */
  private requests = new Map<number, SeatRequest>();
  emptySince = Date.now();
  private dj: DjState = { s: 0, at: Date.now(), q: [] };

  constructor(
    readonly id: string,
    readonly num: number,
    readonly cap: number,
  ) {}

  get count() {
    return this.players.size;
  }
  get full() {
    return this.players.size >= this.cap;
  }

  add(p: Player, now: number) {
    this.players.set(p.id, p);
    this.joins.push(this.tuple(p));
    const welcome: WelcomeMsg = {
      t: 'hi',
      v: PROTOCOL_VERSION,
      id: p.id,
      token: p.token,
      room: { id: this.id, num: this.num, cap: this.cap },
      now,
      players: [...this.players.values()].map((q) => this.tuple(q)),
      seats: this.seats.flatMap((id, i) => (id === null ? [] : [[i, id] as [number, number]])),
      inc: this.incState(),
      sticks: this.liveSticks(now),
      chat: this.chatLog,
      dj: this.dj,
    };
    p.conn.send(JSON.stringify(welcome));
  }

  remove(id: number, now: number) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.dropRequestsOf(id);
    if (this.dj.q.some(([, by]) => by === id)) {
      this.dj.q = this.dj.q.filter(([, by]) => by !== id);
      this.broadcast({ t: 'dj', d: this.dj });
    }
    this.freeSeat(p);
    this.incLeave(id, now);
    this.joins = this.joins.filter((j) => j[0] !== id);
    this.leaves.push(id);
    if (this.players.size === 0) this.emptySince = now;
  }

  move(p: Player, x: number, z: number, r: number, pose: Pose) {
    if (p.x === x && p.z === z && p.r === r && p.p === pose) return;
    p.x = x;
    p.z = z;
    p.r = r;
    p.p = pose;
    p.dirty = true;
  }

  // ---------- identity & chat ----------
  rename(p: Player, name: string, now: number) {
    if (now - p.lastName < 3000 || name === p.name) return;
    p.lastName = now;
    p.name = name;
    this.broadcast({ t: 'nm', id: p.id, n: name });
  }

  /** Token bucket: bursts of 3 messages, then one every 1.5 s. */
  chat(p: Player, text: string, now: number) {
    p.chatTokens = Math.min(3, p.chatTokens + (now - p.chatAt) / 1500);
    p.chatAt = now;
    if (p.chatTokens < 1 || !text) return;
    p.chatTokens -= 1;
    const c: ChatTuple = [p.id, p.name, p.adj, p.noun, text, now];
    this.chatLog.push(c);
    if (this.chatLog.length > CHAT_HISTORY) this.chatLog.shift();
    this.broadcast({ t: 'chat', c });
  }

  ring(p: Player, k: number, now: number) {
    if (now - p.lastRing < 2500) return;
    p.lastRing = now;
    this.broadcast({ t: 'fx', k, id: p.id });
  }

  // ---------- DJ (one shared playlist per room) ----------
  djRequest(p: Player, song: number) {
    if (!Number.isInteger(song) || song < 0 || song >= SONGS.length) return;
    if (this.dj.q.length >= DJ_QUEUE_MAX || this.dj.q.some(([, by]) => by === p.id)) return;
    this.dj.q.push([song, p.id]);
    this.broadcast({ t: 'dj', d: this.dj });
  }

  private djTick(now: number) {
    if (now < this.dj.at + songDurationMs(this.dj.s)) return;
    const next = this.dj.q.shift();
    this.dj = { s: next ? next[0] : (this.dj.s + 1) % SONGS.length, at: now, q: this.dj.q };
    this.broadcast({ t: 'dj', d: this.dj });
  }

  // ---------- cushions ----------
  takeSeat(p: Player, i: number) {
    if (i < 0 || i >= this.seats.length) return;
    if (this.seats[i] !== null && this.seats[i] !== p.id) {
      p.conn.send(JSON.stringify({ t: 'seatno', i } satisfies ServerMsg));
      return;
    }
    this.assignSeat(p, i);
  }

  private assignSeat(p: Player, i: number) {
    this.freeSeat(p);
    this.seats[i] = p.id;
    p.seat = i;
    this.broadcast({ t: 'seat', i, id: p.id });
  }

  freeSeat(p: Player) {
    if (p.seat < 0) return;
    const i = p.seat;
    p.seat = -1;
    if (this.seats[i] === p.id) {
      this.seats[i] = null;
      this.broadcast({ t: 'seat', i, id: null });
      // nobody to ask any more
      const req = this.requests.get(p.id);
      if (req) {
        this.requests.delete(p.id);
        p.conn.send(JSON.stringify({ t: 'sreqx' } satisfies ServerMsg));
        this.answer(req.from, req.seat, 'gone');
      }
    }
  }

  // ---------- asking someone for their cushion ----------
  seatRequest(from: Player, i: number, now: number) {
    if (i < 0 || i >= this.seats.length) return;
    const ownerId = this.seats[i];
    if (ownerId === null) return this.assignSeat(from, i);
    if (ownerId === from.id) return;
    if ([...this.requests.values()].some((r) => r.from === from.id)) return this.answer(from.id, i, 'busy');
    if (this.requests.has(ownerId)) return this.answer(from.id, i, 'busy');
    this.requests.set(ownerId, { from: from.id, owner: ownerId, seat: i, until: now + SEAT_REQUEST_MS });
    this.players.get(ownerId)?.conn.send(JSON.stringify({ t: 'sreq', i, from: from.id } satisfies ServerMsg));
  }

  seatAnswer(owner: Player, ok: boolean) {
    const req = this.requests.get(owner.id);
    if (!req) return;
    this.requests.delete(owner.id);
    const asker = this.players.get(req.from);
    if (!asker) return;
    if (!ok) return this.answer(req.from, req.seat, 'no');
    if (this.seats[req.seat] !== owner.id) return this.answer(req.from, req.seat, 'gone');
    // owner stands up, asker sits down — one atomic swap on the server
    owner.seat = -1;
    this.seats[req.seat] = null;
    this.assignSeat(asker, req.seat);
    this.answer(req.from, req.seat, 'ok');
  }

  private answer(to: number, i: number, r: SeatAnswer) {
    this.players.get(to)?.conn.send(JSON.stringify({ t: 'sres', i, r } satisfies ServerMsg));
  }

  private dropRequestsOf(id: number) {
    const mine = this.requests.get(id);
    if (mine) {
      this.requests.delete(id);
      this.answer(mine.from, mine.seat, 'gone');
    }
    for (const [owner, r] of this.requests)
      if (r.from === id) {
        this.requests.delete(owner);
        this.players.get(owner)?.conn.send(JSON.stringify({ t: 'sreqx' } satisfies ServerMsg));
      }
  }

  private expireRequests(now: number) {
    for (const [owner, r] of this.requests)
      if (now > r.until) {
        this.requests.delete(owner);
        this.players.get(owner)?.conn.send(JSON.stringify({ t: 'sreqx' } satisfies ServerMsg));
        this.answer(r.from, r.seat, 'timeout');
      }
  }

  // ---------- incense queue (server-authoritative, one person at the censer) ----------
  incJoin(id: number, now: number) {
    if (this.incCur === id || this.incQueue.includes(id)) return;
    this.incQueue.push(id);
    if (this.incCur === null) this.incAdvance(now);
    else this.broadcast({ t: 'inc', s: this.incState() });
  }

  incLeave(id: number, now: number) {
    if (this.incCur === id) this.incAdvance(now);
    else if (this.incQueue.includes(id)) {
      this.incQueue = this.incQueue.filter((q) => q !== id);
      this.broadcast({ t: 'inc', s: this.incState() });
    }
  }

  private incAdvance(now: number) {
    this.incCur = this.incQueue.shift() ?? null;
    this.incPhase = 0;
    this.incUntil = this.incCur === null ? 0 : now + INCENSE_WALK_MS;
    this.broadcast({ t: 'inc', s: this.incState() });
  }

  private incTick(now: number) {
    if (this.incCur === null || now < this.incUntil) return;
    if (this.incPhase === 0) {
      this.incPhase = 1;
      this.incUntil = now + INCENSE_OFFER_MS;
      this.broadcast({ t: 'inc', s: this.incState() });
      return;
    }
    // offering finished -> plant a stick in the free (or oldest) slot
    let slot = -1;
    let oldest = Infinity;
    for (let i = 0; i < INCENSE_SLOTS; i++) {
      const at = this.sticks.get(i);
      if (at === undefined || now - at > INCENSE_BURN_MS) {
        slot = i;
        break;
      }
      if (at < oldest) {
        oldest = at;
        slot = i;
      }
    }
    this.sticks.set(slot, now);
    this.broadcast({ t: 'stk', s: [slot, now] });
    this.incAdvance(now);
  }

  private incState(): IncenseState {
    return { cur: this.incCur, ph: this.incPhase, until: this.incUntil, q: [...this.incQueue] };
  }

  private liveSticks(now: number): StickTuple[] {
    const out: StickTuple[] = [];
    for (const [slot, at] of this.sticks) if (now - at < INCENSE_BURN_MS) out.push([slot, at]);
    return out;
  }

  // ---------- networking ----------
  private tuple(p: Player): PlayerTuple {
    return [p.id, p.adj, p.noun, p.x, p.z, p.r, p.p, p.tint, p.name];
  }

  broadcast(msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) p.conn.send(data);
  }

  /**
   * One tick: timers + a single delta message serialised ONCE and
   * fanned out to every member (O(n) serialisation instead of O(n²)).
   */
  tick(now: number): number {
    this.incTick(now);
    this.djTick(now);
    if (this.requests.size) this.expireRequests(now);
    const u: MoveTuple[] = [];
    for (const p of this.players.values())
      if (p.dirty) {
        u.push([p.id, p.x, p.z, p.r, p.p]);
        p.dirty = false;
      }
    if (!u.length && !this.joins.length && !this.leaves.length) return 0;

    const delta: ServerMsg = { t: 's', now };
    if (u.length) delta.u = u;
    if (this.joins.length) delta.j = this.joins;
    if (this.leaves.length) delta.l = this.leaves;
    const data = JSON.stringify(delta);
    let full: string | null = null;
    let sent = 0;

    for (const p of this.players.values()) {
      if (p.conn.bufferedAmount > BACKPRESSURE_BYTES) {
        p.needsFull = true;
        continue;
      }
      if (p.needsFull) {
        full ??= JSON.stringify({
          t: 's',
          now,
          u: [...this.players.values()].map((q) => [q.id, q.x, q.z, q.r, q.p]),
          j: [...this.players.values()].map((q) => this.tuple(q)),
          l: this.leaves,
        } satisfies ServerMsg);
        p.conn.send(full);
        p.needsFull = false;
      } else p.conn.send(data);
      sent++;
    }
    this.joins = [];
    this.leaves = [];
    return sent;
  }
}
