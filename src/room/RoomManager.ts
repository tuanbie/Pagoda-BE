import { randomBytes } from 'node:crypto';
import {
  NAME_ADJ_COUNT,
  NAME_NOUN_COUNT,
  POSE_MAX,
  Pose,
  TICK_HZ,
  TINT_COUNT,
  PLACES,
  placeDef,
  clampToPlace,
  MAX_CHAT_CHARS,
  MAX_NAME_CHARS,
  cleanText,
  round2,
  type ClientMsg,
  type Place,
  type RoomInfo,
} from '@sontu/shared';
import { config } from '../config.ts';
import { metrics } from '../metrics.ts';
import { Room, type Conn, type Player } from './Room.ts';

interface Session {
  /** where the position was saved; it is only restored in the same place */
  place: Place;
  name: string;
  adj: number;
  noun: number;
  tint: number;
  x: number;
  z: number;
  r: number;
  expires: number;
}

const SESSION_TTL_MS = 3 * 60_000;
const EMPTY_ROOM_TTL_MS = 60_000;
/** A room counts as "crowded" above this ratio and the node opens a new one. */
const ELASTIC_RATIO = 0.9;

/**
 * Client-side hints used when the server has no session for the visitor (e.g. after a
 * Vercel instance recycle or a node restart): keep the same spot and anonymous name.
 */
export interface JoinHint {
  x?: number;
  z?: number;
  adj?: number;
  noun?: number;
  tint?: number;
}

const intIn = (v: number | undefined, max: number) => (v !== undefined && Number.isInteger(v) && v >= 0 && v < max ? v : undefined);

export type JoinResult = { ok: true; room: Room; player: Player } | { ok: false; room: string };

/** Pick a spot near the wanted point where nobody is standing (people never overlap). */
function freeSpot(room: Room, x: number, z: number): { x: number; z: number } {
  const taken = (cx: number, cz: number) => [...room.players.values()].some((q) => (q.x - cx) ** 2 + (q.z - cz) ** 2 < 0.8 ** 2);
  if (!taken(x, z)) return { x: round2(x), z: round2(z) };
  for (let ring = 1; ring <= 8; ring++)
    for (let k = 0; k < ring * 6; k++) {
      const a = (k / (ring * 6)) * Math.PI * 2 + ring;
      const [cx, cz] = clampToPlace(room.place, x + Math.cos(a) * ring * 0.9, z + Math.sin(a) * ring * 0.9);
      if (!taken(cx, cz)) return { x: round2(cx), z: round2(cz) };
    }
  return { x: round2(x), z: round2(z) };
}

