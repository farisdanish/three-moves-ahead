import { useState } from 'react';
import type { LeaderboardRow } from '../../shared/api.ts';
import { getPodiumPlaces } from '../leaderboardView.ts';
import { SpiritSprite } from './SpiritSprite.tsx';

type DailyPodiumProps = {
  readonly rows: readonly LeaderboardRow[];
};

/**
 * Celebratory three-step stone podium grouped strictly by authoritative
 * `sharedRank` so ties share a pedestal rather than picking a false winner.
 */
export function DailyPodium(props: DailyPodiumProps) {
  const { rows } = props;
  const [stoneFailed, setStoneFailed] = useState<boolean>(false);
  const places = getPodiumPlaces(rows);

  return (
    <section className="daily-podium" aria-label="Daily podium">
      <div className="daily-podium__stage">
        <div className="daily-podium__scene" aria-hidden="true">
          {!stoneFailed && (
            <img
              src="/art/dojo/podium.webp"
              alt=""
              width="768"
              height="384"
              className="daily-podium__stone"
              onError={() => setStoneFailed(true)}
            />
          )}
          <div className="daily-podium__actors">
            {places
              .filter((place) => place.players.length > 0)
              .map((place) => (
                <div
                  key={place.rank}
                  data-podium-actor-rank={place.rank}
                  className={`podium-actor podium-actor--${place.rank}`}
                >
                  {place.rank === 1 && (
                    <span className="podium-crown" aria-hidden="true">
                      <svg
                        viewBox="0 0 24 18"
                        width="22"
                        height="16"
                        fill="currentColor"
                      >
                        <path d="M2 15L0.5 4.5L6.8 9L12 1.5L17.2 9L23.5 4.5L22 15H2ZM3 17H21V18H3V17Z" />
                      </svg>
                    </span>
                  )}
                  <SpiritSprite
                    pose="celebrate"
                    eventId={place.rank}
                    variant="podium"
                  />
                </div>
              ))}
          </div>
        </div>

        <div className="daily-podium__steps">
          {places.map((place) => {
            const firstPlayer = place.players[0];
            const isTied = place.players.length > 1;
            const hasPlayers = place.players.length > 0;
            return (
              <div
                key={place.rank}
                data-podium-rank={place.rank}
                className={`podium-place podium-place--${place.rank}${
                  hasPlayers ? ' podium-place--occupied' : ' podium-place--empty'
                }`}
              >
                {hasPlayers && firstPlayer && (
                  <>
                    <div className="podium-plaque">
                      <strong className="podium-rank-label">
                        {isTied ? `Shared #${place.rank}` : `#${place.rank}`}
                      </strong>
                      {place.players.length === 1 ? (
                        <>
                          <p
                            key={firstPlayer.label}
                            data-player=""
                            className="podium-player-name"
                          >
                            {firstPlayer.label}
                          </p>
                          <span className="podium-player-score">
                            {firstPlayer.rawScore}/{firstPlayer.maxScore}
                          </span>
                        </>
                      ) : (
                        <>
                          <p className="podium-tied-note">
                            See tied players below
                          </p>
                          <span className="podium-player-score">
                            {firstPlayer.rawScore}/{firstPlayer.maxScore}
                          </span>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
