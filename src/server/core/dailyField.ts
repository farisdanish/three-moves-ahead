import type { CrowdHint, FieldComposition } from '../../shared/api.ts';
import {
  FIELD_GHOST_COUNT,
  getModifierForUtcDate,
  previousUtcDayId,
  type ModifierId,
  type Move,
  type Strategy,
} from '../../shared/engine.ts';
import {
  generateDailyBotStrategies,
  parseStrategyKey,
} from './botGenerator.ts';
import {
  DAY_TTL_SECONDS,
  MAX_WATCH_RETRIES,
  MIN_CROWD_HINT_HUMANS,
  REDIS_KEYS,
  type ArenaRedisClient,
} from './redisTypes.ts';
import {
  ArenaTransientConflictError,
  createSeededRng,
} from './seedAndIdentity.ts';

export type GhostEntry = {
  readonly moves: Strategy;
  readonly source: 'human' | 'bot';
};

export type DailyFieldRecord = {
  readonly version: 1;
  readonly dayId: string;
  readonly modifierId: ModifierId;
  readonly ghosts: readonly GhostEntry[];
  readonly humanCount: number;
  readonly botCount: number;
  readonly yesterdayHumanCount: number;
  readonly hint: CrowdHint;
  readonly createdAt: string;
};

export type CrowdSlotCounts = {
  readonly A: number;
  readonly D: number;
  readonly C: number;
};

const MOVE_NAMES: Record<Move, string> = {
  A: 'Attack',
  D: 'Defend',
  C: 'Counter',
};

const SLOT_LABELS: Record<0 | 1 | 2, 'opening' | 'middle' | 'closing'> = {
  0: 'opening',
  1: 'middle',
  2: 'closing',
};

export function toFieldComposition(field: DailyFieldRecord): FieldComposition {
  return {
    humans: field.humanCount,
    bots: field.botCount,
    isStarterArena: field.humanCount === 0,
    yesterdayHumanCount: field.yesterdayHumanCount,
  };
}

/**
 * Computes the single daily historical crowd hint from closed day `D-1`'s human move counts.
 * Never reveals hints when fewer than `MIN_CROWD_HINT_HUMANS` (10) humans played on `D-1`,
 * and reports ties explicitly rather than breaking them arbitrarily.
 */
export function computeCrowdHint(params: {
  readonly masterSeed: string;
  readonly dayId: string;
  readonly yesterdayHumanCount: number;
  readonly slotCounts: readonly [CrowdSlotCounts, CrowdSlotCounts, CrowdSlotCounts];
}): CrowdHint {
  const { masterSeed, dayId, yesterdayHumanCount, slotCounts } = params;

  if (yesterdayHumanCount < MIN_CROWD_HINT_HUMANS) {
    return {
      status: 'insufficient_data',
      message: 'Not enough player data yet',
    };
  }

  const rng = createSeededRng(masterSeed, `daily-hint:${dayId}`);
  const rawSlot = rng.nextInt(3);
  const slot: 0 | 1 | 2 = rawSlot === 0 ? 0 : rawSlot === 1 ? 1 : 2;
  const slotLabel = SLOT_LABELS[slot];
  const counts = slotCounts[slot];

  const entries: readonly { readonly move: Move; readonly count: number }[] = [
    { move: 'A', count: counts.A },
    { move: 'D', count: counts.D },
    { move: 'C', count: counts.C },
  ];

  const maxCount = Math.max(counts.A, counts.D, counts.C);
  if (maxCount <= 0) {
    return {
      status: 'insufficient_data',
      message: 'Not enough player data yet',
    };
  }

  const leaders = entries.filter((entry) => entry.count === maxCount);
  if (leaders.length !== 1 || !leaders[0]) {
    return {
      status: 'ready',
      slot,
      slotLabel,
      topMove: null,
      message: `Mixed tactics in the ${slotLabel} position`,
    };
  }

  const topMove = leaders[0].move;
  return {
    status: 'ready',
    slot,
    slotLabel,
    topMove,
    message: `Yesterday, ${MOVE_NAMES[topMove]} was the most common ${slotLabel} move.`,
  };
}

