/**
 * Scheda "Personaggio": come parla, come appare, come si comporta.
 *
 * Le voci arrivano dal motore attivo con nome, lingua e genere (un elenco di
 * Kokoro, del tuo account ElevenLabs, delle voci Azure...): si cercano, si
 * filtrano per lingua e si ascoltano prima di sceglierle.
 */

import { apiUrl } from '../config.js';
import { el, iconButton, languageLabel, readSetting, writeSetting } from '../dom.js';
import { icon } from '../icons.js';
import { MIC_SETTING, SAMPLE_RATE, VoiceInput, listMicrophones } from '../mic.js';
import { BARGE_IN_SETTING } from '../voice.js';
import { MemoryCard } from './memory.js';

/** Quanto dura la registrazione di prova. */
const MIC_TEST_SECONDS = 4;
/** Sotto questo livello il rilevatore del parlato (mic.js, modo `vad`) non si accorge che parli. */
const VAD_THRESHOLD = 0.02;

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

const WEATHER_WORDS = {
  clear: 'sereno',
  cloudy: 'nuvoloso',
  fog: 'nebbia',
  rain: 'pioggia',
  snow: 'neve',
  storm: 'temporale',
};

const ACTIONS = [
  { play: 'wave', label: 'Saluta', icon: 'hand' },
  { play: 'stretch', label: 'Stiracchiati', icon: 'resize' },
  { play: 'lookAround', label: 'Guardati intorno', icon: 'search' },
  { play: 'hum', label: 'Canticchia', icon: 'music' },
  { play: 'yawn', label: 'Sbadiglia', icon: 'moon' },
  { play: 'knock', label: 'Bussa', icon: 'hand' },
  { play: 'fanSelf', label: 'Che caldo', icon: 'wave' },
  { play: 'shiver', label: 'Che freddo', icon: 'ghost' },
  { play: 'pout', label: 'Broncio', icon: 'smile' },
  { posture: 'sit', label: 'Siediti', icon: 'sit' },
  { posture: 'lie', label: 'Sdraiati', icon: 'window' },
  { posture: 'side', label: 'Sul fianco', icon: 'window' },
  { posture: 'stand', label: 'Alzati', icon: 'character' },
];

const GENDER = { female: 'donna', male: 'uomo' };

/** Le lingue in cui una voce clonata può parlare (quelle di Chatterbox che il pannello sa nominare). */
const CLONE_LANGUAGES = ['it', 'en', 'es', 'fr', 'de', 'pt', 'ja', 'zh', 'hi'];

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

