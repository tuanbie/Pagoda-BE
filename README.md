# Tịnh Tâm Tự (淨心寺) — Realtime Backend

The realtime server for a 3D online temple (frontend: https://github.com/tuanbie/Pagoda-Turio).
Built with Node 22, TypeScript, Fastify and `ws`. Redis is optional and only used as a room directory for multi-node setups.

## What it does
- **Rooms:** sharded rooms of up to 100 people. Rooms open and close automatically with load, and resume tokens let a visitor reconnect with the same name and position.
- **10 Hz tick:** each tick sends only what changed, serialised **once per room** and fanned out to everyone (O(n)).
- **Server-authoritative features:**
  - cushions (60 seats) and seat requests (ask / give / decline / timeout);
  - incense queue with burning sticks;
  - group chat (rate-limited, history of 40);
  - display names (sanitised);
  - bell and drum strikes;
  - DJ playlist with a shared queue.
- **Protection:**
  - token bucket per connection;
  - 1 KB maximum payload;
  - type validation on every message;
  - connection limit per IP (`X-Forwarded-For` is trusted only with `TRUST_PROXY=1`);
  - origin allow-list;
  - heartbeat;
  - backpressure (slow clients get a full snapshot later instead of an unbounded buffer);
  - graceful shutdown.
- **Observability:** `/api/health` and Prometheus `/metrics`.

## Run
```bash
npm install
npm run dev                         # tsx watch, :8787
npm run build && npm start          # esbuild bundle → dist/main.js
npm run e2e                         # 29 protocol tests against a real node
MAX_CONN_PER_IP=100000 npm start &  # then:
BOTS=2000 SECONDS=20 npm run load   # load test
docker compose up --build           # nginx :8080 + 2 nodes + redis
```

## Configuration (environment variables)
| Var | Default | Meaning |
|---|---|---|
| `PORT` | 8787 | HTTP / WebSocket port |
| `NODE_ID` | n1 | Unique id when running several nodes |
| `PUBLIC_WS_URL` | /ws | URL clients use to reach this node |
| `ROOM_NUMBER_BASE` | 0 | Room numbers shown to users (node 2 → 101…) |
| `ROOM_CAPACITY` | 100 | Maximum people per room |
| `MIN_ROOMS` / `MAX_ROOMS` | 2 / 50 | Rooms kept warm / hard cap per node |
| `REDIS_URL` | – | Enables the shared room directory |
| `STATIC_DIR` | – | Serve a built frontend from this folder |
| `ALLOWED_ORIGINS` | – | Comma-separated WebSocket origin allow-list |
| `MAX_CONN_PER_IP` | 20 | Concurrent sockets per IP |
| `TRUST_PROXY` | 0 | Set to 1 behind your own reverse proxy |
| `ADMIN_KEY` | – | Key to read feedback from outside localhost (sent as a header, never in the URL) |
| `FEEDBACK_FILE` | data/feedback.jsonl | Where feedback goes when Redis is not configured |

## Privacy
The server keeps no personal data.
- **Feedback** (`POST /api/feedback`) stores only the kind, the message, the UI language and the time. No name, contact or IP address is stored, and entries older than 12 months are deleted. Entries from older versions are scrubbed of those fields automatically.
- **Chat and display names** live in memory only: the last 40 messages per room, gone on restart.
- **IP addresses** are used in memory to limit connections and feedback spam, and never written down. Request logs carry only the method and path.
- **Reading feedback** from outside localhost needs `ADMIN_KEY`: `Authorization: Bearer <key>` for `/api/feedback`. `/admin/feedback` asks for a password in the browser (any user name, the key as password).

## Measured
On one node, 2000 bots moving at 10 Hz split into 20 full rooms with 0 errors and 0 dropped messages. Each tick took ~30 ms of its 100 ms budget, and ping p95 was 81 ms.
