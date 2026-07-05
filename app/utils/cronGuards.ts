import { formatISODate } from './dateUtils.js';
import { unwrapSettingValue } from './settingsValue.js';

export type CronGuardSkip =
  | { shouldRun: false; reason: 'disabled' }
  | { shouldRun: false; reason: 'hour_mismatch'; currentHour: number; targetHour: number }
  | { shouldRun: false; reason: 'already_ran_today'; lastRunDate: string; today: string };

export type CronGuardRun = {
  shouldRun: true;
  targetHour: number;
  today: string;
};

export type CronGuardResult = CronGuardRun | CronGuardSkip;

export interface CronGuardInput {
  enabledValue: unknown;
  hourValue: unknown;
  lastRunValue: unknown;
  defaultHour: number;
  now?: Date;
}

export function evaluateDailyCronGuard(input: CronGuardInput): CronGuardResult {
  if (input.enabledValue !== true && input.enabledValue !== 'true') {
    return { shouldRun: false, reason: 'disabled' };
  }

  const now = input.now ?? new Date();
  const currentHour = now.getHours();
  const parsed = parseInt((input.hourValue as string) || String(input.defaultHour), 10);
  const targetHour = Number.isFinite(parsed) ? parsed : input.defaultHour;

  if (currentHour !== targetHour) {
    return { shouldRun: false, reason: 'hour_mismatch', currentHour, targetHour };
  }

  const today = formatISODate(now);
  const unwrapped = unwrapSettingValue(input.lastRunValue);
  const lastRunStr = typeof unwrapped === 'string' ? unwrapped : '';
  const lastRunDate = lastRunStr.split('T')[0];

  if (lastRunDate && lastRunDate === today) {
    return { shouldRun: false, reason: 'already_ran_today', lastRunDate, today };
  }

  return { shouldRun: true, targetHour, today };
}