function parseCrowdHash(raw: Record<string, string>): CrowdSlotCounts {
  const toNonNegInt = (val: string | undefined): number => {
    const parsed = Number(val ?? '0');
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  };
  return {
    A: toNonNegInt(raw['A']),
    D: toNonNegInt(raw['D']),
    C: toNonNegInt(raw['C']),
  };
}

function parseDailyFieldRecord(rawJson: string): DailyFieldRecord | null {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!('version' in parsed) || parsed.version !== 1) return null;
    if (!('dayId' in parsed) || typeof parsed.dayId !== 'string') return null;
    if (
      !('modifierId' in parsed) ||
      (parsed.modifierId !== 'classic' &&
        parsed.modifierId !== 'draw_day' &&
        parsed.modifierId !== 'sweep_bonus')
    ) {
      return null;
    }
    if (
      !('ghosts' in parsed) ||
      !Array.isArray(parsed.ghosts) ||
      parsed.ghosts.length !== FIELD_GHOST_COUNT
    ) {
      return null;
    }

    const ghosts: GhostEntry[] = [];
    for (const item of parsed.ghosts) {
      if (typeof item !== 'object' || item === null) return null;
      if (
        !('source' in item) ||
        (item.source !== 'human' && item.source !== 'bot')
      ) {
        return null;
      }
      if (!('moves' in item) || !Array.isArray(item.moves)) return null;
      const moveStr = item.moves.join(',');
      const strategy = parseStrategyKey(moveStr);
      if (!strategy) return null;
      ghosts.push({ moves: strategy, source: item.source });
    }

    const humanCount =
      'humanCount' in parsed && typeof parsed.humanCount === 'number'
        ? parsed.humanCount
        : ghosts.filter((g) => g.source === 'human').length;
    const botCount =
      'botCount' in parsed && typeof parsed.botCount === 'number'
        ? parsed.botCount
        : ghosts.length - humanCount;
    const yesterdayHumanCount =
      'yesterdayHumanCount' in parsed &&
      typeof parsed.yesterdayHumanCount === 'number'
        ? parsed.yesterdayHumanCount
        : humanCount;
    const createdAt =
      'createdAt' in parsed && typeof parsed.createdAt === 'string'
        ? parsed.createdAt
        : new Date(0).toISOString();

    let hint: CrowdHint = {
      status: 'insufficient_data',
      message: 'Not enough player data yet',
    };
    if (
      'hint' in parsed &&
      typeof parsed.hint === 'object' &&
      parsed.hint !== null &&
      'status' in parsed.hint &&
      'message' in parsed.hint &&
      typeof parsed.hint.message === 'string'
    ) {
      if (parsed.hint.status === 'insufficient_data') {
        hint = {
          status: 'insufficient_data',
          message: parsed.hint.message,
        };
      } else if (
        parsed.hint.status === 'ready' &&
        'slot' in parsed.hint &&
        (parsed.hint.slot === 0 ||
          parsed.hint.slot === 1 ||
          parsed.hint.slot === 2) &&
        'slotLabel' in parsed.hint &&
        (parsed.hint.slotLabel === 'opening' ||
          parsed.hint.slotLabel === 'middle' ||
          parsed.hint.slotLabel === 'closing') &&
        'topMove' in parsed.hint &&
        (parsed.hint.topMove === 'A' ||
          parsed.hint.topMove === 'D' ||
          parsed.hint.topMove === 'C' ||
          parsed.hint.topMove === null)
      ) {
        hint = {
          status: 'ready',
          slot: parsed.hint.slot,
          slotLabel: parsed.hint.slotLabel,
          topMove: parsed.hint.topMove,
          message: parsed.hint.message,
        };
      }
    }

    return {
      version: 1,
      dayId: parsed.dayId,
      modifierId: parsed.modifierId,
      ghosts,
      humanCount,
      botCount,
      yesterdayHumanCount,
      hint,
      createdAt,
    };
  } catch {
    return null;
  }
}

