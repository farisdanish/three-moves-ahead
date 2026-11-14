import { Hono } from 'hono';
import {
  context as devvitContext,
  redis as devvitRedis,
  settings as devvitSettings,
} from '@devvit/web/server';
import type {
  ApiErrorResponse,
  ArenaResponse,
  ArenaStatusResponse,
  BoardResponse,
  PracticeResponse,
  PracticeSlotBreakdown,
  ResultRecoveryResponse,
} from '../../shared/api.ts';
import {
  formatUtcDayId,
  getMaxScore,
  getModifierForUtcDate,
  isValidUtcDayId,
  resolveExchange,
  scoreVsGhost,
  type ModifierId,
  type Move,
} from '../../shared/engine.ts';
import { generatePracticeOpponent } from '../core/botGenerator.ts';
import { ensureDailyField, toFieldComposition } from '../core/dailyField.ts';
import { formatRedditPostUrl, resolveArenaLinks } from '../core/post.ts';
import {
  buildRankedResultPayload,
  getDailyLeaderboard,
  parseStoredRankedRecord,
  parseStreakRecord,
  parseSubmittedMoves,
  recoverRankedResult,
  submitRankedStrategy,
} from '../core/ranked.ts';
import {
  REDIS_KEYS,
  type ArenaRedisClient,
  type ArenaSettingsClient,
} from '../core/redisTypes.ts';
import {
  ArenaTransientConflictError,
  getOrCreateMasterSeed,
} from '../core/seedAndIdentity.ts';

type LegacyStatusError = {
  readonly status: 'error';
  readonly message: string;
};

export type ApiContextView = {
  readonly appSlug: string;
  readonly subredditId: string;
  readonly subredditName: string;
  readonly postId: string | undefined;
  readonly postData: Record<string, unknown> | undefined;
  readonly userId: string | undefined;
  readonly username: string | undefined;
};

export type ApiRouterDependencies = {
  readonly getContext?: () => ApiContextView;
  readonly redis?: ArenaRedisClient;
  readonly settings?: ArenaSettingsClient;
  readonly now?: () => number;
  readonly pickPracticeMoveIndex?: (maxExclusive: number) => number;
};

function getDefaultContext(): ApiContextView {
  return {
    appSlug: devvitContext.appSlug,
    subredditId: devvitContext.subredditId,
    subredditName: devvitContext.subredditName,
    postId: devvitContext.postId,
    postData: devvitContext.postData,
    userId: devvitContext.userId,
    username: devvitContext.username,
  };
}

function isModifierId(value: unknown): value is ModifierId {
  return (
    value === 'classic' || value === 'draw_day' || value === 'sweep_bonus'
  );
}

function buildPracticeSlot(
  slot: 0 | 1 | 2,
  playerMove: Move,
  botMove: Move,
  modifier: ModifierId
): PracticeSlotBreakdown {
  const outcome = resolveExchange(playerMove, botMove);
  let pointsEarned = 0;
  if (outcome === 'win') {
    pointsEarned = modifier === 'draw_day' ? 1 : 2;
  } else if (outcome === 'tie') {
    pointsEarned = modifier === 'draw_day' ? 2 : 1;
  }
  return {
    slot,
    playerMove,
    botMove,
    outcome,
    pointsEarned,
  };
}

