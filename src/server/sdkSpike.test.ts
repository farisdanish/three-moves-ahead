import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HScanResponse, TxClientLike, ZMember, ZRangeOptions } from '@devvit/web/server';
import {
  runSdkSpike,
  type SpikeDependencies,
  type SpikeRedisClient,
} from './core/sdkSpike.ts';
import { api } from './routes/api.ts';

type FakeStore = {
  strings: Map<string, string>;
  hashes: Map<string, Map<string, string>>;
  zsets: Map<string, Map<string, number>>;
  expiries: Map<string, number>;
};

function makeFakeRedis(
  store: FakeStore,
  now: () => number,
  overrides?: Partial<SpikeRedisClient>
): SpikeRedisClient {
  const purgeIfExpired = (key: string): void => {
    const expiresAt = store.expiries.get(key);
    if (expiresAt !== undefined && now() >= expiresAt) {
      store.strings.delete(key);
      store.hashes.delete(key);
      store.zsets.delete(key);
      store.expiries.delete(key);
    }
  };

  const client: SpikeRedisClient = {
    async watch() {
      const queued: Array<() => unknown> = [];
      let isMulti = false;
      const tx: TxClientLike = {
        async exec() {
          isMulti = false;
          return queued.map((fn) => fn());
        },
        async multi() {
          isMulti = true;
        },
        async discard() {
          queued.length = 0;
          isMulti = false;
        },
        async watch() {
          return tx;
        },
        async unwatch() {
          return tx;
        },
        async get(key: string) {
          if (isMulti) {
            queued.push(() => {
              purgeIfExpired(key);
              return store.strings.get(key);
            });
          }
          return tx;
        },
        async set(key: string, value: string) {
          if (isMulti) {
            queued.push(() => {
              store.strings.set(key, value);
              store.expiries.delete(key);
              return 'OK';
            });
          }
          return tx;
        },
        async del(...keys: string[]) {
          if (isMulti) {
            queued.push(() => {
              for (const k of keys) {
                store.strings.delete(k);
                store.hashes.delete(k);
                store.zsets.delete(k);
                store.expiries.delete(k);
              }
              return keys.length;
            });
          }
          return tx;
        },
        async incrBy() {
          return tx;
        },
        async type() {
          return tx;
        },
        async getRange() {
          return tx;
        },
        async setRange() {
          return tx;
        },
        async strLen() {
          return tx;
        },
        async mGet() {
          return tx;
        },
        async mSet() {
          return tx;
        },
        async expire(key: string, seconds: number) {
          if (isMulti) {
            queued.push(() => {
              const hasKey =
                store.strings.has(key) || store.hashes.has(key) || store.zsets.has(key);
              if (!hasKey) return 0;
              store.expiries.set(key, now() + seconds * 1000);
              return 1;
            });
          }
          return tx;
        },
        async expireTime() {
          return tx;
        },
        async zAdd(key: string, ...members: ZMember[]) {
          if (isMulti) {
            queued.push(() => {
              const map = store.zsets.get(key) ?? new Map<string, number>();
              for (const m of members) {
                map.set(m.member, m.score);
              }
              store.zsets.set(key, map);
              return members.length;
            });
          }
          return tx;
        },
        async zScore() {
          return tx;
        },
        async zRem() {
          return tx;
        },
        async zRemRangeByLex() {
          return tx;
        },
        async zRemRangeByRank() {
          return tx;
        },
        async zRemRangeByScore() {
          return tx;
        },
        async zCard() {
          return tx;
        },
        async zRange() {
          return tx;
        },
        async zRank() {
          return tx;
        },
        async zIncrBy() {
          return tx;
        },
        async zScan() {
          return tx;
        },
        async hGetAll() {
          return tx;
        },
        async hGet() {
          return tx;
        },
        async hMGet() {
          return tx;
        },
        async hSet() {
          return tx;
        },
        async hSetNX() {
          return tx;
        },
        async hDel() {
          return tx;
        },
        async hScan() {
          return tx;
        },
        async hKeys() {
          return tx;
        },
        async hIncrBy(key: string, field: string, value: number) {
          if (isMulti) {
            queued.push(() => {
              const map = store.hashes.get(key) ?? new Map<string, string>();
              const next = Number(map.get(field) ?? '0') + value;
              map.set(field, String(next));
              store.hashes.set(key, map);
              return next;
            });
          }
          return tx;
        },
        async hLen() {
          return tx;
        },
      };
      return tx;
    },
    async get(key: string) {
      purgeIfExpired(key);
      return store.strings.get(key);
    },
    async hGetAll(key: string) {
      purgeIfExpired(key);
      const map = store.hashes.get(key);
      if (!map) return {};
      return Object.fromEntries(map.entries());
    },
    async hLen(key: string) {
      purgeIfExpired(key);
      return store.hashes.get(key)?.size ?? 0;
    },
    async hScan(key: string): Promise<HScanResponse> {
      purgeIfExpired(key);
      const map = store.hashes.get(key);
      if (!map) return { cursor: 0, fieldValues: [] };
      return {
        cursor: 0,
        fieldValues: [...map.entries()].map(([field, value]) => ({ field, value })),
      };
    },
    async zCard(key: string) {
      purgeIfExpired(key);
      return store.zsets.get(key)?.size ?? 0;
    },
    async zScore(key: string, member: string) {
      purgeIfExpired(key);
      return store.zsets.get(key)?.get(member);
    },
    async zRange(
      key: string,
      start: number | string,
      stop: number | string,
      options?: ZRangeOptions
    ): Promise<ZMember[]> {
      purgeIfExpired(key);
      const map = store.zsets.get(key);
      if (!map) return [];
      const entries = [...map.entries()].map(([member, score]) => ({ member, score }));
      entries.sort((a, b) => (options?.reverse ? b.score - a.score : a.score - b.score));
      const s = typeof start === 'number' ? start : Number(start);
      const e = typeof stop === 'number' ? stop : Number(stop);
      return entries.slice(s, e + 1);
    },
    async del(...keys: string[]) {
      for (const k of keys) {
        store.strings.delete(k);
        store.hashes.delete(k);
        store.zsets.delete(k);
        store.expiries.delete(k);
      }
    },
    ...overrides,
  };
  return client;
}

