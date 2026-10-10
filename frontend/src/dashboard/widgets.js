/**
 * The dashboard's tiles. Each has a node (`node`) and a `render(store)` that
 * redraws it from scratch: the data is small, so there's no state to keep
 * in sync. `store` is dashboard.js's.
 */

import { el, iconButton } from '../dom.js';
import { LOCALE, t, tx } from '../i18n.js';
import { icon } from '../icons.js';
import { KIND_ICON, KIND_LABEL, collect } from './events.js';
import { addDays, clock, dayNumber, nowSeconds, sameDay, sinceText, startOfDay, startOfWeek, weekTitle, weekdayShort, whenText } from './time.js';

/** A tile: header with icon and title, any controls on the right. */
function card(className, iconName, title, ...actions) {
  const body = el('div', { class: 'w-body' });
  const node = el(
    'section',
    { class: `card widget ${className}` },
    el('header', { class: 'card-head' }, el('span', { class: 'card-icon' }, icon(iconName, 16)), el('h3', {}, title), el('span', { class: 'spacer' }), ...actions),
    body,
  );
  return { node, body };
}

function empty(text) {
  return el('p', { class: 'hint' }, text);
}

// --------------------------------------------------------------- calendar
export class WeekWidget {
  constructor() {
    this.offset = 0;
    this.title = el('span', { class: 'w-week-title' });
    const back = iconButton('back', { title: t('Previous week'), className: 'icon-btn', onClick: () => this.move(-1) });
    const next = iconButton('forward', { title: t('Next week'), className: 'icon-btn', onClick: () => this.move(1) });
    this.todayButton = el('button', { class: 'ghost-btn', type: 'button', onClick: () => this.move(-this.offset) }, t('Today'));
    ({ node: this.node, body: this.body } = card('w-calendar', 'calendar', t('Week'), this.title, this.todayButton, back, next));
  }

  move(step) {
    this.offset = Math.max(-4, Math.min(8, this.offset + step));
    this.render(this.store);
  }

  render(store) {
    this.store = store;
    const now = nowSeconds();
    const monday = addDays(startOfWeek(now), this.offset * 7);
    const end = addDays(monday, 7);
    this.title.textContent = weekTitle(monday);
    this.todayButton.classList.toggle('hidden', this.offset === 0);
    const items = collect(store, monday, end);
    const columns = [];
    for (let index = 0; index < 7; index += 1) {
      const day = addDays(monday, index);
      const mine = items.filter((item) => sameDay(item.start, day) || (item.start < day && item.end > day));
      const isToday = sameDay(day, now);
      columns.push(
        el(
          'div',
          { class: `w-day${isToday ? ' today' : ''}${index >= 5 ? ' weekend' : ''}${day + 86_400 <= now ? ' past' : ''}` },
          el('div', { class: 'w-day-head' }, el('span', {}, weekdayShort(day)), el('strong', {}, String(dayNumber(day)))),
          ...mine.map((item) =>
            el(
              'div',
              {
                class: `w-event kind-${item.kind}${item.cancelled ? ' cancelled' : ''}${item.end < now ? ' done' : ''}`,
                title: `${KIND_LABEL[item.kind]}: ${item.title}${item.sub ? ` · ${item.sub}` : ''}`,
              },
              el('span', { class: 'w-event-time' }, clock(item.start)),
              el('strong', {}, item.title),
              item.sub ? el('small', {}, item.sub) : null,
            ),
          ),
        ),
      );
    }
    // An empty week doesn't take half the page: low columns and a line that says so.
    const quiet = items.length === 0;
    const week = el('div', { class: `w-week${quiet ? ' quiet' : ''}` }, ...columns);
    if (quiet) this.body.replaceChildren(week, el('p', { class: 'w-week-empty' }, t('Free week: no reminders. Tell her "remind me…" and it ends up here.')));
    else this.body.replaceChildren(week);
  }
}

// ------------------------------------------------------------------ today
export class TodayWidget {
  constructor() {
    ({ node: this.node, body: this.body } = card('w-today', 'clock', t('Today')));
  }

