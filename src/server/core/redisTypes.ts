import type {
  HScanResponse,
  SetOptions,
  TxClientLike,
  ZMember,
  ZRangeOptions,
} from '@devvit/web/server';

export const DAY_TTL_SECONDS = 45 * 86_400;
export const STREAK_TTL_SECONDS = 90 * 86_400;
export const MAX_DAILY_RANKED_ENTRIES = 2_000;
export const MIN_CROWD_HINT_HUMANS = 10;
export const MAX_BOARD_ROWS = 50;
export const MAX_WATCH_RETRIES = 5;

export const REDIS_KEYS = {
  settingsSeed: 'settings:seed',
  postHub: 'post:hub',
  postDaily: (dayId: string): string => `post:daily:${dayId}`,
  dayField: (dayId: string): string => `day:${dayId}:field`,
  dayClosed: (dayId: string): string => `day:${dayId}:closed`,
  dayEntrants: (dayId: string): string => `day:${dayId}:entrants`,
  dayBoard: (dayId: string): string => `day:${dayId}:board`,
  dayScoreCounts: (dayId: string): string => `day:${dayId}:score_counts`,
  dayCrowdSlot: (dayId: string, slot: 0 | 1 | 2): string =>
    `day:${dayId}:crowd:${slot}`,
  rankedEntry: (dayId: string, userId: string): string =>
    `ranked:${dayId}:${userId}`,
  streakEntry: (userId: string): string => `streak:${userId}`,
};

export type ArenaRedisClient = {
  watch(...keys: string[]): Promise<TxClientLike>;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, options?: SetOptions): Promise<string>;
  hGet(key: string, field: string): Promise<string | undefined>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hLen(key: string): Promise<number>;
  hScan(
    key: string,
    cursor: number,
    pattern?: string,
    count?: number
  ): Promise<HScanResponse>;
  hSet(key: string, fieldValues: Record<string, string>): Promise<number>;
  hIncrBy(key: string, field: string, value: number): Promise<number>;
  zCard(key: string): Promise<number>;
  zScore(key: string, member: string): Promise<number | undefined>;
  zRange(
    key: string,
    start: number | string,
    stop: number | string,
    options?: ZRangeOptions
  ): Promise<ZMember[]>;
  expire(key: string, seconds: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
};

export type ArenaSettingsClient = {
  getAll(): Promise<Record<string, unknown>>;
};