function makeDeps(
  overrides?: Partial<SpikeRedisClient>,
  submitCommentImpl?: SpikeDependencies['reddit']['submitComment']
): {
  deps: SpikeDependencies;
  store: FakeStore;
  getCommentCalls: () => number;
  advanceClock: (ms: number) => void;
} {
  const store: FakeStore = {
    strings: new Map(),
    hashes: new Map(),
    zsets: new Map(),
    expiries: new Map(),
  };
  let commentCalls = 0;
  let clock = 1_700_000_000_000;

  const deps: SpikeDependencies = {
    redis: makeFakeRedis(store, () => clock, overrides),
    settings: {
      async getAll() {
        return {};
      },
    },
    reddit: {
      async submitComment(params) {
        commentCalls += 1;
        if (submitCommentImpl) {
          return submitCommentImpl(params);
        }
        return {
          id: `t1_comment_${commentCalls}`,
          async distinguish() {},
        };
      },
    },
    postId: 't3_test_post',
    now: () => {
      clock += 1;
      return clock;
    },
  };

  return {
    deps,
    store,
    getCommentCalls: () => commentCalls,
    advanceClock: (ms: number) => {
      clock += ms;
    },
  };
}

void describe('SDK verification spike guards', () => {
  void it('removes public /api/sdk-spike route from player API router', async () => {
    const res = await api.request('/sdk-spike', { method: 'POST' });
    assert.equal(res.status, 404);
  });

  void it('reserves comment attempt per postId so repeated runs submit at most once', async () => {
    const { deps, getCommentCalls } = makeDeps();

    const first = await runSdkSpike(deps);
    assert.equal(first.ok, true);
    assert.match(first.submitCommentAndPin, /^ok /);
    assert.equal(getCommentCalls(), 1);

    const second = await runSdkSpike(deps);
    assert.equal(second.ok, true);
    assert.match(second.submitCommentAndPin, /^skipped \(already created: t1_comment_1\)/);
    assert.equal(getCommentCalls(), 1);
  });

  void it('reports ok:false when Redis returns empty hash, zero cardinality, undefined score, or wrong order', async () => {
    const emptyHash = makeDeps({
      async hGetAll() {
        return {};
      },
    });
    const r1 = await runSdkSpike(emptyHash.deps);
    assert.equal(r1.ok, false);
    assert.match(r1.redisCommands, /^fail: expected hash/);

    const zeroBoard = makeDeps({
      async zCard() {
        return 0;
      },
    });
    const r2 = await runSdkSpike(zeroBoard.deps);
    assert.equal(r2.ok, false);
    assert.match(r2.redisCommands, /^fail: expected zCard 2/);

    const missingScore = makeDeps({
      async zScore() {
        return undefined;
      },
    });
    const r3 = await runSdkSpike(missingScore.deps);
    assert.equal(r3.ok, false);
    assert.match(r3.redisCommands, /^fail: expected zScore\(p1\)=38/);

    const wrongOrder = makeDeps({
      async zRange() {
        return [
          { member: 'p1', score: 38 },
          { member: 'p2', score: 44 },
        ];
      },
    });
    const r4 = await runSdkSpike(wrongOrder.deps);
    assert.equal(r4.ok, false);
    assert.match(r4.redisCommands, /^fail: expected descending topRows/);
  });

  void it('keeps comment reservation past 24 hours for created posts', async () => {
    const { deps, getCommentCalls, advanceClock } = makeDeps();

    const first = await runSdkSpike(deps);
    assert.equal(first.ok, true);
    assert.equal(getCommentCalls(), 1);

    advanceClock(48 * 60 * 60 * 1000);

    const second = await runSdkSpike(deps);
    assert.equal(second.ok, true);
    assert.match(second.submitCommentAndPin, /^skipped \(already created: t1_comment_1\)/);
    assert.equal(getCommentCalls(), 1);
  });

  void it('keeps unresolved reserved and ambiguous_failed states unverified (ok:false) and blocks retries past 24h', async () => {
    const reservedRun = makeDeps();
    reservedRun.store.strings.set(
      'spike:comment:t3_test_post',
      JSON.stringify({ status: 'reserved', reservedAt: '2026-11-14T00:00:00.000Z' })
    );
    const reservedOutcome = await runSdkSpike(reservedRun.deps);
    assert.equal(reservedOutcome.ok, false);
    assert.match(reservedOutcome.submitCommentAndPin, /^unverified \(existing reserved reservation/);
    assert.equal(reservedRun.getCommentCalls(), 0);

    const failedSubmit = makeDeps(undefined, async () => {
      throw new Error('timeout after comment created?');
    });
    const firstFailed = await runSdkSpike(failedSubmit.deps);
    assert.equal(firstFailed.ok, false);
    assert.match(firstFailed.submitCommentAndPin, /^fail: timeout/);
    assert.equal(failedSubmit.getCommentCalls(), 1);

    failedSubmit.advanceClock(48 * 60 * 60 * 1000);

    const secondAfterFailure = await runSdkSpike(failedSubmit.deps);
    assert.equal(secondAfterFailure.ok, false);
    assert.match(
      secondAfterFailure.submitCommentAndPin,
      /^unverified \(existing ambiguous_failed reservation/
    );
    assert.equal(failedSubmit.getCommentCalls(), 1);
  });
});
