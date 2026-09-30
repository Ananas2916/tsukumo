/**
 * "Musica": Spotify collegato, cosa sta suonando e cosa ha capito dei tuoi gusti.
 *
 * Il backend (backend/music.py) racconta al cervello cosa ascolti quando si
 * parla di musica, e mette i brani che il cervello sceglie. Per collegarsi
 * serve un'app Spotify tua (è gratis): Spotify non dà un accesso unico a tutti.
 * Il permesso si dà nel browser di sistema, poi Spotify torna sul backend.
 */

import { apiUrl } from '../config.js';
import { el } from '../dom.js';
import { icon } from '../icons.js';

export class MusicCard {
  /**
   * @param {{socket: object, toast: Function}} app
   * @param {(iconName: string, title: string, ...children: Node[]) => HTMLElement} card costruttore dei riquadri
   */
  constructor(app, card) {
    this.app = app;

    this.status = el('p', { class: 'card-sub' }, 'Spotify non è collegato.');
    this.clientId = el('input', {
      class: 'field-input',
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      maxlength: 64,
      placeholder: '32 caratteri, dalla tua app Spotify',
      'aria-label': 'Client ID di Spotify',
      onKeydown: (event) => {
        if (event.key === 'Enter') this._connect();
      },
    });
    this.redirect = el('code', { class: 'music-redirect' });
    this.connectButton = el('button', { class: 'btn primary', type: 'button', onClick: () => this._connect() }, icon('music', 15), el('span', {}, 'Collega Spotify'));
    this.setup = el(
      'div',
      { class: 'music-setup' },
      el(
        'ol',
        { class: 'hint music-steps' },
        el('li', {}, 'Su ', el('a', { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noreferrer' }, 'developer.spotify.com/dashboard'), ' crea un’app e spunta «Web API».'),
        el('li', {}, 'Come Redirect URI incolla: ', this.redirect),
        el('li', {}, 'Copia qui il Client ID e premi Collega: il permesso lo dai nel browser.'),
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
        el('button', { class: 'link-btn', type: 'button', onClick: () => this._post('/api/music/taste/forget', 'Gusti dimenticati') }, 'Dimentica i gusti'),
        el('button', { class: 'link-btn', type: 'button', onClick: () => this._post('/api/music/spotify/disconnect', 'Spotify scollegato') }, 'Scollega'),
      ),
    );

    this.node = card(
      'music',
      'Musica',
      this.status,
      this.setup,
      this.connected,
      el(
        'p',
        { class: 'hint' },
        'Chiedile «che genere è?», «mettine di simili», «metti in pausa la musica». Scegliere cosa suonare richiede Spotify Premium; pausa e cambio brano vanno con qualunque account.',
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
      // Senza backend resta "non collegato".
    }
  }

  _set(data) {
    const connected = Boolean(data.connected);
    this.redirect.textContent = data.redirectUri ?? '';
    this.setup.classList.toggle('hidden', connected);
    this.connected.classList.toggle('hidden', !connected);

    const now = data.nowPlaying;
    if (!connected) {
      this.status.textContent = data.configured ? 'Spotify non è collegato: premi Collega e dai il permesso nel browser.' : 'Spotify non è collegato.';
    } else if (now) {
      this.status.textContent = `${now.playing ? 'Sta suonando' : 'In pausa'}: ${now.title} — ${now.artist}.`;
    } else {
      this.status.textContent = `Collegato${data.user ? ` come ${data.user}` : ''}. Adesso non suona niente.`;
    }
    if (data.error && connected) this.status.textContent += ` ${data.error}`;

    const taste = data.taste ?? {};
    const pieces = [];
    if (taste.favourites?.length) pieces.push(`ti piacciono ${taste.favourites.slice(0, 5).join(', ')}`);
    if (taste.genres?.length) pieces.push(`soprattutto ${taste.genres.slice(0, 3).join(', ')}`);
    this.taste.textContent = pieces.length
      ? `Ho capito che ${pieces.join(', ')}.`
      : 'Sto ancora imparando i tuoi gusti: li capisco da cosa ascolti fino in fondo, cosa salti e cosa mi dici che ti piace.';
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
      if (!response.ok) throw new Error(data.detail ?? `HTTP ${response.status}`);
      // Si apre nel browser di sistema (setWindowOpenHandler in electron/main.js).
      window.open(data.authorizeUrl, '_blank');
      this.status.textContent = 'Dai il permesso nella pagina di Spotify che si è aperta nel browser…';
    } catch (error) {
      this.app.toast(`Spotify non collegato: ${error.message}`, 'error');
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
      this.app.toast(`Non riuscito: ${error.message}`, 'error');
    }
  }
}