async function scanAllEntrants(
  redis: ArenaRedisClient,
  entrantsKey: string
): Promise<readonly { readonly field: string; readonly strategy: Strategy }[]> {
  const collected = new Map<string, Strategy>();
  let cursor = 0;
  let pages = 0;
  const maxPages = 50;

  do {
    const page = await redis.hScan(entrantsKey, cursor, undefined, 200);
    for (const item of page.fieldValues) {
      const strategy = parseStrategyKey(item.value);
      if (strategy) {
        collected.set(item.field, strategy);
      }
    }
    cursor = page.cursor;
    pages += 1;
  } while (cursor !== 0 && pages < maxPages);

  const entries = [...collected.entries()].map(([field, strategy]) => ({
    field,
    strategy,
  }));
  // Sort by opaqueUserId before seeded shuffle so sampling is independent of Redis hash iteration order.
  entries.sort((a, b) => a.field.localeCompare(b.field));
  return entries;
}

/**
 * Two-phase atomic initializer for `day:{D}:field`:
 * - Phase A: Atomically sets `day:{D-1}:closed` (`45d` TTL) via `WATCH/MULTI/EXEC` so no late
 *   day `D-1` submission can commit after `D` begins scanning `D-1` entrants.
 * - Phase B: Watches `day:{D}:field` and immediately re-reads it after `WATCH` (returning existing
 *   field if another worker initialized it first); otherwise scans frozen `day:{D-1}:entrants` via
 *   `hScan`, samples up to 9 humans uniformly without replacement, fills remaining slots with daily
 *   bots, computes the `D-1` crowd hint, and commits `day:{D}:field` (`45d` TTL).
 */
