/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LeaderboardRow } from '../shared/api.ts';
import { getPodiumPlaces } from './leaderboardView.ts';

function makeRow(
  sharedRank: number,
  label: string,
  rawScore: number,
  isCurrentUser = false
): LeaderboardRow {
  return {
    sharedRank,
    label,
    rawScore,
    maxScore: 54,
    normalizedScore: Math.round((rawScore / 54) * 100),
    isCurrentUser,
  };
}

void describe('getPodiumPlaces', () => {
  void it('orders podium steps as 2, 1, 3 for distinct top-three ranks', () => {
    const rows = [
      makeRow(1, 'Player #8F12', 42),
      makeRow(2, 'Player #4A09', 40),
      makeRow(3, 'Player #D301', 38),
      makeRow(4, 'Player #7C6E', 36),
    ];

    const places = getPodiumPlaces(rows);
    assert.deepEqual(
      places.map((p) => p.rank),
      [2, 1, 3]
    );
    assert.equal(places[0]?.players[0]?.label, 'Player #4A09');
    assert.equal(places[1]?.players[0]?.label, 'Player #8F12');
    assert.equal(places[2]?.players[0]?.label, 'Player #D301');
  });

  void it('groups two tied #1 players on #1 and leaves #2 empty rather than promoting #3 or fabricating #2', () => {
    const rows = [
      makeRow(1, 'Player #8F12', 44),
      makeRow(1, 'You', 44, true),
      makeRow(3, 'Player #D301', 39),
    ];

    const places = getPodiumPlaces(rows);
    const second = places.find((p) => p.rank === 2);
    const first = places.find((p) => p.rank === 1);
    const third = places.find((p) => p.rank === 3);

    assert.equal(second?.players.length, 0);
    assert.deepEqual(
      first?.players.map((p) => p.label),
      ['Player #8F12', 'You']
    );
    assert.deepEqual(
      third?.players.map((p) => p.label),
      ['Player #D301']
    );
  });

  void it('keeps #2 and #3 empty when all podium leaders tie at #1', () => {
    const rows = [
      makeRow(1, 'Player #1111', 40),
      makeRow(1, 'Player #2222', 40),
      makeRow(1, 'Player #3333', 40),
    ];

    const places = getPodiumPlaces(rows);
    assert.equal(places.find((p) => p.rank === 1)?.players.length, 3);
    assert.equal(places.find((p) => p.rank === 2)?.players.length, 0);
    assert.equal(places.find((p) => p.rank === 3)?.players.length, 0);
  });

  void it('handles empty and single-entry boards without fabricating placeholder slots', () => {
    const emptyPlaces = getPodiumPlaces([]);
    assert.deepEqual(
      emptyPlaces.map((p) => p.players.length),
      [0, 0, 0]
    );

    const singlePlaces = getPodiumPlaces([makeRow(1, 'You', 36, true)]);
    assert.equal(singlePlaces.find((p) => p.rank === 1)?.players.length, 1);
    assert.equal(singlePlaces.find((p) => p.rank === 2)?.players.length, 0);
    assert.equal(singlePlaces.find((p) => p.rank === 3)?.players.length, 0);
  });
});
