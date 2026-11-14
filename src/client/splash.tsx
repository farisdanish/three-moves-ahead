import './index.css';

import { context, requestExpandedMode } from '@devvit/web/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { formatUtcDayId, getModifierForUtcDate } from '../shared/engine';

const MODIFIER_LABELS = {
  classic: 'Classic (2 / 1 / 0)',
  draw_day: 'Draw Day (1 / 2 / 0)',
  sweep_bonus: 'Sweep Bonus (+3 on 3 wins)',
} as const;

export const Splash = () => {
  const utcDayId = formatUtcDayId();
  const modifier = getModifierForUtcDate(utcDayId);

  return (
    <div className="flex flex-col justify-center items-center min-h-screen gap-4 px-5 py-6 bg-slate-950 text-slate-100">
      <div className="text-xs uppercase tracking-widest text-amber-400 font-semibold">
        Three Moves Ahead · {utcDayId} UTC
      </div>
      <h1 className="text-2xl font-bold text-center">
        Outsmart yesterday&apos;s crowd
      </h1>
      <p className="text-sm text-center text-slate-300 max-w-sm">
        Today&apos;s rule:{' '}
        <span className="font-semibold text-white">
          {MODIFIER_LABELS[modifier]}
        </span>
      </p>
      <p className="text-xs text-slate-400 text-center">
        {context.userId
          ? `Signed in as ${context.username ?? 'player'}`
          : 'Viewing logged out — sign in to Reddit to play ranked'}
      </p>
      <button
        className="mt-1 bg-orange-600 hover:bg-orange-500 text-white font-semibold px-5 py-2.5 rounded-full cursor-pointer transition-colors"
        onClick={(e) => requestExpandedMode(e.nativeEvent, 'game')}
      >
        Open Daily Arena
      </button>
    </div>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Splash />
  </StrictMode>
);
