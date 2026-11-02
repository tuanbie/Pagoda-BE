/**
 * Shared contract between backend and frontend:
 *  - wire protocol (compact JSON, short keys)
 *  - world layout (so the server can validate seats / bounds)
 *  - ceremony schedule (computed from server time, identical everywhere)
 */

export * from './games.ts';
import type { GameKind, GameState, Move, Side } from './games.ts';

export const PROTOCOL_VERSION = 3;
export const TICK_HZ = 10;
export const DEFAULT_ROOM_CAPACITY = 100;
export const MAX_MESSAGE_BYTES = 1024;
export const MAX_NAME_CHARS = 24;
export const MAX_CHAT_CHARS = 200;
export const CHAT_HISTORY = 40;
export const SEAT_REQUEST_MS = 20_000;

/** Continuous body poses. Encoded as small ints on the wire. */
export const Pose = {
  Idle: 0,
  Sit: 1,
  Bow: 2,
  Greet: 3,
  Beads: 4,
  Dance: 5,
  Offer: 6,
  Moktak: 7,
  /** tea house: pouring from the pot / sipping from the cup */
  PourTea: 8,
  DrinkTea: 9,
} as const;
export type Pose = (typeof Pose)[keyof typeof Pose];
export const POSE_MAX = 9;

/** [id, adjIdx, nounIdx, x, z, rot, pose, tint, name] */
export type PlayerTuple = [number, number, number, number, number, number, Pose, number, string];
/** [id, x, z, rot, pose] */
export type MoveTuple = [number, number, number, number, Pose];
/** [id, name, adj, noun, text, serverMs, channel] — name/adj/noun snapshotted so history survives leavers.
 *  channel 0 = whole room, 1 = only people inside the discussion hall */
export type ChatTuple = [number, string, number, number, string, number, number];

export interface IncenseState {
  /** player currently at the censer */
  cur: number | null;
  /** 0 = walking to censer, 1 = offering */
  ph: 0 | 1;
  /** server time (ms) the current phase ends */
  until: number;
  /** waiting player ids, in order */
  q: number[];
}

/** [slot, lit-at server ms] */
export type StickTuple = [number, number];

/** Instruments anyone can strike; everybody in the room hears them. */
export const Instrument = { Bell: 0, Drum: 1 } as const;

// ---------- client -> server ----------
export type ClientMsg =
  | { t: 'mv'; x: number; z: number; r: number; p: Pose }
  | { t: 'seat'; i: number }
  | { t: 'unseat' }
  /** ask the person sitting on cushion i for it */
  | { t: 'sreq'; i: number }
  /** answer to a seat request addressed to me */
  | { t: 'sans'; ok: boolean }
  | { t: 'inc' }
  | { t: 'incx' }
  | { t: 'name'; n: string }
  | { t: 'chat'; m: string; ch?: number }
  /** game tables: sit down, stand up, move, resign, start a new game */
  | { t: 'tb'; a: 'join' | 'leave' | 'move' | 'resign' | 'reset'; i: number; side?: Side; m?: Move }
  | { t: 'ring'; k: number }
  /** release a fish into the lotus pond */
  | { t: 'fish' }
  /** ask the DJ to play song s */
  | { t: 'dj'; s: number }
  | { t: 'ping'; c: number };

// ---------- server -> client ----------
export interface WelcomeMsg {
  t: 'hi';
  v: number;
  id: number;
  token: string;
  room: { id: string; num: number; cap: number };
  now: number;
  players: PlayerTuple[];
  seats: [number, number][];
  inc: IncenseState;
  sticks: StickTuple[];
  chat: ChatTuple[];
  dj: DjState;
  tables: TableSnap[];
  fish: FishTuple[];
}
export type SeatAnswer = 'ok' | 'no' | 'busy' | 'timeout' | 'gone';
export type ServerMsg =
  | WelcomeMsg
  | { t: 's'; now: number; u?: MoveTuple[]; j?: PlayerTuple[]; l?: number[] }
  | { t: 'seat'; i: number; id: number | null }
  | { t: 'seatno'; i: number }
  /** someone (from) asks for my cushion i */
  | { t: 'sreq'; i: number; from: number }
  /** the request I'm answering was withdrawn / expired */
  | { t: 'sreqx' }
  /** result of my own request */
  | { t: 'sres'; i: number; r: SeatAnswer }
  | { t: 'inc'; s: IncenseState }
  | { t: 'stk'; s: StickTuple }
  | { t: 'nm'; id: number; n: string }
  | { t: 'chat'; c: ChatTuple }
  | { t: 'fx'; k: number; id: number }
  | { t: 'dj'; d: DjState }
  | { t: 'tb'; s: TableSnap }
  | { t: 'fish'; f: FishTuple; id: number }
  | { t: 'full'; room: string }
  | { t: 'pong'; c: number; s: number }
  | { t: 'bye'; reason: string };

