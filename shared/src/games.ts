/**
 * Board-game rules shared by server (authoritative validation) and client (move hints).
 * Moves are plain number arrays so they travel as tiny JSON:
 *  - xiangqi: [from, to]            squares 0..89, row-major, row 0 = black's back rank
 *  - chess:   [from, to, promo?]    squares 0..63, row 0 = rank 8; promo 0..3 = q r b n
 *  - gomoku:  [cell]                cells 0..224 on a 15×15 board
 * Side 0 always moves first (red / white / black stones).
 */
import { Chess } from 'chess.js';

export type GameKind = 'xiangqi' | 'chess' | 'gomoku';
export type Side = 0 | 1;
export type Move = number[];

export interface GameResult {
  /** winning side, or null for a draw */
  w: Side | null;
  why: 'mate' | 'stalemate' | 'five' | 'resign' | 'draw' | 'left' | 'full' | 'limit';
}

export interface GameState {
  kind: GameKind;
  /** compact board encoding (xiangqi/gomoku: one char per square; chess: FEN) */
  s: string;
  turn: Side;
  ply: number;
  last: Move | null;
  result: GameResult | null;
}

const MAX_PLY = 400;

// =====================================================================================
// Xiangqi (Cờ tướng). Uppercase = red (side 0, bottom), lowercase = black (side 1, top).
// K general · A advisor · E elephant · H horse · R chariot · C cannon · P soldier
// =====================================================================================
const XQ_W = 9;
const XQ_H = 10;
const XQ_START =
  'rheakaehr' + '.........' + '.c.....c.' + 'p.p.p.p.p' + '.........' + '.........' + 'P.P.P.P.P' + '.C.....C.' + '.........' + 'RHEAKAEHR';

const xqSide = (c: string): Side | -1 => (c === '.' ? -1 : c === c.toUpperCase() ? 0 : 1);
const inPalace = (x: number, y: number, side: Side) => x >= 3 && x <= 5 && (side === 0 ? y >= 7 : y <= 2);

function xqPseudo(b: string, from: number): number[] {
  const p = b[from];
  const side = xqSide(p);
  if (side === -1) return [];
  const x = from % XQ_W;
  const y = (from / XQ_W) | 0;
  const out: number[] = [];
  const at = (cx: number, cy: number) => (cx >= 0 && cx < XQ_W && cy >= 0 && cy < XQ_H ? b[cy * XQ_W + cx] : null);
  const add = (cx: number, cy: number) => {
    const c = at(cx, cy);
    if (c === null) return;
    if (c === '.' || xqSide(c) !== side) out.push(cy * XQ_W + cx);
  };
  const orth = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  switch (p.toUpperCase()) {
    case 'K':
      for (const [dx, dy] of orth) if (inPalace(x + dx, y + dy, side)) add(x + dx, y + dy);
      break;
    case 'A':
      for (const dx of [-1, 1]) for (const dy of [-1, 1]) if (inPalace(x + dx, y + dy, side)) add(x + dx, y + dy);
      break;
    case 'E':
      for (const dx of [-2, 2])
        for (const dy of [-2, 2]) {
          const ny = y + dy;
          if (side === 0 ? ny < 5 : ny > 4) continue; // may not cross the river
          if (at(x + dx / 2, y + dy / 2) === '.') add(x + dx, ny);
        }
      break;
    case 'H':
      for (const [dx, dy, lx, ly] of [
        [1, 2, 0, 1],
        [-1, 2, 0, 1],
        [1, -2, 0, -1],
        [-1, -2, 0, -1],
        [2, 1, 1, 0],
        [2, -1, 1, 0],
        [-2, 1, -1, 0],
        [-2, -1, -1, 0],
      ])
        if (at(x + lx, y + ly) === '.') add(x + dx, y + dy); // hobbled horse leg
      break;
    case 'R':
      for (const [dx, dy] of orth)
        for (let k = 1; ; k++) {
          const c = at(x + dx * k, y + dy * k);
          if (c === null) break;
          add(x + dx * k, y + dy * k);
          if (c !== '.') break;
        }
      break;
    case 'C':
      for (const [dx, dy] of orth) {
        let screen = false;
        for (let k = 1; ; k++) {
          const c = at(x + dx * k, y + dy * k);
          if (c === null) break;
          if (!screen) {
            if (c === '.') out.push((y + dy * k) * XQ_W + x + dx * k);
            else screen = true;
          } else if (c !== '.') {
            if (xqSide(c) !== side) out.push((y + dy * k) * XQ_W + x + dx * k);
            break;
          }
        }
      }
      break;
    case 'P': {
      const fwd = side === 0 ? -1 : 1;
      add(x, y + fwd);
      const crossed = side === 0 ? y <= 4 : y >= 5;
      if (crossed) {
        add(x - 1, y);
        add(x + 1, y);
      }
      break;
    }
  }
  return out;
}

