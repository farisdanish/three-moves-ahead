import './index.css';

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ArenaStatusResponse } from '../shared/api';

export const App = () => {
  const [status, setStatus] = useState<ArenaStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data: ArenaStatusResponse = await res.json();
        if (!cancelled) {
          setStatus(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-5 flex flex-col items-center justify-center gap-4">
      <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-3">
        <div className="text-xs uppercase tracking-widest text-amber-400 font-semibold">
          Three Moves Ahead · Daily Arena Status
        </div>
        <h1 className="text-xl font-bold">Custom Post &amp; Engine Ready</h1>
        <p className="text-xs text-slate-300">
          Attack beats Counter · Counter beats Defend · Defend beats Attack
        </p>

        {error && (
          <div className="rounded bg-red-950/70 border border-red-800 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        )}

        {status ? (
          <dl className="grid grid-cols-2 gap-2 text-xs bg-slate-950/70 rounded-lg p-3 border border-slate-800">
            <dt className="text-slate-400">App</dt>
            <dd className="font-mono text-right">{status.appSlug}</dd>
            <dt className="text-slate-400">UTC Day</dt>
            <dd className="font-mono text-right">{status.utcDayId}</dd>
            <dt className="text-slate-400">Modifier</dt>
            <dd className="font-mono text-right">{status.modifier}</dd>
            <dt className="text-slate-400">Post Kind</dt>
            <dd className="font-mono text-right">{status.postDataKind}</dd>
            <dt className="text-slate-400">Auth State</dt>
            <dd className="font-mono text-right">
              {status.viewerAuthenticated
                ? `Authenticated (${status.username ?? 'user'})`
                : 'Logged out'}
            </dd>
          </dl>
        ) : (
          <div className="text-xs text-slate-400">Loading server context…</div>
        )}
      </div>
    </div>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
