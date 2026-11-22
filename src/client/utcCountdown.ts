import { formatUtcDayId } from '../shared/engine.ts';

const MS_PER_UTC_DAY = 86_400_000;

/**
 * Formats the remaining time until the next `00:00 UTC` rollover (`Xh Ym` or `Ym`).
 */
export function formatUtcResetCountdown(nowMs: number = Date.now()): string {
  const elapsed =
    ((nowMs % MS_PER_UTC_DAY) + MS_PER_UTC_DAY) % MS_PER_UTC_DAY;
  const remainingMinutes = Math.max(
    1,
    Math.ceil((MS_PER_UTC_DAY - elapsed) / 60_000)
  );
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * Returns true when `nowMs` has crossed into a newer `YYYY-MM-DD` UTC day than `arenaDayId`.
 */
export function hasUtcDayRolledOver(
  arenaDayId: string,
  nowMs: number = Date.now()
): boolean {
  return formatUtcDayId(new Date(nowMs)) > arenaDayId;
}