function xqKing(b: string, side: Side) {
  return b.indexOf(side === 0 ? 'K' : 'k');
}

function xqInCheck(b: string, side: Side): boolean {
  const k = xqKing(b, side);
  if (k < 0) return true;
  // flying general: the two generals may not face each other on an open file
  const o = xqKing(b, side === 0 ? 1 : 0);
  if (o >= 0 && o % XQ_W === k % XQ_W) {
    let open = true;
    for (let i = Math.min(k, o) + XQ_W; i < Math.max(k, o); i += XQ_W)
      if (b[i] !== '.') {
        open = false;
        break;
      }
    if (open) return true;
  }
  for (let i = 0; i < 90; i++) if (xqSide(b[i]) === (side === 0 ? 1 : 0) && xqPseudo(b, i).includes(k)) return true;
  return false;
}

const xqApply = (b: string, f: number, t: number) => {
  const a = b.split('');
  a[t] = a[f];
  a[f] = '.';
  return a.join('');
};

function xqLegal(b: string, side: Side, from?: number): Move[] {
  const out: Move[] = [];
  for (let i = 0; i < 90; i++) {
    if (from !== undefined && i !== from) continue;
    if (xqSide(b[i]) !== side) continue;
    for (const t of xqPseudo(b, i)) if (!xqInCheck(xqApply(b, i, t), side)) out.push([i, t]);
  }
  return out;
}

// =====================================================================================
// Gomoku (Cờ caro) — 15×15, five or more in a row wins.
// =====================================================================================
export const GOMOKU_N = 15;

function gomokuWin(b: string, idx: number): boolean {
  const c = b[idx];
  const x = idx % GOMOKU_N;
  const y = (idx / GOMOKU_N) | 0;
  for (const [dx, dy] of [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ]) {
    let n = 1;
    for (const s of [1, -1])
      for (let k = 1; k < 5; k++) {
        const cx = x + dx * k * s;
        const cy = y + dy * k * s;
        if (cx < 0 || cy < 0 || cx >= GOMOKU_N || cy >= GOMOKU_N || b[cy * GOMOKU_N + cx] !== c) break;
        n++;
      }
    if (n >= 5) return true;
  }
  return false;
}

// =====================================================================================
// Chess — delegated to chess.js (full rules: castling, en passant, promotion, draws).
// =====================================================================================
const FILES = 'abcdefgh';
export const chessSq = (i: number) => FILES[i % 8] + (8 - ((i / 8) | 0));
const chessIdx = (sq: string) => (8 - +sq[1]) * 8 + FILES.indexOf(sq[0]);
const PROMO = ['q', 'r', 'b', 'n'];

function chessLegal(fen: string, from?: number): Move[] {
  const c = new Chess(fen);
  const moves = c.moves({ verbose: true, ...(from !== undefined ? { square: chessSq(from) as never } : {}) });
  return moves.map((m) => [chessIdx(m.from), chessIdx(m.to), ...(m.promotion ? [PROMO.indexOf(m.promotion)] : [])]);
}