function spawnAt(room: Room, s: Session | undefined, hint: JoinHint) {
  // a session from the other place keeps the visitor's name, not their (foreign) coordinates
  if (s && s.place === room.place) {
    const [x, z] = clampToPlace(room.place, s.x, s.z);
    return freeSpot(room, x, z);
  }
  if (Number.isFinite(hint.x) && Number.isFinite(hint.z)) {
    const [x, z] = clampToPlace(room.place, hint.x!, hint.z!);
    return freeSpot(room, x, z);
  }
  const sp = placeDef(room.place).spawn;
  return freeSpot(room, sp.x + (Math.random() - 0.5) * 4, sp.z + Math.random() * 2);
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private sessions = new Map<string, Session>();
  private nextPlayerId = 1;
  private timer?: NodeJS.Timeout;

  constructor() {
    for (const place of PLACES) for (let i = 0; i < config.minRooms; i++) this.createRoom(place);
  }

  start() {
    const interval = 1000 / TICK_HZ;
    this.timer = setInterval(() => {
      const t0 = performance.now();
      const now = Date.now();
      let sent = 0;
      for (const room of this.rooms.values()) sent += room.tick(now);
      metrics.ticks++;
      metrics.messagesOut += sent;
      metrics.lastTickMs = performance.now() - t0;
    }, interval);
    setInterval(() => this.housekeeping(), 5000).unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  private createRoom(place: Place): Room {
    // reuse the lowest free number so the list stays "Server 1, 2, 3…" (numbered per place)
    const used = new Set([...this.rooms.values()].filter((r) => r.place === place).map((r) => r.num - config.roomNumberBase));
    let num = 1;
    while (used.has(num)) num++;
    // temple rooms keep their old ids ("-r1"); church rooms are "-c1", "-c2"…
    const room = new Room(`${config.nodeId}-${place === 'church' ? 'c' : 'r'}${num}`, config.roomNumberBase + num, config.roomCapacity, place);
    this.rooms.set(room.id, room);
    return room;
  }

  /** Lowest-numbered room with space; opens a new room when everything is crowded. */
  private pickRoom(place: Place): Room | null {
    let best: Room | null = null;
    let crowded = true;
    for (const r of this.rooms.values()) {
      if (r.place !== place) continue;
      if (!r.full && (!best || r.num < best.num)) best = r;
      if (r.count < r.cap * ELASTIC_RATIO) crowded = false;
    }
    if ((crowded || !best) && this.rooms.size < config.maxRooms) {
      const fresh = this.createRoom(place);
      return best ?? fresh;
    }
    return best;
  }

  directory(): RoomInfo[] {
    return [...this.rooms.values()]
      .map((r) => ({ id: r.id, num: r.num, count: r.count, cap: r.cap, url: config.publicWsUrl, node: config.nodeId, place: r.place }))
      .sort((a, b) => a.num - b.num);
  }

  join(conn: Conn, roomId: string | null, token: string | null, name = '', hint: JoinHint = {}, place: Place = 'pagoda'): JoinResult {
    let room = roomId ? this.rooms.get(roomId) ?? null : null;
    // a room id from the other place (e.g. remembered from the last visit) is ignored
    if (room && room.place !== place) room = null;
    if (room?.full) return { ok: false, room: room.id };
    room ??= this.pickRoom(place);
    if (!room) return { ok: false, room: roomId ?? '' };

    const now = Date.now();
    const s = token ? this.sessions.get(token) : undefined;
    if (s) this.sessions.delete(token!);
    const id = this.nextPlayerId++;
    const player: Player = {
      id,
      token: s ? token! : randomBytes(12).toString('base64url'),
      conn,
      name: cleanText(name, MAX_NAME_CHARS) || s?.name || '',
      adj: s?.adj ?? intIn(hint.adj, NAME_ADJ_COUNT) ?? Math.floor(Math.random() * NAME_ADJ_COUNT),
      noun: s?.noun ?? intIn(hint.noun, NAME_NOUN_COUNT) ?? Math.floor(Math.random() * NAME_NOUN_COUNT),
      tint: s?.tint ?? intIn(hint.tint, TINT_COUNT) ?? Math.floor(Math.random() * TINT_COUNT),
      ...spawnAt(room, s, hint),
      r: s && s.place === room.place ? s.r : Math.PI,
      p: Pose.Idle,
      dirty: false,
      seat: -1,
      needsFull: false,
      lastName: 0,
      lastRing: 0,
      lastFish: 0,
      chatTokens: 3,
      chatAt: now,
    };
    room.add(player, now);
    metrics.joins++;
    return { ok: true, room, player };
  }

  leave(room: Room, player: Player) {
    const now = Date.now();
    room.remove(player.id, now);
    this.sessions.set(player.token, {
      place: room.place,
      name: player.name,
      adj: player.adj,
      noun: player.noun,
      tint: player.tint,
      x: player.x,
      z: player.z,
      r: player.r,
      expires: now + SESSION_TTL_MS,
    });
  }

  /** Validates and applies one client message. Returns false for protocol abuse. */
  handle(room: Room, p: Player, msg: ClientMsg): boolean {
    switch (msg.t) {
      case 'mv': {
        const { x, z, r, p: pose } = msg;
        if (![x, z, r].every(Number.isFinite) || !Number.isInteger(pose) || pose < 0 || pose > POSE_MAX) return false;
        const [cx, cz] = clampToPlace(room.place, x, z);
        room.move(p, round2(cx), round2(cz), round2(r), pose as Pose);
        return true;
      }
      case 'seat':
        if (!Number.isInteger(msg.i)) return false;
        room.takeSeat(p, msg.i);
        return true;
      case 'unseat':
        room.freeSeat(p);
        return true;
      case 'sreq':
        if (!Number.isInteger(msg.i)) return false;
        room.seatRequest(p, msg.i, Date.now());
        return true;
      case 'sans':
        room.seatAnswer(p, msg.ok === true);
        return true;
      case 'name':
        room.rename(p, cleanText(msg.n, MAX_NAME_CHARS), Date.now());
        return true;
      case 'chat':
        room.chat(p, cleanText(msg.m, MAX_CHAT_CHARS), msg.ch === 1 ? 1 : 0, Date.now());
        return true;
      case 'tb':
        if (!Number.isInteger(msg.i) || !['join', 'leave', 'move', 'resign', 'reset'].includes(msg.a)) return false;
        room.tableAction(p, msg);
        return true;
      case 'ring':
        if (msg.k !== 0 && msg.k !== 1) return false;
        room.ring(p, msg.k, Date.now());
        return true;
      case 'fish':
        room.releaseFish(p, Date.now());
        return true;
      case 'dj':
        room.djRequest(p, msg.s);
        return true;
      case 'inc': {
        const c = msg.c ?? 0;
        if (!Number.isInteger(c)) return false;
        room.incJoin(p.id, c, Date.now());
        return true;
      }
      case 'incx':
        room.incLeave(p.id, Date.now());
        return true;
      case 'ping':
        if (!Number.isFinite(msg.c)) return false;
        p.conn.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() }));
        return true;
      default:
        return false;
    }
  }

  get playerCount() {
    let n = 0;
    for (const r of this.rooms.values()) n += r.count;
    return n;
  }

  /** Drop expired resume sessions and idle extra rooms. */
  private housekeeping() {
    const now = Date.now();
    for (const [k, s] of this.sessions) if (s.expires < now) this.sessions.delete(k);
    const sorted = [...this.rooms.values()].sort((a, b) => b.num - a.num);
    for (const r of sorted) {
      if ([...this.rooms.values()].filter((q) => q.place === r.place).length <= config.minRooms) continue;
      if (r.count === 0 && now - r.emptySince > EMPTY_ROOM_TTL_MS) this.rooms.delete(r.id);
    }
  }

  shutdown(reason: string) {
    for (const room of this.rooms.values()) {
      room.broadcast({ t: 'bye', reason });
      for (const p of room.players.values()) p.conn.close(1012, reason);
    }
  }
}