export function createApiRouter(deps: ApiRouterDependencies = {}): Hono {
  const router = new Hono();
  const getCtx = deps.getContext ?? getDefaultContext;
  const redisClient: ArenaRedisClient = deps.redis ?? devvitRedis;
  const settingsClient: ArenaSettingsClient = deps.settings ?? devvitSettings;
  const nowFn = deps.now ?? Date.now;

  router.get('/status', (c) => {
    const { appSlug, postData, postId, userId, username } = getCtx();

    if (!postId) {
      return c.json<LegacyStatusError>(
        {
          status: 'error',
          message: 'postId is required but missing from Devvit context',
        },
        400
      );
    }

    const utcDayId = formatUtcDayId(new Date(nowFn()));
    const rawKind = postData?.['kind'];
    const postDataKind = typeof rawKind === 'string' ? rawKind : 'unset';

    return c.json<ArenaStatusResponse>({
      type: 'arena_status',
      appSlug,
      postId,
      postDataKind,
      utcDayId,
      modifier: getModifierForUtcDate(utcDayId),
      viewerAuthenticated: Boolean(userId),
      username: username ?? null,
    });
  });

  router.get('/arena', async (c) => {
    const { postData, postId, subredditName, userId, username } = getCtx();
    const serverDayId = formatUtcDayId(new Date(nowFn()));
    const rawKind = postData?.['kind'];
    const rawPostDayId = postData?.['dayId'];

    // Archived daily post short-circuit: never initialize today's field or return live arena data.
    if (
      rawKind === 'daily' &&
      typeof rawPostDayId === 'string' &&
      isValidUtcDayId(rawPostDayId) &&
      rawPostDayId < serverDayId
    ) {
      const hubPostId = (await redisClient.get(REDIS_KEYS.postHub)) ?? null;
      return c.json<ArenaResponse>({
        postMode: 'archived',
        archivedDayId: rawPostDayId,
        serverDayId,
        hubPostId,
        hubUrl: formatRedditPostUrl(subredditName, hubPostId),
      });
    }

    try {
      const masterSeed = await getOrCreateMasterSeed({
        redis: redisClient,
        settings: settingsClient,
      });

      const [field, links, rawRanked, rawStreak] = await Promise.all([
        ensureDailyField({
          redis: redisClient,
          masterSeed,
          dayId: serverDayId,
          now: nowFn,
        }),
        resolveArenaLinks({
          redis: redisClient,
          subredditName,
          currentPostId: postId,
          currentPostData: postData,
          dayId: serverDayId,
        }),
        userId
          ? redisClient.get(REDIS_KEYS.rankedEntry(serverDayId, userId))
          : Promise.resolve(undefined),
        userId
          ? redisClient.get(REDIS_KEYS.streakEntry(userId))
          : Promise.resolve(undefined),
      ]);

      const storedRanked = parseStoredRankedRecord(rawRanked, serverDayId);
      const rankedResult = storedRanked
        ? await buildRankedResultPayload(redisClient, storedRanked)
        : null;
      const streak =
        rankedResult?.streak ?? parseStreakRecord(rawStreak) ?? null;

      const postMode: 'hub' | 'daily' = rawKind === 'daily' ? 'daily' : 'hub';

      return c.json<ArenaResponse>({
        postMode,
        dayId: serverDayId,
        modifier: field.modifierId,
        hint: field.hint,
        composition: toFieldComposition(field),
        rankedResult,
        streak,
        viewerAuthenticated: Boolean(userId),
        username: username ?? null,
        hubPostId: links.hubPostId,
        hubUrl: links.hubUrl,
        discussionPostId: links.discussionPostId,
        discussionUrl: links.discussionUrl,
      });
    } catch (err) {
      if (err instanceof ArenaTransientConflictError) {
        return c.json<ApiErrorResponse>(
          {
            status: 'error',
            code: 'TRANSACTION_CONFLICT',
            message: err.message,
          },
          503
        );
      }
      throw err;
    }
  });

  router.post('/ranked', async (c) => {
    const { postData, postId, subredditId, subredditName, userId } = getCtx();
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = await c.req.json();
      if (typeof parsed === 'object' && parsed !== null) {
        payload = { ...parsed };
      }
    } catch {
      return c.json<ApiErrorResponse>(
        {
          status: 'error',
          code: 'BAD_REQUEST',
          message: 'Invalid JSON request body.',
        },
        400
      );
    }

    const serverDayId = formatUtcDayId(new Date(nowFn()));
    try {
      const [masterSeed, links] = await Promise.all([
        getOrCreateMasterSeed({
          redis: redisClient,
          settings: settingsClient,
        }),
        resolveArenaLinks({
          redis: redisClient,
          subredditName,
          currentPostId: postId,
          currentPostData: postData,
          dayId: serverDayId,
        }),
      ]);

      const outcome = await submitRankedStrategy({
        redis: redisClient,
        masterSeed,
        subredditId,
        userId,
        rawMoves: payload['moves'],
        rawClientDayId: payload['clientDayId'],
        postData,
        hubPostId: links.hubPostId,
        hubUrl: links.hubUrl,
        now: nowFn,
      });

      return c.json(outcome.body, outcome.status);
    } catch (err) {
      if (err instanceof ArenaTransientConflictError) {
        return c.json<ApiErrorResponse>(
          {
            status: 'error',
            code: 'TRANSACTION_CONFLICT',
            message: err.message,
          },
          503
        );
      }
      throw err;
    }
  });

  router.get('/result', async (c) => {
    const { userId } = getCtx();
    if (!userId) {
      return c.json<ApiErrorResponse>(
        {
          status: 'error',
          code: 'UNAUTHORIZED',
          message: 'Sign in to Reddit to recover your ranked result.',
        },
        401
      );
    }

    const dayId = c.req.query('dayId');
    if (typeof dayId !== 'string' || !isValidUtcDayId(dayId)) {
      return c.json<ApiErrorResponse>(
        {
          status: 'error',
          code: 'BAD_REQUEST',
          message: 'Valid query parameter dayId=YYYY-MM-DD is required.',
        },
        400
      );
    }

    const recovery = await recoverRankedResult({
      redis: redisClient,
      userId,
      dayId,
    });
    return c.json<ResultRecoveryResponse>(recovery, 200);
  });

  router.get('/board', async (c) => {
    const { subredditId, userId } = getCtx();
    const dayId = formatUtcDayId(new Date(nowFn()));
    try {
      const masterSeed = await getOrCreateMasterSeed({
        redis: redisClient,
        settings: settingsClient,
      });

      const board = await getDailyLeaderboard({
        redis: redisClient,
        masterSeed,
        subredditId,
        userId,
        dayId,
      });
      return c.json<BoardResponse>(board, 200);
    } catch (err) {
      if (err instanceof ArenaTransientConflictError) {
        return c.json<ApiErrorResponse>(
          {
            status: 'error',
            code: 'TRANSACTION_CONFLICT',
            message: err.message,
          },
          503
        );
      }
      throw err;
    }
  });

  router.post('/practice', async (c) => {
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = await c.req.json();
      if (typeof parsed === 'object' && parsed !== null) {
        payload = { ...parsed };
      }
    } catch {
      return c.json<ApiErrorResponse>(
        {
          status: 'error',
          code: 'BAD_REQUEST',
          message: 'Invalid JSON request body.',
        },
        400
      );
    }

    const moves = parseSubmittedMoves(payload['moves']);
    if (!moves) {
      return c.json<ApiErrorResponse>(
        {
          status: 'error',
          code: 'BAD_REQUEST',
          message:
            'Invalid moves tuple: expected an array of 3 moves (A, D, or C).',
        },
        400
      );
    }

    const serverDayId = formatUtcDayId(new Date(nowFn()));
    const rawModifier = payload['modifier'];
    if (rawModifier !== undefined && !isModifierId(rawModifier)) {
      return c.json<ApiErrorResponse>(
        {
          status: 'error',
          code: 'BAD_REQUEST',
          message:
            'Invalid modifier: expected classic, draw_day, or sweep_bonus.',
        },
        400
      );
    }
    const modifier: ModifierId =
      rawModifier !== undefined
        ? rawModifier
        : getModifierForUtcDate(serverDayId);

    const botMoves = generatePracticeOpponent(deps.pickPracticeMoveIndex);
    const match = scoreVsGhost(moves, botMoves, modifier);
    const maxScore = getMaxScore(modifier, 1);
    const normalizedScore = Math.round((100 * match.score) / maxScore);

    const slot0 = buildPracticeSlot(0, moves[0], botMoves[0], modifier);
    const slot1 = buildPracticeSlot(1, moves[1], botMoves[1], modifier);
    const slot2 = buildPracticeSlot(2, moves[2], botMoves[2], modifier);

    return c.json<PracticeResponse>(
      {
        status: 'ok',
        modifier,
        playerMoves: moves,
        botMoves,
        slots: [slot0, slot1, slot2],
        rawScore: match.score,
        maxScore,
        normalizedScore,
        wins: match.wins,
        ties: match.ties,
        losses: match.losses,
        swept: match.swept,
      },
      200
    );
  });

  return router;
}

export const api = createApiRouter();
