import { Hono } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import { context, reddit, redis, settings } from '@devvit/web/server';
import { createPost } from '../core/post.ts';
import { runSdkSpike } from '../core/sdkSpike.ts';

export const menu = new Hono();

menu.post('/post-create', async (c) => {
  try {
    const post = await createPost();

    return c.json<UiResponse>(
      {
        navigateTo: `https://reddit.com/r/${context.subredditName}/comments/${post.id}`,
      },
      200
    );
  } catch (error) {
    console.error(`Error creating post: ${error}`);
    return c.json<UiResponse>(
      {
        showToast: 'Failed to create post',
      },
      400
    );
  }
});

menu.post('/example-form', (c) => {
  return c.json<UiResponse>(
    {
      showForm: {
        name: 'exampleForm',
        form: {
          title: 'Example form',
          fields: [{ name: 'message', label: 'Message', type: 'string' }],
        },
      },
    },
    200
  );
});

menu.post('/sdk-spike', async (c) => {
  const { subredditName, userId } = context;
  if (!userId || !subredditName) {
    return c.json<UiResponse>(
      { showToast: 'Moderator authentication required' },
      401
    );
  }

  const currentUsername = await reddit.getCurrentUsername();
  if (!currentUsername) {
    return c.json<UiResponse>(
      { showToast: 'Moderator authentication required' },
      403
    );
  }

  const mods = await reddit
    .getModerators({ subredditName, username: currentUsername })
    .all();
  const isModerator = mods.some(
    (mod) => mod.username.toLowerCase() === currentUsername.toLowerCase()
  );
  if (!isModerator) {
    return c.json<UiResponse>(
      { showToast: 'Only subreddit moderators can run the SDK spike' },
      403
    );
  }

  let body: Partial<MenuItemRequest> = {};
  try {
    body = await c.req.json<MenuItemRequest>();
  } catch {
    // Fallback to context.postId if request body is absent.
  }

  const rawTargetId =
    typeof body.targetId === 'string' && body.targetId.startsWith('t3_')
      ? body.targetId
      : context.postId;

  const isT3Id = (id: string | undefined): id is `t3_${string}` =>
    typeof id === 'string' && id.startsWith('t3_');

  if (!isT3Id(rawTargetId)) {
    return c.json<UiResponse>(
      { showToast: 'Target postId (t3_...) is required to run SDK spike' },
      400
    );
  }

  const outcome = await runSdkSpike({
    redis,
    settings,
    reddit,
    postId: rawTargetId,
  });

  console.info('[SDK Spike]', JSON.stringify(outcome));

  return c.json<UiResponse>(
    {
      showToast: outcome.ok
        ? `SDK spike OK (${outcome.submitCommentAndPin})`
        : `SDK spike FAILED: ${outcome.notes[0] ?? outcome.redisCommands}`,
    },
    outcome.ok ? 200 : 500
  );
});
