import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  MAX_WATCH_RETRIES,
  REDIS_KEYS,
  type ArenaRedisClient,
  type ArenaSettingsClient,
} from './redisTypes.ts';

export type SeededRng = {
  nextUint32(): number;
  nextInt(maxExclusive: number): number;
};

export class ArenaTransientConflictError extends Error {
  readonly code = 'TRANSACTION_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'ArenaTransientConflictError';
  }
}

/**
 * Resolves the server-only master seed with single-source-of-truth stability:
 * 1. Reads `settings:seed` from Redis first; once persisted, it is immutable across all
 *    requests so a transient `settings.getAll()` failure can never switch the active seed
 *    or alter player leaderboard identities.
 * 2. On first bootstrap (when `settings:seed` is absent), reads `settings.getAll()` for a
 *    configured `botSeed`/`seed` (failing with a retryable error if `settings.getAll()` throws
 *    before `settings:seed` is established, rather than silently generating a conflicting seed),
 *    and atomically persists the chosen seed into `settings:seed` via `WATCH/MULTI/EXEC`.
 */
export async function getOrCreateMasterSeed(deps: {
  readonly redis: ArenaRedisClient;
  readonly settings: ArenaSettingsClient;
}): Promise<string> {
  const { redis, settings } = deps;

  const existingFast = await redis.get(REDIS_KEYS.settingsSeed);
  if (typeof existingFast === 'string' && existingFast.length >= 16) {
    return existingFast;
  }

  let configuredSeed: string | null = null;
  try {
    const allSettings = await settings.getAll();
    const rawConfigured = allSettings['botSeed'] ?? allSettings['seed'];
    if (
      typeof rawConfigured === 'string' &&
      rawConfigured.trim().length >= 16
    ) {
      configuredSeed = rawConfigured.trim();
    }
  } catch (err) {
    // Re-check Redis in case another worker persisted `settings:seed` concurrently.
    const fallbackExisting = await redis.get(REDIS_KEYS.settingsSeed);
    if (typeof fallbackExisting === 'string' && fallbackExisting.length >= 16) {
      return fallbackExisting;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new ArenaTransientConflictError(
      `Unable to read app settings during initial seed bootstrap: ${detail}`
    );
  }

  for (let attempt = 0; attempt < MAX_WATCH_RETRIES; attempt += 1) {
    const txn = await redis.watch(REDIS_KEYS.settingsSeed);
    const existingWatched = await redis.get(REDIS_KEYS.settingsSeed);
    if (typeof existingWatched === 'string' && existingWatched.length >= 16) {
      await txn.unwatch();
      return existingWatched;
    }

    const candidate = configuredSeed ?? randomBytes(32).toString('hex');
    await txn.multi();
    await txn.set(REDIS_KEYS.settingsSeed, candidate);
    const replies = await txn.exec();
    if (Array.isArray(replies) && replies.length > 0) {
      return candidate;
    }

    const committed = await redis.get(REDIS_KEYS.settingsSeed);
    if (typeof committed === 'string' && committed.length >= 16) {
      return committed;
    }
  }

  const finalRead = await redis.get(REDIS_KEYS.settingsSeed);
  if (typeof finalRead === 'string' && finalRead.length >= 16) {
    return finalRead;
  }
  throw new ArenaTransientConflictError(
    'Failed to confirm server-only master seed initialization in Redis'
  );
}

/**
 * Derives an installation-scoped, collision-resistant 16-hex-character opaque ID
 * for a Reddit user ID. Never exposes raw `t2_...` IDs in Redis hashes or sorted sets.
 */
export function deriveOpaqueUserId(
  masterSeed: string,
  subredditId: string,
  userId: string
): string {
  return createHmac('sha256', masterSeed)
    .update(`entrant:${subredditId}:${userId}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Formats an opaque user ID into a public pseudonymous leaderboard handle (`Player #XXXX`).
 */
export function formatPlayerLabel(opaqueUserId: string): string {
  const code = opaqueUserId.slice(0, 4).toUpperCase().padEnd(4, '0');
  return `Player #${code}`;
}

/**
 * Creates a deterministic SHA-256 counter-mode PRNG scoped by master seed and context label.
 */
export function createSeededRng(
  masterSeed: string,
  contextLabel: string
): SeededRng {
  let counter = 0;
  let buffer = Buffer.alloc(0);
  let offset = 0;

  const refill = (): void => {
    const hmac = createHmac('sha256', masterSeed);
    hmac.update(`${contextLabel}:${counter}`);
    buffer = hmac.digest();
    offset = 0;
    counter += 1;
  };

  const nextUint32 = (): number => {
    if (offset + 4 > buffer.length) {
      refill();
    }
    const value = buffer.readUInt32BE(offset);
    offset += 4;
    return value;
  };

  const nextInt = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`Invalid maxExclusive: ${maxExclusive}`);
    }
    if (maxExclusive === 1) {
      return 0;
    }
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
    while (true) {
      const sample = nextUint32();
      if (sample < limit) {
        return sample % maxExclusive;
      }
    }
  };

  return { nextUint32, nextInt };
}

/**
 * Computes a deterministic sub-seed string for a specific UTC day and purpose.
 */
export function deriveDailyPurposeSeed(
  masterSeed: string,
  dayId: string,
  purpose: string
): string {
  return createHash('sha256')
    .update(`${masterSeed}:${purpose}:${dayId}`)
    .digest('hex');
}
