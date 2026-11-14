import { randomInt } from 'node:crypto';
import {
  FIELD_GHOST_COUNT,
  MOVES,
  generateAllStrategies,
  type Move,
  type Strategy,
} from '../../shared/engine.ts';
import { createSeededRng } from './seedAndIdentity.ts';

export type BotArchetypeId =
  | 'aggressive_opener'
  | 'defensive_anchor'
  | 'counter_weaver'
  | 'mirror_repeat'
  | 'triangle_shift';

type ArchetypePool = {
  readonly id: BotArchetypeId;
  readonly strategies: readonly Strategy[];
};

const TACTICAL_ARCHETYPE_POOLS: readonly ArchetypePool[] = [
  {
    id: 'aggressive_opener',
    strategies: [
      ['A', 'A', 'C'],
      ['A', 'C', 'A'],
      ['A', 'D', 'A'],
      ['A', 'A', 'D'],
    ],
  },
  {
    id: 'defensive_anchor',
    strategies: [
      ['D', 'D', 'C'],
      ['D', 'A', 'D'],
      ['C', 'D', 'D'],
      ['A', 'D', 'D'],
    ],
  },
  {
    id: 'counter_weaver',
    strategies: [
      ['C', 'C', 'A'],
      ['C', 'A', 'C'],
      ['C', 'D', 'A'],
      ['D', 'C', 'C'],
    ],
  },
  {
    id: 'mirror_repeat',
    strategies: [
      ['A', 'A', 'A'],
      ['D', 'D', 'D'],
      ['C', 'C', 'C'],
    ],
  },
  {
    id: 'triangle_shift',
    strategies: [
      ['A', 'C', 'D'],
      ['C', 'D', 'A'],
      ['D', 'A', 'C'],
      ['A', 'D', 'C'],
      ['D', 'C', 'A'],
      ['C', 'A', 'D'],
    ],
  },
];

export function formatStrategyKey(strategy: Strategy): string {
  return `${strategy[0]},${strategy[1]},${strategy[2]}`;
}

export function parseStrategyKey(serialized: string): Strategy | null {
  const parts = serialized.split(',');
  if (parts.length !== 3) {
    return null;
  }
  const [first, second, third] = parts;
  const isMove = (val: string | undefined): val is Move =>
    val === 'A' || val === 'D' || val === 'C';
  if (!isMove(first) || !isMove(second) || !isMove(third)) {
    return null;
  }
  return [first, second, third];
}

/**
 * Generates `count` (`0..9`) deterministic daily bot strategies for `dayId` using
 * the server-only master seed. Mixes tactical archetypes with seeded random draws
 * and enforces a strict diversity guard (all generated bot strategies are distinct).
 */
export function generateDailyBotStrategies(
  masterSeed: string,
  dayId: string,
  count: number
): readonly Strategy[] {
  if (!Number.isInteger(count) || count < 0 || count > FIELD_GHOST_COUNT) {
    throw new Error(
      `Invalid bot count: ${count} (expected integer in 0..${FIELD_GHOST_COUNT})`
    );
  }
  if (count === 0) {
    return [];
  }

  const rng = createSeededRng(masterSeed, `daily-bots:${dayId}`);
  const chosen: Strategy[] = [];
  const usedKeys = new Set<string>();

  // Shuffle archetype pools deterministically for this UTC day.
  const poolOrder = [...TACTICAL_ARCHETYPE_POOLS];
  for (let i = poolOrder.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(i + 1);
    const current = poolOrder[i];
    const swap = poolOrder[j];
    if (current && swap) {
      poolOrder[i] = swap;
      poolOrder[j] = current;
    }
  }

  // First pass: pick up to one strategy from each tactical archetype pool (~60% archetype mix).
  const maxArchetypePicks = Math.min(poolOrder.length, Math.ceil(count * 0.65));
  for (let p = 0; p < maxArchetypePicks && chosen.length < count; p += 1) {
    const pool = poolOrder[p];
    if (!pool || pool.strategies.length === 0) continue;
    const startIdx = rng.nextInt(pool.strategies.length);
    for (let offset = 0; offset < pool.strategies.length; offset += 1) {
      const candidate =
        pool.strategies[(startIdx + offset) % pool.strategies.length];
      if (!candidate) continue;
      const key = formatStrategyKey(candidate);
      if (!usedKeys.has(key)) {
        usedKeys.add(key);
        chosen.push(candidate);
        break;
      }
    }
  }

  // Second pass: fill remaining slots from all 27 strategies uniformly without replacement
  // so Starter Arena (9 bots) and partial bot fills never contain duplicate bot strategies.
  const allStrategies = [...generateAllStrategies()];
  for (let i = allStrategies.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(i + 1);
    const current = allStrategies[i];
    const swap = allStrategies[j];
    if (current && swap) {
      allStrategies[i] = swap;
      allStrategies[j] = current;
    }
  }

  for (const candidate of allStrategies) {
    if (chosen.length >= count) break;
    const key = formatStrategyKey(candidate);
    if (!usedKeys.has(key)) {
      usedKeys.add(key);
      chosen.push(candidate);
    }
  }

  // Final deterministic shuffle of the selected bot strategies so slot positions aren't ordered by pass.
  for (let i = chosen.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(i + 1);
    const current = chosen[i];
    const swap = chosen[j];
    if (current && swap) {
      chosen[i] = swap;
      chosen[j] = current;
    }
  }

  return chosen;
}

/**
 * Generates an unranked Practice opponent strategy completely independently of
 * the daily seed and daily ranked field.
 */
export function generatePracticeOpponent(
  pickIndex: (maxExclusive: number) => number = (max) => randomInt(max)
): Strategy {
  const pickMove = (): Move => {
    const idx = pickIndex(MOVES.length);
    const move = MOVES[idx];
    if (!move) {
      throw new Error(`Out-of-bounds move index: ${idx}`);
    }
    return move;
  };
  return [pickMove(), pickMove(), pickMove()];
}
