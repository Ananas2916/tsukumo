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

  // The user's own calendars (the secretary reads their iCal links).
  for (const event of store.secretary?.calendar?.events ?? []) {
    if (!inside(event.start, event.end)) continue;
    items.push({ kind: 'calendar', start: event.start, end: event.end, title: event.title, sub: event.allDay ? t('all day') : event.location || event.calendar || '', allDay: event.allDay });
  }
  for (const reminder of store.reminders ?? []) {
    const title = reminder.text || reminder.label;
    if (reminder.repeat === 'daily' || reminder.repeat === 'weekly') {
      // Every day (or week) at the same time, from the first one on.
      const step = reminder.repeat === 'daily' ? 1 : 7;
      const time = reminder.due - startOfDay(reminder.due);
      const first = startOfDay(reminder.due);
      const skip = Math.max(0, Math.floor((startOfDay(from) - first) / 86_400 / step));
      for (let day = addDays(first, skip * step); day < to; day = addDays(day, step)) {
        const start = day + time;
        if (start >= reminder.due - 1 && inside(start)) items.push({ kind: 'reminder', start, end: start, title, sub: reminder.repeat === 'daily' ? t('every day') : t('every week') });
      }
    } else if (inside(reminder.due)) {
      items.push({ kind: reminder.kind === 'timer' ? 'timer' : 'reminder', start: reminder.due, end: reminder.due, title, sub: '' });
    }
  }
  return items.sort((a, b) => a.start - b.start);
}

export const KIND_ICON = {
  calendar: 'calendar',
  reminder: 'bell',
  timer: 'clock',
};

export const KIND_LABEL = {
  calendar: t('Calendar'),
  reminder: t('Reminder'),
  timer: t('Timer'),
};