/** One game table as everyone sees it. p = [side 0 player, side 1 player]. */
export interface TableSnap {
  i: number;
  p: [number | null, number | null];
  g: GameState;
}

/** Private feedback to the developer (POST /api/feedback). */
export interface FeedbackInput {
  kind: 'bug' | 'idea' | 'other';
  message: string;
  name?: string;
  contact?: string;
  locale?: string;
}
export const FEEDBACK_MAX = 2000;

export interface RoomInfo {
  id: string;
  num: number;
  count: number;
  cap: number;
  /** websocket URL (absolute or path) to reach the node hosting this room */
  url: string;
  node: string;
}

/** Strip control / bidi-override characters, collapse whitespace, cap length (by code points). */
export function cleanText(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  const cleaned = s
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, max).join('');
}

// ---------- world layout (metres; +z = south, toward the gate) ----------
export interface HallDef {
  id: 'main' | 'west' | 'east' | 'jizo' | 'maitreya';
  x: number;
  z: number;
  w: number;
  d: number;
  /** platform height */
  h: number;
  cols: number;
  rows: number;
  /** depth reserved for the altar at the back */
  altar: number;
}

export const HALLS: readonly HallDef[] = [
  { id: 'main', x: 0, z: -62, w: 46, d: 34, h: 1.5, cols: 14, rows: 10, altar: 8 },
  { id: 'west', x: -50, z: -50, w: 28, d: 22, h: 1.1, cols: 8, rows: 6, altar: 5.5 },
  { id: 'east', x: 50, z: -50, w: 28, d: 22, h: 1.1, cols: 8, rows: 6, altar: 5.5 },
  { id: 'jizo', x: -88, z: -22, w: 26, d: 20, h: 1, cols: 8, rows: 5, altar: 5 },
  { id: 'maitreya', x: 88, z: -22, w: 26, d: 20, h: 1, cols: 8, rows: 5, altar: 5 },
];

/** Smaller buildings for daily life: tea house, discussion hall, game hall. */
export interface PavilionDef {
  id: 'tea' | 'talk' | 'games';
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}
export const PAVILIONS: readonly PavilionDef[] = [
  { id: 'games', x: 92, z: 30, w: 18, d: 14, h: 0.6 },
  { id: 'tea', x: 70, z: 84, w: 16, d: 12, h: 0.5 },
  { id: 'talk', x: -60, z: 36, w: 18, d: 14, h: 0.6 },
];
export const pavilion = (id: PavilionDef['id']) => PAVILIONS.find((p) => p.id === id)!;
export function inPavilion(id: PavilionDef['id'], x: number, z: number) {
  const p = pavilion(id);
  return Math.abs(x - p.x) < p.w / 2 && Math.abs(z - p.z) < p.d / 2;
}

export const WORLD = {
  radius: 130,
  /** visitors are dropped off by the shuttle just inside the gate */
  spawn: { x: 0, z: 127.4 },
  gate: { x: 0, z: 124 },
  courtyard: { x: 0, z: -22, r: 18 },
  censer: { x: 0, z: -32 },
  censerStand: { x: 0, z: -29.6 },
  donation: { x: 11, z: -38 },
  bellTower: { x: -22, z: -28 },
  drumTower: { x: 22, z: -28 },
  bodhi: { x: -104, z: 8 },
  garden: { x: -36, z: 20, w: 26, d: 18 },
  pond: { x: 40, z: 34, r: 24 },
  moonYard: { x: -40, z: 92, r: 12 },
  djBooth: { x: -50.5, z: 92 },
} as const;

/**
 * Climbable stupa: a 3-step-limit heightfield. Lower balcony ring at 10 m reached by a
 * straight stair from the north; a spiral stair on the balcony climbs to the upper ring at 22 m.
 */
