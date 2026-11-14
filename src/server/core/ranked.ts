import type {
  ApiErrorResponse,
  BoardResponse,
  FieldComposition,
  LeaderboardRow,
  RankedResultPayload,
  RankedSubmitResponse,
  ResultRecoveryResponse,
  StreakRecord,
} from '../../shared/api.ts';
import {
  computeSharedRankFromCounts,
  formatUtcDayId,
  getMaxScore,
  getModifierForUtcDate,
  isValidUtcDayId,
  previousUtcDayId,
  scoreStrategy,
  type ExchangeSummary,
  type ModifierId,
  type Strategy,
} from '../../shared/engine.ts';
import { formatStrategyKey, parseStrategyKey } from './botGenerator.ts';
import { ensureDailyField, toFieldComposition } from './dailyField.ts';
import {
  DAY_TTL_SECONDS,
  MAX_BOARD_ROWS,
  MAX_DAILY_RANKED_ENTRIES,
  MAX_WATCH_RETRIES,
  REDIS_KEYS,
  STREAK_TTL_SECONDS,
  type ArenaRedisClient,
} from './redisTypes.ts';
import {
  ArenaTransientConflictError,
  deriveOpaqueUserId,
  formatPlayerLabel,
} from './seedAndIdentity.ts';

export type StoredRankedRecord = {
  readonly dayId: string;
  readonly modifier: ModifierId;
  readonly moves: Strategy;
  readonly rawScore: number;
  readonly maxScore: number;
  readonly normalizedScore: number;
  readonly exchangeSummary: ExchangeSummary;
  readonly fieldVersion: number;
  readonly submittedAt: string;
  readonly streak: StreakRecord;
  readonly composition: FieldComposition;
};

export type RankedServiceOutcome =
  | {
      readonly ok: true;
      readonly status: 200;
      readonly body: RankedSubmitResponse;
    }
  | {
      readonly ok: false;
      readonly status: 400 | 401 | 403 | 409 | 503;
      readonly body: ApiErrorResponse;
    };

export function parseScoreCountsHash(raw: Record<string, string>): {
  readonly countsByScore: Record<string, number>;
  readonly totalPlayers: number;
} {
  const countsByScore: Record<string, number> = {};
  let totalPlayers = 0;

  for (const [key, val] of Object.entries(raw)) {
    const score = Number(key);
    const count = Number(val);
    if (
      Number.isInteger(score) &&
      score >= 0 &&
      Number.isInteger(count) &&
      count > 0
    ) {
      countsByScore[String(score)] = count;
      totalPlayers += count;
    }
  }

  return { countsByScore, totalPlayers };
}

export function parseStreakRecord(
  rawJson: string | undefined
): StreakRecord | null {
  if (!rawJson) return null;
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (
      !('lastPlayedDay' in parsed) ||
      typeof parsed.lastPlayedDay !== 'string' ||
      !isValidUtcDayId(parsed.lastPlayedDay)
    ) {
      return null;
    }
    if (
      !('currentCount' in parsed) ||
      typeof parsed.currentCount !== 'number' ||
      !Number.isInteger(parsed.currentCount) ||
      parsed.currentCount < 1
    ) {
      return null;
    }
    if (
      !('bestCount' in parsed) ||
      typeof parsed.bestCount !== 'number' ||
      !Number.isInteger(parsed.bestCount) ||
      parsed.bestCount < 1
    ) {
      return null;
    }
    return {
      lastPlayedDay: parsed.lastPlayedDay,
      currentCount: parsed.currentCount,
      bestCount: parsed.bestCount,
    };
  } catch {
    return null;
  }
}

