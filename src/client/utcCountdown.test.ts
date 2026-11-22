/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatUtcResetCountdown,
  hasUtcDayRolledOver,
} from './utcCountdown.ts';

void describe('utcCountdown', () => {
  void it('formats countdown accurately across midnight, mid-day, and final minute', () => {
    const midnight = Date.UTC(2026, 10, 22, 0, 0, 0);
    assert.equal(formatUtcResetCountdown(midnight), '24h 0m');

    const midDay = Date.UTC(2026, 10, 22, 14, 35, 0);
    assert.equal(formatUtcResetCountdown(midDay), '9h 25m');

    const finalSeconds = Date.UTC(2026, 10, 22, 23, 59, 30);
    assert.equal(formatUtcResetCountdown(finalSeconds), '1m');
  });

  void it('detects UTC rollover strictly when server/clock date advances past arenaDayId', () => {
    const beforeMidnight = Date.UTC(2026, 10, 22, 23, 59, 59);
    const atMidnight = Date.UTC(2026, 10, 23, 0, 0, 0);

    assert.equal(hasUtcDayRolledOver('2026-11-22', beforeMidnight), false);
    assert.equal(hasUtcDayRolledOver('2026-11-22', atMidnight), true);
    assert.equal(hasUtcDayRolledOver('2026-11-23', atMidnight), false);
  });
});
