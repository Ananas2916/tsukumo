/**
 * Scheda "Lavoro": gli agenti che usi per conto tuo.
 *
 *  - Consumi: quanto e' usato dei limiti del piano di Claude Code e Codex,
 *    quando si azzerano, i token di oggi (backend/usage.py). Antigravity non
 *    li scrive sul PC: si vede solo quando l'hai usato.
 *  - Avvisi: quando finiscono un lavoro o ti aspettano, lei ti chiama
 *    (backend/notify.py).
 *
 * Collegare qualcosa scrive nelle configurazioni degli agenti (con una copia
 * di sicurezza): solo quando premi il pulsante.
 */

import { apiUrl } from '../config.js';
import { el } from '../dom.js';
import { icon } from '../icons.js';

const WINDOW_LABELS = { 300: '5 ore', 10080: 'Settimana', 43200: 'Mese' };
const PLAN_LABELS = { free: 'Free', plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };

async function request(path, method = 'GET', body) {
  const response = await fetch(apiUrl(path), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail ?? `HTTP ${response.status}`);
  return data;
}

function windowLabel(minutes) {
  if (WINDOW_LABELS[minutes]) return WINDOW_LABELS[minutes];
  if (!minutes) return 'Limite';
  return minutes < 1440 ? `${Math.round(minutes / 60)} ore` : `${Math.round(minutes / 1440)} giorni`;
}

