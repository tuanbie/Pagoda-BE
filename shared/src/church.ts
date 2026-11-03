/**
 * The second place: a fictional Gothic church ("Nhà thờ Bình An" in the UI — not modelled on
 * any real church). Same multiplayer features as the temple, with church equivalents:
 *  - pews instead of cushions (seats), candle stands instead of censers,
 *  - the tower bell (Instrument.Bell), doves released in the cloister instead of fish.
 * No services, sacraments, prayer requests or donations: it is a quiet place to visit.
 *
 * Metres; +z = south (toward the gate), the altar end of the church is to the north.
 */
import type { CenserDef, SeatDef, TableDef } from './index.ts';

export type Place = 'pagoda' | 'church';
export const PLACES: readonly Place[] = ['pagoda', 'church'];
export const isPlace = (v: unknown): v is Place => v === 'pagoda' || v === 'church';

export const CHURCH = {
  radius: 120,
  /** visitors arrive on foot through the churchyard gate */
  spawn: { x: 0, z: 96 },
  gate: { x: 0, z: 100 },
  /** interior floor height of the church (three steps up from the plaza) */
  floorH: 0.45,
  /** nave: inner width, from the west front (z1) to the crossing */
  nave: { x: 0, w: 22, z0: -40, z1: 0 },
  /** aisle columns stand at ±colX every colStep */
  colX: 11,
  colStep: 5,
  /** crossing + transept arms */
  transept: { z: -46, w: 46, d: 12 },
  /** choir and the semicircular apse */
  choir: { z0: -58, z1: -52 },
  apse: { z: -58, r: 11 },
  /** two west towers flanking the door; the bell hangs in the east one */
  towers: { x: 15.5, z: 3, size: 9, h: 46, spire: 26 },
  bellRope: { x: 15.5, z: 6.2 },
  /** plaza in front of the west door */
  plaza: { x: 0, z: 24, w: 40, d: 40 },
  /** cloister garden east of the nave, with a fountain in the middle */
  cloister: { x: 46, z: -26, w: 30, d: 30 },
  fountain: { x: 46, z: -26, r: 3.2 },
} as const;

/** Pews: two blocks either side of the central aisle, 19 rows, 4 places per side of a row. */
export const CHURCH_SEATS: readonly SeatDef[] = (() => {
  const out: SeatDef[] = [];
  for (let row = 0; row < 19; row++) {
    const z = -37.4 + row * 1.7;
    for (const side of [-1, 1])
      for (let k = 0; k < 4; k++) out.push({ x: side * (2.9 + k * 1.9), z, r: Math.PI, area: 'nave' });
  }
  // stone benches around the cloister fountain: 6 benches × 2
  const f = CHURCH.fountain;
  for (let b = 0; b < 6; b++) {
    const a = (b / 6) * Math.PI * 2 + Math.PI / 6;
    for (const off of [-0.55, 0.55]) {
      const tx = -Math.sin(a) * off;
      const tz = Math.cos(a) * off;
      const x = f.x + Math.cos(a) * 7 + tx;
      const z = f.z + Math.sin(a) * 7 + tz;
      out.push({ x, z, r: Math.atan2(f.x - x, f.z - z), area: 'cloister' });
    }
  }
  return out;
})();

/**
 * Candle stands (the church's "censers"): one in each transept arm and one by the west door.
 * Each holds INCENSE_SLOTS candles; `y` is the height of the candle tray.
 */
export const CHURCH_CANDLES: readonly CenserDef[] = [
  { x: -18, z: -48.2, stand: { x: -18, z: -46.6 }, y: CHURCH.floorH + 0.95, scale: 0.9, hall: null },
  { x: 18, z: -48.2, stand: { x: 18, z: -46.6 }, y: CHURCH.floorH + 0.95, scale: 0.9, hall: null },
  { x: -8, z: -3.2, stand: { x: -8, z: -1.6 }, y: CHURCH.floorH + 0.95, scale: 0.7, hall: null },
];

export const CHURCH_TABLES: readonly TableDef[] = [];