export function parseStoredRankedRecord(
  rawJson: string | undefined,
  fallbackDayId: string
): StoredRankedRecord | null {
  if (!rawJson) return null;
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!('moves' in parsed) || !Array.isArray(parsed.moves)) return null;
    const strategy = parseStrategyKey(parsed.moves.join(','));
    if (!strategy) return null;

    if (
      !('rawScore' in parsed) ||
      typeof parsed.rawScore !== 'number' ||
      !Number.isInteger(parsed.rawScore)
    ) {
      return null;
    }
    if (
      !('normalizedScore' in parsed) ||
      typeof parsed.normalizedScore !== 'number'
    ) {
      return null;
    }
    if (
      !('exchangeSummary' in parsed) ||
      typeof parsed.exchangeSummary !== 'object' ||
      parsed.exchangeSummary === null
    ) {
      return null;
    }
    const summaryObj = parsed.exchangeSummary;
    const wins =
      'wins' in summaryObj && typeof summaryObj.wins === 'number'
        ? summaryObj.wins
        : 0;
    const ties =
      'ties' in summaryObj && typeof summaryObj.ties === 'number'
        ? summaryObj.ties
        : 0;
    const losses =
      'losses' in summaryObj && typeof summaryObj.losses === 'number'
        ? summaryObj.losses
        : 0;
    const sweeps =
      'sweeps' in summaryObj && typeof summaryObj.sweeps === 'number'
        ? summaryObj.sweeps
        : 0;

    const dayId =
      'dayId' in parsed &&
      typeof parsed.dayId === 'string' &&
      isValidUtcDayId(parsed.dayId)
        ? parsed.dayId
        : fallbackDayId;
    const modifier: ModifierId =
      'modifier' in parsed &&
      (parsed.modifier === 'classic' ||
        parsed.modifier === 'draw_day' ||
        parsed.modifier === 'sweep_bonus')
        ? parsed.modifier
        : getModifierForUtcDate(dayId);
    const maxScore =
      'maxScore' in parsed && typeof parsed.maxScore === 'number'
        ? parsed.maxScore
        : getMaxScore(modifier);
    const fieldVersion =
      'fieldVersion' in parsed && typeof parsed.fieldVersion === 'number'
        ? parsed.fieldVersion
        : 1;
    const submittedAt =
      'submittedAt' in parsed && typeof parsed.submittedAt === 'string'
        ? parsed.submittedAt
        : new Date(0).toISOString();

    let streak: StreakRecord = {
      lastPlayedDay: dayId,
      currentCount: 1,
      bestCount: 1,
    };
    if (
      'streak' in parsed &&
      typeof parsed.streak === 'object' &&
      parsed.streak !== null
    ) {
      const parsedStreak = parseStreakRecord(JSON.stringify(parsed.streak));
      if (parsedStreak) {
        streak = parsedStreak;
      }
    }

    let composition: FieldComposition = {
      humans: 0,
      bots: 9,
      isStarterArena: true,
      yesterdayHumanCount: 0,
    };
    if (
      'composition' in parsed &&
      typeof parsed.composition === 'object' &&
      parsed.composition !== null &&
      'humans' in parsed.composition &&
      typeof parsed.composition.humans === 'number' &&
      'bots' in parsed.composition &&
      typeof parsed.composition.bots === 'number'
    ) {
      const humans = parsed.composition.humans;
      const bots = parsed.composition.bots;
      const yesterdayHumanCount =
        'yesterdayHumanCount' in parsed.composition &&
        typeof parsed.composition.yesterdayHumanCount === 'number'
          ? parsed.composition.yesterdayHumanCount
          : humans;
      composition = {
        humans,
        bots,
        isStarterArena: humans === 0,
        yesterdayHumanCount,
      };
    }

    return {
      dayId,
      modifier,
      moves: strategy,
      rawScore: parsed.rawScore,
      maxScore,
      normalizedScore: parsed.normalizedScore,
      exchangeSummary: { wins, ties, losses, sweeps },
      fieldVersion,
      submittedAt,
      streak,
      composition,
    };
  } catch {
    return null;
  }
}