function resetText(epoch) {
  if (!epoch) return 'azzerato';
  const moment = new Date(epoch * 1000);
  const now = new Date();
  const clock = moment.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  if (moment.toDateString() === now.toDateString()) return `si azzera alle ${clock}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (moment.toDateString() === tomorrow.toDateString()) return `si azzera domani alle ${clock}`;
  const day = moment.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
  return `si azzera ${day}`;
}

function ago(epoch) {
  if (!epoch) return '';
  const minutes = Math.round((Date.now() / 1000 - epoch) / 60);
  if (minutes < 2) return 'usato adesso';
  if (minutes < 60) return `usato ${minutes} min fa`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `usato ${hours} ${hours === 1 ? 'ora' : 'ore'} fa`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'usato ieri' : `usato ${days} giorni fa`;
}

function tokensText(tokens) {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)} mila`;
  return `${(tokens / 1_000_000).toFixed(1).replace('.', ',').replace(',0', '')} M`;
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
    this.agents = el('div', { class: 'usage-list' }, el('p', { class: 'hint' }, 'Leggo i consumi…'));
    this.alerts = this._switch(
      'Avvisami vicino ai limiti',
      'All’80 e al 95% di un limite, e quando si azzera. Anche con le chiacchiere spente; mai in riunione o se non sei al PC.',
    );
    this.alerts.input.addEventListener('change', () => {
      request('/api/preferences', 'POST', { topics: { usage: this.alerts.input.checked } }).catch((error) => this.app.toast(error.message, 'error'));
    });
    const usageCard = this._card(
      'gauge',
      'Consumi degli agenti',
      el(
        'p',
        { class: 'card-sub' },
        'Letti dai file che gli agenti scrivono sul tuo PC: niente rete, niente password. Puoi anche chiederglielo a voce: «quanto mi resta di Claude?».',
      ),
      this.agents,
      this.alerts.node,
    );

    this.notifyList = el('div', { class: 'integration-list' });
    const notifyCard = this._card(
      'robot',
      'Avvisi dagli agenti',
      el(
        'p',
        { class: 'card-sub' },
        'Quando Claude Code o Codex, usati per conto tuo, finiscono un lavoro (o ti aspettano), lei ti chiama. Se stai già guardando l’editor basta una bolla.',
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

  // -------------------------------------------------------------- consumi
  async _loadUsage() {
    try {
      this._setUsage(await request('/api/usage'));
    } catch (error) {
      if (!this.usage) this.agents.replaceChildren(el('p', { class: 'hint error' }, `Consumi non disponibili: ${error.message}`));
    }
  }

  _setUsage(snapshot) {
    this.usage = snapshot;
    const agents = snapshot?.agents ?? [];
    if (!agents.length) {
      this.agents.replaceChildren(el('p', { class: 'hint' }, 'Non trovo Claude Code, Codex o Antigravity su questo PC.'));
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
      ? el('p', { class: 'usage-today' }, `Oggi: ${tokensText(today.tokens)} token in ${today.messages} ${today.messages === 1 ? 'risposta' : 'risposte'}`)
      : today
        ? el('p', { class: 'usage-today' }, 'Oggi non l’hai ancora usato.')
        : null;
    const note = agent.note ? el('p', { class: 'hint' }, agent.note) : null;
    return el('div', { class: 'usage-agent' }, head, ...limits, todayLine, note, agent.link ? this._linkRow(agent) : null);
  }

  /** Claude Code: i limiti arrivano solo dalla sua barra di stato, che si collega da qui. */
  _linkRow(agent) {
    const status = this.integrations?.[agent.link];
    if (agent.linked) {
      return el(
        'button',
        { class: 'link-btn', type: 'button', onClick: () => this._change(agent.link, 'uninstall') },
        'Scollega la barra di stato di Claude Code',
      );
    }
    const wraps = status?.wraps
      ? ' Avevi già una barra: resta com’è, la nostra la mostra uguale.'
      : ' Mostra modello, contesto e limiti.';
    return el(
      'div',
      { class: 'usage-link' },
      el(
        'button',
        { class: 'btn primary', type: 'button', onClick: () => this._change(agent.link, 'install') },
        icon('gauge', 15),
        el('span', {}, 'Mostra i limiti di Claude Code'),
      ),
      el('p', { class: 'hint' }, `Aggiunge a Claude Code una barra di stato che passa i limiti a Tsukumo.${wraps} Prima fa una copia di settings.json.`),
    );
  }

  // ---------------------------------------------------------------- avvisi
  async _loadIntegrations() {
    try {
      this._renderIntegrations(await request('/api/integrations'));
    } catch {
      /* backend spento: resta com'era */
    }
  }

  _renderIntegrations(status) {
    this.integrations = status;
    this.notifyList.replaceChildren(
      ...['claude', 'codex'].map((tool) => {
        const item = status?.[tool];
        if (!item) return null;
        const state = item.installed ? 'Collegato' : item.conflict ? 'Ha già un suo avviso' : item.available ? 'Non collegato' : 'Non installato';
        return el(
          'div',
          { class: 'integration' },
          el('span', { class: 'integration-text' }, el('strong', {}, item.label), el('small', { title: item.file }, state)),
          el(
            'button',
            {
              class: `btn${item.installed ? '' : ' primary'}`,
              type: 'button',
              disabled: !item.available || item.conflict,
              onClick: () => this._change(tool, item.installed ? 'uninstall' : 'install'),
            },
            el('span', {}, item.installed ? 'Scollega' : 'Collega'),
          ),
        );
      }),
    );
    if (this.usage) this._setUsage(this.usage);
  }

  async _change(tool, action) {
    try {
      const data = await request('/api/integrations', 'POST', { tool, action });
      if (!data.ok) throw new Error(data.error ?? 'non riuscito');
      this._renderIntegrations(data.status);
      const done = tool === 'claude_usage' ? 'I limiti arrivano alla prossima risposta di Claude Code.' : 'Collegato: ti chiamo quando ha finito.';
      this.app.toast(action === 'install' ? done : 'Scollegato.');
      this._loadUsage();
    } catch (error) {
      this.app.toast(error.message, 'error');
    }
  }

  // ------------------------------------------------------------ preferenze
  async _loadPreferences() {
    try {
      this._setPreferences(await request('/api/preferences'));
    } catch {
      /* resta com'era */
    }
  }

  _setPreferences(preferences) {
    const value = preferences?.topics?.usage;
    if (typeof value === 'boolean') this.alerts.input.checked = value;
  }
}
