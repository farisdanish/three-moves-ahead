import type { ModifierId } from './engine';

export type ArenaStatusResponse = {
  readonly type: 'arena_status';
  readonly appSlug: string;
  readonly postId: string;
  readonly postDataKind: string;
  readonly utcDayId: string;
  readonly modifier: ModifierId;
  readonly viewerAuthenticated: boolean;
  readonly username: string | null;
};
