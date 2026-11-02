/**
 * Load test: N bots join through /api/rooms auto-assignment and walk around at 10 Hz.
 * Start the server with MAX_CONN_PER_IP high enough (all bots share one IP), e.g. MAX_CONN_PER_IP=100000.
 *   BOTS=1000 SECONDS=30 TARGET=http://127.0.0.1:8787 npm run load -w backend
 */
import { WebSocket } from 'ws';
import type { ServerMsg } from '@sontu/shared';

const TARGET = process.env.TARGET ?? 'http://127.0.0.1:8787';
const BOTS = Number(process.env.BOTS ?? 500);
const SECONDS = Number(process.env.SECONDS ?? 20);
const RAMP_PER_S = Number(process.env.RAMP ?? 200);

let connected = 0;
let failed = 0;
let msgsIn = 0;
let bytesIn = 0;
const latencies: number[] = [];
const rooms = new Map<string, number>();
const sockets: WebSocket[] = [];

function startBot(_i: number) {
  const ws = new WebSocket(TARGET.replace(/^http/, 'ws') + '/ws');
  sockets.push(ws);
  let x = (Math.random() - 0.5) * 30;
  let z = (Math.random() - 0.5) * 30;
  let timer: NodeJS.Timeout | undefined;
  ws.on('message', (d) => {
    msgsIn++;
    bytesIn += (d as Buffer).length;
    const m = JSON.parse(d.toString()) as ServerMsg;
    if (m.t === 'hi') {
      connected++;
      rooms.set(m.room.id, (rooms.get(m.room.id) ?? 0) + 1);
      timer = setInterval(() => {
        x += (Math.random() - 0.5) * 0.6;
        z += (Math.random() - 0.5) * 0.6;
        ws.send(JSON.stringify({ t: 'mv', x, z, r: Math.random() * 6, p: 0 }));
        if (Math.random() < 0.02) ws.send(JSON.stringify({ t: 'ping', c: performance.now() }));
      }, 100);
    } else if (m.t === 'pong') latencies.push(performance.now() - m.c);
  });
  ws.on('error', () => failed++);
  ws.on('close', () => clearInterval(timer));
}

console.log(`Load test → ${TARGET}: ${BOTS} bots, ${SECONDS}s`);
for (let i = 0; i < BOTS; i++) {
  startBot(i);
  if (i % RAMP_PER_S === RAMP_PER_S - 1) await new Promise((r) => setTimeout(r, 1000));
}
const t0 = Date.now();
const report = setInterval(() => {
  const s = (Date.now() - t0) / 1000;
  console.log(`t=${s.toFixed(0)}s connected=${connected} failed=${failed} in=${(msgsIn / s).toFixed(0)} msg/s ${(bytesIn / s / 1024).toFixed(0)} KB/s`);
}, 5000);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(report);
latencies.sort((a, b) => a - b);
const pct = (p: number) => (latencies.length ? latencies[Math.floor(latencies.length * p)].toFixed(1) : '-');
const metrics = await fetch(TARGET + '/metrics').then((r) => r.text()).catch(() => '');
console.log('\nrooms:', Object.fromEntries([...rooms].sort()));
console.log(`connected ${connected}/${BOTS}, errors ${failed}`);
console.log(`ping RTT p50=${pct(0.5)}ms p95=${pct(0.95)}ms p99=${pct(0.99)}ms`);
console.log(metrics.split('\n').filter((l) => /last_tick|players|rooms|dropped/.test(l)).join('\n'));
for (const ws of sockets) ws.terminate();
process.exit(0);