// =====================================================================================
// Public API
// =====================================================================================
export function newGame(kind: GameKind): GameState {
  const s = kind === 'xiangqi' ? XQ_START : kind === 'chess' ? new Chess().fen() : '.'.repeat(GOMOKU_N * GOMOKU_N);
  return { kind, s, turn: 0, ply: 0, last: null, result: null };
}

/** Legal moves for the side to move (optionally only from one square). */
export function legalMoves(g: GameState, from?: number): Move[] {
  if (g.result) return [];
  if (g.kind === 'xiangqi') return xqLegal(g.s, g.turn, from);
  if (g.kind === 'chess') return chessLegal(g.s, from);
  if (from !== undefined) return [];
  const out: Move[] = [];
  for (let i = 0; i < g.s.length; i++) if (g.s[i] === '.') out.push([i]);
  return out;
}

/** Returns the next state, or null if the move is illegal. Never trusts the caller. */
export function applyMove(g: GameState, m: unknown): GameState | null {
  if (g.result || !Array.isArray(m) || !m.every((v) => Number.isInteger(v))) return null;
  const mv = m as Move;
  const next: GameState = { ...g, ply: g.ply + 1, last: mv, turn: g.turn === 0 ? 1 : 0 };
  if (g.kind === 'gomoku') {
    const [i] = mv;
    if (mv.length !== 1 || i < 0 || i >= g.s.length || g.s[i] !== '.') return null;
    next.s = g.s.slice(0, i) + (g.turn === 0 ? 'x' : 'o') + g.s.slice(i + 1);
    if (gomokuWin(next.s, i)) next.result = { w: g.turn, why: 'five' };
    else if (!next.s.includes('.')) next.result = { w: null, why: 'full' };
    return next;
  }
  if (g.kind === 'xiangqi') {
    if (mv.length !== 2 || !xqLegal(g.s, g.turn, mv[0]).some(([, t]) => t === mv[1])) return null;
    next.s = xqApply(g.s, mv[0], mv[1]);
    // no legal reply = loss in xiangqi (both checkmate and stalemate)
    if (!xqLegal(next.s, next.turn).length) next.result = { w: g.turn, why: xqInCheck(next.s, next.turn) ? 'mate' : 'stalemate' };
    else if (next.ply >= MAX_PLY) next.result = { w: null, why: 'limit' };
    return next;
  }
  // chess
  if (mv.length < 2 || mv.length > 3) return null;
  const c = new Chess(g.s);
  try {
    c.move({ from: chessSq(mv[0]), to: chessSq(mv[1]), promotion: mv.length === 3 ? PROMO[mv[2]] ?? 'q' : 'q' });
  } catch {
    return null;
  }
  next.s = c.fen();
  if (c.isCheckmate()) next.result = { w: g.turn, why: 'mate' };
  else if (c.isDraw() || c.isStalemate()) next.result = { w: null, why: c.isStalemate() ? 'stalemate' : 'draw' };
  else if (next.ply >= MAX_PLY) next.result = { w: null, why: 'limit' };
  return next;
}

/** Is the side to move currently in check? (for UI highlighting) */
export function inCheck(g: GameState): boolean {
  if (g.kind === 'xiangqi') return xqInCheck(g.s, g.turn);
  if (g.kind === 'chess') return new Chess(g.s).inCheck();
  return false;
}

/** Piece/stone at square i in a renderer-friendly form ('' for empty). */
export function pieceAt(g: GameState, i: number): string {
  if (g.kind === 'chess') {
    const p = new Chess(g.s).get(chessSq(i) as never);
    return p ? (p.color === 'w' ? p.type.toUpperCase() : p.type) : '';
  }
  const c = g.s[i];
  return c === '.' ? '' : c;
}

/** Full board as an array (cheaper than pieceAt in a loop for chess). */
export function boardArray(g: GameState): string[] {
  if (g.kind !== 'chess') return g.s.split('').map((c) => (c === '.' ? '' : c));
  const out: string[] = [];
  for (const row of new Chess(g.s).board()) for (const p of row) out.push(p ? (p.color === 'w' ? p.type.toUpperCase() : p.type) : '');
  return out;
}
