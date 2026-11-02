/**
 * Shared contract between backend and frontend:
 *  - wire protocol (compact JSON, short keys)
 *  - world layout (so the server can validate seats / bounds)
 *  - ceremony schedule (computed from server time, identical everywhere)
 */

export const PROTOCOL_VERSION = 2;
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
} as const;
export type Pose = (typeof Pose)[keyof typeof Pose];
export const POSE_MAX = 7;

/** [id, adjIdx, nounIdx, x, z, rot, pose, tint, name] */
export type PlayerTuple = [number, number, number, number, number, number, Pose, number, string];
/** [id, x, z, rot, pose] */
export type MoveTuple = [number, number, number, number, Pose];
/** [id, name, adj, noun, text, serverMs] — name/adj/noun snapshotted so history survives leavers */
export type ChatTuple = [number, string, number, number, string, number];

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
  | { t: 'chat'; m: string }
  | { t: 'ring'; k: number }
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
  | { t: 'full'; room: string }
  | { t: 'pong'; c: number; s: number }
  | { t: 'bye'; reason: string };

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
  id: 'main' | 'west' | 'east';
  x: number;
  z: number;
  w: number;
  d: number;
  /** platform height */
  h: number;
  cols: number;
  rows: number;
}

export const HALLS: readonly HallDef[] = [
  { id: 'main', x: 0, z: -24, w: 24, d: 16, h: 0.8, cols: 6, rows: 5 },
  { id: 'west', x: -34, z: -20, w: 15, d: 12, h: 0.6, cols: 4, rows: 3 },
  { id: 'east', x: 34, z: -20, w: 15, d: 12, h: 0.6, cols: 4, rows: 3 },
];

export const WORLD = {
  radius: 66,
  spawn: { x: 0, z: 40 },
  gate: { x: 0, z: 60 },
  courtyard: { x: 0, z: 2, r: 15 },
  censer: { x: 0, z: -9 },
  censerStand: { x: 0, z: -6.6 },
  donation: { x: 7, z: -13.4 },
  bellTower: { x: -15, z: -6 },
  drumTower: { x: 15, z: -6 },
  bodhi: { x: -48, z: 4 },
  garden: { x: -30, z: 24, w: 22, d: 16 },
  pond: { x: 30, z: 26, r: 8.5 },
  stupa: { x: 48, z: 4 },
  moonYard: { x: -36, z: 48, r: 11 },
  djBooth: { x: -44.5, z: 48 },
} as const;

export interface SeatDef {
  x: number;
  z: number;
  /** facing (rotation around Y; 0 = facing +z) */
  r: number;
  /** what the seat belongs to, for UI */
  area: HallDef['id'] | 'bodhi';
}

/** Cushions in every hall + meditation stones under the Bodhi tree (60 in total). */
export const SEATS: readonly SeatDef[] = (() => {
  const out: SeatDef[] = [];
  for (const h of HALLS) {
    const back = h.z - h.d / 2;
    const altarDepth = h.id === 'main' ? 5 : 3.8;
    for (let row = 0; row < h.rows; row++)
      for (let col = 0; col < h.cols; col++)
        out.push({
          x: h.x + (col - (h.cols - 1) / 2) * 2.2,
          z: back + altarDepth + 1.6 + row * 1.8,
          r: Math.PI,
          area: h.id,
        });
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const x = WORLD.bodhi.x + Math.cos(a) * 5;
    const z = WORLD.bodhi.z + Math.sin(a) * 5;
    out.push({ x, z, r: Math.atan2(WORLD.bodhi.x - x, WORLD.bodhi.z - z), area: 'bodhi' });
  }
  return out;
})();

export const INCENSE_SLOTS = 24;
export const INCENSE_WALK_MS = 9000;
export const INCENSE_OFFER_MS = 7000;
export const INCENSE_BURN_MS = 5 * 60_000;

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
