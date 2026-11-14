import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  formatStrategyKey,
  generateDailyBotStrategies,
  generatePracticeOpponent,
} from './core/botGenerator.ts';
import {
  computeCrowdHint,
  ensureDailyField,
} from './core/dailyField.ts';
import {
  getDailyLeaderboard,
  recoverRankedResult,
  submitRankedStrategy,
} from './core/ranked.ts';
import { createApiRouter, type ApiContextView } from './routes/api.ts';
import type {
  ArenaResponse,
  BoardResponse,
  PracticeResponse,
  RankedSubmitResponse,
  ResultRecoveryResponse,
} from '../shared/api.ts';
import {
  ArenaTransientConflictError,
  deriveOpaqueUserId,
  formatPlayerLabel,
  getOrCreateMasterSeed,
} from './core/seedAndIdentity.ts';
import { REDIS_KEYS, type ArenaRedisClient } from './core/redisTypes.ts';
import { loadArenaThenBoardIndependent } from '../shared/arenaLoader.ts';
import type { HScanResponse, SetOptions, TxClientLike, ZMember, ZRangeOptions } from '@devvit/web/server';

export type FakeArenaStore = {
  strings: Map<string, string>;
  hashes: Map<string, Map<string, string>>;
  zsets: Map<string, Map<string, number>>;
  expiries: Map<string, number>;
  versions: Map<string, number>;
};

export function createFakeArenaStore(): FakeArenaStore {
  return {
    strings: new Map(),
    hashes: new Map(),
    zsets: new Map(),
    expiries: new Map(),
    versions: new Map(),
  };
}