export const STUPA = {
  x: -80,
  z: 74,
  core: 4, // solid tower inside this radius
  upperR: 6.2, // upper balcony: core..upperR at 22 m
  lowerR: 10.5, // lower balcony: upperR..lowerR at 10 m
  lowerH: 10,
  upperH: 22,
  stairW: 3,
  stairLen: 22, // straight stair from the ground (north side) up to the lower balcony
  spiralFrom: Math.PI * 0.5, // spiral stair sector on the balcony (angle measured from +x toward +z)
  spiralSpan: Math.PI * 1.1,
} as const;

/** Walkable height of the stupa at (x,z): null = not part of the stupa, NaN = solid. */
export function stupaHeight(x: number, z: number): number | null {
  const s = STUPA;
  const dx = x - s.x;
  const dz = z - s.z;
  const r = Math.hypot(dx, dz);
  // straight stair on the north side (toward -z), outside the balcony
  if (Math.abs(dx) < s.stairW / 2 && dz < -s.lowerR + 0.01 && dz > -s.lowerR - s.stairLen) return s.lowerH * (1 - (-dz - s.lowerR) / s.stairLen);
  if (r >= s.lowerR) return null;
  if (r < s.core) return NaN;
  if (r < s.upperR) return s.upperH;
  // spiral stair sector on the balcony
  let a = Math.atan2(dz, dx) - s.spiralFrom;
  a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (a < s.spiralSpan && r < s.upperR + 2.6) return s.lowerH + (s.upperH - s.lowerH) * (a / s.spiralSpan);
  return s.lowerH;
}

/** Game tables in the game hall: 3 kinds × 2. Side 0 sits south (facing north). */
export interface TableDef {
  kind: GameKind;
  x: number;
  z: number;
}
export const TABLES: readonly TableDef[] = (() => {
  const g = pavilion('games');
  const kinds: GameKind[] = ['xiangqi', 'chess', 'gomoku'];
  const out: TableDef[] = [];
  for (const dz of [-2.6, 2.6]) kinds.forEach((kind, k) => out.push({ kind, x: g.x + (k - 1) * 5.2, z: g.z + dz }));
  return out;
})();
export const tableSeat = (t: TableDef, side: Side) => ({ x: t.x, z: t.z + (side === 0 ? 1.05 : -1.05), r: side === 0 ? Math.PI : 0 });

export interface SeatDef {
  x: number;
  z: number;
  /** facing (rotation around Y; 0 = facing +z) */
  r: number;
  /** what the seat belongs to, for UI */
  area: HallDef['id'] | 'bodhi' | 'tea' | 'talk';
}

/** Cushions in every hall, Bodhi stones, tea house and discussion hall. */
export const SEATS: readonly SeatDef[] = (() => {
  const out: SeatDef[] = [];
  for (const h of HALLS) {
    const back = h.z - h.d / 2;
    for (let row = 0; row < h.rows; row++)
      for (let col = 0; col < h.cols; col++)
        out.push({
          x: h.x + (col - (h.cols - 1) / 2) * 2.4,
          z: back + h.altar + 1.6 + row * 2.0,
          r: Math.PI,
          area: h.id,
        });
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const x = WORLD.bodhi.x + Math.cos(a) * 5.6;
    const z = WORLD.bodhi.z + Math.sin(a) * 5.6;
    out.push({ x, z, r: Math.atan2(WORLD.bodhi.x - x, WORLD.bodhi.z - z), area: 'bodhi' });
  }
  // tea house: 4 low tables with a cushion on each side
  const tea = pavilion('tea');
  for (const tx of [-3.6, 3.6])
    for (const tz of [-2.4, 2.4])
      for (const [dx, dz] of [
        [0, 1.05],
        [0, -1.05],
        [1.05, 0],
        [-1.05, 0],
      ]) {
        const x = tea.x + tx + dx;
        const z = tea.z + tz + dz;
        out.push({ x, z, r: Math.atan2(-dx, -dz), area: 'tea' });
      }
  // discussion hall: a ring of 16 cushions facing each other
  const talk = pavilion('talk');
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const x = talk.x + Math.cos(a) * 4.4;
    const z = talk.z + Math.sin(a) * 4.4;
    out.push({ x, z, r: Math.atan2(talk.x - x, talk.z - z), area: 'talk' });
  }
  return out;
})();

