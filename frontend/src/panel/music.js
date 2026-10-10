/**
 * "Music": Spotify connected, what's playing and what she has understood of
 * your taste.
 *
 * The backend (backend/music.py) tells the brain what you listen to when
 * music comes up, and plays the tracks the brain picks. Connecting needs a
 * Spotify app of your own (it's free): Spotify doesn't give everyone a
 * single shared access. Permission is given in the system browser, then
 * Spotify comes back to the backend.
 */

import { apiUrl } from '../config.js';
import { el } from '../dom.js';
import { t, tx } from '../i18n.js';
import { icon } from '../icons.js';

export class MusicCard {
  /**
   * @param {{socket: object, toast: Function}} app
   * @param {(iconName: string, title: string, ...children: Node[]) => HTMLElement} card builds the cards
   */
  constructor(app, card) {
    this.app = app;

    this.status = el('p', { class: 'card-sub' }, t('Spotify is not connected.'));
    this.clientId = el('input', {
      class: 'field-input',
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      maxlength: 64,
      placeholder: t('32 characters, from your Spotify app'),
      'aria-label': t('Spotify Client ID'),
      onKeydown: (event) => {
        if (event.key === 'Enter') this._connect();
      },
    });
    this.redirect = el('code', { class: 'music-redirect' });
    this.connectButton = el('button', { class: 'btn primary', type: 'button', onClick: () => this._connect() }, icon('music', 15), el('span', {}, t('Connect Spotify')));
    this.setup = el(
      'div',
      { class: 'music-setup' },
      el(
        'ol',
        { class: 'hint music-steps' },
        el('li', {}, t('On '), el('a', { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noreferrer' }, 'developer.spotify.com/dashboard'), t(' create an app and tick "Web API".')),
        el('li', {}, t('As the Redirect URI paste: '), this.redirect),
        el('li', {}, t('Copy the Client ID here and press Connect: you give the permission in the browser.')),
      ),
      el('label', { class: 'row' }, el('span', { class: 'row-label' }, 'Client ID'), this.clientId),
      this.connectButton,
    );

    this.taste = el('p', { class: 'hint' });
    this.connected = el(
      'div',
      { class: 'music-connected hidden' },
      this.taste,
      el(
        'div',
        { class: 'music-links' },
        el('button', { class: 'link-btn', type: 'button', onClick: () => this._post('/api/music/taste/forget', t('Taste forgotten')) }, t('Forget my taste')),
        el('button', { class: 'link-btn', type: 'button', onClick: () => this._post('/api/music/spotify/disconnect', t('Spotify disconnected')) }, t('Disconnect')),
      ),
    );

    this.node = card(
      'music',
      t('Music'),
      this.status,
      this.setup,
      this.connected,
      el(
        'p',
        { class: 'hint' },
        t('Ask her "what genre is this?", "play something similar", "pause the music". Choosing what to play needs Spotify Premium; pause and skip work with any account.'),
      ),
    );

    app.socket.on('music', (message) => this._set(message));
    this.load();
  }

  async load() {
    try {
      const response = await fetch(apiUrl('/api/music'));
      if (response.ok) this._set(await response.json());
    } catch {
      // Without the backend it stays "not connected".
    }
  }

  _set(data) {
    const connected = Boolean(data.connected);
    this.redirect.textContent = data.redirectUri ?? '';
    this.setup.classList.toggle('hidden', connected);
    this.connected.classList.toggle('hidden', !connected);

    const now = data.nowPlaying;
    if (!connected) {
      this.status.textContent = data.configured ? t('Spotify is not connected: press Connect and give the permission in the browser.') : t('Spotify is not connected.');
    } else if (now) {
      this.status.textContent = `${now.playing ? t('Playing') : t('Paused')}: ${now.title} — ${now.artist}.`;
    } else {
      this.status.textContent = data.user ? t('Connected as {user}. Nothing is playing right now.', { user: data.user }) : t('Connected. Nothing is playing right now.');
    }
    if (data.error && connected) this.status.textContent += ` ${data.error}`;

    const taste = data.taste ?? {};
    const pieces = [];
    if (taste.favourites?.length) pieces.push(t('you like {list}', { list: taste.favourites.slice(0, 5).join(', ') }));
    if (taste.genres?.length) pieces.push(t('mostly {list}', { list: taste.genres.slice(0, 3).join(', ') }));
    this.taste.textContent = pieces.length
      ? t('I understood that {things}.', { things: pieces.join(', ') })
      : t("I'm still learning your taste: I get it from what you listen to all the way through, what you skip and what you tell me you like.");
  }

  async _connect() {
    const clientId = this.clientId.value.trim();
    if (!clientId) {
      this.clientId.focus();
      return;
    }
    this.connectButton.disabled = true;
    try {
      const response = await fetch(apiUrl('/api/music/spotify/setup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(tx(data.detail) ?? `HTTP ${response.status}`);
      // It opens in the system browser (setWindowOpenHandler in electron/main.js).
      window.open(data.authorizeUrl, '_blank');
      this.status.textContent = t('Give the permission in the Spotify page that opened in the browser…');
    } catch (error) {
      this.app.toast(t('Spotify not connected: {error}', { error: error.message }), 'error');
    } finally {
      this.connectButton.disabled = false;
    }
  }

  async _post(path, done) {
    try {
      const response = await fetch(apiUrl(path), { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this._set(await response.json());
      this.app.toast(done, 'ok');
    } catch (error) {
      this.app.toast(t('Failed: {error}', { error: error.message }), 'error');
    }
  }
}