/** Riproduce PCM 16 bit mono a 16 kHz e aspetta che finisca. */
async function playPcm16(buffer) {
  const samples = new Int16Array(buffer);
  const context = new AudioContext();
  const audio = context.createBuffer(1, samples.length, SAMPLE_RATE);
  const channel = audio.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 32768;
  const source = context.createBufferSource();
  source.buffer = audio;
  source.connect(context.destination);
  await new Promise((resolve) => {
    source.onended = resolve;
    source.start();
  });
  await context.close();
}

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

  shown() {
    this._loadMicrophones();
    this.memory.load();
    this._showWeather?.();
    this._loadIntegrations?.();
  }

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

    this.cloneBox = this._buildClone();

    const voiceCard = this._card(
      'volume',
      'Voce',
      this.engineLine,
      this.search,
      this.languageChips,
      this.voiceList,
      this.cloneBox,
      this._row('Risponde', this.replyLanguage),
      this.languageHint,
      this.muted.node,
    );

    // Microfono -----------------------------------------------------------
    this.micSelect = el('select', { class: 'field-input' });
    this.micMeter = el('span', { class: 'mic-meter-fill' });
    this.micStatus = el('p', { class: 'hint' }, 'Parla per 4 secondi: poi ti faccio riascoltare e ti dico cosa ho capito.');
    this.micTest = el('button', { class: 'btn', type: 'button', onClick: () => this._testMicrophone() }, icon('mic', 16), el('span', {}, 'Prova il microfono'));
    this.micSelect.addEventListener('change', () => {
      writeSetting(MIC_SETTING, this.micSelect.value);
      this.companion?.sendToPet({ type: 'mic-device', value: this.micSelect.value });
    });
    navigator.mediaDevices?.addEventListener?.('devicechange', () => this._loadMicrophones());
    this.bargeIn = this._switch(
      'Puoi interromperla parlando',
      'In ascolto continuo o a chiamata: se le parli sopra si ferma e ti ascolta. Se con le casse alte si interrompe da sola, spegnilo o usa le cuffie.',
    );
    this.bargeIn.input.checked = readSetting(BARGE_IN_SETTING, true);
    this.bargeIn.input.addEventListener('change', () => {
      writeSetting(BARGE_IN_SETTING, this.bargeIn.input.checked);
      this.companion?.sendToPet({ type: 'barge-in', value: this.bargeIn.input.checked });
    });
    const micCard = this._card(
      'mic',
      'Microfono',
      this._row('Usa', this.micSelect),
      el('div', { class: 'mic-meter' }, this.micMeter),
      this.micTest,
      this.micStatus,
      this.bargeIn.node,
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
    this.vocals = this._switch('Versetti con la sua voce', 'Un “Ciao!” quando saluta, una risatina alle carezze: con la voce scelta.');
    this.sleep = this._switch('Si addormenta se non usi il PC', 'Prima è assonnata, poi dorme; quando torni si sveglia e ti saluta.');
    this.sfx = this._switch('Effetti sonori', 'Un «pop» quando compare, un tonfo quando atterra, un campanello per i promemoria.');
    this.drowsyAfter = this._slider(1, 30, 1, (value) => `${value} min`);
    this.asleepAfter = this._slider(2, 60, 1, (value) => `${value} min`);
    this.drowsyAfter.set(readSetting('dc:sleep-drowsy', 2));
    this.asleepAfter.set(readSetting('dc:sleep-asleep', 5));
    const sendSleepTimes = () => {
      const drowsy = this.drowsyAfter.value();
      const asleep = Math.max(drowsy + 1, this.asleepAfter.value());
      if (asleep !== this.asleepAfter.value()) this.asleepAfter.set(asleep);
      writeSetting('dc:sleep-drowsy', drowsy);
      writeSetting('dc:sleep-asleep', asleep);
      this.companion?.sendToPet({ type: 'sleep-times', drowsy, asleep });
    };
    this.drowsyAfter.input.addEventListener('change', sendSleepTimes);
    this.asleepAfter.input.addEventListener('change', sendSleepTimes);
    this.ghost = this._switch('Modalità fantasma', 'I click la attraversano; per uscirne usa l’icona nell’area di notifica.');

    this.spontaneous.input.checked = readSetting('dc:spontaneous', true);
    this.dance.input.checked = readSetting('dc:dance', true);
    this.vocals.input.checked = readSetting('dc:vocals', true);
    this.sleep.input.checked = readSetting('dc:sleep', true);
    this.sfx.input.checked = readSetting('dc:sfx', true);
    this.sfx.input.addEventListener('change', () => {
      writeSetting('dc:sfx', this.sfx.input.checked);
      this.companion?.sendToPet({ type: 'sfx', value: this.sfx.input.checked });
    });
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
    this.vocals.input.addEventListener('change', () => {
      writeSetting('dc:vocals', this.vocals.input.checked);
      this.companion?.sendToPet({ type: 'vocals', value: this.vocals.input.checked });
    });
    this.sleep.input.addEventListener('change', () => {
      writeSetting('dc:sleep', this.sleep.input.checked);
      this.companion?.sendToPet({ type: 'sleep', value: this.sleep.input.checked });
    });

    const behaviourCard = this._card(
      'sit',
      'Comportamento',
      this.onTop.node,
      this.windows.node,
      this.spontaneous.node,
      this.vocals.node,
      this.sfx.node,
      this.sleep.node,
      this._row('Assonnata dopo', this.drowsyAfter.node),
      this._row('Dorme dopo', this.asleepAfter.node),
      this.dance.node,
      this.ghost.node,
    );
    const chatterCard = this._chatterCard();
    const agentsCard = this._agentsCard();

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
    // Le clip .vrma "a richiesta" (vedi clips.js) si aggiungono qui quando arrivano.
    this.clipChips = el('div', { class: 'action-grid' });
    this.app.on('hello', (message) => this._renderClipChips(message.animations ?? []));
    const actionsCard = this._card(
      'hand',
      'Falle fare qualcosa',
      el('div', { class: 'action-grid' }, chips),
      this.clipChips,
      el('p', { class: 'hint' }, 'Sedersi e sdraiarsi funzionano quando è sulla barra delle applicazioni.'),
    );

    // Altro ----------------------------------------------------------------
    this.debug = this._switch('Pannello di debug del lip-sync');
    this.debug.input.addEventListener('change', () => this.companion?.sendToPet({ type: 'debug', value: this.debug.input.checked }));
    const quit = el('button', { class: 'btn danger', type: 'button', onClick: () => this.companion?.quit() }, icon('power', 16), el('span', {}, 'Chiudi Tsukumo'));
    const replay = el(
      'button',
      { class: 'btn', type: 'button', onClick: () => this.app.welcome?.start() },
      icon('star', 16),
      el('span', {}, 'Rifai la presentazione'),
    );
    const moreCard = this._card('bug', 'Altro', this.debug.node, replay, quit);

    if (!this.companion) {
      for (const node of [lookCard, behaviourCard, actionsCard, moreCard]) node.classList.add('hidden');
    }
    this.memory = new MemoryCard(this.app, (...args) => this._card(...args));
    this.root.append(voiceCard, this.memory.node, micCard, chatterCard, agentsCard, lookCard, behaviourCard, actionsCard, moreCard);
  }

  _renderClipChips(animations) {
    const onDemand = animations.filter((item) => !/^(greet|wave|hello|idle|dance)/i.test(item.name));
    this.clipChips.replaceChildren(
      ...onDemand.map((item) => {
        const name = item.name.replace(/\.vrma$/i, '');
        return el(
          'button',
          { class: 'action-chip', type: 'button', onClick: () => this.companion?.sendToPet({ type: 'play-clip', name }) },
          icon('play', 15),
          el('span', {}, name),
        );
      }),
    );
  }

  /**
   * Avvisi da Claude Code e Codex usati per conto tuo (vedi backend/notify.py).
   * Collegarli scrive nelle loro configurazioni: solo quando premi il pulsante.
   */
  _agentsCard() {
    const list = el('div', { class: 'integration-list' });
    const render = (status) => {
      list.replaceChildren(
        ...['claude', 'codex'].map((tool) => {
          const item = status?.[tool];
          if (!item) return null;
          const state = item.installed ? 'Collegato' : item.conflict ? 'Ha già un suo avviso' : item.available ? 'Non collegato' : 'Non installato';
          const button = el(
            'button',
            {
              class: `btn${item.installed ? '' : ' primary'}`,
              type: 'button',
              disabled: !item.available || item.conflict,
              onClick: () => change(tool, item.installed ? 'uninstall' : 'install'),
            },
            el('span', {}, item.installed ? 'Scollega' : 'Collega'),
          );
          return el(
            'div',
            { class: 'integration' },
            el('span', { class: 'integration-text' }, el('strong', {}, item.label), el('small', { title: item.file }, state)),
            button,
          );
        }),
      );
    };
    const load = () =>
      fetch(apiUrl('/api/integrations'))
        .then((response) => (response.ok ? response.json() : null))
        .then(render)
        .catch(() => {});
    const change = async (tool, action) => {
      try {
        const response = await fetch(apiUrl('/api/integrations'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool, action }),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error ?? data.detail ?? `HTTP ${response.status}`);
        render(data.status);
        this.app.toast(action === 'install' ? 'Collegato: ti chiamo quando ha finito.' : 'Scollegato.');
      } catch (error) {
        this.app.toast(error.message, 'error');
      }
    };
    load();
    this._loadIntegrations = load;
    return this._card(
      'robot',
      'Avvisi dagli agenti',
      el(
        'p',
        { class: 'card-sub' },
        'Quando Claude Code o Codex, usati per conto tuo, finiscono un lavoro (o ti aspettano), lei ti chiama. Se stai già guardando l’editor basta una bolla.',
      ),
      list,
    );
  }

  /**
   * Quanto chiacchiera di sua iniziativa e di cosa (vedi backend/proactive.py).
   * Le preferenze stanno nel backend (`/api/preferences`), non qui.
   */
  _chatterCard() {
    const level = el(
      'select',
      { class: 'field-input' },
      ...[
        ['off', 'Mai (solo batteria)'],
        ['rare', 'Poco'],
        ['normal', 'Normale'],
        ['chatty', 'Tanto'],
      ].map(([value, label]) => el('option', { value }, label)),
    );
    const topics = {
      night: this._switch('Ora tarda', 'All’una sei ancora lì? Te lo fa notare (e sbadiglia).'),
      breaks: this._switch('Pause', 'Dopo due ore di fila al PC ti propone una pausa.'),
      weather: this._switch('Meteo', 'Il buongiorno col tempo che fa, il caldo, il freddo, la pioggia.'),
      battery: this._switch('Batteria', 'Al 20, 10 e 5% ti ricorda il caricabatterie.'),
      youtube: this._switch('Video di YouTube', 'Un commento sul video che stai guardando o sul suo creator.'),
      news: this._switch('Notizie', 'Un titolo di oggi, commentato.'),
      facts: this._switch('Curiosità', 'Un fatto sorprendente, ogni tanto.'),
      films: this._switch('Film', 'Un film da vedere, con il perché.'),
    };
    const city = el('input', { class: 'field-input', type: 'text', placeholder: 'Vuoto = dall’indirizzo IP', 'aria-label': 'Città per il meteo' });
    const weatherLine = el('p', { class: 'card-sub' });

    const save = async (changes) => {
      try {
        const response = await fetch(apiUrl('/api/preferences'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(changes),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        this.app.toast(`Preferenza non salvata: ${error.message}`, 'error');
      }
    };
    const apply = (prefs) => {
      level.value = prefs.chatter ?? 'normal';
      city.value = prefs.city ?? '';
      for (const [name, control] of Object.entries(topics)) control.input.checked = prefs.topics?.[name] !== false;
    };
    const showWeather = async () => {
      try {
        const response = await fetch(apiUrl('/api/weather'));
        const data = await response.json();
        const weather = data.weather;
        weatherLine.textContent = weather
          ? `Adesso${weather.city ? ` a ${weather.city}` : ''}: ${weather.temperature}°, ${WEATHER_WORDS[weather.condition] ?? weather.condition}.`
          : 'Meteo non disponibile (serve la connessione).';
      } catch {
        weatherLine.textContent = '';
      }
    };

    level.addEventListener('change', () => save({ chatter: level.value }));
    city.addEventListener('change', () => save({ city: city.value }).then(showWeather));
    for (const [name, control] of Object.entries(topics)) {
      control.input.addEventListener('change', () => save({ topics: { [name]: control.input.checked } }));
    }
    this.socket.on('preferences', apply);
    fetch(apiUrl('/api/preferences'))
      .then((response) => (response.ok ? response.json() : null))
      .then((prefs) => prefs && apply(prefs))
      .catch(() => {});
    this._showWeather = showWeather;

    return this._card(
      'chat',
      'Chiacchiere',
      el('p', { class: 'card-sub' }, 'Quanto parla di sua iniziativa: mai con lo schermo intero, in riunione o se non sei al PC.'),
      this._row('Quanto', level),
      ...Object.values(topics).map((control) => control.node),
      this._row('Città', city),
      weatherLine,
    );
  }

  _card(iconName, title, ...children) {
    return el(
      'section',
      { class: 'card' },
      el('header', { class: 'card-head' }, el('span', { class: 'card-icon' }, icon(iconName, 16)), el('h3', {}, title)),
      ...children,
    );
  }

  /** "Clona una voce": scegli un audio, dagli un nome e una lingua. Solo coi motori che sanno clonare. */
  _buildClone() {
    const file = el('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.flac,.ogg', class: 'hidden' });
    const name = el('input', { class: 'field-input', type: 'text', maxlength: 40, placeholder: 'Nome della voce' });
    const language = el(
      'select',
      { class: 'field-input' },
      CLONE_LANGUAGES.map((code) => el('option', { value: code }, languageLabel(code))),
    );
    const status = el('p', { class: 'hint' }, 'Un audio pulito di 5-20 secondi, con una sola persona che parla e senza musica sotto.');
    const submit = el('button', { class: 'btn primary', type: 'button' }, icon('check', 16), el('span', {}, 'Clona'));
    const cancel = el('button', { class: 'btn', type: 'button' }, el('span', {}, 'Annulla'));
    const form = el('div', { class: 'clone-form hidden' }, this._row('Nome', name), this._row('Parla in', language), status, el('div', { class: 'clone-actions' }, submit, cancel));
    const open = el('button', { class: 'btn', type: 'button', onClick: () => file.click() }, icon('mic', 16), el('span', {}, 'Clona una voce…'));

    const reset = () => {
      file.value = '';
      form.classList.add('hidden');
      open.classList.remove('hidden');
      status.classList.remove('error');
      status.textContent = 'Un audio pulito di 5-20 secondi, con una sola persona che parla e senza musica sotto.';
    };
    file.addEventListener('change', () => {
      const picked = file.files?.[0];
      if (!picked) return;
      name.value = picked.name.replace(/\.[^.]+$/, '').slice(0, 40);
      const system = (navigator.language || 'it').slice(0, 2);
      language.value = CLONE_LANGUAGES.includes(system) ? system : 'it';
      form.classList.remove('hidden');
      open.classList.add('hidden');
      name.focus();
    });
    cancel.addEventListener('click', reset);
    submit.addEventListener('click', async () => {
      const picked = file.files?.[0];
      if (!picked) return;
      submit.disabled = true;
      status.classList.remove('error');
      status.textContent = 'Ascolto la voce e la imparo…';
      try {
        const query = new URLSearchParams({ name: name.value.trim() || 'Voce', language: language.value });
        const response = await fetch(apiUrl(`/api/voices/clone?${query}`), { method: 'POST', body: picked });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || result.detail || `Errore ${response.status}`);
        const engine = this.app.settings.ttsEngine;
        if (engine) writeSetting(`dc:voice:${engine}`, result.voice);
        reset();
        this.app.toast('Voce clonata: ora parla così', 'ok');
        this._preview({ id: result.voice, language: language.value });
      } catch (error) {
        status.classList.add('error');
        status.textContent = error.message;
      } finally {
        submit.disabled = false;
      }
    });
    return el('div', { class: 'clone-box hidden' }, file, open, form);
  }

  // ----------------------------------------------------------- microfono
  async _loadMicrophones() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    let mics = [];
    try {
      mics = await listMicrophones();
    } catch (error) {
      this.micStatus.textContent = `Non riesco a vedere i microfoni: ${error.message}`;
    }
    const saved = readSetting(MIC_SETTING, '');
    const options = [el('option', { value: '' }, 'Predefinito di Windows'), ...mics.map((mic) => el('option', { value: mic.id }, mic.label))];
    if (saved && !mics.some((mic) => mic.id === saved)) {
      options.push(el('option', { value: saved }, 'Microfono scollegato (uso il predefinito)'));
    }
    this.micSelect.replaceChildren(...options);
    this.micSelect.value = saved;
  }

  async _testMicrophone() {
    if (this.micTesting) return;
    this.micTesting = true;
    this.micTest.disabled = true;
    this.micStatus.classList.remove('warn', 'error');
    // Il personaggio non deve prendere la frase di prova per una domanda.
    this.companion?.sendToPet({ type: 'mic-test', value: true });

    let peak = 0;
    let recorded = null;
    const input = new VoiceInput({
      onLevel: (level) => {
        peak = Math.max(peak, level);
        this.micMeter.style.width = `${Math.min(1, Math.sqrt(level) * 1.8) * 100}%`;
      },
      onUtterance: (pcm16) => {
        recorded = pcm16;
      },
      onError: (error) => {
        this.micStatus.textContent = error.message;
      },
    });

    try {
      if (!(await input.start({ mode: 'push', deviceId: this.micSelect.value }))) throw new Error(this.micStatus.textContent);
      input.beginPush();
      for (let left = MIC_TEST_SECONDS; left > 0; left -= 1) {
        this.micStatus.textContent = `Parla adesso… ${left}`;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      input.endPush();
      input.stop();
      this.micMeter.style.width = '0%';

      if (!recorded || peak < 0.004) {
        this.micStatus.classList.add('error');
        this.micStatus.textContent = 'Non sento niente: controlla che il microfono sia collegato e non silenziato in Windows.';
        return;
      }
      this.micStatus.textContent = 'Ti faccio riascoltare…';
      await playPcm16(recorded);
      this.micStatus.textContent = 'Cerco di capire cosa hai detto…';
      const heard = await this._transcribe(recorded);
      const quiet = peak < VAD_THRESHOLD ? ' Però ti sento piano: se mi lasci sempre in ascolto potrei non accorgermi che parli.' : '';
      this.micStatus.classList.toggle('warn', Boolean(quiet));
      this.micStatus.textContent = `${heard}${quiet}`;
    } catch (error) {
      this.micStatus.classList.add('error');
      this.micStatus.textContent = error.message || 'Microfono non disponibile';
    } finally {
      input.stop();
      this.micMeter.style.width = '0%';
      this.companion?.sendToPet({ type: 'mic-test', value: false });
      this.micTest.disabled = false;
      this.micTesting = false;
    }
  }

  async _transcribe(pcm16) {
    const response = await fetch(apiUrl('/api/transcribe'), { method: 'POST', body: pcm16 });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return `L'audio arriva bene. ${result.error || result.detail || ''}`.trim();
    return result.text?.trim() ? `Ho capito: «${result.text.trim()}»` : 'L’audio arriva, ma non ho riconosciuto parole.';
  }

  async _removeVoice(voice) {
    if (!window.confirm(`Eliminare la voce "${voice.name || voice.id}"?`)) return;
    const response = await fetch(apiUrl(`/api/voices/${encodeURIComponent(voice.id)}`), { method: 'DELETE' });
    if (!response.ok) this.app.toast('Non sono riuscita a eliminarla', 'warn');
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
    this.cloneBox.classList.toggle('hidden', !this.app.settings.canClone);
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
    if (voice.removable) {
      const remove = iconButton('trash', { title: 'Elimina', className: 'icon-btn small', size: 14 });
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        this._removeVoice(voice);
      });
      row.append(remove);
    }
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
