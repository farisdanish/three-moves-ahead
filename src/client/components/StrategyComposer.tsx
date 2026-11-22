import { useId, useState } from 'react';
import { MOVES, type Move, type Strategy } from '../../shared/engine.ts';

type Turn = 0 | 1 | 2;

const TURNS: readonly [Turn, Turn, Turn] = [0, 1, 2];

const TURN_LABELS: Record<Turn, string> = {
  0: 'Opening',
  1: 'Middle',
  2: 'Closing',
};

const MOVE_COPY: Record<
  Move,
  {
    readonly title: string;
    readonly beats: string;
    readonly theme: 'attack' | 'defend' | 'counter';
  }
> = {
  A: {
    title: 'Attack',
    beats: 'Beats Counter',
    theme: 'attack',
  },
  D: {
    title: 'Defend',
    beats: 'Beats Attack',
    theme: 'defend',
  },
  C: {
    title: 'Counter',
    beats: 'Beats Defend',
    theme: 'counter',
  },
};

function MoveEmblem({ move }: { readonly move: Move }) {
  if (move === 'A') {
    return (
      <svg viewBox="0 0 48 48" width="38" height="38" fill="none">
        <path
          d="M27 5C29 12 36 15 39 23C42 31 37 40 27 42C19 44 10 39 9 30C8 24 12 20 15 17C14 21 16 24 19 24C17 17 21 10 27 5Z"
          fill="#d94c28"
          stroke="#2b1e1a"
          strokeWidth="2.6"
          strokeLinejoin="round"
        />
        <path
          d="M26 16C29 21 33 24 33 30C33 35 29 38 24 38C20 38 17 35 17 31C17 28 19 25 22 23C22 26 24 27 26 26C25 22 25 19 26 16Z"
          fill="#ffd36d"
        />
      </svg>
    );
  }
  if (move === 'D') {
    return (
      <svg viewBox="0 0 48 48" width="38" height="38" fill="none">
        <path
          d="M24 6L39 11.5V23C39 32.8 32.5 39.6 24 43C15.5 39.6 9 32.8 9 23V11.5L24 6Z"
          fill="#3ab5a7"
          stroke="#2b1e1a"
          strokeWidth="2.6"
          strokeLinejoin="round"
        />
        <path
          d="M24 10.5L34.5 14.4V23C34.5 30.2 29.8 35.4 24 38.2V10.5Z"
          fill="#58d8ca"
        />
        <path
          d="M24 18.5C27 18.5 29.5 21 29.5 24C29.5 27.5 26.7 30 23.5 30C20.8 30 19 28 19 25.5C19 23.4 20.6 22 22.5 22C24 22 25 23.1 25 24.4"
          stroke="#fff2cf"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 48 48" width="38" height="38" fill="none">
      <path
        d="M35 11C28 8 18 11 13 18C9 24 9 32 14 37C17 40 22 41 27 40C20 38 17 32 18 25C19 18 26 14 35 11Z"
        fill="#b994ef"
        stroke="#2b1e1a"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      <path
        d="M15 37C22 40 31 37 36 30C40 24 40 16 35 11C32 18 28 24 22 29C19 32 17 34 15 37Z"
        fill="#8f67d6"
        stroke="#2b1e1a"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      <path
        d="M29 18L31.5 22.5L36 25L31.5 27.5L29 32L26.5 27.5L22 25L26.5 22.5L29 18Z"
        fill="#fff2cf"
      />
    </svg>
  );
}

export type StrategyComposerProps = {
  readonly moves: Strategy;
  readonly onChange: (moves: Strategy) => void;
  readonly disabled: boolean;
  readonly onPreview: (move: Move) => void;
};

/**
 * Interactive Opening -> Middle -> Closing sequence paired with three
 * illustrated radio choices that trigger fighter poses without stealing focus.
 */
export function StrategyComposer(props: StrategyComposerProps) {
  const { moves, onChange, disabled, onPreview } = props;
  const [activeTurn, setActiveTurn] = useState<Turn>(0);
  const groupId = useId();

  const choose = (move: Move): void => {
    if (disabled) return;
    onChange([
      activeTurn === 0 ? move : moves[0],
      activeTurn === 1 ? move : moves[1],
      activeTurn === 2 ? move : moves[2],
    ]);
    onPreview(move);
  };

  return (
    <div className="strategy-composer">
      <div
        role="group"
        aria-label="Turn to edit"
        className="strategy-sequence"
      >
        {TURNS.map((turn, index) => {
          const move = moves[turn];
          const meta = MOVE_COPY[move];
          const isSelectedTurn = activeTurn === turn;
          return (
            <button
              key={turn}
              type="button"
              disabled={disabled}
              aria-pressed={isSelectedTurn}
              aria-label={`${TURN_LABELS[turn]}: ${meta.title}`}
              data-move={meta.theme}
              className={`turn-step${isSelectedTurn ? ' turn-step--active' : ''}`}
              onClick={() => setActiveTurn(turn)}
            >
              <span className="turn-step__slot">
                {index + 1}. {TURN_LABELS[turn]}
              </span>
              <span className={`turn-step__move turn-step__move--${meta.theme}`}>
                {meta.title}
              </span>
            </button>
          );
        })}
      </div>

      <fieldset disabled={disabled} className="composer-fieldset">
        <legend className="composer-legend">
          Choose {TURN_LABELS[activeTurn].toLowerCase()} move (
          {MOVE_COPY[moves[activeTurn]].title} selected)
        </legend>

        <div className="action-trio">
          {MOVES.map((move) => {
            const meta = MOVE_COPY[move];
            const isSelected = moves[activeTurn] === move;
            return (
              <label
                key={move}
                className={`action-choice action-choice--${meta.theme}${
                  isSelected ? ' action-choice--selected' : ''
                }`}
              >
                <input
                  type="radio"
                  name={`${groupId}-${activeTurn}`}
                  aria-label={meta.title}
                  value={move}
                  checked={isSelected}
                  onChange={() => choose(move)}
                  onClick={() => {
                    if (!disabled && isSelected) {
                      onPreview(move);
                    }
                  }}
                />
                <span className="action-choice__art" aria-hidden="true">
                  <MoveEmblem move={move} />
                </span>
                {isSelected && (
                  <span className="action-choice__check" aria-hidden="true">
                    ✓
                  </span>
                )}
                <strong className="action-choice__title">{meta.title}</strong>
                <span className="action-choice__beats">{meta.beats}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}
