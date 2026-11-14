import type { HScanResponse, TxClientLike, ZMember, ZRangeOptions } from '@devvit/web/server';

export type SpikeRedisClient = {
  watch(...keys: string[]): Promise<TxClientLike>;
  get(key: string): Promise<string | undefined>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hLen(key: string): Promise<number>;
  hScan(
    key: string,
    cursor: number,
    pattern?: string,
    count?: number
  ): Promise<HScanResponse>;
  zCard(key: string): Promise<number>;
  zScore(key: string, member: string): Promise<number | undefined>;
  zRange(
    key: string,
    start: number | string,
    stop: number | string,
    options?: ZRangeOptions
  ): Promise<ZMember[]>;
  del(...keys: string[]): Promise<void>;
};

export type SpikeCommentRecord = {
  readonly status: 'reserved' | 'created' | 'ambiguous_failed';
  readonly commentId?: string;
  readonly reservedAt: string;
};

export type SpikeDependencies = {
  readonly redis: SpikeRedisClient;
  readonly settings: {
    getAll(): Promise<Record<string, unknown>>;
  };
  readonly reddit: {
    submitComment(opts: { id: `t3_${string}` | `t1_${string}`; text: string }): Promise<{
      id: string;
      distinguish(makeSticky?: boolean): Promise<void>;
    }>;
  };
  readonly postId: `t3_${string}`;
  readonly now?: () => number;
};

export type SpikeOutcome = {
  readonly ok: boolean;
  readonly redisWatchMultiExec: string;
  readonly redisCommands: string;
  readonly settingsAccess: string;
  readonly submitCommentAndPin: string;
  readonly notes: readonly string[];
};

const SPIKE_TTL_SECONDS = 60;

function validateRedisReads(params: {
  strVal: string | undefined;
  hashAll: Record<string, string>;
  hashLen: number;
  hashScan: HScanResponse;
  zCardVal: number;
  zScoreVal: number | undefined;
  topRows: ZMember[];
}): string | null {
  const { strVal, hashAll, hashLen, hashScan, zCardVal, zScoreVal, topRows } = params;

  if (strVal !== 'ok') {
    return `expected string "ok", got ${String(strVal)}`;
  }
  const hashKeys = Object.keys(hashAll);
  if (hashKeys.length !== 1 || hashAll['38'] !== '2') {
    return `expected hash {"38":"2"}, got ${JSON.stringify(hashAll)}`;
  }
  if (hashLen !== 1) {
    return `expected hLen 1, got ${hashLen}`;
  }
  const hasScannedEntry = hashScan.fieldValues.some(
    (entry) => entry.field === '38' && entry.value === '2'
  );
  if (!hasScannedEntry) {
    return `expected hScan to include 38=2, got ${JSON.stringify(hashScan.fieldValues)}`;
  }
  if (zCardVal !== 2) {
    return `expected zCard 2, got ${zCardVal}`;
  }
  if (zScoreVal !== 38) {
    return `expected zScore(p1)=38, got ${String(zScoreVal)}`;
  }
  const first = topRows[0];
  const second = topRows[1];
  if (
    topRows.length !== 2 ||
    first?.member !== 'p2' ||
    first?.score !== 44 ||
    second?.member !== 'p1' ||
    second?.score !== 38
  ) {
    return `expected descending topRows [p2:44, p1:38], got ${JSON.stringify(topRows)}`;
  }

  return null;
}

/**
 * Reserves at most one SDK-spike verification comment per postId so repeated
 * moderator runs never create duplicate APP comments.
 */
async function reserveSpikeComment(
  redis: SpikeRedisClient,
  reservationKey: string,
  nowIso: string
): Promise<'reserved_by_us' | SpikeCommentRecord> {
  const txn = await redis.watch(reservationKey);
  const existingRaw = await redis.get(reservationKey);
  if (existingRaw) {
    await txn.unwatch();
    const parsed: unknown = JSON.parse(existingRaw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'status' in parsed &&
      (parsed.status === 'reserved' ||
        parsed.status === 'created' ||
        parsed.status === 'ambiguous_failed') &&
      'reservedAt' in parsed &&
      typeof parsed.reservedAt === 'string'
    ) {
      return {
        status: parsed.status,
        reservedAt: parsed.reservedAt,
        ...('commentId' in parsed && typeof parsed.commentId === 'string'
          ? { commentId: parsed.commentId }
          : {}),
      };
    }
    return { status: 'ambiguous_failed', reservedAt: nowIso };
  }

  const record: SpikeCommentRecord = {
    status: 'reserved',
    reservedAt: nowIso,
  };
  await txn.multi();
  await txn.set(reservationKey, JSON.stringify(record));
  const replies = await txn.exec();
  if (!Array.isArray(replies) || replies.length === 0) {
    return { status: 'reserved', reservedAt: nowIso };
  }
  return 'reserved_by_us';
}

async function persistSpikeCommentState(
  redis: SpikeRedisClient,
  reservationKey: string,
  record: SpikeCommentRecord
): Promise<void> {
  const txn = await redis.watch(reservationKey);
  await txn.multi();
  await txn.set(reservationKey, JSON.stringify(record));
  await txn.exec();
}

/**
 * Exercises Devvit Redis transactions/commands, settings access, and single-shot
 * APP comment + distinguish(true) permissions for Devvit SDK verification.
 */