export async function ensureDailyField(params: {
  readonly redis: ArenaRedisClient;
  readonly masterSeed: string;
  readonly dayId: string;
  readonly now?: () => number;
}): Promise<DailyFieldRecord> {
  const { redis, masterSeed, dayId } = params;
  const nowFn = params.now ?? Date.now;
  const fieldKey = REDIS_KEYS.dayField(dayId);

  const existingRaw = await redis.get(fieldKey);
  if (existingRaw) {
    const parsed = parseDailyFieldRecord(existingRaw);
    if (parsed) return parsed;
  }

  const prevDayId = previousUtcDayId(dayId);
  const prevClosedKey = REDIS_KEYS.dayClosed(prevDayId);

  // Phase A: Atomically close day D-1 before scanning its entrants/crowd hashes.
  let phaseAConfirmedClosed = false;
  for (let attempt = 0; attempt < MAX_WATCH_RETRIES; attempt += 1) {
    const txn = await redis.watch(prevClosedKey, fieldKey);
    const [watchedFieldRaw, watchedClosedRaw] = await Promise.all([
      redis.get(fieldKey),
      redis.get(prevClosedKey),
    ]);

    if (watchedFieldRaw) {
      const parsed = parseDailyFieldRecord(watchedFieldRaw);
      if (parsed) {
        await txn.unwatch();
        return parsed;
      }
    }

    if (watchedClosedRaw) {
      await txn.unwatch();
      phaseAConfirmedClosed = true;
      break;
    }

    const closedPayload = JSON.stringify({
      closedAt: new Date(nowFn()).toISOString(),
    });
    await txn.multi();
    await txn.set(prevClosedKey, closedPayload);
    await txn.expire(prevClosedKey, DAY_TTL_SECONDS);
    const replies = await txn.exec();
    if (Array.isArray(replies) && replies.length > 0) {
      phaseAConfirmedClosed = true;
      break;
    }
  }

  if (!phaseAConfirmedClosed) {
    const [postPhaseAFieldRaw, postPhaseAClosedRaw] = await Promise.all([
      redis.get(fieldKey),
      redis.get(prevClosedKey),
    ]);
    if (postPhaseAFieldRaw) {
      const parsed = parseDailyFieldRecord(postPhaseAFieldRaw);
      if (parsed) return parsed;
    }
    if (!postPhaseAClosedRaw) {
      throw new ArenaTransientConflictError(
        `Unable to confirm day close barrier (${prevClosedKey}) before initializing field for ${dayId}`
      );
    }
  }

  // Phase B: Watch day:{D}:field, re-read immediately after WATCH, scan frozen D-1, and commit.
  for (let attempt = 0; attempt < MAX_WATCH_RETRIES; attempt += 1) {
    const txn = await redis.watch(fieldKey);
    const reReadRaw = await redis.get(fieldKey);
    if (reReadRaw) {
      const parsed = parseDailyFieldRecord(reReadRaw);
      if (parsed) {
        await txn.unwatch();
        return parsed;
      }
    }

    const prevEntrantsKey = REDIS_KEYS.dayEntrants(prevDayId);
    const [entrants, rawCrowd0, rawCrowd1, rawCrowd2] = await Promise.all([
      scanAllEntrants(redis, prevEntrantsKey),
      redis.hGetAll(REDIS_KEYS.dayCrowdSlot(prevDayId, 0)),
      redis.hGetAll(REDIS_KEYS.dayCrowdSlot(prevDayId, 1)),
      redis.hGetAll(REDIS_KEYS.dayCrowdSlot(prevDayId, 2)),
    ]);

    const yesterdayHumanCount = entrants.length;
    const rng = createSeededRng(masterSeed, `daily-field-sample:${dayId}`);
    const pool = [...entrants];
    const sampleCount = Math.min(FIELD_GHOST_COUNT, pool.length);
    const humanGhosts: GhostEntry[] = [];

    for (let i = 0; i < sampleCount; i += 1) {
      const pickIdx = i + rng.nextInt(pool.length - i);
      const picked = pool[pickIdx];
      const current = pool[i];
      if (picked && current) {
        pool[i] = picked;
        pool[pickIdx] = current;
        humanGhosts.push({ moves: picked.strategy, source: 'human' });
      }
    }

    const botCount = FIELD_GHOST_COUNT - humanGhosts.length;
    const botStrategies = generateDailyBotStrategies(
      masterSeed,
      dayId,
      botCount
    );
    const botGhosts: GhostEntry[] = botStrategies.map((moves) => ({
      moves,
      source: 'bot',
    }));

    const combinedGhosts: GhostEntry[] = [...humanGhosts, ...botGhosts];
    for (let i = combinedGhosts.length - 1; i > 0; i -= 1) {
      const j = rng.nextInt(i + 1);
      const current = combinedGhosts[i];
      const swap = combinedGhosts[j];
      if (current && swap) {
        combinedGhosts[i] = swap;
        combinedGhosts[j] = current;
      }
    }

    const hint = computeCrowdHint({
      masterSeed,
      dayId,
      yesterdayHumanCount,
      slotCounts: [
        parseCrowdHash(rawCrowd0),
        parseCrowdHash(rawCrowd1),
        parseCrowdHash(rawCrowd2),
      ],
    });

    const record: DailyFieldRecord = {
      version: 1,
      dayId,
      modifierId: getModifierForUtcDate(dayId),
      ghosts: combinedGhosts,
      humanCount: humanGhosts.length,
      botCount,
      yesterdayHumanCount,
      hint,
      createdAt: new Date(nowFn()).toISOString(),
    };

    await txn.multi();
    await txn.set(fieldKey, JSON.stringify(record));
    await txn.expire(fieldKey, DAY_TTL_SECONDS);
    const replies = await txn.exec();
    if (Array.isArray(replies) && replies.length > 0) {
      return record;
    }

    const concurrentRaw = await redis.get(fieldKey);
    if (concurrentRaw) {
      const parsed = parseDailyFieldRecord(concurrentRaw);
      if (parsed) return parsed;
    }
  }

  const finalRaw = await redis.get(fieldKey);
  if (finalRaw) {
    const parsed = parseDailyFieldRecord(finalRaw);
    if (parsed) return parsed;
  }
  throw new ArenaTransientConflictError(
    `Failed to initialize daily field for ${dayId}`
  );
}
