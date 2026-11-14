import type { ArenaResponse, BoardResponse } from './api.ts';

export type FetchResponseLike = {
  readonly ok: boolean;
  readonly status: number;
  // Matches standard Fetch Response.json() signature without requiring type assertions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): Promise<any>;
};

export type FetchLike = (
  input: string,
  init?: RequestInit
) => Promise<FetchResponseLike>;

export type BoardFetchOutcome =
  | {
      readonly ok: true;
      readonly board: BoardResponse;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractApiErrorMessage(
  payload: unknown,
  fallbackText: string
): string {
  if (
    isRecord(payload) &&
    typeof payload['message'] === 'string' &&
    payload['message'].length > 0
  ) {
    return payload['message'];
  }
  return fallbackText;
}

/**
 * Fetches `/api/arena` and throws only when the arena endpoint itself fails.
 */
export async function fetchArenaState(
  fetchFn: FetchLike = fetch
): Promise<ArenaResponse> {
  const res = await fetchFn('/api/arena');
  if (!res.ok) {
    let errText = `Arena load failed (HTTP ${res.status})`;
    try {
      const errJson: unknown = await res.json();
      errText = extractApiErrorMessage(errJson, errText);
    } catch {
      // Keep default status error text.
    }
    throw new Error(errText);
  }
  const data: ArenaResponse = await res.json();
  return data;
}

/**
 * Fetches `/api/board` independently without ever throwing.
 * Distinguishes both rejected network requests and non-2xx HTTP responses
 * from a genuinely empty leaderboard.
 */
export async function fetchBoardStateIndependent(
  fetchFn: FetchLike = fetch
): Promise<BoardFetchOutcome> {
  try {
    const res = await fetchFn('/api/board');
    if (!res.ok) {
      let detail = `Leaderboard load failed (HTTP ${res.status})`;
      try {
        const errBody: unknown = await res.json();
        detail = extractApiErrorMessage(errBody, detail);
      } catch {
        // Keep HTTP status fallback message.
      }
      return {
        ok: false,
        error: detail,
      };
    }
    const board: BoardResponse = await res.json();
    return {
      ok: true,
      board,
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : 'Unable to load daily leaderboard.',
    };
  }
}

/**
 * Loads `/api/arena` first and commits it immediately via `onArenaReady` before
 * requesting `/api/board`, ensuring a failed or rejected leaderboard request
 * never discards the arena or blocks Ranked/Practice play.
 */
export async function loadArenaThenBoardIndependent(params: {
  readonly fetchFn?: FetchLike;
  readonly onArenaReady: (arena: ArenaResponse) => void;
  readonly onBoardOutcome: (outcome: BoardFetchOutcome) => void;
}): Promise<ArenaResponse> {
  const fetchFn = params.fetchFn ?? fetch;
  const arenaData = await fetchArenaState(fetchFn);
  params.onArenaReady(arenaData);

  if (arenaData.postMode !== 'archived') {
    const boardOutcome = await fetchBoardStateIndependent(fetchFn);
    params.onBoardOutcome(boardOutcome);
  }

  return arenaData;
}
