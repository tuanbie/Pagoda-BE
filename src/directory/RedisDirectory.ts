import { Redis } from 'ioredis';
import type { RoomInfo } from '@sontu/shared';
import type { Directory } from './Directory.ts';

const PREFIX = 'sontu:node:';
const TTL_S = 5;

export class RedisDirectory implements Directory {
  private redis: Redis;
  private cache: { at: number; rooms: RoomInfo[] } = { at: 0, rooms: [] };

  constructor(
    url: string,
    private nodeId: string,
  ) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
  }

  async publish(rooms: RoomInfo[]) {
    // one key per node; dead nodes disappear automatically after TTL
    await this.redis.set(PREFIX + this.nodeId, JSON.stringify(rooms), 'EX', TTL_S);
  }

  /** Cached for 500 ms so a burst of /api/rooms calls costs one Redis round-trip. */
  async list() {
    if (Date.now() - this.cache.at < 500) return this.cache.rooms;
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', PREFIX + '*', 'COUNT', 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    const values = keys.length ? await this.redis.mget(keys) : [];
    const rooms = values.flatMap((v) => (v ? (JSON.parse(v) as RoomInfo[]) : [])).sort((a, b) => a.num - b.num);
    this.cache = { at: Date.now(), rooms };
    return rooms;
  }

  async close() {
    await this.redis.del(PREFIX + this.nodeId).catch(() => {});
    this.redis.disconnect();
  }
}
