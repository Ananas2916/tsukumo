/**
 * Scheda "Personaggio": come parla, come appare, come si comporta.
 *
 * Le voci arrivano dal motore attivo con nome, lingua e genere (un elenco di
 * Kokoro, del tuo account ElevenLabs, delle voci Azure...): si cercano, si
 * filtrano per lingua e si ascoltano prima di sceglierle.
 */

import { el, iconButton, languageLabel, readSetting, writeSetting } from '../dom.js';
import { icon } from '../icons.js';

const SAMPLES = {
  it: 'Ciao! Sono io, con questa voce. Ti piaccio?',
  en: "Hi! It's me, with this voice. Do you like it?",
  es: '¡Hola! Soy yo, con esta voz. ¿Te gusta?',
  fr: "Salut ! C'est moi, avec cette voix. Elle te plaît ?",
  de: 'Hallo! Ich bin es, mit dieser Stimme. Gefällt sie dir?',
  pt: 'Olá! Sou eu, com esta voz. Gostas?',
  ja: 'こんにちは！この声はどうかな？',
};

const REPLY_LANGUAGES = [
  { value: 'auto', label: 'Nella lingua della voce' },
  { value: 'same', label: 'Nella lingua in cui scrivo' },
  { value: 'Italian', label: 'Sempre in italiano' },
  { value: 'English', label: 'Sempre in inglese' },
];

const ACTIONS = [
  { play: 'wave', label: 'Saluta', icon: 'hand' },
  { play: 'stretch', label: 'Stiracchiati', icon: 'resize' },
  { play: 'lookAround', label: 'Guardati intorno', icon: 'search' },
  { play: 'hum', label: 'Canticchia', icon: 'music' },
  { posture: 'sit', label: 'Siediti', icon: 'sit' },
  { posture: 'lie', label: 'Sdraiati', icon: 'window' },
  { posture: 'side', label: 'Sul fianco', icon: 'window' },
  { posture: 'stand', label: 'Alzati', icon: 'character' },
];

const GENDER = { female: 'donna', male: 'uomo' };

/** Come il backend chiama le lingue (`replyLanguageResolved`), per codice. */
const ENGLISH_NAMES = {
  it: 'Italian',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  ja: 'Japanese',
  hi: 'Hindi',
  zh: 'Mandarin Chinese',
  cmn: 'Mandarin Chinese',
};

