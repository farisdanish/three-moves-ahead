import './index.css';

import { context, requestExpandedMode } from '@devvit/web/client';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  formatUtcDayId,
  getModifierForUtcDate,
  isValidUtcDayId,
  type ModifierId,
} from '../shared/engine.ts';
import { useArenaMotion } from './useArenaMotion.ts';

const MODIFIER_LABELS: Record<ModifierId, string> = {
  classic: 'Classic · Win 2 / Tie 1 / Loss 0',
  draw_day: 'Draw Day · Tie 2 / Win 1 / Loss 0',
  sweep_bonus: 'Sweep Bonus · +3 on 3 wins',
};

export const Splash = () => {
  const { dataMotion, prefersReducedMotion, toggleMotion } = useArenaMotion();
  const [backdropFailed, setBackdropFailed] = useState<boolean>(false);
  const [spriteFailed, setSpriteFailed] = useState<boolean>(false);

  const utcDayId = formatUtcDayId();
  const modifier = getModifierForUtcDate(utcDayId);
  const rawKind = context.postData?.['kind'];
  const rawPostDayId = context.postData?.['dayId'];
  const isArchivedDaily =
    rawKind === 'daily' &&
    typeof rawPostDayId === 'string' &&
    isValidUtcDayId(rawPostDayId) &&
    rawPostDayId < utcDayId;

  return (
    <main className="splash-root" data-motion={dataMotion}>
      <article className="splash-stage-card">
        {!prefersReducedMotion && (
          <button
            type="button"
            className="splash-motion-btn"
            aria-pressed={dataMotion === 'on'}
            onClick={toggleMotion}
          >
            {dataMotion === 'on' ? 'Motion: On' : 'Motion: Off'}
          </button>
        )}

        <div className="splash-scene" aria-hidden="true">
          {!backdropFailed && (
            <img
              src="/art/dojo/arena.webp"
              alt=""
              width="1024"
              height="768"
              className="splash-backdrop"
              onError={() => setBackdropFailed(true)}
            />
          )}
          <div className="splash-scrim" />
          {!spriteFailed && (
            <img
              src="/art/dojo/spirit-ready.png"
              alt=""
              width="384"
              height="384"
              className="splash-hero-sprite spirit-base"
              onError={() => setSpriteFailed(true)}
            />
          )}
        </div>

        <div className="splash-panel">
          <p className="dojo-eyebrow">
            Three Moves Ahead ·{' '}
            {isArchivedDaily
              ? `${rawPostDayId} UTC (Archived)`
              : `${utcDayId} UTC`}
          </p>

          <h1 className="splash-title">
            {isArchivedDaily
              ? `This daily dojo (${rawPostDayId} UTC) has closed.`
              : MODIFIER_LABELS[modifier]}
          </h1>

          <p className="dojo-meta">
            {isArchivedDaily
              ? 'Open to jump straight to today’s Evergreen Hub.'
              : context.userId
                ? `Attack > Counter > Defend > Attack · u/${context.username ?? 'player'}`
                : 'Attack > Counter > Defend > Attack · Sign in for Ranked or play Practice'}
          </p>

          <button
            type="button"
            className="dojo-cta-primary mt-0.5"
            onClick={(e) => requestExpandedMode(e.nativeEvent, 'game')}
          >
            {isArchivedDaily ? 'Open Archive & Hub Link' : 'Open Daily Arena'}
          </button>
        </div>
      </article>
    </main>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Splash />
  </StrictMode>
);