/** 60 distinct spots in the censer (concentric rings) — sticks never share a spot. */
export const INCENSE_SLOTS = 60;
export const INCENSE_RINGS: readonly [number, number][] = [
  [0.14, 6],
  [0.3, 12],
  [0.46, 18],
  [0.62, 24],
];
export function incenseSpot(slot: number): [number, number] {
  let s = slot;
  for (const [r, n] of INCENSE_RINGS) {
    if (s < n) {
      const a = (s / n) * Math.PI * 2 + r * 3;
      return [Math.cos(a) * r, Math.sin(a) * r];
    }
    s -= n;
  }
  return [0, 0];
}
export const INCENSE_WALK_MS = 12000;
export const INCENSE_OFFER_MS = 7000;
/** a stick burns for 30 minutes */
export const INCENSE_BURN_MS = 30 * 60_000;

/** Released fish: [seed, released-at server ms]. The pond keeps the most recent ones. */
export type FishTuple = [number, number];
export const FISH_MAX = 120;

/** Anonymous names: index pairs, rendered in each viewer's own language. */
export const NAME_ADJ_COUNT = 12;
export const NAME_NOUN_COUNT = 12;
export const TINT_COUNT = 6;

// ---------- ceremony schedule (Indochina Time, UTC+7: VN / LA / KH) ----------
export const TZ_OFFSET_MS = 7 * 3600_000;
export const SERVICE_LENGTH_MS = 20 * 60_000;
export const SERVICES = [
  { kind: 'dawn', hour: 5, minute: 0 },
  { kind: 'evening', hour: 18, minute: 0 },
] as const;
export type ServiceKind = (typeof SERVICES)[number]['kind'];

export interface ServiceSlot {
  kind: ServiceKind;
  startsAt: number;
  endsAt: number;
}

/** Returns the service in progress (if any) and the next upcoming one. */
export function serviceStatus(now: number): { live: ServiceSlot | null; next: ServiceSlot } {
  const DAY = 86_400_000;
  const dayStart = Math.floor((now + TZ_OFFSET_MS) / DAY) * DAY - TZ_OFFSET_MS;
  const slots: ServiceSlot[] = [];
  for (const d of [-DAY, 0, DAY])
    for (const s of SERVICES) {
      const startsAt = dayStart + d + s.hour * 3600_000 + s.minute * 60_000;
      slots.push({ kind: s.kind, startsAt, endsAt: startsAt + SERVICE_LENGTH_MS });
    }
  slots.sort((a, b) => a.startsAt - b.startsAt);
  const live = slots.find((s) => now >= s.startsAt && now < s.endsAt) ?? null;
  const next = slots.find((s) => s.startsAt > now)!;
  return { live, next };
}

// ---------- moonlight yard DJ ----------
/**
 * Procedural songs: every client synthesises the same notes from (song, start time),
 * so the server only has to say "song 3 started at t".
 */
export interface SongDef {
  bpm: number;
  /** MIDI root note */
  root: number;
  /** chord roots as scale degrees (0-6) over the bars */
  prog: number[];
  style: 'lofi' | 'house' | 'ambient' | 'bossa';
  bars: number;
}
export const SONGS: readonly SongDef[] = [
  { bpm: 84, root: 53, prog: [0, 6, 5, 4], style: 'lofi', bars: 48 },
  { bpm: 118, root: 50, prog: [0, 5, 3, 4], style: 'house', bars: 64 },
  { bpm: 70, root: 55, prog: [0, 3, 0, 4], style: 'ambient', bars: 32 },
  { bpm: 96, root: 52, prog: [1, 4, 0, 5], style: 'bossa', bars: 48 },
  { bpm: 90, root: 57, prog: [5, 3, 0, 4], style: 'lofi', bars: 48 },
  { bpm: 124, root: 48, prog: [0, 0, 5, 3], style: 'house', bars: 64 },
];
export const songDurationMs = (i: number) => (SONGS[i].bars * 4 * 60_000) / SONGS[i].bpm;
export const DJ_QUEUE_MAX = 8;

export interface DjState {
  /** song playing and its server start time */
  s: number;
  at: number;
  /** queued requests: [song, requested by player id] */
  q: [number, number][];
}

/** Beat position (in beats, fractional) of the DJ at server time `now`. */
export function djBeat(d: DjState, now: number) {
  return ((now - d.at) / 60_000) * SONGS[d.s].bpm;
}

export function inMoonYard(x: number, z: number): boolean {
  const m = WORLD.moonYard;
  return (x - m.x) ** 2 + (z - m.z) ** 2 < m.r * m.r;
}

export function clampToWorld(x: number, z: number): [number, number] {
  const d = Math.hypot(x, z);
  if (d > WORLD.radius) {
    const k = WORLD.radius / d;
    return [x * k, z * k];
  }
  return [x, z];
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
