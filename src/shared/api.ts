import type {
  ExchangeOutcome,
  ExchangeSummary,
  ModifierId,
  Move,
  Strategy,
} from './engine.ts';

export type ArenaStatusResponse = {
  readonly type: 'arena_status';
  readonly appSlug: string;
  readonly postId: string;
  readonly postDataKind: string;
  readonly utcDayId: string;
  readonly modifier: ModifierId;
  readonly viewerAuthenticated: boolean;
  readonly username: string | null;
};

export type CrowdHint =
  | {
      readonly status: 'ready';
      readonly slot: 0 | 1 | 2;
      readonly slotLabel: 'opening' | 'middle' | 'closing';
      readonly topMove: Move | null;
      readonly message: string;
    }
  | {
      readonly status: 'insufficient_data';
      readonly message: string;
    };

export type FieldComposition = {
  readonly humans: number;
  readonly bots: number;
  readonly isStarterArena: boolean;
  readonly yesterdayHumanCount: number;
};

export type StreakRecord = {
  readonly lastPlayedDay: string;
  readonly currentCount: number;
  readonly bestCount: number;
};

export type RankedResultPayload = {
  readonly dayId: string;
  readonly modifier: ModifierId;
  readonly moves: Strategy;
  readonly rawScore: number;
  readonly maxScore: number;
  readonly normalizedScore: number;
  readonly exchangeSummary: ExchangeSummary;
  readonly sharedRank: number;
  readonly totalPlayers: number;
  readonly streak: StreakRecord;
  readonly composition: FieldComposition;
  readonly submittedAt: string;
};

export type ArenaArchivedResponse = {
  readonly postMode: 'archived';
  readonly archivedDayId: string;
  readonly serverDayId: string;
  readonly hubPostId: string | null;
  readonly hubUrl: string | null;
};

export type ArenaLiveResponse = {
  readonly postMode: 'hub' | 'daily';
  readonly dayId: string;
  readonly modifier: ModifierId;
  readonly hint: CrowdHint;
  readonly composition: FieldComposition;
  readonly rankedResult: RankedResultPayload | null;
  readonly streak: StreakRecord | null;
  readonly viewerAuthenticated: boolean;
  readonly username: string | null;
  readonly hubPostId: string | null;
  readonly hubUrl: string | null;
  readonly discussionPostId: string | null;
  readonly discussionUrl: string | null;
};

export type ArenaResponse = ArenaArchivedResponse | ArenaLiveResponse;

export type RankedSubmitRequest = {
  readonly moves: Strategy;
  readonly clientDayId: string;
};

export type RankedSubmitResponse = {
  readonly status: 'ok';
  readonly alreadySubmitted: boolean;
  readonly result: RankedResultPayload;
};

export type ResultRecoveryResponse =
  | {
      readonly dayId: string;
      readonly found: false;
    }
  | {
      readonly dayId: string;
      readonly found: true;
      readonly result: RankedResultPayload;
    };

export type PracticeSlotBreakdown = {
  readonly slot: 0 | 1 | 2;
  readonly playerMove: Move;
  readonly botMove: Move;
  readonly outcome: ExchangeOutcome;
  readonly pointsEarned: number;
};

export type PracticeRequest = {
  readonly moves: Strategy;
  readonly modifier?: ModifierId;
};

export type PracticeResponse = {
  readonly status: 'ok';
  readonly modifier: ModifierId;
  readonly playerMoves: Strategy;
  readonly botMoves: Strategy;
  readonly slots: readonly [
    PracticeSlotBreakdown,
    PracticeSlotBreakdown,
    PracticeSlotBreakdown,
  ];
  readonly rawScore: number;
  readonly maxScore: number;
  readonly normalizedScore: number;
  readonly wins: number;
  readonly ties: number;
  readonly losses: number;
  readonly swept: boolean;
};

export type LeaderboardRow = {
  readonly sharedRank: number;
  readonly label: string;
  readonly rawScore: number;
  readonly maxScore: number;
  readonly normalizedScore: number;
  readonly isCurrentUser: boolean;
};

export type BoardResponse = {
  readonly dayId: string;
  readonly modifier: ModifierId;
  readonly totalPlayers: number;
  readonly rows: readonly LeaderboardRow[];
  readonly currentUserRow: LeaderboardRow | null;
};

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'POST_ARCHIVED'
  | 'DAY_ROLLOVER'
  | 'DAILY_CAPACITY_REACHED'
  | 'TRANSACTION_CONFLICT';

export type ApiErrorResponse = {
  readonly status: 'error';
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly serverDayId?: string;
  readonly clientDayId?: string;
  readonly archivedDayId?: string;
  readonly hubPostId?: string | null;
  readonly hubUrl?: string | null;
};
