import type { ArenaResponse, BoardResponse } from './api.ts';

export type FetchResponseLike = {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
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

function isArenaResponse(value: unknown): value is ArenaResponse {
  if (!isRecord(value) || typeof value['postMode'] !== 'string') {
    return false;
  }
  if (value['postMode'] === 'archived') {
    return (
      typeof value['archivedDayId'] === 'string' &&
      typeof value['serverDayId'] === 'string'
    );
  }
  return (
    (value['postMode'] === 'hub' || value['postMode'] === 'daily') &&
    typeof value['dayId'] === 'string' &&
    typeof value['modifier'] === 'string' &&
    isRecord(value['hint']) &&
    isRecord(value['composition'])
  );
}

function isBoardResponse(value: unknown): value is BoardResponse {
  return (
    isRecord(value) &&
    typeof value['dayId'] === 'string' &&
    typeof value['modifier'] === 'string' &&
    typeof value['totalPlayers'] === 'number' &&
    Array.isArray(value['rows'])
  );
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
  const data = await res.json();
  if (!isArenaResponse(data)) {
    throw new Error('Invalid /api/arena response shape');
  }
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
    const board = await res.json();
    if (!isBoardResponse(board)) {
      return {
        ok: false,
        error: 'Invalid leaderboard response payload.',
      };
    }
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
