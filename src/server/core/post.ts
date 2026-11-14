import { reddit } from '@devvit/web/server';

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