export function createFakeArenaRedis(
  store: FakeArenaStore,
  nowMs: () => number = () => 1_700_000_000_000,
  onBeforeMultiHook?: (watchedKeys: readonly string[]) => void
): ArenaRedisClient {
  const bumpVersion = (key: string): void => {
    store.versions.set(key, (store.versions.get(key) ?? 0) + 1);
  };

  const purgeIfExpired = (key: string): void => {
    const expiresAt = store.expiries.get(key);
    if (expiresAt !== undefined && nowMs() >= expiresAt) {
      store.strings.delete(key);
      store.hashes.delete(key);
      store.zsets.delete(key);
      store.expiries.delete(key);
      bumpVersion(key);
    }
  };

  const client: ArenaRedisClient = {
    async watch(...initialKeys: string[]) {
      const watchedVersions = new Map<string, number>();
      const recordWatches = (keys: readonly string[]): void => {
        for (const k of keys) {
          purgeIfExpired(k);
          watchedVersions.set(k, store.versions.get(k) ?? 0);
        }
      };
      recordWatches(initialKeys);

      const queued: Array<() => unknown> = [];
      let isMulti = false;

      const tx: TxClientLike = {
        async exec() {
          if (!isMulti) {
            return [];
          }
          isMulti = false;
          for (const [k, snapVersion] of watchedVersions.entries()) {
            purgeIfExpired(k);
            const currentVersion = store.versions.get(k) ?? 0;
            if (currentVersion !== snapVersion) {
              queued.length = 0;
              watchedVersions.clear();
              return [];
            }
          }
          const results = queued.map((fn) => fn());
          queued.length = 0;
          watchedVersions.clear();
          return results;
        },
        async multi() {
          if (onBeforeMultiHook) {
            onBeforeMultiHook([...watchedVersions.keys()]);
          }
          isMulti = true;
        },
        async discard() {
          queued.length = 0;
          watchedVersions.clear();
          isMulti = false;
        },
        async watch(...moreKeys: string[]) {
          recordWatches(moreKeys);
          return tx;
        },
        async unwatch() {
          watchedVersions.clear();
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
        async set(key: string, value: string, options?: SetOptions) {
          if (isMulti) {
            queued.push(() => {
              purgeIfExpired(key);
              if (options?.nx && store.strings.has(key)) {
                return null;
              }
              if (options?.xx && !store.strings.has(key)) {
                return null;
              }
              store.strings.set(key, value);
              if (options?.expiration) {
                store.expiries.set(key, options.expiration.getTime());
              } else {
                store.expiries.delete(key);
              }
              bumpVersion(key);
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
                bumpVersion(k);
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
                store.strings.has(key) ||
                store.hashes.has(key) ||
                store.zsets.has(key);
              if (!hasKey) return 0;
              store.expiries.set(key, nowMs() + seconds * 1000);
              bumpVersion(key);
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
              purgeIfExpired(key);
              const map = store.zsets.get(key) ?? new Map<string, number>();
              for (const m of members) {
                map.set(m.member, m.score);
              }
              store.zsets.set(key, map);
              bumpVersion(key);
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
        async hSet(key: string, fieldValues: Record<string, string>) {
          if (isMulti) {
            queued.push(() => {
              purgeIfExpired(key);
              const map = store.hashes.get(key) ?? new Map<string, string>();
              let added = 0;
              for (const [f, v] of Object.entries(fieldValues)) {
                if (!map.has(f)) added += 1;
                map.set(f, v);
              }
              store.hashes.set(key, map);
              bumpVersion(key);
              return added;
            });
          }
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
              purgeIfExpired(key);
              const map = store.hashes.get(key) ?? new Map<string, string>();
              const next = Number(map.get(field) ?? '0') + value;
              map.set(field, String(next));
              store.hashes.set(key, map);
              bumpVersion(key);
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
    async set(key: string, value: string, options?: SetOptions) {
      purgeIfExpired(key);
      if (options?.nx && store.strings.has(key)) {
        return '';
      }
      if (options?.xx && !store.strings.has(key)) {
        return '';
      }
      store.strings.set(key, value);
      if (options?.expiration) {
        store.expiries.set(key, options.expiration.getTime());
      } else {
        store.expiries.delete(key);
      }
      bumpVersion(key);
      return 'OK';
    },
    async hGet(key: string, field: string) {
      purgeIfExpired(key);
      return store.hashes.get(key)?.get(field);
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
    async hScan(
      key: string,
      cursor: number,
      _pattern?: string,
      count: number = 200
    ): Promise<HScanResponse> {
      purgeIfExpired(key);
      const map = store.hashes.get(key);
      if (!map) return { cursor: 0, fieldValues: [] };
      const allEntries = [...map.entries()].map(([field, value]) => ({
        field,
        value,
      }));
      const slice = allEntries.slice(cursor, cursor + count);
      const nextCursor =
        cursor + count < allEntries.length ? cursor + count : 0;
      return {
        cursor: nextCursor,
        fieldValues: slice,
      };
    },
    async hSet(key: string, fieldValues: Record<string, string>) {
      purgeIfExpired(key);
      const map = store.hashes.get(key) ?? new Map<string, string>();
      let added = 0;
      for (const [f, v] of Object.entries(fieldValues)) {
        if (!map.has(f)) added += 1;
        map.set(f, v);
      }
      store.hashes.set(key, map);
      bumpVersion(key);
      return added;
    },
    async hIncrBy(key: string, field: string, value: number) {
      purgeIfExpired(key);
      const map = store.hashes.get(key) ?? new Map<string, string>();
      const next = Number(map.get(field) ?? '0') + value;
      map.set(field, String(next));
      store.hashes.set(key, map);
      bumpVersion(key);
      return next;
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
      const entries = [...map.entries()].map(([member, score]) => ({
        member,
        score,
      }));
      entries.sort((a, b) => {
        if (b.score !== a.score) {
          return options?.reverse ? b.score - a.score : a.score - b.score;
        }
        return a.member.localeCompare(b.member);
      });
      const s = typeof start === 'number' ? start : Number(start);
      const e = typeof stop === 'number' ? stop : Number(stop);
      return entries.slice(s, e + 1);
    },
    async expire(key: string, seconds: number) {
      const hasKey =
        store.strings.has(key) ||
        store.hashes.has(key) ||
        store.zsets.has(key);
      if (!hasKey) return;
      store.expiries.set(key, nowMs() + seconds * 1000);
      bumpVersion(key);
    },
    async del(...keys: string[]) {
      for (const k of keys) {
        store.strings.delete(k);
        store.hashes.delete(k);
        store.zsets.delete(k);
        store.expiries.delete(k);
        bumpVersion(k);
      }
    },
  };

  return client;
}

void describe('Bot seeding, pseudonymous handles, and Starter Arena diversity', () => {
  void it('declares optional global botSeed secret in devvit.json and bootstraps cleanly on a fresh installation without settings:seed', async () => {
    const rawConfigText = readFileSync(
      new URL('../../devvit.json', import.meta.url),
      'utf8'
    );
    const parsedConfig: unknown = JSON.parse(rawConfigText);
    assert.equal(
      typeof parsedConfig === 'object' && parsedConfig !== null,
      true
    );
    if (typeof parsedConfig === 'object' && parsedConfig !== null) {
      assert.equal('settings' in parsedConfig, true);
      const settingsObj =
        'settings' in parsedConfig &&
        typeof parsedConfig.settings === 'object' &&
        parsedConfig.settings !== null
          ? parsedConfig.settings
          : null;
      assert.notEqual(settingsObj, null);
      if (settingsObj && 'global' in settingsObj) {
        const globalSettings = settingsObj.global;
        assert.equal(
          typeof globalSettings === 'object' &&
            globalSettings !== null &&
            'botSeed' in globalSettings,
          true
        );
        if (
          typeof globalSettings === 'object' &&
          globalSettings !== null &&
          'botSeed' in globalSettings &&
          typeof globalSettings.botSeed === 'object' &&
          globalSettings.botSeed !== null
        ) {
          const botSeedDef = globalSettings.botSeed;
          assert.equal('type' in botSeedDef ? botSeedDef.type : null, 'string');
          assert.equal(
            'isSecret' in botSeedDef ? botSeedDef.isSecret : null,
            true
          );
        }
      }
    }

    // Fresh installation: settings:seed is absent in Redis and optional global botSeed is unset ('').
    const freshStore = createFakeArenaStore();
    const dayMs = Date.UTC(2026, 10, 15, 12, 0, 0);
    const freshRedis = createFakeArenaRedis(freshStore, () => dayMs);
    const router = createApiRouter({
      getContext: () => ({
        appSlug: 'three-moves-ahead',
        subredditId: 't5_fresh',
        subredditName: 'three_moves_ahead_dev',
        postId: 't3_fresh_hub',
        postData: { kind: 'hub' },
        userId: 't2_fresh_user',
        username: 'fresh_user',
      }),
      redis: freshRedis,
      settings: {
        async getAll() {
          return { botSeed: '' };
        },
      },
      now: () => dayMs,
    });

    const arenaRes = await router.request('/arena');
    assert.equal(arenaRes.status, 200);
    const persistedSeed = freshStore.strings.get(REDIS_KEYS.settingsSeed);
    assert.equal(typeof persistedSeed, 'string');
    assert.equal(persistedSeed?.length, 64);

    const submitRes = await router.request('/ranked', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moves: ['A', 'C', 'D'], clientDayId: '2026-11-15' }),
    });
    assert.equal(submitRes.status, 200);

    const boardRes = await router.request('/board');
    assert.equal(boardRes.status, 200);
    const boardBody: BoardResponse = await boardRes.json();
    assert.equal(boardBody.currentUserRow?.label, 'You');
    assert.equal(
      freshStore.strings.get(REDIS_KEYS.settingsSeed),
      persistedSeed
    );
  });

  void it('persists atomic settings:seed fallback when app secret settings are absent', async () => {
    const store = createFakeArenaStore();
    const redis = createFakeArenaRedis(store);
    const settings = {
      async getAll() {
        return {};
      },
    };

    const firstSeed = await getOrCreateMasterSeed({ redis, settings });
    const secondSeed = await getOrCreateMasterSeed({ redis, settings });

    assert.equal(firstSeed.length, 64);
    assert.equal(firstSeed, secondSeed);
    assert.equal(store.strings.get(REDIS_KEYS.settingsSeed), firstSeed);
  });

  void it('preserves player leaderboard identity across transient settings outages and rejects cold-start outage without poisoning seed', async () => {
    const coldStore = createFakeArenaStore();
    const coldRedis = createFakeArenaRedis(coldStore);

    // Cold-start settings outage before settings:seed exists must fail with retryable ArenaTransientConflictError, never fabricating a random seed.
    await assert.rejects(
      () =>
        getOrCreateMasterSeed({
          redis: coldRedis,
          settings: {
            async getAll() {
              throw new Error('settings RPC timeout');
            },
          },
        }),
      (err: unknown) => err instanceof ArenaTransientConflictError
    );
    assert.equal(coldStore.strings.has(REDIS_KEYS.settingsSeed), false);

    // Once initialized from configured botSeed, a subsequent settings.getAll() outage must keep the exact same seed and currentUserRow.
    const store = createFakeArenaStore();
    const dayMs = Date.UTC(2026, 10, 15, 12, 0, 0);
    const redis = createFakeArenaRedis(store, () => dayMs);
    let settingsShouldFail = false;

    const router = createApiRouter({
      getContext: () => ({
        appSlug: 'three-moves-ahead',
        subredditId: 't5_sub',
        subredditName: 'three_moves_ahead_dev',
        postId: 't3_hub_main',
        postData: { kind: 'hub' },
        userId: 't2_stable_player',
        username: 'stable_player',
      }),
      redis,
      settings: {
        async getAll() {
          if (settingsShouldFail) {
            throw new Error('transient settings outage');
          }
          return {
            botSeed: 'configured_master_seed_value_0123456789abcdef',
          };
        },
      },
      now: () => dayMs,
    });

    const submitRes = await router.request('/ranked', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moves: ['A', 'C', 'D'], clientDayId: '2026-11-15' }),
    });
    assert.equal(submitRes.status, 200);

    // Simulate settings outage on subsequent leaderboard fetch.
    settingsShouldFail = true;
    const boardRes = await router.request('/board');
    assert.equal(boardRes.status, 200);
    const boardBody: BoardResponse = await boardRes.json();
    assert.notEqual(boardBody.currentUserRow, null);
    assert.equal(boardBody.currentUserRow?.label, 'You');
    assert.equal(boardBody.currentUserRow?.isCurrentUser, true);
  });

  void it('produces deterministic daily bots per UTC day with 9 distinct strategies in Starter Arena', () => {
    const seed = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const dayAFirst = generateDailyBotStrategies(seed, '2026-11-15', 9);
    const dayASecond = generateDailyBotStrategies(seed, '2026-11-15', 9);
    const dayB = generateDailyBotStrategies(seed, '2026-11-16', 9);

    assert.deepEqual(dayAFirst, dayASecond);
    assert.notDeepEqual(dayAFirst, dayB);
    assert.equal(dayAFirst.length, 9);

    const uniqueKeys = new Set(dayAFirst.map((s) => formatStrategyKey(s)));
    assert.equal(
      uniqueKeys.size,
      9,
      'Starter Arena must contain 9 distinct bot strategies'
    );
  });

  void it('derives collision-resistant opaque user IDs and pseudonymous Player #XXXX labels without raw IDs', () => {
    const seed = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const opaque1 = deriveOpaqueUserId(seed, 't5_sub', 't2_alice123');
    const opaque2 = deriveOpaqueUserId(seed, 't5_sub', 't2_bob456');

    assert.equal(opaque1.length, 16);
    assert.notEqual(opaque1, opaque2);
    assert.equal(opaque1.includes('alice'), false);
    assert.equal(opaque1.includes('t2_'), false);

    const label = formatPlayerLabel(opaque1);
    assert.match(label, /^Player #[0-9A-F]{4}$/);
  });

  void it('generates unranked Practice opponents independently from the daily field', () => {
    let idx = 0;
    const sequence = [0, 2, 1];
    const bot = generatePracticeOpponent(() => {
      const val = sequence[idx % sequence.length] ?? 0;
      idx += 1;
      return val;
    });
    assert.deepEqual(bot, ['A', 'C', 'D']);
  });
});

void describe('Two-phase day close, immutable field initialization, and crowd hints', () => {
  void it('sets day:{D-1}:closed before scanning entrants and initializes Starter Arena when D-1 has 0 humans', async () => {
    const store = createFakeArenaStore();
    const redis = createFakeArenaRedis(store);
    const masterSeed = '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff';

    const field = await ensureDailyField({
      redis,
      masterSeed,
      dayId: '2026-11-15',
    });

    assert.equal(Boolean(store.strings.get(REDIS_KEYS.dayClosed('2026-11-14'))), true);
    assert.equal(field.dayId, '2026-11-15');
    assert.equal(field.humanCount, 0);
    assert.equal(field.botCount, 9);
    assert.equal(field.yesterdayHumanCount, 0);
    assert.equal(field.hint.status, 'insufficient_data');
    assert.equal(field.hint.message, 'Not enough player data yet');
  });

  void it('aborts with retryable 503 conflict and never publishes day:{D}:field if all Phase A close attempts abort', async () => {
    const store = createFakeArenaStore();
    const dayMs = Date.UTC(2026, 10, 15, 12, 0, 0);
    const prevClosedKey = REDIS_KEYS.dayClosed('2026-11-14');
    const todayFieldKey = REDIS_KEYS.dayField('2026-11-15');

    // Fault-inject watched version conflicts on every Phase A attempt without setting day:{D-1}:closed.
    const conflictRedis = createFakeArenaRedis(
      store,
      () => dayMs,
      (watchedKeys) => {
        if (watchedKeys.includes(prevClosedKey)) {
          store.versions.set(
            prevClosedKey,
            (store.versions.get(prevClosedKey) ?? 0) + 1
          );
        }
      }
    );

    await assert.rejects(
      () =>
        ensureDailyField({
          redis: conflictRedis,
          masterSeed:
            '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
          dayId: '2026-11-15',
          now: () => dayMs,
        }),
      (err: unknown) => err instanceof ArenaTransientConflictError
    );

    assert.equal(store.strings.has(prevClosedKey), false);
    assert.equal(
      store.strings.has(todayFieldKey),
      false,
      'Must never enter Phase B or publish today field when previous-day close barrier failed'
    );

    // Verify HTTP /arena and /ranked surface 503 TRANSACTION_CONFLICT when Phase A close cannot be confirmed.
    const router = createApiRouter({
      getContext: () => ({
        appSlug: 'three-moves-ahead',
        subredditId: 't5_sub',
        subredditName: 'three_moves_ahead_dev',
        postId: 't3_hub_main',
        postData: { kind: 'hub' },
        userId: 't2_u1',
        username: 'u1',
      }),
      redis: conflictRedis,
      settings: {
        async getAll() {
          return {
            botSeed: '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
          };
        },
      },
      now: () => dayMs,
    });

    const arenaRes = await router.request('/arena');
    assert.equal(arenaRes.status, 503);

    const rankedRes = await router.request('/ranked', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moves: ['A', 'C', 'D'], clientDayId: '2026-11-15' }),
    });
    assert.equal(rankedRes.status, 503);
    assert.equal(store.strings.has(todayFieldKey), false);
  });

  void it('scans all 2,000 entrants across multiple hScan pages and preserves existing field on concurrent Phase B race', async () => {
    const store = createFakeArenaStore();
    const redis = createFakeArenaRedis(store);
    const masterSeed = '9999888877776666555544443333222211110000aaaabbbbccccddddeeeeffff';
    const entrantsKey = REDIS_KEYS.dayEntrants('2026-11-14');

    const map = new Map<string, string>();
    for (let i = 0; i < 2000; i += 1) {
      const id = `entrant_${String(i).padStart(4, '0')}`;
      map.set(id, i % 2 === 0 ? 'A,C,D' : 'D,A,C');
    }
    store.hashes.set(entrantsKey, map);
    store.hashes.set(
      REDIS_KEYS.dayCrowdSlot('2026-11-14', 0),
      new Map([
        ['A', '1200'],
        ['D', '500'],
        ['C', '300'],
      ])
    );
    store.hashes.set(
      REDIS_KEYS.dayCrowdSlot('2026-11-14', 1),
      new Map([
        ['A', '400'],
        ['D', '900'],
        ['C', '700'],
      ])
    );
    store.hashes.set(
      REDIS_KEYS.dayCrowdSlot('2026-11-14', 2),
      new Map([
        ['A', '600'],
        ['D', '600'],
        ['C', '800'],
      ])
    );

    const [first, second] = await Promise.all([
      ensureDailyField({ redis, masterSeed, dayId: '2026-11-15' }),
      ensureDailyField({ redis, masterSeed, dayId: '2026-11-15' }),
    ]);

    assert.deepEqual(first, second);
    assert.equal(first.humanCount, 9);
    assert.equal(first.botCount, 0);
    assert.equal(first.yesterdayHumanCount, 2000);
    assert.equal(first.hint.status, 'ready');
  });

  void it('enforces >= 10 human hint threshold and reports slot ties cleanly', () => {
    const masterSeed = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff66667777888899990000';
    const slotCounts: readonly [
      { readonly A: number; readonly D: number; readonly C: number },
      { readonly A: number; readonly D: number; readonly C: number },
      { readonly A: number; readonly D: number; readonly C: number },
    ] = [
      { A: 5, D: 5, C: 2 },
      { A: 4, D: 4, C: 4 },
      { A: 6, D: 6, C: 0 },
    ];

    const belowThreshold = computeCrowdHint({
      masterSeed,
      dayId: '2026-11-15',
      yesterdayHumanCount: 9,
      slotCounts,
    });
    assert.equal(belowThreshold.status, 'insufficient_data');
    assert.equal(belowThreshold.message, 'Not enough player data yet');

    const tiedHint = computeCrowdHint({
      masterSeed,
      dayId: '2026-11-15',
      yesterdayHumanCount: 12,
      slotCounts,
    });
    assert.equal(tiedHint.status, 'ready');
    assert.equal(tiedHint.topMove, null);
    assert.match(tiedHint.message, /^Mixed tactics in the (opening|middle|closing) position$/);
  });
});

void describe('Atomic ranked submission state machine, streak guard, and capacity bounds', () => {
  const masterSeed = 'deadbeefcafebabe0123456789abcdefdeadbeefcafebabe0123456789abcdef';
  const day1Ms = Date.UTC(2026, 10, 15, 12, 0, 0);
  const day2Ms = Date.UTC(2026, 10, 16, 12, 0, 0);

  void it('rejects unauthenticated, malformed, archived-post, and day-mismatched submissions without writing', async () => {
    const store = createFakeArenaStore();
    const redis = createFakeArenaRedis(store, () => day1Ms);

    const unauth = await submitRankedStrategy({
      redis,
      masterSeed,
      subredditId: 't5_sub',
      userId: undefined,
      rawMoves: ['A', 'C', 'D'],
      rawClientDayId: '2026-11-15',
      now: () => day1Ms,
    });
    assert.equal(unauth.ok, false);
    assert.equal(unauth.status, 401);

    const badMoves = await submitRankedStrategy({
      redis,
      masterSeed,
      subredditId: 't5_sub',
      userId: 't2_u1',
      rawMoves: ['A', 'X', 'D'],
      rawClientDayId: '2026-11-15',
      now: () => day1Ms,
    });
    assert.equal(badMoves.ok, false);
    assert.equal(badMoves.status, 400);

    const archived = await submitRankedStrategy({
      redis,
      masterSeed,
      subredditId: 't5_sub',
      userId: 't2_u1',
      rawMoves: ['A', 'C', 'D'],
      rawClientDayId: '2026-11-15',
      postData: { kind: 'daily', dayId: '2026-11-14' },
      hubUrl: 'https://www.reddit.com/r/sub/comments/hub123/',
      now: () => day1Ms,
    });
    assert.equal(archived.ok, false);
    assert.equal(archived.status, 403);
    if (!archived.ok) {
      assert.equal(archived.body.code, 'POST_ARCHIVED');
    }

    const mismatch = await submitRankedStrategy({
      redis,
      masterSeed,
      subredditId: 't5_sub',
      userId: 't2_u1',
      rawMoves: ['A', 'C', 'D'],
      rawClientDayId: '2026-11-14',
      now: () => day1Ms,
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.status, 409);
    if (!mismatch.ok) {
      assert.equal(mismatch.body.code, 'DAY_ROLLOVER');
      assert.equal(mismatch.body.serverDayId, '2026-11-15');
    }
    assert.equal(store.strings.size, 0);
  });

  void it('deduplicates simultaneous double-submit and same-day retry with identical score, rank, and streak', async () => {
    const store = createFakeArenaStore();
    const redis = createFakeArenaRedis(store, () => day1Ms);

    const [first, second] = await Promise.all([
      submitRankedStrategy({
        redis,
        masterSeed,
        subredditId: 't5_sub',
        userId: 't2_alice',
        rawMoves: ['A', 'C', 'D'],
        rawClientDayId: '2026-11-15',
        now: () => day1Ms,
      }),
      submitRankedStrategy({
        redis,
        masterSeed,
        subredditId: 't5_sub',
        userId: 't2_alice',
        rawMoves: ['D', 'D', 'D'],
        rawClientDayId: '2026-11-15',
        now: () => day1Ms,
      }),
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (first.ok && second.ok) {
      assert.deepEqual(first.body.result.moves, second.body.result.moves);
      assert.equal(first.body.result.rawScore, second.body.result.rawScore);
      assert.equal(first.body.result.sharedRank, 1);
      assert.equal(first.body.result.totalPlayers, 1);
      assert.equal(first.body.result.streak.currentCount, 1);
    }

    const zCardCount = await redis.zCard(REDIS_KEYS.dayBoard('2026-11-15'));
    assert.equal(zCardCount, 1);
  });

  void it('increments consecutive-day streaks and prohibits backward streak updates across rollover', async () => {
    const store = createFakeArenaStore();
    let currentClock = day1Ms;
    const redis = createFakeArenaRedis(store, () => currentClock);

    const d1 = await submitRankedStrategy({
      redis,
      masterSeed,
      subredditId: 't5_sub',
      userId: 't2_player1',
      rawMoves: ['A', 'C', 'D'],
      rawClientDayId: '2026-11-15',
      now: () => currentClock,
    });
    assert.equal(d1.ok, true);
    if (d1.ok) {
      assert.equal(d1.body.result.streak.currentCount, 1);
    }

    currentClock = day2Ms;
    const d2 = await submitRankedStrategy({
      redis,
      masterSeed,
      subredditId: 't5_sub',
      userId: 't2_player1',
      rawMoves: ['C', 'A', 'D'],
      rawClientDayId: '2026-11-16',
      now: () => currentClock,
    });
    assert.equal(d2.ok, true);
    if (d2.ok) {
      assert.equal(d2.body.result.streak.currentCount, 2);
      assert.equal(d2.body.result.streak.bestCount, 2);
    }

    // Even if a delayed day-1 worker still saw day1Ms, streak.lastPlayedDay === 2026-11-16 (> 2026-11-15) blocks backward update.
    store.strings.delete(REDIS_KEYS.rankedEntry('2026-11-15', 't2_player1'));
    store.strings.delete(REDIS_KEYS.dayClosed('2026-11-15'));
    const backwardAttempt = await submitRankedStrategy({
      redis,
      masterSeed,
      subredditId: 't5_sub',
      userId: 't2_player1',
      rawMoves: ['D', 'D', 'D'],
      rawClientDayId: '2026-11-15',
      now: () => day1Ms,
    });
    assert.equal(backwardAttempt.ok, false);
    assert.equal(backwardAttempt.status, 409);
  });

  void it('enforces atomic 2,000-entrant daily cap under concurrent load while allowing idempotent retries', async () => {
    const store = createFakeArenaStore();
    const redis = createFakeArenaRedis(store, () => day1Ms);

    // Commit player_0 through normal path first so it has a persisted ranked:{D}:{userId} record.
    const firstPlayer = await submitRankedStrategy({
      redis,
      masterSeed,
      subredditId: 't5_sub',
      userId: 't2_cap_0',
      rawMoves: ['A', 'C', 'D'],
      rawClientDayId: '2026-11-15',
      now: () => day1Ms,
    });
    assert.equal(firstPlayer.ok, true);

    // Pre-populate board to 1,999 entries.
    const boardMap = store.zsets.get(REDIS_KEYS.dayBoard('2026-11-15')) ?? new Map<string, number>();
    for (let i = 1; i < 1999; i += 1) {
      boardMap.set(`prefill_${i}`, 25);
    }
    store.zsets.set(REDIS_KEYS.dayBoard('2026-11-15'), boardMap);
    assert.equal(await redis.zCard(REDIS_KEYS.dayBoard('2026-11-15')), 1999);

    // Race two new users for the 2,000th slot.
    const [raceA, raceB] = await Promise.all([
      submitRankedStrategy({
        redis,
        masterSeed,
        subredditId: 't5_sub',
        userId: 't2_cap_1999_a',
        rawMoves: ['A', 'A', 'A'],
        rawClientDayId: '2026-11-15',
        now: () => day1Ms,
      }),
      submitRankedStrategy({
        redis,
        masterSeed,
        subredditId: 't5_sub',
        userId: 't2_cap_1999_b',
        rawMoves: ['D', 'D', 'D'],
        rawClientDayId: '2026-11-15',
        now: () => day1Ms,
      }),
    ]);

    const successes = [raceA, raceB].filter((r) => r.ok);
    const rejections = [raceA, raceB].filter((r) => !r.ok);
    assert.equal(successes.length, 1);
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0]?.status, 503);
    assert.equal(await redis.zCard(REDIS_KEYS.dayBoard('2026-11-15')), 2000);

    // Already-committed player_0 still succeeds via idempotency fast-path even at 2,000/2,000 capacity.
    const retryExisting = await submitRankedStrategy({
      redis,
      masterSeed,
      subredditId: 't5_sub',
      userId: 't2_cap_0',
      rawMoves: ['A', 'C', 'D'],
      rawClientDayId: '2026-11-15',
      now: () => day1Ms,
    });
    assert.equal(retryExisting.ok, true);
    if (retryExisting.ok) {
      assert.equal(retryExisting.body.alreadySubmitted, true);
    }

    const recovered = await recoverRankedResult({
      redis,
      userId: 't2_cap_0',
      dayId: '2026-11-15',
    });
    assert.equal(recovered.found, true);

    const board = await getDailyLeaderboard({
      redis,
      masterSeed,
      subredditId: 't5_sub',
      userId: 't2_cap_0',
      dayId: '2026-11-15',
    });
    assert.equal(board.rows.length, 50);
    assert.notEqual(board.currentUserRow, null);
    assert.equal(board.currentUserRow?.label, 'You');
  });
});

void describe('HTTP API endpoints: /arena, /ranked, /result, /board, and /practice', () => {
  const dayMs = Date.UTC(2026, 10, 15, 14, 0, 0);

  void it('serves archived post notice on past daily posts without initializing today field', async () => {
    const store = createFakeArenaStore();
    const redis = createFakeArenaRedis(store, () => dayMs);
    store.strings.set(REDIS_KEYS.postHub, 't3_hub_main');

    const ctx: ApiContextView = {
      appSlug: 'three-moves-ahead',
      subredditId: 't5_sub',
      subredditName: 'three_moves_ahead_dev',
      postId: 't3_daily_old',
      postData: { kind: 'daily', dayId: '2026-11-14' },
      userId: 't2_viewer',
      username: 'viewer',
    };

    const router = createApiRouter({
      getContext: () => ctx,
      redis,
      settings: { async getAll() { return {}; } },
      now: () => dayMs,
    });

    const res = await router.request('/arena');
    assert.equal(res.status, 200);
    const body: ArenaResponse = await res.json();
    assert.equal(body.postMode, 'archived');
    if (body.postMode === 'archived') {
      assert.equal(body.archivedDayId, '2026-11-14');
      assert.equal(body.serverDayId, '2026-11-15');
      assert.equal(body.hubPostId, 't3_hub_main');
      assert.equal(
        body.hubUrl,
        'https://www.reddit.com/r/three_moves_ahead_dev/comments/hub_main/'
      );
    }
    assert.equal(store.strings.has(REDIS_KEYS.dayField('2026-11-15')), false);
  });

  void it('runs end-to-end practice, ranked submit, result recovery, and outside-Top-50 leaderboard without leaking secrets', async () => {
    const store = createFakeArenaStore();
    const redis = createFakeArenaRedis(store, () => dayMs);
    const activeUserId: string | undefined = 't2_player_main';

    const router = createApiRouter({
      getContext: () => ({
        appSlug: 'three-moves-ahead',
        subredditId: 't5_sub',
        subredditName: 'three_moves_ahead_dev',
        postId: 't3_hub_main',
        postData: { kind: 'hub' },
        userId: activeUserId,
        username: activeUserId ? 'player_main' : undefined,
      }),
      redis,
      settings: { async getAll() { return { botSeed: 'fixed_secret_seed_for_http_test_0123456789' }; } },
      now: () => dayMs,
      pickPracticeMoveIndex: () => 2,
    });

    // 1. Practice mode writes zero keys to Redis.
    const practiceRes = await router.request('/practice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moves: ['A', 'A', 'A'], modifier: 'sweep_bonus' }),
    });
    assert.equal(practiceRes.status, 200);
    const practiceBody: PracticeResponse = await practiceRes.json();
    assert.equal(practiceBody.swept, true);
    assert.equal(practiceBody.rawScore, 9);
    assert.equal(store.strings.size, 0);

    // 2. Arena endpoint initializes field and persists post:hub.
    const arenaRes = await router.request('/arena');
    assert.equal(arenaRes.status, 200);
    const arenaRawText = await arenaRes.text();
    assert.equal(arenaRawText.includes('fixed_secret_seed'), false);
    assert.equal(arenaRawText.includes('ghosts'), false);
    const arenaBody: ArenaResponse = JSON.parse(arenaRawText);
    assert.equal(arenaBody.postMode, 'hub');
    if (arenaBody.postMode === 'hub') {
      assert.equal(arenaBody.dayId, '2026-11-15');
      assert.equal(arenaBody.composition.isStarterArena, true);
      assert.equal(arenaBody.rankedResult, null);
    }

    // 3. Submit ranked strategy for main player.
    const submitRes = await router.request('/ranked', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moves: ['D', 'D', 'D'], clientDayId: '2026-11-15' }),
    });
    assert.equal(submitRes.status, 200);
    const submitBody: RankedSubmitResponse = await submitRes.json();
    assert.equal(submitBody.alreadySubmitted, false);

    // 4. Add 55 higher-scoring players so main player sits outside Top 50.
    const boardKey = REDIS_KEYS.dayBoard('2026-11-15');
    const countsKey = REDIS_KEYS.dayScoreCounts('2026-11-15');
    const topScore = submitBody.result.maxScore;
    for (let i = 0; i < 55; i += 1) {
      const zmap = store.zsets.get(boardKey) ?? new Map<string, number>();
      zmap.set(`high_${String(i).padStart(2, '0')}abcdef0123`, topScore);
      store.zsets.set(boardKey, zmap);
    }
    await redis.hIncrBy(countsKey, String(topScore), 55);

    const boardRes = await router.request('/board');
    assert.equal(boardRes.status, 200);
    const boardText = await boardRes.text();
    assert.equal(boardText.includes('t2_player_main'), false);
    assert.equal(boardText.includes('player_main'), false);
    const boardBody: BoardResponse = JSON.parse(boardText);
    assert.equal(boardBody.rows.length, 50);
    assert.notEqual(boardBody.currentUserRow, null);
    assert.equal(boardBody.currentUserRow?.label, 'You');
    assert.equal(boardBody.currentUserRow?.sharedRank, 56);

    // 5. Read-only recovery via GET /result?dayId=2026-11-15 reflects updated sharedRank (56).
    const resultRes = await router.request('/result?dayId=2026-11-15');
    assert.equal(resultRes.status, 200);
    const resultBody: ResultRecoveryResponse = await resultRes.json();
    assert.equal(resultBody.found, true);
    if (resultBody.found) {
      assert.equal(resultBody.result.sharedRank, 56);
    }
  });

  void it('recovers a lost 23:59:59 UTC submission at 00:00:02 UTC via GET /api/result and blocks interleaved post-close writes', async () => {
    const store = createFakeArenaStore();
    const preMidnightMs = Date.UTC(2026, 10, 15, 23, 59, 59);
    const postMidnightMs = Date.UTC(2026, 10, 16, 0, 0, 2);
    let clockMs = preMidnightMs;
    const masterSeed = 'feedfacecafebeef0123456789abcdef0123456789abcdef0123456789abcdef';

    const redis = createFakeArenaRedis(store, () => clockMs);
    const router = createApiRouter({
      getContext: () => ({
        appSlug: 'three-moves-ahead',
        subredditId: 't5_sub',
        subredditName: 'three_moves_ahead_dev',
        postId: 't3_hub_main',
        postData: { kind: 'hub' },
        userId: 't2_midnight_user',
        username: 'midnight_user',
      }),
      redis,
      settings: { async getAll() { return { botSeed: masterSeed }; } },
      now: () => clockMs,
    });

    // Player submits at 23:59:59 UTC (server commits, but client loses HTTP response).
    const submitBeforeMidnight = await router.request('/ranked', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moves: ['A', 'C', 'D'], clientDayId: '2026-11-15' }),
    });
    assert.equal(submitBeforeMidnight.status, 200);

    // Clock advances to 00:00:02 UTC on 2026-11-16. Client retries with stale 2026-11-15 clientDayId -> 409 DAY_ROLLOVER.
    clockMs = postMidnightMs;
    const staleRetry = await router.request('/ranked', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moves: ['A', 'C', 'D'], clientDayId: '2026-11-15' }),
    });
    assert.equal(staleRetry.status, 409);

    // Client recovers the 2026-11-15 result at 00:00:02 UTC via read-only GET /api/result?dayId=2026-11-15.
    const recoveredRes = await router.request('/result?dayId=2026-11-15');
    assert.equal(recoveredRes.status, 200);
    const recoveredBody: ResultRecoveryResponse = await recoveredRes.json();
    assert.equal(recoveredBody.found, true);
    if (recoveredBody.found) {
      assert.equal(recoveredBody.result.dayId, '2026-11-15');
      assert.deepEqual(recoveredBody.result.moves, ['A', 'C', 'D']);
    }

    // Interleaved midnight race: a day-D worker passes pre-WATCH clock check at 23:59:59,
    // but D+1 closes day D (`day:2026-11-15:closed`) right before the day-D worker calls MULTI/EXEC.
    let hookTriggered = false;
    const hookedRedis = createFakeArenaRedis(
      store,
      () => clockMs,
      (watchedKeys) => {
        if (
          !hookTriggered &&
          watchedKeys.includes(REDIS_KEYS.dayClosed('2026-11-15'))
        ) {
          hookTriggered = true;
          // Simulate D+1 Phase A committing day:2026-11-15:closed and clock crossing midnight right before MULTI.
          store.strings.set(
            REDIS_KEYS.dayClosed('2026-11-15'),
            JSON.stringify({ closedAt: '2026-11-16T00:00:00.000Z' })
          );
          store.versions.set(
            REDIS_KEYS.dayClosed('2026-11-15'),
            (store.versions.get(REDIS_KEYS.dayClosed('2026-11-15')) ?? 0) + 1
          );
          clockMs = postMidnightMs;
        }
      }
    );

    clockMs = preMidnightMs;
    const interleavedLate = await submitRankedStrategy({
      redis: hookedRedis,
      masterSeed,
      subredditId: 't5_sub',
      userId: 't2_late_racer',
      rawMoves: ['D', 'A', 'C'],
      rawClientDayId: '2026-11-15',
      now: () => clockMs,
    });
    assert.equal(interleavedLate.ok, false);
    assert.equal(interleavedLate.status, 409);
    assert.equal(
      store.strings.has(REDIS_KEYS.rankedEntry('2026-11-15', 't2_late_racer')),
      false
    );
  });

  void it('measures serialized payload byte size in the in-memory store across 200 entrants', async () => {
    const store = createFakeArenaStore();
    const redis = createFakeArenaRedis(store, () => dayMs);
    const masterSeed = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

    const sampleCount = 200;
    for (let i = 0; i < sampleCount; i += 1) {
      const userId = `t2_load_user_${String(i).padStart(4, '0')}`;
      const moves: readonly ['A' | 'D' | 'C', 'A' | 'D' | 'C', 'A' | 'D' | 'C'] =
        i % 3 === 0
          ? ['A', 'C', 'D']
          : i % 3 === 1
            ? ['D', 'A', 'C']
            : ['C', 'D', 'A'];
      const res = await submitRankedStrategy({
        redis,
        masterSeed,
        subredditId: 't5_sub',
        userId,
        rawMoves: moves,
        rawClientDayId: '2026-11-15',
        now: () => dayMs,
      });
      assert.equal(res.ok, true);
    }

    let totalBytes = 0;
    for (const [k, v] of store.strings.entries()) {
      totalBytes += Buffer.byteLength(k, 'utf8') + Buffer.byteLength(v, 'utf8');
    }
    for (const [k, map] of store.hashes.entries()) {
      totalBytes += Buffer.byteLength(k, 'utf8');
      for (const [f, v] of map.entries()) {
        totalBytes +=
          Buffer.byteLength(f, 'utf8') + Buffer.byteLength(v, 'utf8');
      }
    }
    for (const [k, map] of store.zsets.entries()) {
      totalBytes += Buffer.byteLength(k, 'utf8');
      for (const [m] of map.entries()) {
        totalBytes += Buffer.byteLength(m, 'utf8') + 16;
      }
    }

    const bytesPerEntry = totalBytes / sampleCount;
    const projected45DayBytesAt2000PerDay = bytesPerEntry * 2000 * 45;
    const projectedMegabytes =
      projected45DayBytesAt2000PerDay / (1024 * 1024);

    // Raw serialized payload in the in-memory store (excluding internal Redis allocator/object overhead).
    assert.equal(
      bytesPerEntry < 650,
      true,
      `Expected < 650 B/entry serialized payload, measured ${bytesPerEntry.toFixed(1)} B`
    );
    assert.equal(
      projectedMegabytes < 60,
      true,
      `Expected 45-day serialized payload projection < 60 MB, measured ${projectedMegabytes.toFixed(2)} MB`
    );
  });

  void it('isolates client arena loading from rejected or HTTP-503 leaderboard failures', async () => {
    const store = createFakeArenaStore();
    const redis = createFakeArenaRedis(store, () => dayMs);
    const router = createApiRouter({
      getContext: () => ({
        appSlug: 'three-moves-ahead',
        subredditId: 't5_sub',
        subredditName: 'three_moves_ahead_dev',
        postId: 't3_hub_main',
        postData: { kind: 'hub' },
        userId: 't2_client_user',
        username: 'client_user',
      }),
      redis,
      settings: {
        async getAll() {
          return { botSeed: 'client_isolation_seed_0123456789abcdef' };
        },
      },
      now: () => dayMs,
    });

    // Case A: /api/board rejects with a network error -> arena still commits immediately.
    let committedArenaA: ArenaResponse | null = null;
    let boardErrorA: string | null = null;
    await loadArenaThenBoardIndependent({
      fetchFn: async (url) => {
        if (url === '/api/board') {
          throw new Error('network socket hang up');
        }
        return router.request(url.replace(/^\/api/, ''));
      },
      onArenaReady: (a) => {
        committedArenaA = a;
      },
      onBoardOutcome: (outcome) => {
        if (!outcome.ok) {
          boardErrorA = outcome.error;
        }
      },
    });
    assert.notEqual(committedArenaA, null);
    assert.equal(boardErrorA, 'network socket hang up');

    // Case B: /api/board returns HTTP 503 error -> arena commits and boardError records the failure instead of showing an empty board.
    let committedArenaB: ArenaResponse | null = null;
    let boardErrorB: string | null = null;
    await loadArenaThenBoardIndependent({
      fetchFn: async (url) => {
        if (url === '/api/board') {
          return new Response(
            JSON.stringify({
              status: 'error',
              code: 'TRANSACTION_CONFLICT',
              message: 'Leaderboard temporarily unavailable',
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return router.request(url.replace(/^\/api/, ''));
      },
      onArenaReady: (a) => {
        committedArenaB = a;
      },
      onBoardOutcome: (outcome) => {
        if (!outcome.ok) {
          boardErrorB = outcome.error;
        }
      },
    });
    assert.notEqual(committedArenaB, null);
    assert.equal(boardErrorB, 'Leaderboard temporarily unavailable');
  });
});
