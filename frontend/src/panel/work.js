/**
 * "Work" tab: the agents you use on your own.
 *
 *  - Usage: how much of the Claude Code and Codex plan limits is used, when
 *    they reset, today's tokens (backend/usage.py). Antigravity doesn't write
 *    them on the PC: you only see when you used it.
 *  - Notifications: when they finish a job or wait for you, she calls you
 *    (backend/notify.py).
 *
 * Connecting something writes into the agents' configurations (with a
 * backup copy): only when you press the button.
 */

import { apiUrl } from '../config.js';
import { el } from '../dom.js';
import { LOCALE, t, tx } from '../i18n.js';
import { icon } from '../icons.js';

const WINDOW_LABELS = { 300: t('5 hours'), 10080: t('Week'), 43200: t('Month') };
const PLAN_LABELS = { free: 'Free', plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };

async function request(path, method = 'GET', body) {
  const response = await fetch(apiUrl(path), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(tx(data.detail) ?? `HTTP ${response.status}`);
  return data;
}

function windowLabel(minutes) {
  if (WINDOW_LABELS[minutes]) return WINDOW_LABELS[minutes];
  if (!minutes) return t('Limit');
  return minutes < 1440 ? t('{n} hours', { n: Math.round(minutes / 60) }) : t('{n} days', { n: Math.round(minutes / 1440) });
}

function resetText(epoch) {
  if (!epoch) return t('reset|limit');
  const moment = new Date(epoch * 1000);
  const now = new Date();
  const clock = moment.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  if (moment.toDateString() === now.toDateString()) return t('resets at {time}', { time: clock });
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (moment.toDateString() === tomorrow.toDateString()) return t('resets tomorrow at {time}', { time: clock });
  const day = moment.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
  return t('resets {day}', { day });
}

function ago(epoch) {
  if (!epoch) return '';
  const minutes = Math.round((Date.now() / 1000 - epoch) / 60);
  if (minutes < 2) return t('used just now');
  if (minutes < 60) return t('used {n} min ago', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? t('used 1 hour ago') : t('used {n} hours ago', { n: hours });
  const days = Math.round(hours / 24);
  return days === 1 ? t('used yesterday') : t('used {n} days ago', { n: days });
}

function tokensText(tokens) {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return t('{n}k', { n: Math.round(tokens / 1000) });
  return `${(tokens / 1_000_000).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} M`;
}

function usageColor(used) {
  if (used >= 90) return 'var(--danger)';
  if (used >= 70) return 'var(--warn)';
  return 'var(--ok)';
}

export class WorkView {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.usage = null;
    this.integrations = null;
    this._build();
    app.on('hello', (message) => message.usage && this._setUsage(message.usage));
    app.socket.on('usage', (message) => this._setUsage(message));
    app.socket.on('preferences', (message) => this._setPreferences(message));
  }

  shown() {
    this._loadUsage();
    this._loadIntegrations();
    this._loadPreferences();
  }

  // ----------------------------------------------------------------- DOM
  _build() {
    this.agents = el('div', { class: 'usage-list' }, el('p', { class: 'hint' }, t('Reading the usage…')));
    this.alerts = this._switch(
      t('Warn me near the limits'),
      t("At 80 and 95% of a limit, and when it resets. Even with chatter off; never in a meeting or when you're away from the PC."),
    );
    this.alerts.input.addEventListener('change', () => {
      request('/api/preferences', 'POST', { topics: { usage: this.alerts.input.checked } }).catch((error) => this.app.toast(error.message, 'error'));
    });
    const usageCard = this._card(
      'gauge',
      t('Agent usage'),
      el(
        'p',
        { class: 'card-sub' },
        t('Read from the files the agents write on your PC: no network, no passwords. You can also ask her by voice: "how much Claude do I have left?".'),
      ),
      this.agents,
      this.alerts.node,
    );

    this.notifyList = el('div', { class: 'integration-list' });
    const notifyCard = this._card(
      'robot',
      t('Agent notifications'),
      el(
        'p',
        { class: 'card-sub' },
        t("When Claude Code or Codex, used on your own, finish a job (or wait for you), she calls you. If you're already looking at the editor, a bubble is enough."),
      ),
      this.notifyList,
    );
    this.root.append(usageCard, notifyCard);
  }

  _card(iconName, title, ...children) {
    return el(
      'section',
      { class: 'card' },
      el('header', { class: 'card-head' }, el('span', { class: 'card-icon' }, icon(iconName, 16)), el('h3', {}, title)),
      ...children,
    );
  }

  _switch(label, hint) {
    const input = el('input', { type: 'checkbox', role: 'switch' });
    const node = el(
      'label',
      { class: 'switch-row' },
      el('span', { class: 'switch-text' }, el('span', {}, label), hint ? el('small', {}, hint) : null),
      input,
      el('span', { class: 'switch' }),
    );
    return { node, input };
  }

  // ------------------------------------------------------------------ usage
  async _loadUsage() {
    try {
      this._setUsage(await request('/api/usage'));
    } catch (error) {
      if (!this.usage) this.agents.replaceChildren(el('p', { class: 'hint error' }, t('Usage unavailable: {error}', { error: error.message })));
    }
  }

  _setUsage(snapshot) {
    this.usage = snapshot;
    const agents = snapshot?.agents ?? [];
    if (!agents.length) {
      this.agents.replaceChildren(el('p', { class: 'hint' }, t("I can't find Claude Code, Codex or Antigravity on this PC.")));
      return;
    }
    this.agents.replaceChildren(...agents.map((agent) => this._agent(agent)));
  }

  _agent(agent) {
    const plan = agent.plan ? el('span', { class: 'badge accent' }, PLAN_LABELS[agent.plan] ?? agent.plan) : null;
    const head = el(
      'div',
      { class: 'usage-head' },
      el('strong', {}, agent.label),
      plan,
      el('span', { class: 'spacer' }),
      el('small', {}, ago(agent.lastUsed)),
    );
    const limits = (agent.limits ?? []).map((limit) => {
      const used = Math.round(limit.used);
      const fill = { width: `${Math.max(2, Math.min(100, limit.used))}%`, background: usageColor(limit.used) };
      const bar = el('span', { class: 'usage-bar' }, el('i', { style: fill }));
      return el(
        'div',
        { class: 'usage-limit' },
        el('span', { class: 'usage-window' }, windowLabel(limit.windowMinutes)),
        bar,
        el('span', { class: 'usage-value' }, `${used}%`),
        el('small', { class: 'usage-reset' }, resetText(limit.resetsAt)),
      );
    });
    const today = agent.today;
    const todayLine = today?.tokens
      ? el('p', { class: 'usage-today' }, today.messages === 1 ? t('Today: {tokens} tokens in 1 reply', { tokens: tokensText(today.tokens) }) : t('Today: {tokens} tokens in {n} replies', { tokens: tokensText(today.tokens), n: today.messages }))
      : today
        ? el('p', { class: 'usage-today' }, t("You haven't used it today yet."))
        : null;
    const note = agent.note ? el('p', { class: 'hint' }, agent.note) : null;
    return el('div', { class: 'usage-agent' }, head, ...limits, todayLine, note, agent.link ? this._linkRow(agent) : null);
  }

  /** Claude Code: the limits come only from its status line, which is connected from here. */
  _linkRow(agent) {
    const status = this.integrations?.[agent.link];
    if (agent.linked) {
      return el(
        'button',
        { class: 'link-btn', type: 'button', onClick: () => this._change(agent.link, 'uninstall') },
        t("Disconnect Claude Code's status line"),
      );
    }
    const wraps = status?.wraps
      ? t(' You already had a status line: it stays as it is, ours shows it the same.')
      : t(' Shows model, context and limits.');
    return el(
      'div',
      { class: 'usage-link' },
      el(
        'button',
        { class: 'btn primary', type: 'button', onClick: () => this._change(agent.link, 'install') },
        icon('gauge', 15),
        el('span', {}, t("Show Claude Code's limits")),
      ),
      el('p', { class: 'hint' }, t('Adds a status line to Claude Code that passes the limits to Tsukumo.{wraps} It backs up settings.json first.', { wraps })),
    );
  }

  // --------------------------------------------------------------- notices
  async _loadIntegrations() {
    try {
      this._renderIntegrations(await request('/api/integrations'));
    } catch {
      /* backend off: stays as it was */
    }
  }

  _renderIntegrations(status) {
    this.integrations = status;
    this.notifyList.replaceChildren(
      ...['claude', 'codex'].map((tool) => {
        const item = status?.[tool];
        if (!item) return null;
        const state = item.outdated
          ? t('Connected, without the agents dashboard')
          : item.installed
            ? t('Connected|integration')
            : item.conflict
              ? t('Already has its own notification')
              : item.available
                ? t('Not connected')
                : t('Not installed');
        return el(
          'div',
          { class: 'integration' },
          el('span', { class: 'integration-text' }, el('strong', {}, item.label), el('small', { title: item.file }, state)),
          // Connected before the dashboard: "Update" adds the missing hooks.
          item.outdated
            ? el('button', { class: 'btn primary', type: 'button', onClick: () => this._change(tool, 'install') }, el('span', {}, t('Update')))
            : null,
          el(
            'button',
            {
              class: `btn${item.installed ? '' : ' primary'}`,
              type: 'button',
              disabled: !item.available || item.conflict,
              onClick: () => this._change(tool, item.installed ? 'uninstall' : 'install'),
            },
            el('span', {}, item.installed ? t('Disconnect') : t('Connect')),
          ),
        );
      }),
    );
    if (this.usage) this._setUsage(this.usage);
  }

  async _change(tool, action) {
    try {
      const data = await request('/api/integrations', 'POST', { tool, action });
      if (!data.ok) throw new Error(tx(data.error) ?? t('failed'));
      this._renderIntegrations(data.status);
      const done = tool === 'claude_usage' ? t("The limits arrive with Claude Code's next reply.") : t("Connected: I'll call you when it's done.");
      this.app.toast(action === 'install' ? done : t('Disconnected.'));
      this._loadUsage();
    } catch (error) {
      this.app.toast(error.message, 'error');
    }
  }

  // ----------------------------------------------------------- preferences
  async _loadPreferences() {
    try {
      this._setPreferences(await request('/api/preferences'));
    } catch {
      /* stays as it was */
    }
  }

  _setPreferences(preferences) {
    const value = preferences?.topics?.usage;
    if (typeof value === 'boolean') this.alerts.input.checked = value;
  }
}
