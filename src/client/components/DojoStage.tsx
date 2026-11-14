import { useState } from 'react';
import { SpiritSprite, type SpiritPose } from './SpiritSprite.tsx';

const ECHO_POSITIONS: readonly [
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
] = [0, 1, 2, 3, 4, 5, 6, 7, 8];

type DojoStageProps = {
  readonly pose: SpiritPose;
  readonly eventId: number;
  readonly mode: 'ranked' | 'practice';
  readonly caption?: string;
  readonly badgeText?: string | null;
};

/**
 * Painted nocturnal dojo stage hosting the mascot fighter, transient move
 * effects, and purely decorative 9-echo arc in Ranked mode.
 */
export function DojoStage(props: DojoStageProps) {
  const { pose, eventId, mode, caption, badgeText = null } = props;
  const [backdropFailed, setBackdropFailed] = useState<boolean>(false);
  const [echoFailed, setEchoFailed] = useState<boolean>(false);

  const stageCaption =
    caption ??
    (mode === 'ranked'
      ? 'Nine stored echoes. One daily challenge.'
      : 'Practice against an independent bot');

  return (
    <div
      className={`dojo-stage${backdropFailed ? ' dojo-stage--fallback' : ''}`}
      data-mode={mode}
      data-stage-pose={pose}
    >
      {!backdropFailed && (
        <img
          className="dojo-backdrop"
          src="/art/dojo/arena.webp"
          alt=""
          width="1024"
          height="768"
          onError={() => setBackdropFailed(true)}
        />
      )}

      <div className="dojo-stage__vignette" aria-hidden="true" />
      <div className="dojo-stage__floor-glow" aria-hidden="true" />

      {mode === 'ranked' && (
        <div className="echo-arc" aria-hidden="true">
          {ECHO_POSITIONS.map((position) =>
            !echoFailed ? (
              <img
                key={position}
                src="/art/dojo/echo.png"
                alt=""
                width="64"
                height="64"
                className={`echo-wisp echo-wisp--${position}`}
                onError={() => setEchoFailed(true)}
              />
            ) : (
              <span
                key={position}
                className={`echo-wisp echo-wisp--${position} echo-wisp--fallback`}
              />
            )
          )}
        </div>
      )}

      {pose !== 'ready' && (
        <span
          key={`fx-${pose}-${eventId}`}
          className={`dojo-fx dojo-fx--${pose}`}
          aria-hidden="true"
        />
      )}

      <div className="dojo-stage__actor">
        <SpiritSprite pose={pose} eventId={eventId} variant="stage" />
      </div>

      {badgeText && (
        <div className="dojo-stage__badge" aria-hidden="true">
          {badgeText}
        </div>
      )}

      <p className="stage-caption">{stageCaption}</p>
    </div>
  );
}
