import type { RoomInfo } from '@sontu/shared';

/**
 * Room directory: which rooms exist across ALL nodes and how full they are.
 * Single node -> in-memory. Many nodes -> Redis (each node publishes its rooms with a TTL).
 */
export interface Directory {
  publish(rooms: RoomInfo[]): Promise<void>;
  list(): Promise<RoomInfo[]>;
  close(): Promise<void>;
}

export class MemoryDirectory implements Directory {
  private rooms: RoomInfo[] = [];
  async publish(rooms: RoomInfo[]) {
    this.rooms = rooms;
  }
  async list() {
    return this.rooms;
  }
  async close() {}
}
