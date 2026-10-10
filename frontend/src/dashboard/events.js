/**
 * Everything that has a time, in a single list: reminders and timers
 * (Agenda). The calendar and "Today" read from here.
 */

import { t } from '../i18n.js';
import { addDays, startOfDay } from './time.js';

/**
 * @param {{reminders?: object[]}} store
 * @returns {{kind: string, start: number, end: number, title: string, sub: string, cancelled?: boolean, url?: string}[]}
 */
export function collect(store, from, to) {
  const items = [];
  const inside = (start, end = start) => end >= from && start < to;

  for (const reminder of store.reminders ?? []) {
    const title = reminder.text || reminder.label;
    if (reminder.repeat === 'daily') {
      // Every day at the same time, from the first one on.
      const time = reminder.due - startOfDay(reminder.due);
      for (let day = Math.max(startOfDay(from), startOfDay(reminder.due)); day < to; day = addDays(day, 1)) {
        const start = day + time;
        if (start >= reminder.due - 1 && inside(start)) items.push({ kind: 'reminder', start, end: start, title, sub: t('every day') });
      }
    } else if (inside(reminder.due)) {
      items.push({ kind: reminder.kind === 'timer' ? 'timer' : 'reminder', start: reminder.due, end: reminder.due, title, sub: '' });
    }
  }
  return items.sort((a, b) => a.start - b.start);
}

export const KIND_ICON = {
  reminder: 'bell',
  timer: 'clock',
};

export const KIND_LABEL = {
  reminder: t('Reminder'),
  timer: t('Timer'),
};