export async function runSdkSpike(deps: SpikeDependencies): Promise<SpikeOutcome> {
  const { redis, settings, reddit, postId } = deps;
  const nowMs = (deps.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();
  const notes: string[] = [];

  const spikeKey = `spike:str:${nowMs}`;
  const spikeHashKey = `spike:hash:${nowMs}`;
  const spikeBoardKey = `spike:zset:${nowMs}`;
  const commentLockKey = `spike:comment:${postId}`;

  let redisWatchMultiExec: string;
  let redisCommands = 'skipped';
  let settingsAccess: string;
  let submitCommentAndPin: string;

  try {
    const txn = await redis.watch(spikeKey);
    await txn.multi();
    await txn.set(spikeKey, 'ok');
    await txn.hIncrBy(spikeHashKey, '38', 2);
    await txn.zAdd(
      spikeBoardKey,
      { member: 'p1', score: 38 },
      { member: 'p2', score: 44 }
    );
    await txn.expire(spikeKey, SPIKE_TTL_SECONDS);
    await txn.expire(spikeHashKey, SPIKE_TTL_SECONDS);
    await txn.expire(spikeBoardKey, SPIKE_TTL_SECONDS);
    const execReplies = await txn.exec();

    if (!Array.isArray(execReplies) || execReplies.length === 0) {
      redisWatchMultiExec = 'fail: empty EXEC reply';
      notes.push('Redis EXEC returned no replies');
    } else {
      redisWatchMultiExec = `ok (replies=${execReplies.length})`;
      const [strVal, hashAll, hashLen, hashScan, zCardVal, zScoreVal, topRows] =
        await Promise.all([
          redis.get(spikeKey),
          redis.hGetAll(spikeHashKey),
          redis.hLen(spikeHashKey),
          redis.hScan(spikeHashKey, 0, undefined, 10),
          redis.zCard(spikeBoardKey),
          redis.zScore(spikeBoardKey, 'p1'),
          redis.zRange(spikeBoardKey, 0, 1, { by: 'rank', reverse: true }),
        ]);

      const validationError = validateRedisReads({
        strVal,
        hashAll,
        hashLen,
        hashScan,
        zCardVal,
        zScoreVal,
        topRows,
      });

      if (validationError) {
        redisCommands = `fail: ${validationError}`;
        notes.push(`Redis assertion failed: ${validationError}`);
      } else {
        redisCommands = `ok (hAll=${JSON.stringify(hashAll)}, hLen=${hashLen}, zCard=${zCardVal}, top=[p2:44,p1:38])`;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    redisWatchMultiExec = `fail: ${msg}`;
    notes.push(`Redis error: ${msg}`);
  } finally {
    await redis.del(spikeKey, spikeHashKey, spikeBoardKey).catch(() => undefined);
  }

  try {
    const allSettings = await settings.getAll();
    settingsAccess = `ok (keys=${Object.keys(allSettings).length})`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    settingsAccess = `fail: ${msg}`;
    notes.push(`Settings error: ${msg}`);
  }

  try {
    const reservation = await reserveSpikeComment(redis, commentLockKey, nowIso);
    if (reservation !== 'reserved_by_us') {
      if (reservation.status === 'created') {
        submitCommentAndPin = `skipped (already created${reservation.commentId ? `: ${reservation.commentId}` : ''})`;
      } else {
        submitCommentAndPin = `unverified (existing ${reservation.status} reservation at ${reservation.reservedAt})`;
        notes.push(
          `Comment submission blocked by unresolved ${reservation.status} reservation; verify post comments manually before retrying.`
        );
      }
    } else {
      try {
        const comment = await reddit.submitComment({
          id: postId,
          text: 'Three Moves Ahead SDK verification comment (safe to remove).',
        });
        await persistSpikeCommentState(redis, commentLockKey, {
          status: 'created',
          commentId: comment.id,
          reservedAt: nowIso,
        });
        try {
          await comment.distinguish(true);
          submitCommentAndPin = `ok (comment=${comment.id}, distinguished+pinned=true)`;
        } catch (pinErr) {
          const pinMsg = pinErr instanceof Error ? pinErr.message : String(pinErr);
          submitCommentAndPin = `partial (comment=${comment.id}, pin failed: ${pinMsg})`;
          notes.push(`Pin error: ${pinMsg}`);
        }
      } catch (commentErr) {
        await persistSpikeCommentState(redis, commentLockKey, {
          status: 'ambiguous_failed',
          reservedAt: nowIso,
        }).catch(() => undefined);
        const msg = commentErr instanceof Error ? commentErr.message : String(commentErr);
        submitCommentAndPin = `fail: ${msg}`;
        notes.push(`Comment error: ${msg}`);
      }
    }
  } catch (lockErr) {
    const msg = lockErr instanceof Error ? lockErr.message : String(lockErr);
    submitCommentAndPin = `fail: ${msg}`;
    notes.push(`Comment reservation error: ${msg}`);
  }

  const ok =
    redisWatchMultiExec.startsWith('ok') &&
    redisCommands.startsWith('ok') &&
    settingsAccess.startsWith('ok') &&
    (submitCommentAndPin.startsWith('ok') ||
      submitCommentAndPin.startsWith('partial') ||
      submitCommentAndPin.startsWith('skipped (already created'));

  return {
    ok,
    redisWatchMultiExec,
    redisCommands,
    settingsAccess,
    submitCommentAndPin,
    notes,
  };
}
