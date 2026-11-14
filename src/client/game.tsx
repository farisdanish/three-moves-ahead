import './index.css';

import {
  navigateTo,
  navigateToPost,
  showLoginPrompt,
  showToast,
} from '@devvit/web/client';
import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  ApiErrorResponse,
  ArenaLiveResponse,
  ArenaResponse,
  BoardResponse,
  PracticeResponse,
  RankedResultPayload,
  RankedSubmitResponse,
  ResultRecoveryResponse,
} from '../shared/api';
import {
  fetchBoardStateIndependent,
  loadArenaThenBoardIndependent,
} from '../shared/arenaLoader';
import {
  MODIFIER_CYCLE,
  MOVES,
  type ModifierId,
  type Move,
  type Strategy,
} from '../shared/engine';

type ActiveTab = 'ranked' | 'practice' | 'board';

const MOVE_META: Record<
  Move,
  {
    readonly title: string;
    readonly beats: string;
    readonly badgeClass: string;
  }
> = {
  A: {
    title: 'Attack',
    beats: 'Beats Counter',
    badgeClass: 'border-rose-500/60 bg-rose-950/60 text-rose-200',
  },
  D: {
    title: 'Defend',
    beats: 'Beats Attack',
    badgeClass: 'border-sky-500/60 bg-sky-950/60 text-sky-200',
  },
  C: {
    title: 'Counter',
    beats: 'Beats Defend',
    badgeClass: 'border-emerald-500/60 bg-emerald-950/60 text-emerald-200',
  },
};

const MODIFIER_META: Record<
  ModifierId,
  {
    readonly name: string;
    readonly shortRule: string;
    readonly detail: string;
  }
> = {
  classic: {
    name: 'Classic',
    shortRule: 'Win 2 · Tie 1 · Loss 0',
    detail: 'Standard tactical scoring across all 9 ghosts (max 54 pts).',
  },
  draw_day: {
    name: 'Draw Day',
    shortRule: 'Tie 2 · Win 1 · Loss 0',
    detail:
      'Matching an opponent action (2 pts) outscores beating it (1 pt) (max 54 pts).',
  },
  sweep_bonus: {
    name: 'Sweep Bonus',
    shortRule: 'Win 2 · Tie 1 · +3 on 3 Wins',
    detail:
      'Winning all 3 exchanges against a ghost awards +3 bonus points (max 81 pts).',
  },
};

const SLOT_TITLES: readonly [string, string, string] = [
  '1 · Opening',
  '2 · Middle',
  '3 · Closing',
];

function isT3PostId(value: string | null | undefined): value is `t3_${string}` {
  return typeof value === 'string' && value.startsWith('t3_');
}

function openRedditPostOrUrl(
  postId: string | null | undefined,
  url: string | null | undefined
): void {
  if (isT3PostId(postId)) {
    navigateToPost(postId);
    return;
  }
  if (url) {
    navigateTo(url);
    return;
  }
  showToast('Link is not available in this preview.');
}

function buildSpoilerSafeShareText(result: RankedResultPayload): string {
  const modName = MODIFIER_META[result.modifier].name;
  const rankSegment =
    result.totalPlayers <= 1
      ? 'First challenger today'
      : `Rank #${result.sharedRank} of ${result.totalPlayers}`;
  const sweepSegment =
    result.modifier === 'sweep_bonus'
      ? ` (${result.exchangeSummary.sweeps} sweeps)`
      : '';
  const compSegment = result.composition.isStarterArena
    ? 'Starter Arena (0p + 9b)'
    : `${result.composition.humans}p + ${result.composition.bots}b`;
  const spoilerMoves = `>!${result.moves.join('-')}!<`;

  return [
    `Three Moves Ahead · ${result.dayId} UTC (${modName})`,
    `Score: ${result.rawScore}/${result.maxScore} (${result.normalizedScore}%) · ${rankSegment}`,
    `Exchanges: ${result.exchangeSummary.wins}W-${result.exchangeSummary.ties}T-${result.exchangeSummary.losses}L${sweepSegment} · Streak: ${result.streak.currentCount}d · Field: ${compSegment}`,
    `Moves: ${spoilerMoves}`,
  ].join('\n');
}

const SLOT_INDICES: readonly [0, 1, 2] = [0, 1, 2];

