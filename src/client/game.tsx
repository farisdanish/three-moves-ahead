import './index.css';

import {
  navigateTo,
  navigateToPost,
  showLoginPrompt,
  showToast,
} from '@devvit/web/client';
import {
  StrictMode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
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
} from '../shared/api.ts';
import {
  fetchBoardStateIndependent,
  loadArenaThenBoardIndependent,
} from '../shared/arenaLoader.ts';
import {
  MODIFIER_CYCLE,
  type ModifierId,
  type Move,
  type Strategy,
} from '../shared/engine.ts';
import { DailyPodium } from './components/DailyPodium.tsx';
import { DojoStage } from './components/DojoStage.tsx';
import { type SpiritPose } from './components/SpiritSprite.tsx';
import { StrategyComposer } from './components/StrategyComposer.tsx';
import { useArenaMotion } from './useArenaMotion.ts';
import {
  formatUtcResetCountdown,
  hasUtcDayRolledOver,
} from './utcCountdown.ts';

type ActiveTab = 'ranked' | 'practice' | 'board';

const TAB_ORDER: readonly ActiveTab[] = ['ranked', 'practice', 'board'];

const TAB_LABELS: Record<ActiveTab, string> = {
  ranked: 'Arena',
  practice: 'Practice',
  board: 'Leaders',
};

function formatUtcTimestamp(nowMs: number = Date.now()): string {
  return `${new Date(nowMs).toISOString().slice(11, 19)} UTC`;
}

const MOVE_TITLES: Record<Move, string> = {
  A: 'Attack',
  D: 'Defend',
  C: 'Counter',
};

