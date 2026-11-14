import './index.css';

import { context, requestExpandedMode } from '@devvit/web/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  formatUtcDayId,
  getModifierForUtcDate,
  isValidUtcDayId,
  type ModifierId,
} from '../shared/engine';

const MODIFIER_LABELS: Record<ModifierId, string> = {
  classic: 'Classic (Win 2 · Tie 1 · Loss 0)',
  draw_day: 'Draw Day (Tie 2 · Win 1 · Loss 0)',
  sweep_bonus: 'Sweep Bonus (+3 on 3 wins)',
};

export const Splash = () => {
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
    <div className="flex flex-col justify-center items-center min-h-screen gap-3 px-5 py-6 bg-slate-950 text-slate-100">
      <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-amber-400 font-semibold">
        <span>Three Moves Ahead</span>
        <span>·</span>
        <span>{isArchivedDaily ? `${rawPostDayId} Archived` : `${utcDayId} UTC`}</span>
      </div>

      <h1 className="text-2xl font-bold text-center leading-tight">
        Three moves. One prediction. Outsmart yesterday&apos;s crowd.
      </h1>

      <div className="rounded-lg border border-slate-800 bg-slate-900/90 px-3.5 py-2 text-xs text-slate-200 text-center max-w-sm">
        {isArchivedDaily ? (
          <span>
            This dated daily thread ({rawPostDayId}) has closed. Open to jump to
            today&apos;s live Evergreen Hub.
          </span>
        ) : (
          <span>
            Today&apos;s rule:{' '}
            <strong className="text-amber-300">
              {MODIFIER_LABELS[modifier]}
            </strong>
          </span>
        )}
      </div>

      <p className="text-[11px] text-slate-400 text-center">
        Attack (A) &gt; Counter (C) &gt; Defend (D) &gt; Attack (A)
      </p>

      <p className="text-xs text-slate-400 text-center">
        {context.userId
          ? `Signed in as u/${context.username ?? 'player'}`
          : 'Viewing logged out — Practice open, sign in for Ranked'}
      </p>

      <button
        type="button"
        className="mt-1 bg-orange-600 hover:bg-orange-500 text-white font-semibold px-5 py-2.5 rounded-full cursor-pointer transition-colors text-sm"
        onClick={(e) => requestExpandedMode(e.nativeEvent, 'game')}
      >
        {isArchivedDaily ? 'Open Archive & Hub Link' : 'Open Daily Arena'}
      </button>
    </div>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Splash />
  </StrictMode>
);
