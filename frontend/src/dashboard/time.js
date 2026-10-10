/**
 * Dates and times said the way people say them: "08:00", "in 2 h",
 * "5 min ago", "Wednesday 8". Everything in seconds (as the backend sends it).
 */

import { LOCALE, t } from '../i18n.js';

const DAY = 86_400;

export const nowSeconds = () => Date.now() / 1000;

export function clock(seconds) {
  return new Date(seconds * 1000).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
}

/** Midnight of the day of `seconds` (local time), in seconds. */
export function startOfDay(seconds) {
  const date = new Date(seconds * 1000);
  date.setHours(0, 0, 0, 0);
  return date.getTime() / 1000;
}

/** The Monday of the week of `seconds`, at midnight. */
export function startOfWeek(seconds) {
  const date = new Date(startOfDay(seconds) * 1000);
  const back = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - back);
  return date.getTime() / 1000;
}

/** One day after another: `addDays(monday, 3)` = Thursday (across daylight saving changes too). */
export function addDays(seconds, days) {
  const date = new Date(seconds * 1000);
  date.setDate(date.getDate() + days);
  return date.getTime() / 1000;
}

export function sameDay(a, b) {
  return startOfDay(a) === startOfDay(b);
}

/** "in 25 min", "in 3 h", "tomorrow", "in 4 days". */
export function untilText(seconds, now = nowSeconds()) {
  const left = seconds - now;
  if (left <= 60) return t('now');
  if (left < 3600) return t('in {n} min', { n: Math.round(left / 60) });
  if (sameDay(seconds, now)) return t('in {n} h', { n: Math.round(left / 3600) });
  const days = Math.round((startOfDay(seconds) - startOfDay(now)) / DAY);
  return days === 1 ? t('tomorrow') : t('in {n} days', { n: days });
}

/** "3 min ago", "2 h ago", "since yesterday". */
export function sinceText(seconds, now = nowSeconds()) {
  const gone = Math.max(0, now - seconds);
  if (gone < 60) return t('just now');
  if (gone < 3600) return t('{n} min ago', { n: Math.round(gone / 60) });
  if (gone < DAY) return t('{n} h ago', { n: Math.round(gone / 3600) });
  return t('since yesterday');
}

/** "today at 23:59", "tomorrow at 9:00", "Thu 8 Oct, 14:00". */
export function whenText(seconds, now = nowSeconds()) {
  const days = Math.round((startOfDay(seconds) - startOfDay(now)) / DAY);
  if (days === 0) return t('today at {time}', { time: clock(seconds) });
  if (days === 1) return t('tomorrow at {time}', { time: clock(seconds) });
  const day = new Date(seconds * 1000).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${clock(seconds)}`;
}

export function weekdayShort(seconds) {
  return new Date(seconds * 1000).toLocaleDateString(LOCALE, { weekday: 'short' }).replace('.', '');
}

export function dayNumber(seconds) {
  return new Date(seconds * 1000).getDate();
}

/** "5 – 11 October", "29 September – 5 October". */
export function weekTitle(monday) {
  const sunday = addDays(monday, 6);
  const a = new Date(monday * 1000);
  const b = new Date(sunday * 1000);
  const month = (date) => date.toLocaleDateString(LOCALE, { month: 'long' });
  return a.getMonth() === b.getMonth()
    ? `${a.getDate()} – ${b.getDate()} ${month(b)}`
    : `${a.getDate()} ${month(a)} – ${b.getDate()} ${month(b)}`;
}