  render(store) {
    const now = nowSeconds();
    const tomorrow = addDays(startOfDay(now), 1);
    const upcoming = collect(store, now, addDays(tomorrow, 1)).filter((item) => item.end >= now);
    const rows = [];
    const today = upcoming.filter((item) => item.start < tomorrow);
    const later = upcoming.filter((item) => item.start >= tomorrow);
    const line = (item) =>
      el(
        'div',
        { class: `agenda-item kind-${item.kind}${item.cancelled ? ' cancelled' : ''}` },
        el('span', { class: 'agenda-icon' }, icon(KIND_ICON[item.kind] ?? 'clock', 15)),
        el(
          'span',
          { class: 'agenda-text' },
          el('strong', {}, item.title),
          el('small', {}, `${clock(item.start)}${item.sub ? ` · ${item.sub}` : ''}`, item.cancelled ? el('span', { class: 'badge warn' }, t('cancelled')) : null),
        ),
      );
    if (today.length) rows.push(...today.map(line));
    if (later.length) rows.push(el('div', { class: 'agenda-day' }, t('Tomorrow')), ...later.slice(0, 6).map(line));
    if (!rows.length) {
      // Nothing until tomorrow evening: at least the next appointment, if there's one in the coming days.
      const ahead = collect(store, addDays(tomorrow, 1), addDays(tomorrow, 14)).find((item) => !item.cancelled);
      rows.push(el('div', { class: 'w-free' }, el('span', { class: 'w-free-icon' }, icon('sun', 22)), el('strong', {}, t('Free day')), el('small', {}, t('Nothing scheduled until tomorrow evening.'))));
      if (ahead) {
        const when = new Date(ahead.start * 1000).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric' });
        rows.push(el('div', { class: 'w-next quiet' }, el('small', {}, t('Next up')), el('strong', {}, ahead.title), el('span', {}, t('{day} at {time}', { day: when, time: clock(ahead.start) }))));
      }
    }
    this.body.replaceChildren(el('div', { class: 'agenda-list' }, ...rows));
  }
}

// ---------------------------------------------------------------- weather
const WEATHER_ICON = { clear: 'sun', cloudy: 'cloud', fog: 'cloud', rain: 'rain', snow: 'cloud', storm: 'bolt' };
const WEATHER_TEXT = { clear: t('clear'), cloudy: t('cloudy'), fog: t('fog'), rain: t('rain'), snow: t('snow'), storm: t('storm') };

export class WeatherWidget {
  constructor() {
    ({ node: this.node, body: this.body } = card('w-weather', 'sun', t('Weather')));
  }

  render(store) {
    const weather = store.weather;
    if (!weather) {
      this.body.replaceChildren(empty(store.weatherError ? t("The weather service isn't answering: I'll try again soon.") : t('Looking at the sky…')));
      return;
    }
    const nowIcon = weather.condition === 'clear' && !weather.isDay ? 'moon' : WEATHER_ICON[weather.condition] ?? 'cloud';
    const days = (weather.days ?? []).map((day, index) => {
      const date = new Date(`${day.date}T12:00:00`);
      const name = index === 0 ? t('Today') : date.toLocaleDateString(LOCALE, { weekday: 'short' }).replace('.', '');
      return el(
        'div',
        { class: 'w-forecast-day', title: t('{condition}, rain {n}%', { condition: WEATHER_TEXT[day.condition] ?? day.condition, n: day.rain }) },
        el('small', {}, name),
        icon(WEATHER_ICON[day.condition] ?? 'cloud', 18),
        el('strong', {}, `${day.max}°`),
        el('small', {}, `${day.min}°`),
        day.rain >= 30 ? el('span', { class: 'w-rain' }, `${day.rain}%`) : null,
      );
    });
    this.body.replaceChildren(
      el(
        'div',
        { class: 'w-weather-now' },
        el('span', { class: `w-weather-icon cond-${weather.condition}` }, icon(nowIcon, 34)),
        el('div', {}, el('strong', { class: 'w-temp' }, `${weather.temperature}°`), el('span', {}, t('{condition}, feels like {n}°', { condition: WEATHER_TEXT[weather.condition] ?? '', n: weather.apparent }))),
        el('span', { class: 'spacer' }),
        el('small', { class: 'w-city' }, weather.city || ''),
      ),
      el('div', { class: 'w-forecast' }, ...days),
    );
  }
}