export class CharacterView {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.socket = app.socket;
    this.companion = app.companion;
    this.filter = { text: '', language: null };
    this._build();
    this._listen();
  }

  shown() {}

  // ----------------------------------------------------------------- DOM
  _build() {
    // Voce ---------------------------------------------------------------
    this.engineLine = el('p', { class: 'card-sub' });
    this.search = el('input', { class: 'field-input search', type: 'search', placeholder: 'Cerca una voce…' });
    this.languageChips = el('div', { class: 'chip-row' });
    this.voiceList = el('div', { class: 'voice-list', role: 'listbox' });
    this.replyLanguage = el(
      'select',
      { class: 'field-input' },
      REPLY_LANGUAGES.map((option) => el('option', { value: option.value }, option.label)),
    );
    this.languageHint = el('p', { class: 'hint' });
    this.muted = this._switch('Voce accesa', 'Se la spegni risponde solo per iscritto, e le voci a consumo non spendono niente.');

    this.search.addEventListener('input', () => {
      this.filter.text = this.search.value.trim().toLowerCase();
      this._renderVoices();
    });
    this.replyLanguage.addEventListener('change', () => {
      writeSetting('dc:reply-language', this.replyLanguage.value);
      this.socket.send({ type: 'settings', replyLanguage: this.replyLanguage.value });
    });
    this.muted.input.addEventListener('change', () => {
      const muted = !this.muted.input.checked;
      writeSetting('dc:muted', muted);
      this.socket.send({ type: 'settings', muted });
    });

    const voiceCard = this._card(
      'volume',
      'Voce',
      this.engineLine,
      this.search,
      this.languageChips,
      this.voiceList,
      this._row('Risponde', this.replyLanguage),
      this.languageHint,
      this.muted.node,
    );

    // Aspetto ------------------------------------------------------------
    this.scale = this._slider(0.5, 2.6, 0.05, (value) => `${Math.round(value * 100)}%`);
    this.gain = this._slider(0.4, 2.5, 0.05, (value) => value.toFixed(2));
    const gain = readSetting('dc:gain', 1.15);
    this.gain.set(gain);

    let scaleTimer = null;
    this.scale.input.addEventListener('input', () => {
      // Ridimensionare la finestra a ogni pixel dello slider e' pesante.
      clearTimeout(scaleTimer);
      scaleTimer = setTimeout(() => this.companion?.setScale(this.scale.value()), 40);
    });
    this.gain.input.addEventListener('input', () => {
      writeSetting('dc:gain', this.gain.value());
      this.companion?.sendToPet({ type: 'gain', value: this.gain.value() });
    });

    const model = el('button', { class: 'btn', type: 'button', onClick: () => this.companion?.pickModel() }, icon('cube', 16), el('span', {}, 'Cambia modello 3D…'));
    const lookCard = this._card(
      'character',
      'Aspetto',
      this._row('Dimensione', this.scale.node),
      this._row('Bocca', this.gain.node, 'Quanto apre la bocca mentre parla.'),
      model,
    );

    // Comportamento --------------------------------------------------------
    this.onTop = this._switch('Sempre davanti alle finestre');
    this.windows = this._switch('Si siede sulle finestre', 'Se la lasci cadere su una finestra ci resta sopra e viaggia con lei.');
    this.spontaneous = this._switch('Gesti e pose spontanee');
    this.dance = this._switch('Balla con Spotify', "Quando Spotify suona ascolta l'audio del PC e si muove a tempo.");
    this.ghost = this._switch('Modalità fantasma', 'I click la attraversano; per uscirne usa l’icona nell’area di notifica.');

    this.spontaneous.input.checked = readSetting('dc:spontaneous', true);
    this.dance.input.checked = readSetting('dc:dance', true);
    this.onTop.input.addEventListener('change', () => this.companion?.toggleAlwaysOnTop());
    this.windows.input.addEventListener('change', () => this.companion?.setWindows(this.windows.input.checked));
    this.ghost.input.addEventListener('change', () => this.companion?.toggleGhost());
    this.spontaneous.input.addEventListener('change', () => {
      writeSetting('dc:spontaneous', this.spontaneous.input.checked);
      this.companion?.sendToPet({ type: 'spontaneous', value: this.spontaneous.input.checked });
    });
    this.dance.input.addEventListener('change', () => {
      writeSetting('dc:dance', this.dance.input.checked);
      this.companion?.sendToPet({ type: 'dance', value: this.dance.input.checked });
    });

    const behaviourCard = this._card(
      'sit',
      'Comportamento',
      this.onTop.node,
      this.windows.node,
      this.spontaneous.node,
      this.dance.node,
      this.ghost.node,
    );

    // Azioni ---------------------------------------------------------------
    const chips = ACTIONS.map((action) =>
      el(
        'button',
        {
          class: 'action-chip',
          type: 'button',
          onClick: () =>
            this.companion?.sendToPet(
              action.play ? { type: 'play', name: action.play } : { type: 'posture', value: action.posture },
            ),
        },
        icon(action.icon, 15),
        el('span', {}, action.label),
      ),
    );
    const actionsCard = this._card(
      'hand',
      'Falle fare qualcosa',
      el('div', { class: 'action-grid' }, chips),
      el('p', { class: 'hint' }, 'Sedersi e sdraiarsi funzionano quando è sulla barra delle applicazioni.'),
    );

    // Altro ----------------------------------------------------------------
    this.debug = this._switch('Pannello di debug del lip-sync');
    this.debug.input.addEventListener('change', () => this.companion?.sendToPet({ type: 'debug', value: this.debug.input.checked }));
    const quit = el('button', { class: 'btn danger', type: 'button', onClick: () => this.companion?.quit() }, icon('power', 16), el('span', {}, 'Chiudi Tsukumo'));
    const moreCard = this._card('bug', 'Altro', this.debug.node, quit);

    if (!this.companion) {
      for (const node of [lookCard, behaviourCard, actionsCard, moreCard]) node.classList.add('hidden');
    }
    this.root.append(voiceCard, lookCard, behaviourCard, actionsCard, moreCard);
  }

  _card(iconName, title, ...children) {
    return el(
      'section',
      { class: 'card' },
      el('header', { class: 'card-head' }, el('span', { class: 'card-icon' }, icon(iconName, 16)), el('h3', {}, title)),
      ...children,
    );
  }

  _row(label, control, hint) {
    return el('label', { class: 'row' }, el('span', { class: 'row-label' }, label), control, hint ? el('span', { class: 'row-hint' }, hint) : null);
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

  _slider(min, max, step, format) {
    const input = el('input', { class: 'range', type: 'range', min, max, step });
    const output = el('output', {});
    const refresh = () => {
      output.textContent = format(Number(input.value));
      const ratio = (Number(input.value) - min) / (max - min);
      input.style.setProperty('--fill', `${ratio * 100}%`);
    };
    input.addEventListener('input', refresh);
    return {
      node: el('span', { class: 'slider' }, input, output),
      input,
      value: () => Number(input.value),
      set: (value) => {
        input.value = String(value);
        refresh();
      },
    };
  }

  // -------------------------------------------------------------- stato
  _listen() {
    const { app } = this;
    app.on('voices', () => this._renderVoices());
    app.on('settings', (settings) => this._applySettings(settings));
    app.on('engines', () => this._renderEngineLine());
    app.on('hello', (message) => this._restorePreferences(message.config ?? {}));
    app.on('providers', (message) => {
      if (message.kind === 'tts') this.filter.language = null;
    });
    app.on('window-state', (state) => {
      this.onTop.input.checked = state.pinned;
      this.ghost.input.checked = state.ghost;
      this.windows.input.checked = state.windows;
      this.windows.input.disabled = !state.windowsAvailable;
      this.scale.set(state.scale);
    });
  }

  /**
   * Le scelte fatte qui valgono anche dopo un riavvio del backend: se e'
   * ripartito coi default, gliele rimandiamo. La voce e' salvata per motore:
   * `af_heart` e' una voce Kokoro e su ElevenLabs non significa niente.
   */
  _restorePreferences(config) {
    const wanted = {};
    const engine = config.ttsEngine;
    const voice = engine ? readSetting(`dc:voice:${engine}`, null) : null;
    if (voice && voice !== config.voice) wanted.voice = voice;
    const replyLanguage = readSetting('dc:reply-language', null);
    if (replyLanguage && replyLanguage !== config.replyLanguage) wanted.replyLanguage = replyLanguage;
    if (Object.keys(wanted).length) this.socket.send({ type: 'settings', ...wanted });
  }

  _applySettings(settings) {
    if (settings.replyLanguage) this.replyLanguage.value = settings.replyLanguage;
    this.muted.input.checked = !settings.muted;
    this._renderVoices();
    this._renderLanguageHint();
    this._renderEngineLine();
  }

  _renderEngineLine() {
    const tts = this.app.engines?.tts;
    this.engineLine.replaceChildren(
      el('span', {}, `Motore: ${tts?.label ?? this.app.settings.ttsEngine ?? '…'}`),
      el('button', { class: 'link-btn', type: 'button', onClick: () => this.app.showTab('engines', { section: 'tts' }) }, 'cambia', icon('chevronRight', 13)),
    );
    if (tts?.state === 'degraded' && tts.detail) this.engineLine.append(el('span', { class: 'warn-text' }, tts.detail));
  }

  _renderLanguageHint() {
    const resolved = this.app.settings.replyLanguageResolved;
    const reply = this.replyLanguage.value;
    const voiceLanguage = this.app.settings.voiceLanguage;
    const mismatch = voiceLanguage && (reply === 'same' || resolved !== ENGLISH_NAMES[voiceLanguage]);
    this.languageHint.classList.toggle('warn', reply !== 'auto' && Boolean(mismatch));
    if (reply === 'auto') {
      this.languageHint.textContent = voiceLanguage
        ? `Risponde in ${languageLabel(voiceLanguage).toLowerCase()}, la lingua della voce, anche se le scrivi in un'altra.`
        : 'La voce è multilingua: risponde nella lingua in cui le scrivi.';
    } else {
      this.languageHint.textContent = mismatch ? 'Attenzione: questa voce pronuncia bene solo la sua lingua.' : '';
    }
  }

  // ---------------------------------------------------------------- voci
  _renderVoices() {
    const voices = this.app.voices ?? [];
    const current = this.app.settings.voice;
    const counts = new Map();
    for (const voice of voices) counts.set(voice.language || '', (counts.get(voice.language || '') ?? 0) + 1);

    // Filtri per lingua: prima quella della voce attuale, poi le piu' comuni.
    const currentLanguage = voices.find((voice) => voice.id === current)?.language ?? null;
    const languages = [...counts.keys()].sort((a, b) => {
      const score = (code) => (code === currentLanguage ? -3 : code === 'it' ? -2 : code === 'en' ? -1 : 0);
      return score(a) - score(b) || counts.get(b) - counts.get(a);
    });
    this.languageChips.replaceChildren();
    if (languages.length > 1) {
      const chip = (code, label) =>
        el(
          'button',
          {
            class: `chip${this.filter.language === code ? ' active' : ''}`,
            type: 'button',
            onClick: () => {
              this.filter.language = this.filter.language === code ? null : code;
              this._renderVoices();
            },
          },
          label,
        );
      this.languageChips.append(chip(null, 'Tutte'), ...languages.slice(0, 6).map((code) => chip(code, languageLabel(code))));
    }
    this.search.classList.toggle('hidden', voices.length <= 8);

    const matches = voices.filter((voice) => {
      if (this.filter.language !== null && (voice.language || '') !== this.filter.language) return false;
      if (!this.filter.text) return true;
      return `${voice.name} ${voice.id} ${voice.description}`.toLowerCase().includes(this.filter.text);
    });

    this.voiceList.replaceChildren();
    if (!voices.length) {
      this.voiceList.append(el('p', { class: 'hint pad' }, 'Carico le voci del motore…'));
      return;
    }
    if (!matches.length) {
      this.voiceList.append(el('p', { class: 'hint pad' }, 'Nessuna voce corrisponde.'));
      return;
    }
    for (const voice of matches.slice(0, 300)) this.voiceList.append(this._voiceRow(voice, voice.id === current));
    this.voiceList.querySelector('.voice.selected')?.scrollIntoView({ block: 'nearest' });
  }

  _voiceRow(voice, selected) {
    const meta = [languageLabel(voice.language), GENDER[voice.gender], voice.description].filter(Boolean).join(' · ');
    const preview = iconButton('play', { title: 'Ascolta', className: 'icon-btn small', size: 14 });
    preview.addEventListener('click', (event) => {
      event.stopPropagation();
      this._preview(voice);
    });
    const row = el(
      'div',
      {
        class: `voice${selected ? ' selected' : ''}`,
        role: 'option',
        'aria-selected': String(selected),
        tabindex: 0,
        onClick: () => this._choose(voice),
        onKeydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') this._choose(voice);
        },
      },
      el('span', { class: 'voice-check' }, selected ? icon('check', 14) : null),
      el('span', { class: 'voice-text' }, el('strong', {}, voice.name || voice.id), meta ? el('small', {}, meta) : null),
      preview,
    );
    return row;
  }

  _choose(voice) {
    const engine = this.app.settings.ttsEngine;
    if (engine) writeSetting(`dc:voice:${engine}`, voice.id);
    this.app.settings.voice = voice.id;
    this._renderVoices();
    this.socket.send({ type: 'settings', voice: voice.id });
  }

  _preview(voice) {
    if (voice.preview) {
      // ElevenLabs offre un campione gia' registrato: non costa caratteri.
      new Audio(voice.preview).play().catch(() => this.app.toast('Anteprima non disponibile', 'warn'));
      return;
    }
    const text = SAMPLES[voice.language] ?? SAMPLES.it;
    this.socket.send({ type: 'say', text, voice: voice.id });
  }
}