function MoveSelectorGrid(props: {
  readonly moves: Strategy;
  readonly onChange: (next: Strategy) => void;
  readonly disabled?: boolean;
}) {
  const { moves, onChange, disabled = false } = props;

  const setSlotMove = (slot: 0 | 1 | 2, move: Move): void => {
    const next: Strategy = [
      slot === 0 ? move : moves[0],
      slot === 1 ? move : moves[1],
      slot === 2 ? move : moves[2],
    ];
    onChange(next);
  };

  return (
    <div className="space-y-2.5">
      {SLOT_INDICES.map((slot) => {
        const selectedMove = moves[slot];
        return (
          <div
            key={slot}
            className="rounded-lg border border-slate-800 bg-slate-950/80 p-2.5"
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold text-slate-300">
                {SLOT_TITLES[slot]}
              </span>
              <span className="text-[11px] font-mono text-amber-300">
                Selected: {MOVE_META[selectedMove].title} ({selectedMove})
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {MOVES.map((move) => {
                const active = selectedMove === move;
                const meta = MOVE_META[move];
                return (
                  <button
                    key={move}
                    type="button"
                    disabled={disabled}
                    onClick={() => setSlotMove(slot, move)}
                    className={`rounded-md border px-2 py-2 text-left transition-colors cursor-pointer disabled:opacity-50 ${
                      active
                        ? `${meta.badgeClass} ring-1 ring-amber-400`
                        : 'border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    <div className="text-xs font-bold">
                      {move} · {meta.title}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {meta.beats}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const App = () => {
  const [arena, setArena] = useState<ArenaResponse | null>(null);
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [boardLoading, setBoardLoading] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>('ranked');

  const [rankedMoves, setRankedMoves] = useState<Strategy>(['A', 'D', 'C']);
  const [submittingRanked, setSubmittingRanked] = useState<boolean>(false);
  const [bannerNotice, setBannerNotice] = useState<{
    readonly tone: 'amber' | 'red' | 'emerald';
    readonly text: string;
  } | null>(null);
  const [recoveredResult, setRecoveredResult] =
    useState<RankedResultPayload | null>(null);

  const [practiceMoves, setPracticeMoves] = useState<Strategy>(['A', 'C', 'D']);
  const [practiceModifier, setPracticeModifier] =
    useState<ModifierId>('classic');
  const [practiceResult, setPracticeResult] =
    useState<PracticeResponse | null>(null);
  const [runningPractice, setRunningPractice] = useState<boolean>(false);

  const refreshBoardOnly = useCallback(async () => {
    setBoardLoading(true);
    const outcome = await fetchBoardStateIndependent();
    if (outcome.ok) {
      setBoard(outcome.board);
      setBoardError(null);
    } else {
      setBoardError(outcome.error);
    }
    setBoardLoading(false);
  }, []);

  const loadArenaAndBoard = useCallback(async (preserveNotice = false) => {
    setLoading(true);
    if (!preserveNotice) {
      setBannerNotice(null);
    }
    try {
      await loadArenaThenBoardIndependent({
        onArenaReady: (arenaData) => {
          setArena(arenaData);
          if (arenaData.postMode !== 'archived') {
            setPracticeModifier(arenaData.modifier);
          }
          setLoading(false);
        },
        onBoardOutcome: (outcome) => {
          if (outcome.ok) {
            setBoard(outcome.board);
            setBoardError(null);
          } else {
            setBoardError(outcome.error);
          }
        },
      });
    } catch (err) {
      setBannerNotice({
        tone: 'red',
        text:
          err instanceof Error
            ? err.message
            : 'Unable to load arena state. Please refresh.',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await loadArenaThenBoardIndependent({
          onArenaReady: (arenaData) => {
            if (cancelled) return;
            setArena(arenaData);
            if (arenaData.postMode !== 'archived') {
              setPracticeModifier(arenaData.modifier);
            }
            setLoading(false);
          },
          onBoardOutcome: (outcome) => {
            if (cancelled) return;
            if (outcome.ok) {
              setBoard(outcome.board);
              setBoardError(null);
            } else {
              setBoardError(outcome.error);
            }
          },
        });
      } catch (err) {
        if (!cancelled) {
          setBannerNotice({
            tone: 'red',
            text:
              err instanceof Error
                ? err.message
                : 'Unable to load arena state. Please refresh.',
          });
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLockRankedStrategy = async (
    liveArena: ArenaLiveResponse
  ): Promise<void> => {
    setSubmittingRanked(true);
    setBannerNotice(null);

    try {
      const res = await fetch('/api/ranked', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          moves: rankedMoves,
          clientDayId: liveArena.dayId,
        }),
      });

      if (res.ok) {
        const data: RankedSubmitResponse = await res.json();
        setArena({
          ...liveArena,
          rankedResult: data.result,
          streak: data.result.streak,
        });
        showToast(
          data.alreadySubmitted
            ? 'Loaded your locked strategy for today.'
            : 'Strategy locked!'
        );
        void refreshBoardOnly();
        return;
      }

      const errBody: ApiErrorResponse = await res.json();

      if (res.status === 409 && errBody.code === 'DAY_ROLLOVER') {
        // Check read-only recovery in case an in-flight pre-midnight request committed.
        try {
          const recRes = await fetch(
            `/api/result?dayId=${encodeURIComponent(liveArena.dayId)}`
          );
          if (recRes.ok) {
            const recData: ResultRecoveryResponse = await recRes.json();
            if (recData.found) {
              setRecoveredResult(recData.result);
              setBannerNotice({
                tone: 'emerald',
                text: `Recovered your ${recData.dayId} UTC result (${recData.result.rawScore}/${recData.result.maxScore}, Rank #${recData.result.sharedRank}). Arena refreshed to today's new UTC day.`,
              });
              await loadArenaAndBoard(true);
              return;
            }
          }
        } catch {
          // Proceed with rollover refresh if recovery check fails.
        }

        setBannerNotice({
          tone: 'amber',
          text: 'Day changed; refresh arena — loaded the new UTC day.',
        });
        await loadArenaAndBoard(true);
        return;
      }

      if (res.status === 403 && errBody.code === 'POST_ARCHIVED') {
        await loadArenaAndBoard();
        return;
      }

      if (res.status === 503 && errBody.code === 'DAILY_CAPACITY_REACHED') {
        setBannerNotice({
          tone: 'amber',
          text: errBody.message,
        });
        return;
      }

      setBannerNotice({
        tone: 'red',
        text: errBody.message || `Submission failed (HTTP ${res.status})`,
      });
    } catch (err) {
      setBannerNotice({
        tone: 'red',
        text:
          err instanceof Error
            ? err.message
            : 'Network error while locking strategy. Please retry.',
      });
    } finally {
      setSubmittingRanked(false);
    }
  };

  const handleRunPractice = async (): Promise<void> => {
    setRunningPractice(true);
    try {
      const res = await fetch('/api/practice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          moves: practiceMoves,
          modifier: practiceModifier,
        }),
      });
      if (!res.ok) {
        throw new Error(`Practice request failed (HTTP ${res.status})`);
      }
      const data: PracticeResponse = await res.json();
      setPracticeResult(data);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Practice duel failed; try again.'
      );
    } finally {
      setRunningPractice(false);
    }
  };

  const handleCopyResult = async (
    result: RankedResultPayload
  ): Promise<void> => {
    const shareText = buildSpoilerSafeShareText(result);
    try {
      await navigator.clipboard.writeText(shareText);
      showToast('Spoiler-safe result copied to clipboard!');
    } catch {
      showToast('Clipboard access unavailable in this browser.');
    }
  };

  if (loading && !arena) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 p-4 flex items-center justify-center">
        <div className="rounded-xl border border-slate-800 bg-slate-900 px-5 py-4 text-xs text-slate-300">
          Loading Three Moves Ahead arena…
        </div>
      </div>
    );
  }

  if (arena?.postMode === 'archived') {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 p-4 flex flex-col items-center justify-center">
        <div className="w-full max-w-md rounded-xl border border-amber-700/60 bg-slate-900 p-5 space-y-4">
          <div className="text-xs uppercase tracking-widest text-amber-400 font-semibold">
            Archived Daily Post · {arena.archivedDayId} UTC
          </div>
          <h1 className="text-xl font-bold">
            This daily arena ({arena.archivedDayId}) has closed
          </h1>
          <p className="text-xs text-slate-300 leading-relaxed">
            Ranked entries lock per UTC day. Today&apos;s active arena is{' '}
            <span className="font-mono text-white">{arena.serverDayId} UTC</span>{' '}
            on the Evergreen Hub.
          </p>
          <button
            type="button"
            onClick={() => openRedditPostOrUrl(arena.hubPostId, arena.hubUrl)}
            className="w-full rounded-lg bg-orange-600 hover:bg-orange-500 text-white font-semibold py-2.5 px-4 text-sm cursor-pointer transition-colors"
          >
            Play Today&apos;s Arena
          </button>
        </div>
      </div>
    );
  }

  if (!arena) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 p-4 flex flex-col items-center justify-center">
        <div className="w-full max-w-md rounded-xl border border-red-800 bg-slate-900 p-5 space-y-3">
          <div className="text-sm font-semibold text-red-300">
            {bannerNotice?.text ?? 'Could not load arena state.'}
          </div>
          <button
            type="button"
            onClick={() => void loadArenaAndBoard()}
            className="rounded-lg bg-slate-800 hover:bg-slate-700 px-4 py-2 text-xs font-semibold cursor-pointer"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const modMeta = MODIFIER_META[arena.modifier];
  const rankedResult = arena.rankedResult;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 px-3 py-3 sm:px-5 sm:py-4 flex flex-col items-center">
      <div className="w-full max-w-lg space-y-3">
        {/* Top Header Card */}
        <header className="rounded-xl border border-slate-800 bg-slate-900 p-3.5 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] uppercase tracking-wider font-semibold text-amber-400">
              Three Moves Ahead · {arena.dayId} UTC
            </div>
            <div className="flex items-center gap-1.5 text-[11px]">
              {arena.streak && (
                <span className="rounded-full border border-orange-500/40 bg-orange-950/60 px-2 py-0.5 text-orange-200 font-semibold">
                  Streak: {arena.streak.currentCount}d
                </span>
              )}
              <span className="rounded-full border border-slate-700 bg-slate-950 px-2 py-0.5 text-slate-300">
                {arena.composition.isStarterArena
                  ? 'Starter Arena · 0 people + 9 bots'
                  : `${arena.composition.humans} people + ${arena.composition.bots} bots`}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="text-base sm:text-lg font-bold text-white">
              Modifier: {modMeta.name}{' '}
              <span className="text-xs font-normal text-amber-300">
                ({modMeta.shortRule})
              </span>
            </h1>
          </div>
          <p className="text-xs text-slate-300">{modMeta.detail}</p>

          {/* Combat Cheat Sheet */}
          <div className="rounded-lg border border-slate-800 bg-slate-950/90 px-2.5 py-1.5 text-[11px] text-slate-300 flex flex-wrap items-center justify-between gap-1">
            <span className="font-semibold text-slate-200">Cheat Sheet:</span>
            <span>Attack (A) &gt; Counter (C)</span>
            <span>·</span>
            <span>Counter (C) &gt; Defend (D)</span>
            <span>·</span>
            <span>Defend (D) &gt; Attack (A)</span>
          </div>

          {/* Historical Crowd Clue */}
          <div className="rounded-lg border border-indigo-900/60 bg-indigo-950/30 px-2.5 py-1.5 text-xs text-indigo-200">
            <span className="font-semibold text-indigo-300">
              Yesterday&apos;s Crowd Clue:{' '}
            </span>
            <span>{arena.hint.message}</span>
          </div>
        </header>

        {/* Status / Rollover / Recovery Banner */}
        {bannerNotice && (
          <div
            className={`rounded-lg border px-3 py-2 text-xs flex items-center justify-between gap-2 ${
              bannerNotice.tone === 'emerald'
                ? 'border-emerald-700 bg-emerald-950/70 text-emerald-100'
                : bannerNotice.tone === 'amber'
                  ? 'border-amber-700 bg-amber-950/70 text-amber-100'
                  : 'border-red-800 bg-red-950/70 text-red-100'
            }`}
          >
            <span>{bannerNotice.text}</span>
            <button
              type="button"
              onClick={() => void loadArenaAndBoard()}
              className="shrink-0 rounded bg-slate-900/80 px-2 py-1 text-[11px] font-semibold hover:bg-slate-800 cursor-pointer"
            >
              Refresh
            </button>
          </div>
        )}

        {/* Recovered Pre-Midnight Result Notice */}
        {recoveredResult && (
          <div className="rounded-lg border border-emerald-800/80 bg-emerald-950/40 p-2.5 text-xs text-emerald-200 flex items-center justify-between gap-2">
            <span>
              Recovered {recoveredResult.dayId}:{' '}
              <strong>
                {recoveredResult.rawScore}/{recoveredResult.maxScore}
              </strong>{' '}
              (Rank #{recoveredResult.sharedRank} of{' '}
              {recoveredResult.totalPlayers})
            </span>
            <button
              type="button"
              onClick={() => void handleCopyResult(recoveredResult)}
              className="rounded border border-emerald-600 px-2 py-1 text-[11px] font-semibold hover:bg-emerald-900/50 cursor-pointer"
            >
              Copy {recoveredResult.dayId}
            </button>
          </div>
        )}

        {/* Navigation Tabs */}
        <nav className="grid grid-cols-3 gap-1.5 rounded-xl border border-slate-800 bg-slate-900 p-1">
          <button
            type="button"
            onClick={() => setActiveTab('ranked')}
            className={`rounded-lg py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'ranked'
                ? 'bg-orange-600 text-white'
                : 'text-slate-300 hover:bg-slate-800'
            }`}
          >
            {rankedResult ? 'Today’s Result' : 'Ranked Arena'}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('practice')}
            className={`rounded-lg py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'practice'
                ? 'bg-orange-600 text-white'
                : 'text-slate-300 hover:bg-slate-800'
            }`}
          >
            Unranked Practice
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('board')}
            className={`rounded-lg py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
              activeTab === 'board'
                ? 'bg-orange-600 text-white'
                : 'text-slate-300 hover:bg-slate-800'
            }`}
          >
            Leaderboard ({boardError ? '!' : (board?.totalPlayers ?? '…')})
          </button>
        </nav>

        {/* TAB 1: RANKED ARENA & RESULT CARD */}
        {activeTab === 'ranked' && (
          <section className="rounded-xl border border-slate-800 bg-slate-900 p-3.5 space-y-3">
            {rankedResult ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-emerald-400 font-semibold">
                      Strategy Locked · {rankedResult.dayId} UTC
                    </div>
                    <h2 className="text-base font-bold text-white">
                      Moves: {rankedResult.moves.join(' → ')}
                    </h2>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-extrabold text-amber-300">
                      {rankedResult.rawScore} / {rankedResult.maxScore}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Normalized: {rankedResult.normalizedScore}%
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div className="rounded-lg border border-slate-800 bg-slate-950 p-2">
                    <div className="text-[10px] text-slate-400 uppercase">
                      Shared Rank
                    </div>
                    <div className="font-bold text-white mt-0.5">
                      {rankedResult.totalPlayers <= 1
                        ? '1st of 1 (First!)'
                        : `#${rankedResult.sharedRank} of ${rankedResult.totalPlayers}`}
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-800 bg-slate-950 p-2">
                    <div className="text-[10px] text-slate-400 uppercase">
                      27 Exchanges
                    </div>
                    <div className="font-bold text-white mt-0.5">
                      {rankedResult.exchangeSummary.wins}W ·{' '}
                      {rankedResult.exchangeSummary.ties}T ·{' '}
                      {rankedResult.exchangeSummary.losses}L
                      {rankedResult.modifier === 'sweep_bonus'
                        ? ` (${rankedResult.exchangeSummary.sweeps}S)`
                        : ''}
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-800 bg-slate-950 p-2">
                    <div className="text-[10px] text-slate-400 uppercase">
                      UTC Streak
                    </div>
                    <div className="font-bold text-orange-300 mt-0.5">
                      {rankedResult.streak.currentCount}d (Best{' '}
                      {rankedResult.streak.bestCount}d)
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-800 bg-slate-950 p-2">
                    <div className="text-[10px] text-slate-400 uppercase">
                      9-Ghost Field
                    </div>
                    <div className="font-bold text-slate-200 mt-0.5">
                      {rankedResult.composition.isStarterArena
                        ? 'Starter (9 bots)'
                        : `${rankedResult.composition.humans}p + ${rankedResult.composition.bots}b`}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() =>
                      openRedditPostOrUrl(
                        arena.discussionPostId,
                        arena.discussionUrl
                      )
                    }
                    className="flex-1 rounded-lg bg-orange-600 hover:bg-orange-500 text-white font-semibold py-2.5 px-4 text-xs sm:text-sm cursor-pointer transition-colors"
                  >
                    Join today&apos;s discussion
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopyResult(rankedResult)}
                    className="rounded-lg border border-slate-700 bg-slate-950 hover:bg-slate-800 text-slate-200 font-semibold py-2.5 px-3 text-xs cursor-pointer transition-colors"
                  >
                    Copy result
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-bold text-white">
                    Pick Your 3-Move Ranked Strategy
                  </h2>
                  <span className="text-[11px] text-slate-400">
                    One entry per UTC day · Repeats allowed
                  </span>
                </div>

                <MoveSelectorGrid
                  moves={rankedMoves}
                  onChange={setRankedMoves}
                  disabled={submittingRanked}
                />

                {arena.viewerAuthenticated ? (
                  <button
                    type="button"
                    disabled={submittingRanked}
                    onClick={() => void handleLockRankedStrategy(arena)}
                    className="w-full rounded-lg bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white font-bold py-2.5 px-4 text-sm cursor-pointer transition-colors"
                  >
                    {submittingRanked
                      ? 'Locking Strategy…'
                      : `Lock Today’s Strategy (${rankedMoves.join(' → ')})`}
                  </button>
                ) : (
                  <div className="rounded-lg border border-amber-700/60 bg-amber-950/30 p-3 space-y-2 text-xs">
                    <div className="text-amber-200 font-medium">
                      You are viewing logged out. Sign in to Reddit to lock a
                      ranked entry, or test-drive moves in Unranked Practice.
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => showLoginPrompt()}
                        className="rounded-lg bg-orange-600 hover:bg-orange-500 text-white font-semibold px-3.5 py-2 text-xs cursor-pointer"
                      >
                        Sign in to Play Ranked
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveTab('practice')}
                        className="rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200 font-semibold px-3.5 py-2 text-xs cursor-pointer"
                      >
                        Try Unranked Practice
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* TAB 2: UNRANKED PRACTICE */}
        {activeTab === 'practice' && (
          <section className="rounded-xl border border-slate-800 bg-slate-900 p-3.5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-sky-400 font-semibold">
                  Unranked Mode · Separate Computer Opponent
                </div>
                <h2 className="text-sm font-bold text-white">
                  Practice Duel (Zero Ranked Impact)
                </h2>
              </div>
              <span className="rounded-full border border-sky-700/50 bg-sky-950/60 px-2.5 py-0.5 text-[11px] text-sky-200">
                Unranked
              </span>
            </div>

            {/* Sample Tutorial Helper */}
            <div className="rounded-lg border border-slate-800 bg-slate-950/80 px-2.5 py-2 text-[11px] text-slate-300">
              <strong className="text-amber-300">Sample Tutorial:</strong> If an
              opponent opens with Attack (A), Defend (D) wins Slot 1; on{' '}
              <em>Draw Day</em>, matching Attack (A) earns 2 pts vs 1 pt for a
              win.{' '}
              <span className="text-slate-400">
                (Tutorial sample only — not live Reddit crowd data.)
              </span>
            </div>

            {/* Modifier Toggle */}
            <div className="space-y-1">
              <div className="text-xs font-semibold text-slate-300">
                Practice Rule Modifier (defaults to today&apos;s rule):
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {MODIFIER_CYCLE.map((modId) => {
                  const active = practiceModifier === modId;
                  return (
                    <button
                      key={modId}
                      type="button"
                      onClick={() => setPracticeModifier(modId)}
                      className={`rounded-md border px-2 py-1.5 text-xs font-semibold cursor-pointer transition-colors ${
                        active
                          ? 'border-sky-400 bg-sky-950 text-sky-100'
                          : 'border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {MODIFIER_META[modId].name}
                    </button>
                  );
                })}
              </div>
            </div>

            <MoveSelectorGrid
              moves={practiceMoves}
              onChange={setPracticeMoves}
              disabled={runningPractice}
            />

            <button
              type="button"
              disabled={runningPractice}
              onClick={() => void handleRunPractice()}
              className="w-full rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-bold py-2.5 px-4 text-sm cursor-pointer transition-colors"
            >
              {runningPractice
                ? 'Simulating Practice Duel…'
                : `Run Unranked Practice (${practiceMoves.join(' → ')})`}
            </button>

            {practiceResult && (
              <div className="rounded-lg border border-sky-800/60 bg-slate-950 p-3 space-y-2 text-xs">
                <div className="flex items-center justify-between font-semibold text-sky-200">
                  <span>
                    Practice Result ({MODIFIER_META[practiceResult.modifier].name})
                  </span>
                  <span>
                    {practiceResult.rawScore} / {practiceResult.maxScore} pts (
                    {practiceResult.normalizedScore}%)
                    {practiceResult.swept ? ' · SWEEP +3!' : ''}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {practiceResult.slots.map((slotItem) => (
                    <div
                      key={slotItem.slot}
                      className="rounded border border-slate-800 bg-slate-900 p-2 text-center"
                    >
                      <div className="text-[10px] text-slate-400">
                        Slot {slotItem.slot + 1}
                      </div>
                      <div className="font-mono font-bold text-white mt-0.5">
                        You {slotItem.playerMove} vs Bot {slotItem.botMove}
                      </div>
                      <div className="text-[11px] text-amber-300 capitalize">
                        {slotItem.outcome} (+{slotItem.pointsEarned})
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {/* TAB 3: LEADERBOARD */}
        {activeTab === 'board' && (
          <section className="rounded-xl border border-slate-800 bg-slate-900 p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold text-white">
                  Daily Leaderboard · {arena.dayId} UTC
                </h2>
                <p className="text-[11px] text-slate-400">
                  Shared-tie ranks on raw score · Top 50 + your position
                </p>
              </div>
              <button
                type="button"
                disabled={boardLoading}
                onClick={() => void refreshBoardOnly()}
                className="rounded border border-slate-700 bg-slate-950 hover:bg-slate-800 disabled:opacity-50 px-2.5 py-1 text-xs font-semibold cursor-pointer"
              >
                {boardLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {boardError && (
              <div className="rounded-lg border border-red-800 bg-red-950/70 px-3 py-2.5 text-xs text-red-100 flex items-center justify-between gap-2">
                <span>Unable to load leaderboard: {boardError}</span>
                <button
                  type="button"
                  disabled={boardLoading}
                  onClick={() => void refreshBoardOnly()}
                  className="shrink-0 rounded bg-slate-900/90 hover:bg-slate-800 px-2.5 py-1 text-[11px] font-semibold cursor-pointer"
                >
                  Retry Leaderboard
                </button>
              </div>
            )}

            {board && board.rows.length > 0 ? (
              <div className="space-y-2">
                <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-800 divide-y divide-slate-800/80 bg-slate-950">
                  {board.rows.map((row, idx) => (
                    <div
                      key={`${row.label}-${idx}`}
                      className={`flex items-center justify-between px-3 py-2 text-xs ${
                        row.isCurrentUser
                          ? 'bg-orange-950/40 text-orange-200 font-semibold'
                          : 'text-slate-200'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <span className="font-mono text-amber-300 w-10">
                          #{row.sharedRank}
                        </span>
                        <span>{row.label}</span>
                      </div>
                      <div className="font-mono text-right">
                        <span>
                          {row.rawScore}/{row.maxScore}
                        </span>{' '}
                        <span className="text-slate-400">
                          ({row.normalizedScore}%)
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                {board.currentUserRow &&
                  !board.rows.some((r) => r.isCurrentUser) && (
                    <div className="rounded-lg border border-orange-600/60 bg-orange-950/40 px-3 py-2 text-xs flex items-center justify-between font-semibold text-orange-200">
                      <div className="flex items-center gap-2.5">
                        <span className="font-mono text-amber-300">
                          #{board.currentUserRow.sharedRank}
                        </span>
                        <span>{board.currentUserRow.label} (Outside Top 50)</span>
                      </div>
                      <div className="font-mono">
                        {board.currentUserRow.rawScore}/
                        {board.currentUserRow.maxScore} (
                        {board.currentUserRow.normalizedScore}%)
                      </div>
                    </div>
                  )}
              </div>
            ) : !boardError ? (
              <div className="rounded-lg border border-slate-800 bg-slate-950 p-4 text-center text-xs text-slate-400">
                {boardLoading
                  ? 'Loading daily leaderboard…'
                  : `No ranked entries recorded for ${arena.dayId} UTC yet. Be the first challenger today!`}
              </div>
            ) : null}
          </section>
        )}
      </div>
    </div>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
