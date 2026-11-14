import type { LeaderboardRow } from '../shared/api.ts';

export type PodiumRank = 1 | 2 | 3;

export type PodiumPlace = {
  readonly rank: PodiumRank;
  readonly players: readonly LeaderboardRow[];
};

const PODIUM_ORDER: readonly [PodiumRank, PodiumRank, PodiumRank] = [2, 1, 3];

/**
 * Groups authoritative Top-50 leaderboard rows onto the 2 / 1 / 3 podium steps
 * strictly by server-supplied `sharedRank`, preserving ties and skipped ranks.
 */
export function getPodiumPlaces(
  rows: readonly LeaderboardRow[]
): readonly PodiumPlace[] {
  return PODIUM_ORDER.map((rank) => ({
    rank,
    players: rows.filter((row) => row.sharedRank === rank),
  }));
}
