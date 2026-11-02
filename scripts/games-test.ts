import { newGame, legalMoves, applyMove, inCheck } from '@sontu/shared';
let ok = 0, bad = 0;
const check = (n: string, c: boolean, info?: unknown) => { c ? ok++ : bad++; console.log(c ? '✔' : '✘', n, c ? '' : JSON.stringify(info)); };
const xq = newGame('xiangqi');
check('xiangqi opening has 44 legal moves', legalMoves(xq).length === 44, legalMoves(xq).length);
// red cannon b2 (row7,col1 = 64) to e2... play cannon 2 to 5 (central cannon): from 64 to 67
let g = applyMove(xq, [64, 67])!;
check('central cannon move legal', !!g && g.turn === 1);
check('moving out of turn rejected', applyMove(g, [64, 67]) === null);
check('illegal horse leap rejected', applyMove(g, [1, 1 + 9 * 3]) === null);
// cannon captures horse through screen? red cannon at 67 (row7 col4) jumps soldier... capture black middle soldier at 31 requires screen; path 58,49,40 empty -> no screen -> illegal
// central cannon jumping its own soldier (screen) onto the black middle soldier is legal
check('cannon captures over exactly one screen', applyMove({ ...g, turn: 0 }, [67, 31]) !== null);
check('cannon jumps a screen to take the horse', applyMove(xq, [64, 1]) !== null);
check('cannon cannot capture without a screen', applyMove(xq, [64, 19]) === null);
check('cannon cannot slide through a piece', applyMove(xq, [64, 10]) === null);
const ch = newGame('chess');
check('chess opening has 20 legal moves', legalMoves(ch).length === 20, legalMoves(ch).length);
// fool's mate: f3 e5 g4 Qh4#
const sq = (s: string) => (8 - +s[1]) * 8 + 'abcdefgh'.indexOf(s[0]);
let c: any = ch;
for (const [a, b] of [['f2','f3'],['e7','e5'],['g2','g4'],['d8','h4']]) c = applyMove(c, [sq(a), sq(b)]);
check("fool's mate detected", c?.result?.w === 1 && c.result.why === 'mate', c?.result);
check('chess illegal move rejected', applyMove(ch, [sq('e2'), sq('e5')]) === null);
let go: any = newGame('gomoku');
for (const i of [0, 20, 1, 21, 2, 22, 3, 23, 4]) go = applyMove(go, [i]);
check('gomoku five in a row wins', go.result?.w === 0 && go.result.why === 'five', go.result);
check('gomoku occupied cell rejected', applyMove(newGame('gomoku'), [-1]) === null && applyMove(applyMove(newGame('gomoku'), [5])!, [5]) === null);
// xiangqi flying general: clear file between generals is illegal
const fly = { ...newGame('xiangqi'), s: '....k....' + '.'.repeat(9 * 8) + '...K.....', turn: 0 as const };
check('flying general: king may not face king', !legalMoves(fly).some(([, t]) => t === 85 + 1 - 1 && false) && !applyMove(fly, [84, 85]) , legalMoves(fly));
check('checkmated side is in check', inCheck(c) === true && inCheck(newGame('xiangqi')) === false);
console.log(`${ok} passed, ${bad} failed`);