export async function buildRankedResultPayload(
  redis: ArenaRedisClient,
  stored: StoredRankedRecord
): Promise<RankedResultPayload> {
  const rawCounts = await redis.hGetAll(REDIS_KEYS.dayScoreCounts(stored.dayId));
  const { countsByScore, totalPlayers } = parseScoreCountsHash(rawCounts);
  const sharedRank = computeSharedRankFromCounts(
    stored.rawScore,
    countsByScore
  );

  return {
    dayId: stored.dayId,
    modifier: stored.modifier,
    moves: stored.moves,
    rawScore: stored.rawScore,
    maxScore: stored.maxScore,
    normalizedScore: stored.normalizedScore,
    exchangeSummary: stored.exchangeSummary,
    sharedRank,
    totalPlayers: Math.max(1, totalPlayers),
    streak: stored.streak,
    composition: stored.composition,
    submittedAt: stored.submittedAt,
  };
}

export function parseSubmittedMoves(rawMoves: unknown): Strategy | null {
  if (!Array.isArray(rawMoves) || rawMoves.length !== 3) {
    return null;
  }
  const str = rawMoves
    .map((m) => (typeof m === 'string' ? m : ''))
    .join(',');
  return parseStrategyKey(str);
}

/**
 * Atomic ranked submission state machine (`POST /api/ranked`).
 */
