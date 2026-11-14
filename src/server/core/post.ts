import { reddit } from '@devvit/web/server';
import { REDIS_KEYS, type ArenaRedisClient } from './redisTypes.ts';

/**
 * Creates the initial custom post for Three Moves Ahead with hub postData metadata.
 */
export const createPost = async () => {
  return await reddit.submitCustomPost({
    title: 'Three Moves Ahead — Daily Strategy Arena',
    postData: {
      kind: 'hub',
    },
  });
};

export function formatRedditPostUrl(
  subredditName: string | undefined,
  postId: string | null | undefined
): string | null {
  if (!subredditName || !postId) {
    return null;
  }
  const cleanId = postId.startsWith('t3_') ? postId.slice(3) : postId;
  if (!cleanId) {
    return null;
  }
  return `https://www.reddit.com/r/${subredditName}/comments/${cleanId}/`;
}

/**
 * Persists the canonical Evergreen Hub postId (`post:hub`) in Redis if not yet set
 * (or when explicitly updating from moderator post creation).
 */
export async function persistHubPostId(
  redis: Pick<ArenaRedisClient, 'set'>,
  postId: string
): Promise<void> {
  if (!postId) return;
  await redis.set(REDIS_KEYS.postHub, postId);
}

/**
 * Resolves the canonical Evergreen Hub link and today's discussion thread link.
 */
export async function resolveArenaLinks(params: {
  readonly redis: Pick<ArenaRedisClient, 'get' | 'set'>;
  readonly subredditName: string | undefined;
  readonly currentPostId: string | undefined;
  readonly currentPostData: Record<string, unknown> | undefined;
  readonly dayId: string;
}): Promise<{
  readonly hubPostId: string | null;
  readonly hubUrl: string | null;
  readonly discussionPostId: string | null;
  readonly discussionUrl: string | null;
}> {
  const { redis, subredditName, currentPostId, currentPostData, dayId } =
    params;

  let hubPostId = (await redis.get(REDIS_KEYS.postHub)) ?? null;
  if (!hubPostId && currentPostId && currentPostData?.['kind'] === 'hub') {
    await redis.set(REDIS_KEYS.postHub, currentPostId).catch(() => undefined);
    hubPostId = currentPostId;
  }

  let dailyPostId: string | null = null;
  const dailyRaw = await redis.get(REDIS_KEYS.postDaily(dayId));
  if (dailyRaw) {
    try {
      const parsed: unknown = JSON.parse(dailyRaw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'postStatus' in parsed &&
        parsed.postStatus === 'created' &&
        'postId' in parsed &&
        typeof parsed.postId === 'string'
      ) {
        dailyPostId = parsed.postId;
      }
    } catch {
      // Ignore malformed post:daily record.
    }
  }

  const discussionPostId = dailyPostId ?? hubPostId ?? currentPostId ?? null;

  return {
    hubPostId,
    hubUrl: formatRedditPostUrl(subredditName, hubPostId),
    discussionPostId,
    discussionUrl: formatRedditPostUrl(subredditName, discussionPostId),
  };
}
