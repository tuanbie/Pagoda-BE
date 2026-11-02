// Vercel Function: the whole realtime server (HTTP API + WebSocket) as one function.
// `npm run build` bundles the TypeScript app into dist/main.js first.
import { server } from '../dist/main.js';

export default server;