export async function submitRankedStrategy(params: {
  readonly redis: ArenaRedisClient;
  readonly masterSeed: string;
  readonly subredditId: string;
  readonly userId: string | undefined;
  readonly rawMoves: unknown;
  readonly rawClientDayId: unknown;
  readonly postData?: Record<string, unknown> | undefined;
  readonly hubPostId?: string | null;
  readonly hubUrl?: string | null;
  readonly now?: () => number;
}): Promise<RankedServiceOutcome> {
  const {
    redis,
    masterSeed,
    subredditId,
    userId,
    rawMoves,
    rawClientDayId,
    postData,
    hubPostId = null,
    hubUrl = null,
  } = params;
  const nowFn = params.now ?? Date.now;
  const currentUtcDay = (): string => formatUtcDayId(new Date(nowFn()));

  if (!userId) {
    return {
      ok: false,
      status: 401,
      body: {
        status: 'error',
        code: 'UNAUTHORIZED',
        message: 'Sign in to Reddit to submit a ranked strategy.',
      },
    };
  }

  const moves = parseSubmittedMoves(rawMoves);
  if (!moves) {
    return {
      ok: false,
      status: 400,
      body: {
        status: 'error',
        code: 'BAD_REQUEST',
        message:
          'Invalid moves tuple: expected an array of 3 moves (A, D, or C).',
      },
    };
  }

  if (typeof rawClientDayId !== 'string' || !isValidUtcDayId(rawClientDayId)) {
    return {
      ok: false,
      status: 400,
      body: {
        status: 'error',
        code: 'BAD_REQUEST',
        message: 'clientDayId (YYYY-MM-DD) is required.',
      },
    };
  }

  const clientDayId = rawClientDayId;
  const serverDayId = currentUtcDay();

  // Reject archived daily posts before any write or field initialization.
  if (
    postData?.['kind'] === 'daily' &&
    typeof postData['dayId'] === 'string' &&
    isValidUtcDayId(postData['dayId']) &&
    postData['dayId'] < serverDayId
  ) {
    return {
      ok: false,
      status: 403,
      body: {
        status: 'error',
        code: 'POST_ARCHIVED',
        message: `Daily arena for ${postData['dayId']} is closed. Play today's arena on the Evergreen Hub.`,
        archivedDayId: postData['dayId'],
        serverDayId,
        hubPostId,
        hubUrl,
      },
    };
  }

  if (clientDayId !== serverDayId) {
    return {
      ok: false,
      status: 409,
      body: {
        status: 'error',
        code: 'DAY_ROLLOVER',
        message: 'Day changed; refresh arena',
        serverDayId,
        clientDayId,
      },
    };
  }

  const lockedDayId = serverDayId;
  const rankedKey = REDIS_KEYS.rankedEntry(lockedDayId, userId);

  // Idempotency fast-path: if already committed today, return persisted result even at daily capacity.
  const existingFastRaw = await redis.get(rankedKey);
  const existingFast = parseStoredRankedRecord(existingFastRaw, lockedDayId);
  if (existingFast) {
    const result = await buildRankedResultPayload(redis, existingFast);
    return {
      ok: true,
      status: 200,
      body: {
        status: 'ok',
        alreadySubmitted: true,
        result,
      },
    };
  }

  let field;
  try {
    field = await ensureDailyField({
      redis,
      masterSeed,
      dayId: lockedDayId,
      now: nowFn,
    });
  } catch (err) {
    if (err instanceof ArenaTransientConflictError) {
      return {
        ok: false,
        status: 503,
        body: {
          status: 'error',
          code: 'TRANSACTION_CONFLICT',
          message: err.message,
        },
      };
    }
    throw err;
  }

  const ghostStrategies = field.ghosts.map((g) => g.moves);
  const scoreResult = scoreStrategy(moves, ghostStrategies, field.modifierId);
  const composition = toFieldComposition(field);
  const opaqueUserId = deriveOpaqueUserId(masterSeed, subredditId, userId);

  const streakKey = REDIS_KEYS.streakEntry(userId);
  const closedKey = REDIS_KEYS.dayClosed(lockedDayId);
  const boardKey = REDIS_KEYS.dayBoard(lockedDayId);
  const entrantsKey = REDIS_KEYS.dayEntrants(lockedDayId);
  const scoreCountsKey = REDIS_KEYS.dayScoreCounts(lockedDayId);
  const crowd0Key = REDIS_KEYS.dayCrowdSlot(lockedDayId, 0);
  const crowd1Key = REDIS_KEYS.dayCrowdSlot(lockedDayId, 1);
  const crowd2Key = REDIS_KEYS.dayCrowdSlot(lockedDayId, 2);

  for (let attempt = 0; attempt < MAX_WATCH_RETRIES; attempt += 1) {
    const nowDayBeforeWatch = currentUtcDay();
    if (nowDayBeforeWatch !== lockedDayId) {
      return {
        ok: false,
        status: 409,
        body: {
          status: 'error',
          code: 'DAY_ROLLOVER',
          message: 'Day changed; refresh arena',
          serverDayId: nowDayBeforeWatch,
          clientDayId,
        },
      };
    }

    const txn = await redis.watch(rankedKey, streakKey, closedKey, boardKey);
    const [watchedRankedRaw, watchedClosedRaw, watchedBoardCard, watchedStreakRaw] =
      await Promise.all([
        redis.get(rankedKey),
        redis.get(closedKey),
        redis.zCard(boardKey),
        redis.get(streakKey),
      ]);

    const watchedRanked = parseStoredRankedRecord(watchedRankedRaw, lockedDayId);
    if (watchedRanked) {
      await txn.unwatch();
      const result = await buildRankedResultPayload(redis, watchedRanked);
      return {
        ok: true,
        status: 200,
        body: {
          status: 'ok',
          alreadySubmitted: true,
          result,
        },
      };
    }

    if (watchedClosedRaw) {
      await txn.unwatch();
      return {
        ok: false,
        status: 409,
        body: {
          status: 'error',
          code: 'DAY_ROLLOVER',
          message: 'Day changed; refresh arena',
          serverDayId: currentUtcDay(),
          clientDayId,
        },
      };
    }

    if (watchedBoardCard >= MAX_DAILY_RANKED_ENTRIES) {
      await txn.unwatch();
      return {
        ok: false,
        status: 503,
        body: {
          status: 'error',
          code: 'DAILY_CAPACITY_REACHED',
          message:
            'Today’s 2,000-player ranked capacity is full. Practice mode and the daily leaderboard remain open.',
        },
      };
    }

    const existingStreak = parseStreakRecord(watchedStreakRaw);
    if (existingStreak && existingStreak.lastPlayedDay > lockedDayId) {
      await txn.unwatch();
      return {
        ok: false,
        status: 409,
        body: {
          status: 'error',
          code: 'DAY_ROLLOVER',
          message: 'Day changed; refresh arena',
          serverDayId: existingStreak.lastPlayedDay,
          clientDayId,
        },
      };
    }

    let nextStreak: StreakRecord;
    const shouldWriteStreak =
      !existingStreak || existingStreak.lastPlayedDay < lockedDayId;
    if (!existingStreak) {
      nextStreak = {
        lastPlayedDay: lockedDayId,
        currentCount: 1,
        bestCount: 1,
      };
    } else if (existingStreak.lastPlayedDay < lockedDayId) {
      const yesterdayId = previousUtcDayId(lockedDayId);
      const nextCount =
        existingStreak.lastPlayedDay === yesterdayId
          ? existingStreak.currentCount + 1
          : 1;
      nextStreak = {
        lastPlayedDay: lockedDayId,
        currentCount: nextCount,
        bestCount: Math.max(existingStreak.bestCount, nextCount),
      };
    } else {
      nextStreak = existingStreak;
    }

    const nowDayBeforeMulti = currentUtcDay();
    if (nowDayBeforeMulti !== lockedDayId) {
      await txn.unwatch();
      return {
        ok: false,
        status: 409,
        body: {
          status: 'error',
          code: 'DAY_ROLLOVER',
          message: 'Day changed; refresh arena',
          serverDayId: nowDayBeforeMulti,
          clientDayId,
        },
      };
    }

    const storedRecord: StoredRankedRecord = {
      dayId: lockedDayId,
      modifier: field.modifierId,
      moves,
      rawScore: scoreResult.rawScore,
      maxScore: scoreResult.maxScore,
      normalizedScore: scoreResult.normalizedScore,
      exchangeSummary: scoreResult.summary,
      fieldVersion: field.version,
      submittedAt: new Date(nowFn()).toISOString(),
      streak: nextStreak,
      composition,
    };

    await txn.multi();
    await txn.set(rankedKey, JSON.stringify(storedRecord));
    await txn.expire(rankedKey, DAY_TTL_SECONDS);

    if (shouldWriteStreak) {
      await txn.set(streakKey, JSON.stringify(nextStreak));
      await txn.expire(streakKey, STREAK_TTL_SECONDS);
    }

    await txn.hSet(entrantsKey, {
      [opaqueUserId]: formatStrategyKey(moves),
    });
    await txn.expire(entrantsKey, DAY_TTL_SECONDS);

    await txn.hIncrBy(crowd0Key, moves[0], 1);
    await txn.expire(crowd0Key, DAY_TTL_SECONDS);

    await txn.hIncrBy(crowd1Key, moves[1], 1);
    await txn.expire(crowd1Key, DAY_TTL_SECONDS);

    await txn.hIncrBy(crowd2Key, moves[2], 1);
    await txn.expire(crowd2Key, DAY_TTL_SECONDS);

    await txn.hIncrBy(scoreCountsKey, String(scoreResult.rawScore), 1);
    await txn.expire(scoreCountsKey, DAY_TTL_SECONDS);

    await txn.zAdd(boardKey, {
      member: opaqueUserId,
      score: scoreResult.rawScore,
    });
    await txn.expire(boardKey, DAY_TTL_SECONDS);

    const replies = await txn.exec();
    if (Array.isArray(replies) && replies.length > 0) {
      const result = await buildRankedResultPayload(redis, storedRecord);
      return {
        ok: true,
        status: 200,
        body: {
          status: 'ok',
          alreadySubmitted: false,
          result,
        },
      };
    }

    // WATCH conflict: check if day rolled over or closed before retrying.
    const postConflictDay = currentUtcDay();
    const postConflictClosed = await redis.get(closedKey);
    if (postConflictDay !== lockedDayId || postConflictClosed) {
      return {
        ok: false,
        status: 409,
        body: {
          status: 'error',
          code: 'DAY_ROLLOVER',
          message: 'Day changed; refresh arena',
          serverDayId: postConflictDay,
          clientDayId,
        },
      };
    }
  }

  // Final check in case a concurrent duplicate request by the same user won.
  const finalRankedRaw = await redis.get(rankedKey);
  const finalRanked = parseStoredRankedRecord(finalRankedRaw, lockedDayId);
  if (finalRanked) {
    const result = await buildRankedResultPayload(redis, finalRanked);
    return {
      ok: true,
      status: 200,
      body: {
        status: 'ok',
        alreadySubmitted: true,
        result,
      },
    };
  }

  return {
    ok: false,
    status: 503,
    body: {
      status: 'error',
      code: 'TRANSACTION_CONFLICT',
      message: 'High arena traffic — please retry locking your strategy.',
    },
  };
}

