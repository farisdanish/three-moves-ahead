export type Move = 'A' | 'D' | 'C';

export type Strategy = readonly [Move, Move, Move];

export type ModifierId = 'classic' | 'draw_day' | 'sweep_bonus';

export type ExchangeOutcome = 'win' | 'tie' | 'loss';

export type ExchangeSummary = {
  readonly wins: number;
  readonly ties: number;
  readonly losses: number;
  readonly sweeps: number;
};

export type ScoreResult = {
  readonly rawScore: number;
  readonly maxScore: number;
  readonly normalizedScore: number;
  readonly summary: ExchangeSummary;
};

export const MOVES: readonly Move[] = ['A', 'D', 'C'];

export const FIELD_GHOST_COUNT = 9;

export const MODIFIER_CYCLE: readonly ModifierId[] = [
  'classic',
  'draw_day',
  'sweep_bonus',
];

const MS_PER_UTC_DAY = 86_400_000;

/**
 * Generates all 27 ordered 3-move strategies (`A | D | C`) in deterministic order.
 */
export function generateAllStrategies(): readonly Strategy[] {
  const result: Strategy[] = [];
  for (const first of MOVES) {
    for (const second of MOVES) {
      for (const third of MOVES) {
        result.push([first, second, third]);
      }
    }
  }
  return result;
}

/**
 * Parses a strict `YYYY-MM-DD` UTC date string into an integer UTC day index
 * (days since Unix epoch 1970-01-01).
 */
export function parseUtcDayIndex(utcDayId: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(utcDayId);
  if (!match) {
    throw new Error(`Invalid UTC day ID: "${utcDayId}"`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`Non-existent UTC calendar date: "${utcDayId}"`);
  }
  return Math.floor(ms / MS_PER_UTC_DAY);
}

/**
 * Returns the deterministic modifier for an integer UTC day index (`dayIndex % 3`).
 */
export function getModifierForDayIndex(dayIndex: number): ModifierId {
  const normalized = ((dayIndex % 3) + 3) % 3;
  const modifier = MODIFIER_CYCLE[normalized];
  if (!modifier) {
    throw new Error(`Unexpected modifier cycle index: ${normalized}`);
  }
  return modifier;
}

/**
 * Returns the deterministic modifier for a `YYYY-MM-DD` UTC date string.
 */
export function getModifierForUtcDate(utcDayId: string): ModifierId {
  return getModifierForDayIndex(parseUtcDayIndex(utcDayId));
}

/**
 * Formats a `Date` (defaulting to now) as a `YYYY-MM-DD` UTC day ID.
 */
export function formatUtcDayId(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Resolves one head-to-head move exchange using the combat triangle:
 * Attack (`A`) beats Counter (`C`), Counter (`C`) beats Defend (`D`),
 * Defend (`D`) beats Attack (`A`), and identical moves tie.
 */
export function resolveExchange(player: Move, ghost: Move): ExchangeOutcome {
  if (player === ghost) return 'tie';
  if (
    (player === 'A' && ghost === 'C') ||
    (player === 'C' && ghost === 'D') ||
    (player === 'D' && ghost === 'A')
  ) {
    return 'win';
  }
  return 'loss';
}

/**
 * Returns the theoretical maximum raw score for a modifier and ghost count (default 9).
 */
export function getMaxScore(
  modifier: ModifierId,
  ghostCount: number = FIELD_GHOST_COUNT
): number {
  if (!Number.isInteger(ghostCount) || ghostCount <= 0) {
    throw new Error(`Invalid ghostCount: ${ghostCount}`);
  }
  // Classic & Draw Day max is 2 pts × 3 slots = 6 per ghost; Sweep Bonus adds +3 per ghost.
  const perGhostMax = modifier === 'sweep_bonus' ? 9 : 6;
  return ghostCount * perGhostMax;
}

/**
 * Scores a player's 3-move strategy against a single 3-move ghost under a modifier.
 */
export function scoreVsGhost(
  player: Strategy,
  ghost: Strategy,
  modifier: ModifierId
): {
  readonly score: number;
  readonly wins: number;
  readonly ties: number;
  readonly losses: number;
  readonly swept: boolean;
} {
  let score = 0;
  let wins = 0;
  let ties = 0;
  let losses = 0;

  for (let slot = 0; slot < 3; slot += 1) {
    const playerMove = player[slot];
    const ghostMove = ghost[slot];
    if (!playerMove || !ghostMove) {
      throw new Error(`Missing move at slot ${slot}`);
    }
    const outcome = resolveExchange(playerMove, ghostMove);
    if (outcome === 'win') {
      wins += 1;
      score += modifier === 'draw_day' ? 1 : 2;
    } else if (outcome === 'tie') {
      ties += 1;
      score += modifier === 'draw_day' ? 2 : 1;
    } else {
      losses += 1;
    }
  }

  // Sweep Bonus triggers strictly on 3 wins (not 3 non-losses).
  const swept = modifier === 'sweep_bonus' && wins === 3;
  if (swept) {
    score += 3;
  }

  return { score, wins, ties, losses, swept };
}

/**
 * Scores a player's 3-move strategy against the full daily ghost field.
 */
export function scoreStrategy(
  player: Strategy,
  ghosts: readonly Strategy[],
  modifier: ModifierId
): ScoreResult {
  if (ghosts.length !== FIELD_GHOST_COUNT) {
    throw new Error(
      `Expected ${FIELD_GHOST_COUNT} ghosts, received ${ghosts.length}`
    );
  }

  let rawScore = 0;
  let wins = 0;
  let ties = 0;
  let losses = 0;
  let sweeps = 0;

  for (const ghost of ghosts) {
    const match = scoreVsGhost(player, ghost, modifier);
    rawScore += match.score;
    wins += match.wins;
    ties += match.ties;
    losses += match.losses;
    if (match.swept) {
      sweeps += 1;
    }
  }

  const maxScore = getMaxScore(modifier, ghosts.length);
  const normalizedScore = Math.round((100 * rawScore) / maxScore);

  return {
    rawScore,
    maxScore,
    normalizedScore,
    summary: { wins, ties, losses, sweeps },
  };
}

/**
 * Computes shared-tie rank (`1 + count of players with strictly higher rawScore`)
 * from a score-frequency bucket map (`rawScore -> playerCount`), avoiding `ZCOUNT`.
 */
export function computeSharedRankFromCounts(
  rawScore: number,
  scoreCounts: Readonly<Record<string, number>>
): number {
  let strictlyHigher = 0;
  for (const [scoreKey, count] of Object.entries(scoreCounts)) {
    const bucketScore = Number(scoreKey);
    if (
      Number.isInteger(bucketScore) &&
      bucketScore > rawScore &&
      Number.isInteger(count) &&
      count > 0
    ) {
      strictlyHigher += count;
    }
  }
  return 1 + strictlyHigher;
}
