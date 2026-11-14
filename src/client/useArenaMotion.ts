import { useEffect, useState } from 'react';

export type MotionPreference = 'on' | 'off';

export type ArenaMotionState = {
  readonly motionEnabled: boolean;
  readonly dataMotion: MotionPreference;
  readonly prefersReducedMotion: boolean;
  readonly userPreference: MotionPreference;
  readonly toggleMotion: () => void;
};

function readPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function readDocumentHidden(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  return document.visibilityState === 'hidden';
}

/**
 * Tracks session animation state from user toggle, OS reduced-motion setting,
 * and document visibility. OS reduced-motion always takes precedence.
 */
export function useArenaMotion(): ArenaMotionState {
  const [userPreference, setUserPreference] = useState<MotionPreference>('on');
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(
    readPrefersReducedMotion
  );
  const [documentHidden, setDocumentHidden] =
    useState<boolean>(readDocumentHidden);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function'
    ) {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    const onMediaChange = (event: MediaQueryListEvent): void => {
      setPrefersReducedMotion(event.matches);
    };

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', onMediaChange);
      return () => mediaQuery.removeEventListener('change', onMediaChange);
    }

    mediaQuery.addListener(onMediaChange);
    return () => mediaQuery.removeListener(onMediaChange);
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const onVisibilityChange = (): void => {
      setDocumentHidden(document.visibilityState === 'hidden');
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const dataMotion: MotionPreference =
    prefersReducedMotion || userPreference === 'off' ? 'off' : 'on';
  const motionEnabled = dataMotion === 'on' && !documentHidden;

  const toggleMotion = (): void => {
    setUserPreference((prev) => (prev === 'on' ? 'off' : 'on'));
  };

  return {
    motionEnabled,
    dataMotion,
    prefersReducedMotion,
    userPreference,
    toggleMotion,
  };
}