// ----------------------------------------------------------------- agents
const STATE_TEXT = { working: t('working'), waiting: t('waiting for you'), done: t('done'), idle: t('ready') };
const TASK_MARK = { completed: 'check', in_progress: 'dots', pending: 'circle' };

export class AgentsWidget {
  constructor() {
    ({ node: this.node, body: this.body } = card('w-agents', 'robot', t('Agents at work')));
  }

  render(store) {
    const now = nowSeconds();
    const agents = (store.agents ?? []).filter((agent) => agent.internal || now - agent.updated < 6 * 3600);
    const rows = agents.map((agent) => {
      const tasks = agent.tasks ?? [];
      const doneCount = tasks.filter((task) => task.status === 'completed').length;
      const state = agent.state ?? 'idle';
      return el(
        'div',
        { class: `w-agent state-${state}` },
        el(
          'div',
          { class: 'w-agent-head' },
          el('span', { class: 'w-agent-dot', 'aria-hidden': 'true' }),
          el('strong', {}, agent.name),
          agent.project ? el('small', {}, agent.project) : agent.internal && agent.name !== 'Tsukumo' ? el('small', {}, t("Tsukumo's brain")) : null,
          el('span', { class: 'spacer' }),
          el('span', { class: `badge ${state === 'waiting' ? 'warn' : state === 'working' ? 'accent' : 'ok'}` }, STATE_TEXT[state] ?? state),
          state !== 'idle' && agent.since ? el('small', { class: 'w-since' }, sinceText(agent.since, now)) : null,
        ),
        agent.step && state === 'working' ? el('p', { class: 'w-agent-step' }, tx(agent.step)) : null,
        agent.summary ? el('p', { class: 'w-agent-summary', title: agent.summary }, agent.summary) : null,
        tasks.length
          ? el(
              'div',
              { class: 'w-tasks' },
              el('small', {}, t('Task list: {done} of {total}', { done: doneCount, total: tasks.length })),
              ...tasks.slice(0, 8).map((task) =>
                el(
                  'div',
                  { class: `w-task ${task.status}` },
                  icon(TASK_MARK[task.status] ?? 'circle', 13),
                  el('span', {}, task.status === 'in_progress' && task.active ? task.active : task.text),
                ),
              ),
              tasks.length > 8 ? el('small', {}, t('and {n} more', { n: tasks.length - 8 })) : null,
            )
          : null,
      );
    });
    const limits = (store.usage?.agents ?? []).filter((agent) => agent.limits?.length);
    if (limits.length) {
      rows.push(
        el(
          'div',
          { class: 'w-limits' },
          ...limits.flatMap((agent) =>
            agent.limits.map((limit) =>
              el(
                'div',
                { class: 'w-limit', title: limit.resetsAt ? t('resets {when}', { when: whenText(limit.resetsAt) }) : '' },
                el('small', {}, `${agent.label} · ${limitName(limit)}`),
                el('span', { class: 'w-bar' }, el('i', { style: { width: `${Math.min(100, Math.round(limit.used))}%` }, class: limit.used >= 85 ? 'high' : '' })),
                el('small', {}, `${Math.round(limit.used)}%`),
              ),
            ),
          ),
        ),
      );
    }
    if (!rows.length) rows.push(empty(t('No agents at work.')));
    this.body.replaceChildren(...rows);
  }
}

function limitName(limit) {
  const minutes = Number(limit.windowMinutes) || 0;
  if (minutes >= 40_000) return t('month');
  if (minutes >= 10_000) return t('week');
  if (minutes >= 280 && minutes <= 320) return t('5 hours');
  return limit.id === 'secondary' ? t('week') : t('limit');
}
