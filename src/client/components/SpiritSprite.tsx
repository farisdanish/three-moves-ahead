import { useState } from 'react';

export type SpiritPose =
  | 'ready'
  | 'attack'
  | 'defend'
  | 'counter'
  | 'celebrate';

type SpiritSpriteProps = {
  readonly pose: SpiritPose;
  readonly eventId: number;
  readonly variant?: 'stage' | 'podium';
};

const POSE_SRC: Record<SpiritPose, string> = {
  ready: '/art/dojo/spirit-ready.png',
  attack: '/art/dojo/spirit-attack.png',
  defend: '/art/dojo/spirit-defend.png',
  counter: '/art/dojo/spirit-counter.png',
  celebrate: '/art/dojo/spirit-celebrate.png',
};

/**
 * Renders the cream dojo mascot with a resting ready sprite and animated action
 * overlay so pose transitions stay crisp and never double-expose eyes.
 */
export function SpiritSprite(props: SpiritSpriteProps) {
  const { pose, eventId, variant = 'stage' } = props;
  const [baseFailed, setBaseFailed] = useState<boolean>(false);
  const [failedPoses, setFailedPoses] = useState<
    Partial<Record<SpiritPose, true>>
  >({});
  const [loadedPoses, setLoadedPoses] = useState<
    Partial<Record<SpiritPose, true>>
  >({});
  const actionKey = `${pose}-${eventId}`;
  const actionFailed = pose !== 'ready' && Boolean(failedPoses[pose]);
  const actionReady =
    pose !== 'ready' && !actionFailed && Boolean(loadedPoses[pose]);
  const baseRestingVisible = pose === 'ready' || actionFailed || !actionReady;
  const baseClassName = baseRestingVisible
    ? 'spirit-base'
    : 'spirit-base spirit-base--hidden';

  return (
    <span
      className={`spirit-sprite spirit-sprite--${variant}`}
      data-pose={pose}
      aria-hidden="true"
    >
      {!baseFailed ? (
        <img
          src={POSE_SRC.ready}
          alt=""
          width="384"
          height="384"
          className={baseClassName}
          onError={() => setBaseFailed(true)}
        />
      ) : (
        <span className="spirit-fallback-emblem" />
      )}

      {pose !== 'ready' && !actionFailed && (
        <img
          key={actionKey}
          src={POSE_SRC[pose]}
          alt=""
          width="384"
          height="384"
          className={
            actionReady
              ? `spirit-action spirit-action--${pose}`
              : 'spirit-action spirit-action--pending'
          }
          onLoad={() =>
            setLoadedPoses((previous) =>
              previous[pose] ? previous : { ...previous, [pose]: true }
            )
          }
          onError={() =>
            setFailedPoses((previous) =>
              previous[pose] ? previous : { ...previous, [pose]: true }
            )
          }
        />
      )}
    </span>
  );
}