const MOVE_POSES: Record<Move, SpiritPose> = {
  A: 'attack',
  D: 'defend',
  C: 'counter',
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

function formatMovesFull(moves: readonly Move[]): string {
  return moves.map((move) => MOVE_TITLES[move]).join(' → ');
}

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

export const App = () => {
  const { motionEnabled, dataMotion, prefersReducedMotion, toggleMotion } =
    useArenaMotion();
  const tabBaseId = useId();
  const tabRefs = useRef<Record<ActiveTab, HTMLButtonElement | null>>({
    ranked: null,
    practice: null,
    board: null,
  });
  const rolloverRefreshInFlightRef = useRef<boolean>(false);
  const copyTimerRef = useRef<number | null>(null);

  const [arena, setArena] = useState<ArenaResponse | null>(null);
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [boardUpdatedAt, setBoardUpdatedAt] = useState<string | null>(null);
  const [boardLoading, setBoardLoading] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>('ranked');
  const [utcResetLabel, setUtcResetLabel] = useState<string>(() =>
    formatUtcResetCountdown()
  );

  const [preview, setPreview] = useState<{
    readonly pose: SpiritPose;
    readonly eventId: number;
  }>({ pose: 'ready', eventId: 0 });

  const [rankedMoves, setRankedMoves] = useState<Strategy>(['A', 'D', 'C']);
  const [confirmingLock, setConfirmingLock] = useState<boolean>(false);
  const [submittingRanked, setSubmittingRanked] = useState<boolean>(false);
  const [celebrateEventId, setCelebrateEventId] = useState<number>(1);
  const [copiedJustNow, setCopiedJustNow] = useState<boolean>(false);
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
  const [practiceResultPoseActive, setPracticeResultPoseActive] =
    useState<boolean>(false);
  const [practiceRunId, setPracticeRunId] = useState<number>(0);
  const [practiceReplayStep, setPracticeReplayStep] = useState<number | null>(
    null
  );
  const [practiceError, setPracticeError] = useState<string | null>(null);
  const [runningPractice, setRunningPractice] = useState<boolean>(false);

  const previewMove = useCallback((move: Move): void => {
    setPreview((previous) => ({
      pose: MOVE_POSES[move],
      eventId: previous.eventId + 1,
    }));
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
            setBoardUpdatedAt(formatUtcTimestamp());
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
            : 'Unable to load arena state. Check your connection and try again.',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshBoardOnly = useCallback(async () => {
    setBoardLoading(true);
    const outcome = await fetchBoardStateIndependent();
    if (outcome.ok) {
      setBoard(outcome.board);
      setBoardError(null);
      setBoardUpdatedAt(formatUtcTimestamp());
      if (
        arena &&
        arena.postMode !== 'archived' &&
        outcome.board.dayId > arena.dayId &&
        !rolloverRefreshInFlightRef.current
      ) {
        rolloverRefreshInFlightRef.current = true;
        setBannerNotice({
          tone: 'amber',
          text: 'UTC day rolled over — refreshed to today’s challenge.',
        });
        void loadArenaAndBoard(true).finally(() => {
          rolloverRefreshInFlightRef.current = false;
        });
      }
    } else {
      setBoardError(outcome.error);
    }
    setBoardLoading(false);
  }, [arena, loadArenaAndBoard]);

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
              setBoardUpdatedAt(formatUtcTimestamp());
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
                : 'Unable to load arena state. Check your connection and try again.',
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

  const liveArenaDayId =
    arena && arena.postMode !== 'archived' ? arena.dayId : null;

  useEffect(() => {
    const syncUtcClockAndRollover = (): void => {
      setUtcResetLabel(formatUtcResetCountdown());
      if (
        liveArenaDayId &&
        hasUtcDayRolledOver(liveArenaDayId) &&
        !rolloverRefreshInFlightRef.current
      ) {
        rolloverRefreshInFlightRef.current = true;
        setConfirmingLock(false);
        setBannerNotice({
          tone: 'amber',
          text: 'UTC day rolled over — refreshed to today’s challenge.',
        });
        void loadArenaAndBoard(true).finally(() => {
          rolloverRefreshInFlightRef.current = false;
        });
      }
    };

    const interval = window.setInterval(syncUtcClockAndRollover, 30_000);
    const onVisibilityOrFocus = (): void => {
      if (document.visibilityState === 'visible') {
        syncUtcClockAndRollover();
      }
    };
    window.addEventListener('focus', onVisibilityOrFocus);
    document.addEventListener('visibilitychange', onVisibilityOrFocus);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onVisibilityOrFocus);
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
    };
  }, [liveArenaDayId, loadArenaAndBoard]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const effectivePracticeReplayStep =
    motionEnabled && activeTab === 'practice' ? practiceReplayStep : null;

  // Practice replay choreography: 240ms step pacing with clean cancellation
  // on tab change, unmount, skip, or motion disabled.
  useEffect(() => {
    if (effectivePracticeReplayStep === null) {
      return;
    }

    const delayMs = effectivePracticeReplayStep < 2 ? 240 : 320;
    const timer = window.setTimeout(() => {
      setPracticeReplayStep((current) => {
        if (current === null || current >= 2) {
          return null;
        }
        return current + 1;
      });
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [effectivePracticeReplayStep, practiceRunId]);

  const handleTabChange = (nextTab: ActiveTab): void => {
    setPracticeReplayStep(null);
    setConfirmingLock(false);
    setActiveTab(nextTab);
  };

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentTab: ActiveTab
  ): void => {
    const currentIndex = TAB_ORDER.indexOf(currentTab);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % TAB_ORDER.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = TAB_ORDER.length - 1;
    }
    if (nextIndex === null) return;
    const nextTab = TAB_ORDER[nextIndex];
    if (!nextTab) return;
    event.preventDefault();
    handleTabChange(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  const handleRankedMovesChange = (nextMoves: Strategy): void => {
    setConfirmingLock(false);
    setRankedMoves(nextMoves);
  };

  const handleToggleMotion = (): void => {
    setPracticeReplayStep(null);
    toggleMotion();
  };

  const handleLockRankedStrategy = async (
    liveArena: ArenaLiveResponse
  ): Promise<void> => {
    setConfirmingLock(false);
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
        setCelebrateEventId((prev) => prev + 1);
        showToast(
          data.alreadySubmitted
            ? 'Loaded your locked strategy for today.'
            : 'Strategy locked.'
        );
        void refreshBoardOnly();
        return;
      }

      const errBody: ApiErrorResponse = await res.json();

      if (res.status === 409 && errBody.code === 'DAY_ROLLOVER') {
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
                text: `Recovered your ${recData.dayId} UTC result (${recData.result.rawScore}/${recData.result.maxScore}, Rank #${recData.result.sharedRank}). Arena refreshed to today’s UTC day.`,
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
          text: 'UTC day changed while the arena was open. Refreshed to today’s challenge.',
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
        text:
          errBody.message ||
          `Submission failed (HTTP ${res.status}). Retry locking your strategy.`,
      });
    } catch (err) {
      setBannerNotice({
        tone: 'red',
        text:
          err instanceof Error
            ? err.message
            : 'Network error while locking strategy. Retry your submission.',
      });
    } finally {
      setSubmittingRanked(false);
    }
  };

  const handleRunPractice = async (): Promise<void> => {
    setRunningPractice(true);
    setPracticeError(null);
    setPracticeReplayStep(null);
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
        throw new Error(
          `Practice request failed (HTTP ${res.status}). Try again.`
        );
      }
      const data: PracticeResponse = await res.json();
      setPracticeResult(data);
      setPracticeResultPoseActive(true);
      setPracticeRunId((prev) => prev + 1);
      if (motionEnabled) {
        setPracticeReplayStep(0);
      }
    } catch (err) {
      setPracticeError(
        err instanceof Error
          ? err.message
          : 'Practice duel failed. Try running Practice again.'
      );
    } finally {
      setRunningPractice(false);
    }
  };

  const handleUsePracticeInRanked = (): void => {
    setRankedMoves([...practiceMoves]);
    setConfirmingLock(false);
    setPracticeReplayStep(null);
    setActiveTab('ranked');
  };

  const handleCopyResult = async (
    result: RankedResultPayload
  ): Promise<void> => {
    const shareText = buildSpoilerSafeShareText(result);
    try {
      await navigator.clipboard.writeText(shareText);
      setCopiedJustNow(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedJustNow(false);
        copyTimerRef.current = null;
      }, 2500);
      showToast('Spoiler-safe result copied.');
    } catch {
      showToast('Clipboard access unavailable in this browser.');
    }
  };

  if (loading && !arena) {
    return (
      <main className="dojo-root" data-motion={dataMotion}>
        <div className="dojo-shell">
          <div
            role="status"
            aria-busy="true"
            className="dojo-panel space-y-3 p-4"
          >
            <span className="sr-only">Loading Three Moves Ahead dojo…</span>
            <div className="dojo-skeleton h-6 w-48" />
            <div className="dojo-skeleton h-4 w-64" />
            <div className="dojo-skeleton h-36 w-full" />
            <div className="dojo-skeleton h-20 w-full" />
          </div>
        </div>
      </main>
    );
  }

  if (arena?.postMode === 'archived') {
    return (
      <main
        className="dojo-root flex flex-col items-center justify-center p-4"
        data-motion={dataMotion}
      >
        <section
          aria-label="Archived daily arena"
          className="dojo-panel w-full max-w-md space-y-3"
        >
          <DojoStage
            pose="ready"
            eventId={0}
            mode="ranked"
            caption={`Archived post · ${arena.archivedDayId} UTC`}
          />
          <p className="dojo-eyebrow">
            Archived Daily Post · {arena.archivedDayId} UTC
          </p>
          <h1 className="dojo-title">
            This daily arena ({arena.archivedDayId} UTC) has closed
          </h1>
          <p className="dojo-body">
            Ranked entries lock once per UTC day. Today’s live arena is{' '}
            <strong className="dojo-num text-amber-200">
              {arena.serverDayId} UTC
            </strong>{' '}
            on the Evergreen Hub.
          </p>
          <button
            type="button"
            onClick={() => openRedditPostOrUrl(arena.hubPostId, arena.hubUrl)}
            className="dojo-cta-primary cursor-pointer"
          >
            Play Today’s Arena
          </button>
        </section>
      </main>
    );
  }

  if (!arena) {
    return (
      <main
        className="dojo-root flex flex-col items-center justify-center p-4"
        data-motion={dataMotion}
      >
        <section
          role="alert"
          aria-label="Arena load error"
          className="dojo-panel w-full max-w-md border-red-800 space-y-3"
        >
          <h1 className="dojo-heading text-red-200">Unable to load arena</h1>
          <p className="dojo-body text-red-100">
            {bannerNotice?.text ??
              'Could not load today’s arena state. Check your connection and retry.'}
          </p>
          <button
            type="button"
            onClick={() => void loadArenaAndBoard()}
            className="dojo-cta-secondary cursor-pointer"
          >
            Retry loading arena
          </button>
        </section>
      </main>
    );
  }

  const modMeta = MODIFIER_META[arena.modifier];
  const rankedResult = arena.rankedResult;

  const rankedStagePose: SpiritPose = rankedResult ? 'celebrate' : preview.pose;
  const rankedStageEventId = rankedResult ? celebrateEventId : preview.eventId;

  const activePracticeSlot =
    practiceResult && effectivePracticeReplayStep !== null
      ? practiceResult.slots[effectivePracticeReplayStep]
      : undefined;

  const practiceStagePose: SpiritPose = activePracticeSlot
    ? MOVE_POSES[activePracticeSlot.playerMove]
    : practiceResult && practiceResultPoseActive && practiceResult.wins >= 2
      ? 'celebrate'
      : preview.pose;

  const practiceStageEventId = activePracticeSlot
    ? practiceRunId * 10 + (effectivePracticeReplayStep ?? 0)
    : practiceResult && practiceResultPoseActive
      ? practiceRunId
      : preview.eventId;

  const practiceStageBadge = activePracticeSlot
    ? `Turn ${activePracticeSlot.slot + 1}: ${activePracticeSlot.outcome} (+${activePracticeSlot.pointsEarned})`
    : null;

  return (
    <main className="dojo-root" data-motion={dataMotion}>
      <div className="dojo-shell">
        <p role="status" className="sr-only">
          {submittingRanked
            ? 'Locking strategy…'
            : rankedResult
              ? `Strategy locked. Score ${rankedResult.rawScore} out of ${rankedResult.maxScore}.`
              : ''}
        </p>

        {/* Compact Top Bar & Rule Strip */}
        <header className="dojo-topbar">
          <div className="dojo-topbar__row">
            <h1 className="dojo-title">Three Moves Ahead</h1>

            {prefersReducedMotion ? (
              <span
                className="dojo-pill shrink-0"
                title="Motion is off because your system prefers reduced motion"
              >
                Motion: Reduced
              </span>
            ) : (
              <button
                type="button"
                className="dojo-motion-btn shrink-0"
                aria-pressed={dataMotion === 'on'}
                onClick={handleToggleMotion}
                title="Toggle stage and sprite animations for this session"
              >
                {dataMotion === 'on' ? 'Motion: On' : 'Motion: Off'}
              </button>
            )}
          </div>

          <p className="dojo-eyebrow dojo-num">
            {arena.dayId} UTC · Resets in {utcResetLabel} · {modMeta.name} (
            {modMeta.shortRule})
          </p>

          <div className="dojo-topbar__actions">
            {arena.streak && (
              <span className="dojo-pill dojo-pill--streak dojo-num">
                Streak {arena.streak.currentCount}d
              </span>
            )}
            <span className="dojo-pill dojo-num">
              {arena.composition.isStarterArena
                ? 'Starter Arena · 0 people + 9 bots'
                : `${arena.composition.humans} people + ${arena.composition.bots} bots`}
            </span>
            <details className="dojo-rules-disclosure">
              <summary className="dojo-rules-summary">Rules</summary>
              <div className="pt-1 space-y-1">
                <p className="dojo-meta">{modMeta.detail}</p>
                <p className="dojo-meta">
                  Combat triangle: Attack beats Counter · Counter beats Defend ·
                  Defend beats Attack.
                </p>
              </div>
            </details>
          </div>
        </header>

        {/* Status / Rollover / Recovery Banner */}
        {bannerNotice && (
          <div
            role={bannerNotice.tone === 'red' ? 'alert' : 'status'}
            className={`rounded-xl border px-3.5 py-2.5 dojo-meta flex flex-wrap items-center justify-between gap-2.5 ${
              bannerNotice.tone === 'emerald'
                ? 'border-emerald-700 bg-emerald-950/75 text-emerald-100'
                : bannerNotice.tone === 'amber'
                  ? 'border-amber-700 bg-amber-950/75 text-amber-100'
                  : 'border-red-800 bg-red-950/85 text-red-100'
            }`}
          >
            <span>{bannerNotice.text}</span>
            <button
              type="button"
              onClick={() => void loadArenaAndBoard()}
              className="dojo-cta-secondary shrink-0 cursor-pointer"
            >
              Refresh arena
            </button>
          </div>
        )}

        {/* Recovered Pre-Midnight Result Notice */}
        {recoveredResult && (
          <div
            role="status"
            className="rounded-xl border border-emerald-700/80 bg-emerald-950/50 px-3.5 py-2.5 dojo-meta text-emerald-100 flex flex-wrap items-center justify-between gap-2.5"
          >
            <span className="dojo-num">
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
              className="dojo-cta-secondary cursor-pointer"
            >
              Copy {recoveredResult.dayId} result
            </button>
          </div>
        )}

        {/* Section Navigation */}
        <div role="tablist" aria-label="Arena sections" className="dojo-nav">
          {TAB_ORDER.map((tabId) => {
            const isSelected = activeTab === tabId;
            return (
              <button
                key={tabId}
                id={`${tabBaseId}-tab-${tabId}`}
                ref={(el) => {
                  tabRefs.current[tabId] = el;
                }}
                type="button"
                role="tab"
                aria-selected={isSelected}
                aria-controls={`${tabBaseId}-panel-${tabId}`}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => handleTabChange(tabId)}
                onKeyDown={(e) => handleTabKeyDown(e, tabId)}
                className={`dojo-tab${isSelected ? ' dojo-tab--active' : ''}`}
              >
                {TAB_LABELS[tabId]}
              </button>
            );
          })}
        </div>

        {/* Ranked Arena & Result Scorecard */}
        {activeTab === 'ranked' && (
          <section
            id={`${tabBaseId}-panel-ranked`}
            role="tabpanel"
            aria-labelledby={`${tabBaseId}-tab-ranked`}
            aria-busy={submittingRanked}
            className="dojo-panel"
          >
            <DojoStage
              pose={rankedStagePose}
              eventId={rankedStageEventId}
              mode="ranked"
              caption={
                rankedResult
                  ? `Daily seal stamped · ${rankedResult.dayId} UTC`
                  : 'Nine stored echoes. One daily challenge.'
              }
            />

            <p className="dojo-clue-bar">
              <strong className="text-teal-200">Yesterday’s crowd clue: </strong>
              <span>{arena.hint.message}</span>{' '}
              <span className="dojo-meta">
                {arena.hint.status === 'insufficient_data'
                  ? `(${arena.composition.yesterdayHumanCount}/10 yesterday human entries needed; up to 9 sampled into today’s field.)`
                  : `(From ${arena.composition.yesterdayHumanCount} yesterday human entries; up to 9 sampled into today’s 9-ghost field.)`}
              </span>
            </p>

            {rankedResult ? (
              <div className="ranked-seal-reveal space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-700/80 pb-3">
                  <div className="space-y-0.5">
                    <p className="dojo-meta font-semibold text-emerald-300">
                      Strategy Locked · {rankedResult.dayId} UTC
                    </p>
                    <h2 className="dojo-heading">
                      {formatMovesFull(rankedResult.moves)}
                    </h2>
                  </div>
                  <div className="text-left sm:text-right">
                    <div className="dojo-score">
                      {rankedResult.rawScore} / {rankedResult.maxScore}
                    </div>
                    <div className="dojo-meta dojo-num">
                      Normalized: {rankedResult.normalizedScore}%
                    </div>
                  </div>
                </div>

                <div className="dojo-stat-grid">
                  <div className="dojo-stat-card">
                    <div className="dojo-meta">Shared Rank</div>
                    <div className="text-base font-bold text-white dojo-num mt-0.5">
                      {rankedResult.totalPlayers <= 1
                        ? '1st of 1 (First challenger today)'
                        : `#${rankedResult.sharedRank} of ${rankedResult.totalPlayers}`}
                    </div>
                  </div>

                  <div className="dojo-stat-card">
                    <div className="dojo-meta">27 Exchanges</div>
                    <div className="text-base font-bold text-white dojo-num mt-0.5">
                      {rankedResult.exchangeSummary.wins}W ·{' '}
                      {rankedResult.exchangeSummary.ties}T ·{' '}
                      {rankedResult.exchangeSummary.losses}L
                      {rankedResult.modifier === 'sweep_bonus'
                        ? ` (${rankedResult.exchangeSummary.sweeps} sweeps)`
                        : ''}
                    </div>
                  </div>

                  <div className="dojo-stat-card">
                    <div className="dojo-meta">UTC Streak</div>
                    <div className="text-base font-bold text-amber-300 dojo-num mt-0.5">
                      {rankedResult.streak.currentCount}d (Best{' '}
                      {rankedResult.streak.bestCount}d)
                    </div>
                  </div>

                  <div className="dojo-stat-card">
                    <div className="dojo-meta">9-Ghost Field</div>
                    <div className="text-base font-bold text-slate-100 dojo-num mt-0.5">
                      {rankedResult.composition.isStarterArena
                        ? 'Starter Arena (9 bots)'
                        : `${rankedResult.composition.humans} people + ${rankedResult.composition.bots} bots`}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={() =>
                      openRedditPostOrUrl(
                        arena.discussionPostId,
                        arena.discussionUrl
                      )
                    }
                    className="dojo-cta-primary flex-1"
                  >
                    Join today’s discussion
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopyResult(rankedResult)}
                    className="dojo-cta-secondary"
                  >
                    {copiedJustNow ? 'Copied!' : 'Copy result'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2.5">
                <StrategyComposer
                  moves={rankedMoves}
                  onChange={handleRankedMovesChange}
                  disabled={submittingRanked}
                  onPreview={previewMove}
                />

                <p className="dojo-meta text-center">
                  Repeats allowed. Lock once per UTC day; cannot be changed today.
                </p>

                {arena.viewerAuthenticated ? (
                  confirmingLock ? (
                    <div
                      role="region"
                      aria-label="Confirm ranked lock"
                      className="dojo-confirm-bar space-y-2"
                    >
                      <p className="dojo-meta text-amber-100 font-semibold">
                        Lock{' '}
                        <span className="text-white">
                          {formatMovesFull(rankedMoves)}
                        </span>{' '}
                        permanently for {arena.dayId} UTC? This cannot be
                        changed today.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={submittingRanked}
                          onClick={() => void handleLockRankedStrategy(arena)}
                          className="dojo-cta-primary flex-1"
                        >
                          {submittingRanked
                            ? 'Locking strategy…'
                            : 'Confirm & Lock'}
                        </button>
                        <button
                          type="button"
                          disabled={submittingRanked}
                          onClick={() => setConfirmingLock(false)}
                          className="dojo-cta-secondary shrink-0"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={submittingRanked}
                      onClick={() => setConfirmingLock(true)}
                      className="dojo-cta-primary"
                    >
                      {submittingRanked
                        ? 'Locking strategy…'
                        : `Lock strategy (${formatMovesFull(rankedMoves)})`}
                    </button>
                  )
                ) : (
                  <div className="rounded-xl border border-amber-700/70 bg-amber-950/35 p-3.5 space-y-2.5">
                    <p className="dojo-body text-amber-100">
                      You are viewing logged out. Sign in to Reddit to lock a
                      ranked entry, or test strategies in Practice.
                    </p>
                    <div className="flex flex-wrap gap-2.5">
                      <button
                        type="button"
                        onClick={() => showLoginPrompt()}
                        className="dojo-cta-primary flex-1"
                      >
                        Sign in to play ranked
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTabChange('practice')}
                        className="dojo-cta-secondary"
                      >
                        Try Practice
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* Unranked Practice */}
        {activeTab === 'practice' && (
          <section
            id={`${tabBaseId}-panel-practice`}
            role="tabpanel"
            aria-labelledby={`${tabBaseId}-tab-practice`}
            aria-busy={runningPractice}
            className="dojo-panel"
          >
            <DojoStage
              pose={practiceStagePose}
              eventId={practiceStageEventId}
              mode="practice"
              badgeText={practiceStageBadge}
              caption="Practice against an independent bot (unranked)"
            />

            <div className="space-y-1.5">
              <p className="dojo-meta font-semibold text-teal-200">
                Practice Rule Modifier (defaults to today’s rule):
              </p>
              <div
                role="group"
                aria-label="Practice rule modifier"
                className="grid grid-cols-3 gap-2"
              >
                {MODIFIER_CYCLE.map((modId) => {
                  const active = practiceModifier === modId;
                  return (
                    <button
                      key={modId}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setPracticeModifier(modId)}
                      className={`dojo-control rounded-lg border px-2 py-1.5 text-sm font-semibold cursor-pointer ${
                        active
                          ? 'border-teal-300 bg-teal-950/80 text-teal-100'
                          : 'border-slate-700 bg-slate-950/90 text-slate-200 hover:border-slate-500'
                      }`}
                    >
                      {MODIFIER_META[modId].name}
                    </button>
                  );
                })}
              </div>
              <p className="dojo-meta">
                <strong className="text-slate-100">
                  {MODIFIER_META[practiceModifier].shortRule}
                </strong>{' '}
                — {MODIFIER_META[practiceModifier].detail}
              </p>
            </div>

            <StrategyComposer
              moves={practiceMoves}
              onChange={(next) => {
                setPracticeReplayStep(null);
                setPracticeResultPoseActive(false);
                setPracticeMoves(next);
              }}
              disabled={runningPractice}
              onPreview={(move) => {
                setPracticeReplayStep(null);
                setPracticeResultPoseActive(false);
                previewMove(move);
              }}
            />

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={runningPractice}
                onClick={() => void handleRunPractice()}
                className="dojo-cta-practice flex-1"
              >
                {runningPractice
                  ? 'Simulating Practice Duel…'
                  : `Run Practice (${formatMovesFull(practiceMoves)})`}
              </button>
              {effectivePracticeReplayStep !== null && (
                <button
                  type="button"
                  onClick={() => setPracticeReplayStep(null)}
                  className="dojo-cta-secondary shrink-0"
                >
                  Skip animation
                </button>
              )}
            </div>

            {practiceError && (
              <div
                role="alert"
                className="dojo-alert flex flex-wrap items-center justify-between gap-2.5"
              >
                <span className="dojo-meta text-red-100">{practiceError}</span>
                <button
                  type="button"
                  disabled={runningPractice}
                  onClick={() => void handleRunPractice()}
                  className="dojo-cta-secondary shrink-0"
                >
                  Retry Practice
                </button>
              </div>
            )}

            {practiceResult && (
              <div
                role="status"
                className="rounded-xl border border-teal-700/70 bg-slate-950/95 p-3.5 space-y-2.5"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-base font-bold text-teal-200">
                    Practice Result ({MODIFIER_META[practiceResult.modifier].name})
                  </span>
                  <span className="text-lg font-extrabold text-amber-300 dojo-num">
                    {practiceResult.rawScore} / {practiceResult.maxScore} pts (
                    {practiceResult.normalizedScore}%)
                    {practiceResult.swept ? ' · Sweep +3' : ''}
                  </span>
                </div>
                <div className="practice-slots-grid">
                  {practiceResult.slots.map((slotItem) => {
                    const isActiveStep =
                      effectivePracticeReplayStep === slotItem.slot;
                    const isPendingStep =
                      effectivePracticeReplayStep !== null &&
                      slotItem.slot > effectivePracticeReplayStep;
                    return (
                      <div
                        key={slotItem.slot}
                        className={`practice-slot-card${
                          isActiveStep ? ' practice-slot-card--active' : ''
                        }${isPendingStep ? ' practice-slot-card--pending' : ''}`}
                      >
                        <div className="dojo-meta">
                          Turn {slotItem.slot + 1}
                        </div>
                        <div className="text-sm font-bold text-white mt-0.5">
                          You: {MOVE_TITLES[slotItem.playerMove]} vs Bot:{' '}
                          {MOVE_TITLES[slotItem.botMove]}
                        </div>
                        <div className="dojo-meta dojo-num text-amber-300 capitalize mt-0.5">
                          {slotItem.outcome} (+{slotItem.pointsEarned})
                        </div>
                      </div>
                    );
                  })}
                </div>
                {!rankedResult && (
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <span className="dojo-meta">
                      Independent 1v1 sparring bot (max {practiceResult.maxScore}{' '}
                      pts).
                    </span>
                    <button
                      type="button"
                      onClick={handleUsePracticeInRanked}
                      className="dojo-cta-secondary shrink-0"
                    >
                      Use in Ranked ({formatMovesFull(practiceMoves)})
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* Daily Leaderboard */}
        {activeTab === 'board' && (
          <section
            id={`${tabBaseId}-panel-board`}
            role="tabpanel"
            aria-labelledby={`${tabBaseId}-tab-board`}
            aria-busy={boardLoading}
            className="dojo-panel"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="dojo-heading">
                  Daily Leaderboard · {board?.dayId ?? arena.dayId} UTC
                </h2>
                <p className="dojo-meta">
                  Shared-tie ranks on raw score (ties share a rank, next rank
                  skips) ·{' '}
                  {board ? `${board.totalPlayers} total` : 'Top 50 & your rank'}
                </p>
              </div>
              <button
                type="button"
                disabled={boardLoading}
                onClick={() => void refreshBoardOnly()}
                className="dojo-cta-secondary shrink-0"
              >
                {boardLoading ? 'Refreshing…' : 'Refresh leaderboard'}
              </button>
            </div>

            {boardError && (
              <div
                role="alert"
                className="dojo-alert flex flex-wrap items-center justify-between gap-2.5"
              >
                <span className="dojo-meta text-red-100">
                  {board
                    ? `Showing cached standings from ${boardUpdatedAt ?? 'earlier'}. Unable to refresh (${boardError}). Ranked Arena and Practice still work.`
                    : `Unable to load the daily leaderboard (${boardError}). Ranked Arena and Practice still work.`}
                </span>
                <button
                  type="button"
                  disabled={boardLoading}
                  onClick={() => void refreshBoardOnly()}
                  className="dojo-cta-secondary shrink-0"
                >
                  Retry Leaderboard
                </button>
              </div>
            )}

            {board && board.rows.length > 0 ? (
              <div className="space-y-3">
                <DailyPodium rows={board.rows} />

                <div className="max-h-72 overflow-y-auto rounded-xl border border-slate-700/80 divide-y divide-slate-800/90 bg-slate-950/95">
                  {board.rows.map((row, idx) => (
                    <div
                      key={`${row.label}-${idx}`}
                      aria-current={row.isCurrentUser ? 'true' : undefined}
                      className={`flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3.5 py-2.5 dojo-meta ${
                        row.isCurrentUser
                          ? 'border-l-4 border-l-orange-400 bg-orange-950/45 text-orange-100 font-semibold'
                          : 'text-slate-100'
                      }`}
                    >
                      <div className="flex flex-wrap items-baseline gap-2.5">
                        <span className="font-mono dojo-num text-amber-300 min-w-10 shrink-0">
                          #{row.sharedRank}
                        </span>
                        <span className="break-words">{row.label}</span>
                      </div>
                      <div className="font-mono dojo-num text-right shrink-0">
                        <span>
                          {row.rawScore}/{row.maxScore}
                        </span>{' '}
                        <span className="text-slate-300">
                          ({row.normalizedScore}%)
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                {board.currentUserRow &&
                  !board.rows.some((r) => r.isCurrentUser) && (
                    <div className="rounded-xl border border-orange-500/70 bg-orange-950/45 px-3.5 py-2.5 dojo-meta flex flex-wrap items-center justify-between gap-2 font-semibold text-orange-100">
                      <div className="flex flex-wrap items-baseline gap-2.5">
                        <span className="font-mono dojo-num text-amber-300">
                          #{board.currentUserRow.sharedRank}
                        </span>
                        <span className="break-words">
                          {board.currentUserRow.label} (Outside Top 50)
                        </span>
                      </div>
                      <div className="font-mono dojo-num">
                        {board.currentUserRow.rawScore}/
                        {board.currentUserRow.maxScore} (
                        {board.currentUserRow.normalizedScore}%)
                      </div>
                    </div>
                  )}
              </div>
            ) : !boardError ? (
              <div
                role="status"
                className="rounded-xl border border-slate-700/80 bg-slate-950/90 p-5 text-center space-y-3"
              >
                <p className="dojo-body">
                  {boardLoading
                    ? 'Loading daily leaderboard…'
                    : `No ranked entries recorded for ${arena.dayId} UTC yet. Lock your strategy in Ranked Arena to set the first score.`}
                </p>
                {!boardLoading && (
                  <button
                    type="button"
                    onClick={() => handleTabChange('ranked')}
                    className="dojo-cta-secondary"
                  >
                    Go to Ranked Arena
                  </button>
                )}
              </div>
            ) : null}
          </section>
        )}
      </div>
    </main>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
