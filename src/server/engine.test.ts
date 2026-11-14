import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeSharedRankFromCounts,
  generateAllStrategies,
  getMaxScore,
  getModifierForDayIndex,
  getModifierForUtcDate,
  parseUtcDayIndex,
  resolveExchange,
  scoreStrategy,
  scoreVsGhost,
  type ModifierId,
  type Strategy,
} from '../shared/engine.ts';

function parseTuple(code: string): Strategy {
  const chars = [...code];
  if (chars.length !== 3) {
    throw new Error(`Invalid tuple: ${code}`);
  }
  const [first, second, third] = chars;
  if (
    (first !== 'A' && first !== 'D' && first !== 'C') ||
    (second !== 'A' && second !== 'D' && second !== 'C') ||
    (third !== 'A' && third !== 'D' && third !== 'C')
  ) {
    throw new Error(`Invalid move in tuple: ${code}`);
  }
  return [first, second, third];
}

function formatTuple(s: Strategy): string {
  return `${s[0]}${s[1]}${s[2]}`;
}

const REGRESSION_GHOSTS: readonly Strategy[] = [
  'CDA',
  'CDC',
  'ACC',
  'DDA',
  'CDA',
  'DDD',
  'AAC',
  'CCC',
  'CDA',
].map(parseTuple);

void describe('Three Moves Ahead pure rules engine', () => {
  void it('resolves combat triangle and ties across all 9 action pairs', () => {
    assert.equal(resolveExchange('A', 'C'), 'win');
    assert.equal(resolveExchange('C', 'D'), 'win');
    assert.equal(resolveExchange('D', 'A'), 'win');

    assert.equal(resolveExchange('C', 'A'), 'loss');
    assert.equal(resolveExchange('D', 'C'), 'loss');
    assert.equal(resolveExchange('A', 'D'), 'loss');

    assert.equal(resolveExchange('A', 'A'), 'tie');
    assert.equal(resolveExchange('D', 'D'), 'tie');
    assert.equal(resolveExchange('C', 'C'), 'tie');
  });

  void it('rotates modifiers deterministically by UTC day index', () => {
    const day0Index = parseUtcDayIndex('2026-11-14');
    const day0Mod = getModifierForUtcDate('2026-11-14');
    const day1Mod = getModifierForUtcDate('2026-11-15');
    const day2Mod = getModifierForUtcDate('2026-11-16');
    const day3Mod = getModifierForUtcDate('2026-11-17');

    assert.equal(day0Mod, getModifierForDayIndex(day0Index));
    assert.equal(new Set([day0Mod, day1Mod, day2Mod]).size, 3);
    assert.equal(day3Mod, day0Mod);
  });

  void it('produces unique optima for all 27 strategies on the 9-ghost regression fixture', () => {
    const allStrategies = generateAllStrategies();
    assert.equal(allStrategies.length, 27);

    const expected: Record<ModifierId, { strategy: string; rawScore: number }> = {
      classic: { strategy: 'ACA', rawScore: 38 },
      draw_day: { strategy: 'CDA', rawScore: 37 },
      sweep_bonus: { strategy: 'ACD', rawScore: 44 },
    };

    for (const modifier of ['classic', 'draw_day', 'sweep_bonus'] as const) {
      const scored = allStrategies.map((strategy) => ({
        code: formatTuple(strategy),
        result: scoreStrategy(strategy, REGRESSION_GHOSTS, modifier),
      }));
      scored.sort((a, b) => b.result.rawScore - a.result.rawScore);

      const top = scored[0];
      const runnerUp = scored[1];
      assert.ok(top && runnerUp);
      assert.equal(top.code, expected[modifier].strategy);
      assert.equal(top.result.rawScore, expected[modifier].rawScore);
      assert.ok(
        top.result.rawScore > runnerUp.result.rawScore,
        `Expected unique optimum for ${modifier}, got tie with ${runnerUp.code}`
      );
    }
  });

  void it('enforces Sweep Bonus on 3 wins only (not 2 wins + 1 tie) and Draw Day tie > win', () => {
    // Player AAA vs CCC = 3 wins -> sweep bonus (+3)
    const threeWins = scoreVsGhost(['A', 'A', 'A'], ['C', 'C', 'C'], 'sweep_bonus');
    assert.equal(threeWins.swept, true);
    assert.equal(threeWins.score, 9);

    // Player AAA vs CCA = 2 wins + 1 tie -> 3 non-losses, NOT a sweep
    const twoWinsOneTie = scoreVsGhost(['A', 'A', 'A'], ['C', 'C', 'A'], 'sweep_bonus');
    assert.equal(twoWinsOneTie.swept, false);
    assert.equal(twoWinsOneTie.score, 5);

    // Draw Day: tie (2) outscores win (1)
    const drawTie = scoreVsGhost(['A', 'A', 'A'], ['A', 'A', 'A'], 'draw_day');
    const drawWin = scoreVsGhost(['A', 'A', 'A'], ['C', 'C', 'C'], 'draw_day');
    assert.equal(drawTie.score, 6);
    assert.equal(drawWin.score, 3);
  });

  void it('enforces theoretical min/max bounds, determinism, and zero input mutation', () => {
    const allZeroGhosts = Object.freeze(
      Array.from({ length: 9 }, () => Object.freeze(['D', 'D', 'D'] as const))
    );
    const minClassic = scoreStrategy(Object.freeze(['A', 'A', 'A'] as const), allZeroGhosts, 'classic');
    assert.equal(minClassic.rawScore, 0);
    assert.equal(minClassic.maxScore, 54);
    assert.equal(minClassic.normalizedScore, 0);

    const maxSweepGhosts = Object.freeze(
      Array.from({ length: 9 }, () => Object.freeze(['C', 'C', 'C'] as const))
    );
    const player = Object.freeze(['A', 'A', 'A'] as const);
    const run1 = scoreStrategy(player, maxSweepGhosts, 'sweep_bonus');
    const run2 = scoreStrategy(player, maxSweepGhosts, 'sweep_bonus');
    assert.equal(run1.rawScore, 81);
    assert.equal(run1.maxScore, 81);
    assert.equal(run1.normalizedScore, 100);
    assert.equal(run1.summary.sweeps, 9);
    assert.deepEqual(run1, run2);
    assert.equal(getMaxScore('classic'), 54);
    assert.equal(getMaxScore('draw_day'), 54);
    assert.equal(getMaxScore('sweep_bonus'), 81);
  });

  void it('computes shared-tie ranks from score buckets for sole player, ties, and outside Top 50', () => {
    // Sole player
    assert.equal(computeSharedRankFromCounts(38, { '38': 1 }), 1);

    // Tied scores share same rank: scores [44, 38, 38, 31] -> ranks [1, 2, 2, 4]
    const tieBuckets = { '44': 1, '38': 2, '31': 1 };
    assert.equal(computeSharedRankFromCounts(44, tieBuckets), 1);
    assert.equal(computeSharedRankFromCounts(38, tieBuckets), 2);
    assert.equal(computeSharedRankFromCounts(31, tieBuckets), 4);

    // Player outside Top 50: 55 players strictly higher across multiple buckets
    const largeBuckets = {
      '54': 5,
      '45': 20,
      '39': 30,
      '22': 12,
      '10': 3,
    };
    assert.equal(computeSharedRankFromCounts(22, largeBuckets), 56);
    assert.equal(computeSharedRankFromCounts(10, largeBuckets), 68);
  });
});