/**
 * Read-only recovery of a previously committed ranked submission (`GET /api/result?dayId=YYYY-MM-DD`).
 * Never writes keys or initializes a daily field.
 */
export async function recoverRankedResult(params: {
  readonly redis: ArenaRedisClient;
  readonly userId: string;
  readonly dayId: string;
}): Promise<ResultRecoveryResponse> {
  const { redis, userId, dayId } = params;
  const raw = await redis.get(REDIS_KEYS.rankedEntry(dayId, userId));
  const stored = parseStoredRankedRecord(raw, dayId);
  if (!stored) {
    return { dayId, found: false };
  }
  const result = await buildRankedResultPayload(redis, stored);
  return {
    dayId,
    found: true,
    result,
  };
}

/**
 * Fetches Top-50 daily leaderboard rows plus the requesting user's own rank row
 * even when ranked outside Top 50 (`GET /api/board`).
 */
export async function getDailyLeaderboard(params: {
  readonly redis: ArenaRedisClient;
  readonly masterSeed: string;
  readonly subredditId: string;
  readonly userId: string | undefined;
  readonly dayId: string;
}): Promise<BoardResponse> {
  const { redis, masterSeed, subredditId, userId, dayId } = params;
  const modifier = getModifierForUtcDate(dayId);
  const maxScore = getMaxScore(modifier);
  const boardKey = REDIS_KEYS.dayBoard(dayId);
  const scoreCountsKey = REDIS_KEYS.dayScoreCounts(dayId);
  const callerOpaqueId = userId
    ? deriveOpaqueUserId(masterSeed, subredditId, userId)
    : null;

  const [topMembers, rawScoreCounts, callerScore] = await Promise.all([
    redis.zRange(boardKey, 0, MAX_BOARD_ROWS - 1, {
      by: 'rank',
      reverse: true,
    }),
    redis.hGetAll(scoreCountsKey),
    callerOpaqueId
      ? redis.zScore(boardKey, callerOpaqueId)
      : Promise.resolve(undefined),
  ]);

  const { countsByScore, totalPlayers } = parseScoreCountsHash(rawScoreCounts);

  const toLeaderboardRow = (
    member: string,
    rawScore: number
  ): LeaderboardRow => {
    const isCurrentUser = Boolean(
      callerOpaqueId && member === callerOpaqueId
    );
    const sharedRank = computeSharedRankFromCounts(rawScore, countsByScore);
    const normalizedScore = Math.round((100 * rawScore) / maxScore);
    return {
      sharedRank,
      label: isCurrentUser ? 'You' : formatPlayerLabel(member),
      rawScore,
      maxScore,
      normalizedScore,
      isCurrentUser,
    };
  };

  const rows: LeaderboardRow[] = topMembers.map((entry) =>
    toLeaderboardRow(entry.member, entry.score)
  );

  let currentUserRow: LeaderboardRow | null =
    rows.find((row) => row.isCurrentUser) ?? null;

  if (!currentUserRow && callerOpaqueId && typeof callerScore === 'number') {
    currentUserRow = toLeaderboardRow(callerOpaqueId, callerScore);
  }

  return {
    dayId,
    modifier,
    totalPlayers: Math.max(totalPlayers, rows.length),
    rows,
    currentUserRow,
  };
}
