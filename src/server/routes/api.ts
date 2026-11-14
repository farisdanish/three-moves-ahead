import { Hono } from 'hono';
import { context } from '@devvit/web/server';
import type { ArenaStatusResponse } from '../../shared/api';
import { formatUtcDayId, getModifierForUtcDate } from '../../shared/engine.ts';

type ErrorResponse = {
  readonly status: 'error';
  readonly message: string;
};

export const api = new Hono();

api.get('/status', (c) => {
  const { appSlug, postData, postId, userId, username } = context;

  if (!postId) {
    return c.json<ErrorResponse>(
      {
        status: 'error',
        message: 'postId is required but missing from Devvit context',
      },
      400
    );
  }

  const utcDayId = formatUtcDayId();
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
