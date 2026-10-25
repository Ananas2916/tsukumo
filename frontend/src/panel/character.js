/**
 * "Character" tab: how she speaks, how she looks, how she behaves.
 *
 * Voices come from the active engine with name, language and gender (a list
 * from Kokoro, from your ElevenLabs account, Azure's voices...): you search
 * them, filter by language and listen before choosing.
 */

import { apiUrl } from '../config.js';
import { el, iconButton, languageLabel, readSetting, writeSetting } from '../dom.js';
import { LANG, savedLanguage, setLanguage, t, tx, UI_LANGUAGES } from '../i18n.js';
import { icon } from '../icons.js';
import { paletteKey, PALETTE_LABELS, swatchColor } from '../flame/palettes.js';
import { EXTRA_LABELS, EXTRAS, OUTFIT_LABELS, parseExtras, parseOutfit, seasonalOutfit, SELECTIONS, toggleExtra } from '../flame/wardrobe.js';
import { MIC_SETTING, SAMPLE_RATE, VoiceInput, listMicrophones } from '../mic.js';
import { BARGE_IN_SETTING } from '../voice.js';
import { MemoryCard } from './memory.js';
import { MusicCard } from './music.js';
import { outfitPreview } from './wardrobe-art.js';

/** How long the test recording lasts. */
const MIC_TEST_SECONDS = 4;
/** Below this level the speech detector (mic.js, `vad` mode) doesn't notice you're talking. */
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
  { value: 'auto', label: t("In the voice's language") },
  { value: 'same', label: t('In the language I write in') },
  { value: 'Italian', label: t('Always in Italian') },
  { value: 'English', label: t('Always in English') },
];

const WEATHER_WORDS = {
  clear: t('clear'),
  cloudy: t('cloudy'),
  fog: t('fog'),
  rain: t('rain'),
  snow: t('snow'),
  storm: t('storm'),
};

/** Her reactions (flame.js), to see them right away. */
const ACTIONS = [
  { play: 'cheer', label: t('Celebrate'), icon: 'star' },
  { play: 'hearts', label: t('Little hearts'), icon: 'smile' },
  { play: 'cool', label: t('Sunglasses'), icon: 'sun' },
  { play: 'surprise', label: t('Surprise'), icon: 'alert' },
  { play: 'speechless', label: t('Speechless'), icon: 'dots' },
  { play: 'dizzy', label: t('Dizzy'), icon: 'refresh' },
  { play: 'greet', label: t('Wave'), icon: 'hand' },
  { play: 'stretch', label: t('Stretch'), icon: 'resize' },
  { play: 'look', label: t('Look around'), icon: 'search' },
  { play: 'sing', label: t('Hum'), icon: 'music' },
  { play: 'yawn', label: t('Yawn'), icon: 'moon' },
  { play: 'call', label: t('Knock'), icon: 'hand' },
  { play: 'gust', label: t('So cold'), icon: 'ghost' },
  { play: 'pout', label: t('Pout'), icon: 'smile' },
  { play: 'spin', label: t('Twirl'), icon: 'refresh' },
  { play: 'hop', label: t('Hop'), icon: 'top' },
  // A dash along the taskbar, right away.
  { sprint: true, label: 'Sprint', icon: 'bolt' },
];

const GENDER = { female: 'donna', male: 'uomo' };

/** The flame's colours (frontend/src/flame/palettes.js), with the swatch colour. */
const FLAME_COLORS = Object.entries(PALETTE_LABELS).map(([value, label]) => ({ value, label, swatch: swatchColor(value) }));

/** The short name under each wardrobe preview (the long one is in the title). */
const OUTFIT_SHORT = {
  auto: 'Auto',
  none: t('Nothing'),
  bowtie: t('Bow tie'),
  crown: t('Crown'),
  angel: t('Angel'),
  devil: t('Devil'),
  headphones: t('Headphones'),
  catears: t('Neko'),
  tophat: t('Top hat'),
  hachimaki: 'Hachimaki',
  kitsune: 'Kitsune',
  sakura: 'Sakura',
  lantern: t('Lantern'),
  glasses: t('Glasses'),
  scarf: t('Scarf'),
  kasa: t('Straw'),
  witch: t('Witch'),
  santa: t('Christmas'),
  party: t('Party'),
};

/** The same for the decorations. */
const EXTRA_SHORT = {
  bow: t('Bow'),
  whiskers: t('Whiskers'),
};

/** The languages a cloned voice can speak (those of Chatterbox the panel can name). */
const CLONE_LANGUAGES = ['it', 'en', 'es', 'fr', 'de', 'pt', 'ja', 'zh', 'hi'];

/** How the backend names the languages (`replyLanguageResolved`), by code. */
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

/** Plays 16-bit mono PCM at 16 kHz and waits for it to finish. */
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
  }

  // ------------------------------------------------------------------- DOM
  _build() {
    // Voice -----------------------------------------------------------------
    this.engineLine = el('p', { class: 'card-sub' });
    this.search = el('input', { class: 'field-input search', type: 'search', placeholder: t('Search a voice…') });
    this.languageChips = el('div', { class: 'chip-row' });
    this.voiceList = el('div', { class: 'voice-list', role: 'listbox' });
    this.replyLanguage = el(
      'select',
      { class: 'field-input' },
      REPLY_LANGUAGES.map((option) => el('option', { value: option.value }, option.label)),
    );
    this.languageHint = el('p', { class: 'hint' });
    this.muted = this._switch(t('Voice on'), t('If you turn it off she answers only in writing, and pay-per-use voices spend nothing.'));

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
      t('Voice'),
      this.engineLine,
      this.search,
      this.languageChips,
      this.voiceList,
      this.cloneBox,
      this._row(t('Answers'), this.replyLanguage),
      this.languageHint,
      this.muted.node,
    );

    // Microphone ------------------------------------------------------------
    this.micSelect = el('select', { class: 'field-input' });
    this.micMeter = el('span', { class: 'mic-meter-fill' });
    this.micStatus = el('p', { class: 'hint' }, t("Talk for 4 seconds: then I'll play it back and tell you what I understood."));
    this.micTest = el('button', { class: 'btn', type: 'button', onClick: () => this._testMicrophone() }, icon('mic', 16), el('span', {}, t('Test the microphone')));
    this.micSelect.addEventListener('change', () => {
      writeSetting(MIC_SETTING, this.micSelect.value);
      this.companion?.sendToPet({ type: 'mic-device', value: this.micSelect.value });
    });
    navigator.mediaDevices?.addEventListener?.('devicechange', () => this._loadMicrophones());
    this.bargeIn = this._switch(
      t('You can interrupt her by talking'),
      t('In continuous or wake-word listening: if you talk over her she stops and listens. If she interrupts herself with loud speakers, turn it off or use headphones.'),
    );
    this.bargeIn.input.checked = readSetting(BARGE_IN_SETTING, true);
    this.bargeIn.input.addEventListener('change', () => {
      writeSetting(BARGE_IN_SETTING, this.bargeIn.input.checked);
      this.companion?.sendToPet({ type: 'barge-in', value: this.bargeIn.input.checked });
    });
    const micCard = this._card(
      'mic',
      t('Microphone'),
      this._row(t('Use'), this.micSelect),
      el('div', { class: 'mic-meter' }, this.micMeter),
      this.micTest,
      this.micStatus,
      this.bargeIn.node,
    );

    // Look --------------------------------------------------------------------
    this.scale = this._slider(0.5, 2.6, 0.05, (value) => `${Math.round(value * 100)}%`);
    this.gain = this._slider(0.4, 2.5, 0.05, (value) => value.toFixed(2));
    const gain = readSetting('dc:gain', 1.15);
    this.gain.set(gain);

    let scaleTimer = null;
    this.scale.input.addEventListener('input', () => {
      // Resizing the window at every pixel of the slider is heavy.
      clearTimeout(scaleTimer);
      scaleTimer = setTimeout(() => this.companion?.setScale(this.scale.value()), 40);
    });
    this.gain.input.addEventListener('input', () => {
      writeSetting('dc:gain', this.gain.value());
      this.companion?.sendToPet({ type: 'gain', value: this.gain.value() });
    });

    // The flame's colour: it shows right away, with a flare. Besides the six
    // named ones there's the free one (the rainbow swatch opens the picker).
    let flameColor = paletteKey(readSetting('dc:flame-color', 'lilac')) ?? 'lilac';
    const swatches = el('div', { class: 'swatch-row', role: 'radiogroup', 'aria-label': t('Flame colour') });
    let colorTimer = null;
    const pickColor = (value, { now = true } = {}) => {
      flameColor = value;
      writeSetting('dc:flame-color', flameColor);
      renderSwatches();
      clearTimeout(colorTimer);
      // Dragging in the picker sends many colours: only the last one goes to the
      // flame, and the previews are redrawn once.
      colorTimer = setTimeout(
        () => {
          this.companion?.sendToPet({ type: 'flame-color', value: flameColor });
          renderWardrobe();
          renderExtras();
        },
        now ? 0 : 120,
      );
    };
    const custom = el('input', { type: 'color', class: 'swatch-picker', 'aria-label': t('Free colour') });
    custom.addEventListener('input', () => pickColor(custom.value.toLowerCase(), { now: false }));
    // Built once and then only restyled: moving the picker's input in the page
    // (rebuilding the row at every colour) closed it as soon as you dragged in it.
    const namedSwatches = FLAME_COLORS.map((color) =>
      el('button', {
        type: 'button',
        class: 'swatch',
        role: 'radio',
        'aria-label': color.label,
        title: color.label,
        style: { background: color.swatch },
        onClick: () => pickColor(color.value),
      }),
    );
    const freeSwatch = el('label', { class: 'swatch swatch-free' }, custom);
    swatches.append(...namedSwatches, freeSwatch);
    const renderSwatches = () => {
      const free = flameColor.startsWith('#');
      const value = free ? flameColor : '#a58bff';
      if (custom.value !== value) custom.value = value;
      FLAME_COLORS.forEach((color, i) => {
        namedSwatches[i].classList.toggle('on', color.value === flameColor);
        namedSwatches[i].setAttribute('aria-checked', String(color.value === flameColor));
      });
      freeSwatch.classList.toggle('on', free);
      freeSwatch.title = free ? t('Free colour ({color})', { color: flameColor }) : t('Free colour');
      freeSwatch.style.background = free ? flameColor : '';
    };

    // The wardrobe: one preview per accessory, in the current colour and with the decorations.
    let outfit = parseOutfit(readSetting('dc:flame-outfit', 'auto'));
    let extras = parseExtras(readSetting('dc:flame-extras', []));
    const wardrobeNow = el('span', { class: 'wardrobe-now' });
    const wardrobe = el('div', { class: 'wardrobe', role: 'radiogroup', 'aria-label': t('Wardrobe') });
    const describe = (choice) => {
      if (choice !== 'auto') return OUTFIT_LABELS[choice];
      const season = seasonalOutfit();
      return season === 'none' ? t('Automatic · nothing this season') : t('Automatic · {outfit}', { outfit: OUTFIT_LABELS[season] });
    };
    const renderWardrobe = () => {
      wardrobeNow.textContent = describe(outfit);
      wardrobe.replaceChildren(
        ...SELECTIONS.map((choice) => {
          const tile = el('button', {
            type: 'button',
            class: `wardrobe-item${choice === outfit ? ' on' : ''}`,
            role: 'radio',
            'aria-checked': String(choice === outfit),
            title: describe(choice),
            onClick: () => {
              outfit = choice;
              writeSetting('dc:flame-outfit', outfit);
              this.companion?.sendToPet({ type: 'flame-outfit', value: outfit });
              renderWardrobe();
            },
          });
          // SVG made in here with already validated colours (palettes.js): no user text.
          tile.innerHTML = outfitPreview(choice === 'auto' ? seasonalOutfit() : choice, flameColor, { badge: choice === 'auto', extras });
          tile.append(el('span', {}, OUTFIT_SHORT[choice]));
          tile.addEventListener('pointerenter', () => (wardrobeNow.textContent = describe(choice)));
          tile.addEventListener('pointerleave', () => (wardrobeNow.textContent = describe(outfit)));
          return tile;
        }),
      );
    };
    // The decorations: on top of any outfit, each one on or off.
    const decorations = el('div', { class: 'wardrobe', role: 'group', 'aria-label': t('Decorations') });
    const renderExtras = () => {
      decorations.replaceChildren(
        ...EXTRAS.map((extra) => {
          const on = extras.includes(extra);
          const tile = el('button', {
            type: 'button',
            class: `wardrobe-item${on ? ' on' : ''}`,
            'aria-pressed': String(on),
            title: EXTRA_LABELS[extra],
            onClick: () => {
              extras = toggleExtra(extras, extra);
              writeSetting('dc:flame-extras', extras);
              this.companion?.sendToPet({ type: 'flame-extras', value: extras });
              renderExtras();
              renderWardrobe();
            },
          });
          // SVG made in here with already validated colours (palettes.js): no user text.
          tile.innerHTML = outfitPreview('none', flameColor, { extras: [extra] });
          tile.append(el('span', {}, EXTRA_SHORT[extra]));
          return tile;
        }),
      );
    };
    // Changed from the island (the wardrobe is there too): the panel lines up.
    window.addEventListener('storage', (event) => {
      if (event.key !== 'dc:flame-outfit' && event.key !== 'dc:flame-extras') return;
      outfit = parseOutfit(readSetting('dc:flame-outfit', 'auto'));
      extras = parseExtras(readSetting('dc:flame-extras', []));
      renderWardrobe();
      renderExtras();
    });
    renderSwatches();
    renderWardrobe();
    renderExtras();

    const lookCard = this._card(
      'flame',
      t('Look'),
      el('div', { class: 'row' }, el('span', { class: 'row-label' }, t('Colour')), swatches),
      el('div', { class: 'wardrobe-block' }, el('div', { class: 'wardrobe-head' }, el('span', { class: 'row-label' }, t('Wardrobe')), wardrobeNow), wardrobe),
      el('div', { class: 'wardrobe-block' }, el('div', { class: 'wardrobe-head' }, el('span', { class: 'row-label' }, t('Decorations')), el('span', { class: 'wardrobe-now' }, t('On top of any outfit'))), decorations),
      this._row(t('Size'), this.scale.node),
      this._row(t('Mouth'), this.gain.node, t('How wide she opens her mouth while speaking.')),
    );

    // Behaviour ---------------------------------------------------------------
    this.onTop = this._switch(t('Always in front of windows'));
    this.windows = this._switch(t('Sits on windows'), t('If you drop her on a window she stays on it and travels with it.'));
    this.spontaneous = this._switch(t('Spontaneous gestures'));
    this.dance = this._switch(t('Dance to Spotify'), t("When Spotify plays she listens to the PC's audio and moves in time."));
    this.vocals = this._switch(t('Vocals in her voice'), t('A "Hi!" when she greets, a giggle when petted: in the chosen voice.'));
    this.sleep = this._switch(t("Falls asleep if you don't use the PC"), t("First she's drowsy, then she sleeps; when you come back she wakes up and greets you."));
    this.sfx = this._switch(t('Sound effects'), t('Little sounds when she appears, when you touch her, when the menu opens, when an agent is done or waiting: never over her voice.'));
    this.sfxVolume = this._slider(0.05, 1, 0.05, (value) => `${Math.round(value * 100)}%`);
    this.sfxVolume.set(readSetting('dc:sfx-volume', 0.6));
    this.sfxVolume.input.addEventListener('change', () => {
      writeSetting('dc:sfx-volume', this.sfxVolume.value());
      this.companion?.sendToPet({ type: 'sfx-volume', value: this.sfxVolume.value() });
    });
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
    this.ghost = this._switch(t('Ghost mode'), t('Clicks go through her; to leave it use the icon in the notification area.'));

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
      t('Behaviour'),
      this.onTop.node,
      this.windows.node,
      this.spontaneous.node,
      this.vocals.node,
      this.sfx.node,
      this._row(t('Effects volume'), this.sfxVolume.node),
      this.sleep.node,
      this._row(t('Drowsy after'), this.drowsyAfter.node),
      this._row(t('Asleep after'), this.asleepAfter.node),
      this.dance.node,
      this.ghost.node,
    );
    const chatterCard = this._chatterCard();

    // Actions -----------------------------------------------------------------
    const chips = ACTIONS.map((action) =>
      el(
        'button',
        {
          class: 'action-chip',
          type: 'button',
          onClick: () =>
            this.companion?.sendToPet(action.sprint ? { type: 'sprint' } : { type: 'play', name: action.play }),
        },
        icon(action.icon, 15),
        el('span', {}, action.label),
      ),
    );
    const actionsCard = this._card(
      'hand',
      t('Make her do something'),
      el('div', { class: 'action-grid' }, chips),
      el('p', { class: 'hint' }, t('She sprints only when she is down on the taskbar.')),
    );

    // More --------------------------------------------------------------------
    this.debug = this._switch(t('Lip-sync debug panel'));
    this.debug.input.addEventListener('change', () => this.companion?.sendToPet({ type: 'debug', value: this.debug.input.checked }));
    const quit = el('button', { class: 'btn danger', type: 'button', onClick: () => this.companion?.quit() }, icon('power', 16), el('span', {}, t('Quit Tsukumo')));
    const replay = el(
      'button',
      { class: 'btn', type: 'button', onClick: () => this.app.welcome?.start() },
      icon('star', 16),
      el('span', {}, t('Redo the introduction')),
    );
    const moreCard = this._card('bug', t('More'), this.debug.node, replay, quit);

    // Interface language (i18n.js): every open window reloads in the new one.
    const uiLanguage = el(
      'select',
      { class: 'field-input', 'aria-label': t('Interface language') },
      el('option', { value: 'auto' }, t('Automatic (system)')),
      ...Object.entries(UI_LANGUAGES).map(([code, name]) => el('option', { value: code }, name)),
    );
    uiLanguage.value = savedLanguage();
    uiLanguage.addEventListener('change', () => {
      setLanguage(uiLanguage.value);
      window.location.reload();
    });
    const languageCard = this._card('globe', t('Language'), this._row(t('Interface'), uiLanguage, t('What she says follows her voice (Voice, above).')));

    // Pointing at the screen takes her window in Electron: not in a browser.
    const guideCard = this._guideCard();
    if (!this.companion) {
      for (const node of [lookCard, behaviourCard, actionsCard, moreCard, guideCard]) node.classList.add('hidden');
    }
    this.memory = new MemoryCard(this.app, (...args) => this._card(...args));
    this.music = new MusicCard(this.app, (...args) => this._card(...args));
    // First her (the flame and her colour), then the voice and the rest.
    this.root.append(lookCard, voiceCard, this.memory.node, this.music.node, micCard, chatterCard, guideCard, behaviourCard, actionsCard, languageCard, moreCard);
  }

  /**
   * How much she chats on her own and about what (see backend/proactive.py).
   * The preferences live in the backend (`/api/preferences`), not here.
   */
  _chatterCard() {
    const level = el(
      'select',
      { class: 'field-input' },
      ...[
        ['off', t('Never (battery only)')],
        ['rare', t('A little')],
        ['normal', t('Normal')],
        ['chatty', t('A lot')],
      ].map(([value, label]) => el('option', { value }, label)),
    );
    const topics = {
      night: this._switch(t('Late hour'), t('Still there at 1 a.m.? She points it out (and yawns).')),
      breaks: this._switch(t('Breaks'), t('After two hours straight at the PC she suggests a break.')),
      weather: this._switch(t('Weather'), t('Good morning with the weather, the heat, the cold, the rain.')),
      battery: this._switch(t('Battery'), t('At 20, 10 and 5% she reminds you of the charger.')),
      youtube: this._switch(t('YouTube videos'), t("A comment on the video you're watching or on its creator.")),
      news: this._switch(t('News|headlines'), t("One of today's headlines, with a comment.")),
      facts: this._switch(t('Fun facts'), t('A surprising fact, now and then.')),
      films: this._switch(t('Films'), t('A film to watch, and why.')),
    };
    const city = el('input', { class: 'field-input', type: 'text', placeholder: t('Empty = from the IP address'), 'aria-label': t('City for the weather') });
    const weatherLine = el('p', { class: 'card-sub' });

    // Who writes news, fun facts and comments: a separate model (cloud or
    // local), so a pay-per-use agent doesn't spend a turn on every chat.
    const save = (changes) => this._savePreferences(changes);
    const brain = this._modelChoice({
      modelsLabel: t('Models'),
      modelsHint: t('Comma separated: if the first is busy it tries the next one.'),
      modelsAria: t('Models for the chatter'),
      keyAria: t('API key for the chatter'),
      describe: (spec, error) => {
        if (!spec) return t('News, fun facts and comments are written by the brain chosen in Engines.');
        if (error) return t("{engine} didn't answer: {error}", { engine: tx(spec.label), error: tx(error) });
        return t('{engine} writes them; the main brain stays for when you talk to her.', { engine: tx(spec.label) });
      },
      onEngine: (value) => save({ brain: value }),
      onModels: (value) => save({ brainModels: value }),
    });
    const apply = (prefs) => {
      level.value = prefs.chatter ?? 'normal';
      city.value = prefs.city ?? '';
      for (const [name, control] of Object.entries(topics)) control.input.checked = prefs.topics?.[name] !== false;
      brain.set(prefs.brain, prefs.brainModels, 'brainError' in prefs ? prefs.brainError : undefined);
    };
    const showWeather = async () => {
      try {
        const response = await fetch(apiUrl('/api/weather'));
        const data = await response.json();
        const weather = data.weather;
        weatherLine.textContent = weather
          ? weather.city ? t('Now in {city}: {temp}°, {condition}.', { city: weather.city, temp: weather.temperature, condition: WEATHER_WORDS[weather.condition] ?? weather.condition }) : t('Now: {temp}°, {condition}.', { temp: weather.temperature, condition: WEATHER_WORDS[weather.condition] ?? weather.condition })
          : t('Weather unavailable (it needs the connection).');
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
    brain
      .load()
      .then(() => fetch(apiUrl('/api/preferences')))
      .then((response) => (response.ok ? response.json() : null))
      .then((prefs) => prefs && apply(prefs))
      .catch(() => {});
    this._showWeather = showWeather;

    return this._card(
      'chat',
      t('Chatter'),
      el('p', { class: 'card-sub' }, t("How much she talks on her own: never in full screen, in a meeting or when you're away from the PC.")),
      this._row(t('How much'), level),
      ...Object.values(topics).map((control) => control.node),
      this._row(t('City'), city),
      weatherLine,
      this._row(t('Who writes them'), brain.select),
      brain.modelsRow,
      brain.keyRow,
      brain.line,
    );
  }

  /**
   * "Where's the AND?": she looks at the screen and draws an arrow to the spot
   * (backend/guide.py). The eye is the model that finds the spot on the
   * screenshot: any cloud or local model that sees, or the main brain if it's one.
   */
  _guideCard() {
    const save = (changes) => this._savePreferences(changes);
    const looks = this._switch(
      t('Look by herself'),
      t('On «where is…», «where do I click…», «how do I…» she looks at the screen and draws an arrow to the spot. Only then: never by herself.'),
    );
    let effective = '';
    const eye = this._modelChoice({
      modelsLabel: t('Model'),
      modelsHint: t('One that sees images (e.g. gemini-2.5-flash, gpt-4.1, qwen2.5-vl).'),
      modelsAria: t('Model for the eye'),
      keyAria: t('API key for the eye'),
      describe: (spec, error) => {
        if (spec && error) return t("{engine} didn't answer: {error}", { engine: tx(spec.label), error: tx(error) });
        if (spec) return t('{engine} finds the spots on the screenshot.', { engine: tx(spec.label) });
        const main = eye.specs[effective];
        if (main && error) return t("{engine} didn't answer: {error}", { engine: tx(main.label), error: tx(error) });
        if (main) return t('The main brain ({engine}) finds the spots: it must be a model that sees images.', { engine: tx(main.label) });
        return t("The main brain is an agent: choose a model that sees, or she points only at what Windows describes (buttons, menus, fields).");
      },
      onEngine: (value) => save({ eye: value }),
      onModels: (value) => save({ eyeModel: value }),
    });
    const apply = (prefs) => {
      looks.input.checked = prefs.guide !== false;
      if ('eyeEngine' in prefs) effective = prefs.eyeEngine ?? '';
      eye.set(prefs.eye, prefs.eyeModel, 'eyeError' in prefs ? prefs.eyeError : undefined);
    };
    const refresh = () =>
      fetch(apiUrl('/api/preferences'))
        .then((response) => (response.ok ? response.json() : null))
        .then((prefs) => prefs && apply(prefs))
        .catch(() => {});
    looks.input.addEventListener('change', () => save({ guide: looks.input.checked }));
    // The broadcast doesn't carry the eye's state: it's read again after every change.
    this.socket.on('preferences', (prefs) => {
      apply(prefs);
      refresh();
    });
    eye.load().then(refresh);
    return this._card(
      'target',
      t('Show me where'),
      el('p', { class: 'card-sub' }, t('An arrow from her to the button, the field or the pin: a click there (or «done») moves on to the next step. She only points, she never clicks for you.')),
      looks.node,
      this._row(t('Who sees'), eye.select),
      eye.modelsRow,
      eye.keyRow,
      eye.line,
    );
  }

  async _savePreferences(changes) {
    try {
      const response = await fetch(apiUrl('/api/preferences'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      this.app.toast(t('Preference not saved: {error}', { error: error.message }), 'error');
    }
  }

  /**
   * A model for a side job (the chatter, the eye): engine, model and, when
   * its key is missing, the key, saved like those in Engines. `describe(spec,
   * error)` writes the line under it.
   */
  _modelChoice({ modelsLabel, modelsHint, modelsAria, keyAria, describe, onEngine, onModels }) {
    const select = el('select', { class: 'field-input' }, el('option', { value: '' }, t('The main brain')));
    const models = el('input', { class: 'field-input', type: 'text', spellcheck: 'false', 'aria-label': modelsAria });
    const key = el('input', { class: 'field-input', type: 'password', autocomplete: 'off', placeholder: t('Paste the key'), 'aria-label': keyAria });
    const choice = {
      select,
      modelsRow: this._row(modelsLabel, models, modelsHint),
      keyRow: this._row(t('Key'), key, t("It stays in this PC's .env file, like those in Engines.")),
      line: el('p', { class: 'card-sub' }),
      specs: {},
      saved: {},
      error: null,
    };
    const specOf = () => choice.specs[select.value] ?? null;
    const secretOf = (spec) => spec?.fields.find((field) => field.secret) ?? null;
    choice.refresh = () => {
      const spec = specOf();
      const secret = secretOf(spec);
      const model = spec?.fields.find((field) => field.env.endsWith('_MODEL'));
      choice.modelsRow.hidden = !model;
      models.placeholder = model?.default ? t('Empty = {model}', { model: model.default }) : '';
      choice.keyRow.hidden = !secret || Boolean(choice.saved[spec.id]?.[secret.env]);
      choice.line.textContent = describe(spec, choice.error);
    };
    choice.set = (engine, value, error) => {
      select.value = engine && engine in choice.specs ? engine : '';
      models.value = value ?? '';
      if (error !== undefined) choice.error = error;
      choice.refresh();
    };
    choice.load = async () => {
      try {
        const response = await fetch(apiUrl('/api/providers'));
        const data = await response.json();
        const usable = (data.providers?.llm ?? []).filter((spec) => spec.category === 'cloud' || spec.category === 'local');
        choice.specs = Object.fromEntries(usable.map((spec) => [spec.id, spec]));
        choice.saved = data.saved?.llm ?? {};
        const current = select.value;
        select.replaceChildren(
          el('option', { value: '' }, t('The main brain')),
          ...usable.map((spec) => el('option', { value: spec.id }, spec.pricing === 'free' ? spec.label : `${tx(spec.label)} (${spec.pricing === 'freemium' ? t('free too') : t('pay as you go')})`)),
        );
        select.value = current in choice.specs ? current : '';
        choice.refresh();
      } catch {
        // Without the backend it stays "the main brain".
      }
    };
    const saveKey = async () => {
      const spec = specOf();
      const secret = secretOf(spec);
      if (!secret || !key.value.trim()) return;
      try {
        const response = await fetch(apiUrl('/api/providers/options'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'llm', provider: spec.id, options: { [secret.env]: key.value.trim() } }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(tx(data.detail) ?? `HTTP ${response.status}`);
        choice.saved[spec.id] = data.saved;
        key.value = '';
        choice.refresh();
        this.app.toast(t('{engine} key saved', { engine: tx(spec.label) }), 'ok');
      } catch (error) {
        this.app.toast(t('Key not saved: {error}', { error: error.message }), 'error');
      }
    };
    select.addEventListener('change', () => {
      choice.error = null;
      choice.refresh();
      onEngine(select.value);
    });
    models.addEventListener('change', () => onModels(models.value));
    key.addEventListener('change', saveKey);
    this.app.on('providers', choice.load);
    return choice;
  }

  _card(iconName, title, ...children) {
    return el(
      'section',
      { class: 'card' },
      el('header', { class: 'card-head' }, el('span', { class: 'card-icon' }, icon(iconName, 16)), el('h3', {}, title)),
      ...children,
    );
  }

  /** "Clone a voice": choose a recording, give it a name and a language. Only with engines that can clone. */
  _buildClone() {
    const file = el('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.flac,.ogg', class: 'hidden' });
    const name = el('input', { class: 'field-input', type: 'text', maxlength: 40, placeholder: t('Voice name') });
    const language = el(
      'select',
      { class: 'field-input' },
      CLONE_LANGUAGES.map((code) => el('option', { value: code }, languageLabel(code))),
    );
    const status = el('p', { class: 'hint' }, t('A clean recording of 5-20 seconds, with one person speaking and no music underneath.'));
    const submit = el('button', { class: 'btn primary', type: 'button' }, icon('check', 16), el('span', {}, t('Clone')));
    const cancel = el('button', { class: 'btn', type: 'button' }, el('span', {}, t('Cancel')));
    const form = el('div', { class: 'clone-form hidden' }, this._row(t('Name'), name), this._row(t('Speaks'), language), status, el('div', { class: 'clone-actions' }, submit, cancel));
    const open = el('button', { class: 'btn', type: 'button', onClick: () => file.click() }, icon('mic', 16), el('span', {}, t('Clone a voice…')));

    const reset = () => {
      file.value = '';
      form.classList.add('hidden');
      open.classList.remove('hidden');
      status.classList.remove('error');
      status.textContent = t('A clean recording of 5-20 seconds, with one person speaking and no music underneath.');
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
      status.textContent = t('Listening to the voice and learning it…');
      try {
        const query = new URLSearchParams({ name: name.value.trim() || t('Voice'), language: language.value });
        const response = await fetch(apiUrl(`/api/voices/clone?${query}`), { method: 'POST', body: picked });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(tx(result.error || result.detail) || t('Error {code}', { code: response.status }));
        const engine = this.app.settings.ttsEngine;
        if (engine) writeSetting(`dc:voice:${engine}`, result.voice);
        reset();
        this.app.toast(t('Voice cloned: now she speaks like this'), 'ok');
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

  // ------------------------------------------------------------- microphone
  async _loadMicrophones() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    let mics = [];
    try {
      mics = await listMicrophones();
    } catch (error) {
      this.micStatus.textContent = t("I can't see the microphones: {error}", { error: error.message });
    }
    const saved = readSetting(MIC_SETTING, '');
    const options = [el('option', { value: '' }, t('Windows default')), ...mics.map((mic) => el('option', { value: mic.id }, mic.label))];
    if (saved && !mics.some((mic) => mic.id === saved)) {
      options.push(el('option', { value: saved }, t('Microphone unplugged (using the default)')));
    }
    this.micSelect.replaceChildren(...options);
    this.micSelect.value = saved;
  }

  async _testMicrophone() {
    if (this.micTesting) return;
    this.micTesting = true;
    this.micTest.disabled = true;
    this.micStatus.classList.remove('warn', 'error');
    // The character must not take the test sentence for a question.
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
        this.micStatus.textContent = t('Talk now… {left}', { left });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      input.endPush();
      input.stop();
      this.micMeter.style.width = '0%';

      if (!recorded || peak < 0.004) {
        this.micStatus.classList.add('error');
        this.micStatus.textContent = t("I can't hear anything: check that the microphone is plugged in and not muted in Windows.");
        return;
      }
      this.micStatus.textContent = t('Playing it back…');
      await playPcm16(recorded);
      this.micStatus.textContent = t('Trying to understand what you said…');
      const heard = await this._transcribe(recorded);
      const quiet = peak < VAD_THRESHOLD ? t(" But I hear you faintly: if you leave me always listening I might not notice you're talking.") : '';
      this.micStatus.classList.toggle('warn', Boolean(quiet));
      this.micStatus.textContent = `${heard}${quiet}`;
    } catch (error) {
      this.micStatus.classList.add('error');
      this.micStatus.textContent = error.message || t('Microphone unavailable');
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
    if (!response.ok) return `${t('The audio comes through fine.')} ${tx(result.error || result.detail || '')}`.trim();
    return result.text?.trim() ? t('I understood: "{text}"', { text: result.text.trim() }) : t('The audio comes through, but I recognized no words.');
  }

  async _removeVoice(voice) {
    if (!window.confirm(t('Delete the voice "{name}"?', { name: voice.name || voice.id }))) return;
    const response = await fetch(apiUrl(`/api/voices/${encodeURIComponent(voice.id)}`), { method: 'DELETE' });
    if (!response.ok) this.app.toast(t("I couldn't delete it"), 'warn');
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

  // ------------------------------------------------------------------ state
  _listen() {
    const { app } = this;
    app.on('voices', () => this._renderVoices());
    app.on('settings', (settings) => this._applySettings(settings));
    app.on('engines', () => this._renderEngineLine());
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
      el('span', {}, t('Engine: {name}', { name: tx(tts?.label) ?? this.app.settings.ttsEngine ?? '…' })),
      el('button', { class: 'link-btn', type: 'button', onClick: () => this.app.showTab('engines', { section: 'tts' }) }, t('change'), icon('chevronRight', 13)),
    );
    if (tts?.state === 'degraded' && tts.detail) this.engineLine.append(el('span', { class: 'warn-text' }, tx(tts.detail)));
  }

  _renderLanguageHint() {
    const resolved = this.app.settings.replyLanguageResolved;
    const reply = this.replyLanguage.value;
    const voiceLanguage = this.app.settings.voiceLanguage;
    const mismatch = voiceLanguage && (reply === 'same' || resolved !== ENGLISH_NAMES[voiceLanguage]);
    this.languageHint.classList.toggle('warn', reply !== 'auto' && Boolean(mismatch));
    if (reply === 'auto') {
      this.languageHint.textContent = voiceLanguage
        ? t("She answers in {language}, the voice's language, even if you write to her in another one.", { language: LANG === 'it' ? languageLabel(voiceLanguage).toLowerCase() : languageLabel(voiceLanguage) })
        : t('The voice is multilingual: she answers in the language you write in.');
    } else {
      this.languageHint.textContent = mismatch ? t('Careful: this voice pronounces only its own language well.') : '';
    }
  }

  // ------------------------------------------------------------------ voices
  _renderVoices() {
    const voices = this.app.voices ?? [];
    const current = this.app.settings.voice;
    this.cloneBox.classList.toggle('hidden', !this.app.settings.canClone);
    const counts = new Map();
    for (const voice of voices) counts.set(voice.language || '', (counts.get(voice.language || '') ?? 0) + 1);

    // Language filters: first the current voice's, then the most common ones.
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
      this.languageChips.append(chip(null, t('All')), ...languages.slice(0, 6).map((code) => chip(code, languageLabel(code))));
    }
    this.search.classList.toggle('hidden', voices.length <= 8);

    const matches = voices.filter((voice) => {
      if (this.filter.language !== null && (voice.language || '') !== this.filter.language) return false;
      if (!this.filter.text) return true;
      return `${voice.name} ${voice.id} ${voice.description}`.toLowerCase().includes(this.filter.text);
    });

    this.voiceList.replaceChildren();
    if (!voices.length) {
      this.voiceList.append(el('p', { class: 'hint pad' }, t("Loading the engine's voices…")));
      return;
    }
    if (!matches.length) {
      this.voiceList.append(el('p', { class: 'hint pad' }, t('No voice matches.')));
      return;
    }
    for (const voice of matches.slice(0, 300)) this.voiceList.append(this._voiceRow(voice, voice.id === current));
    this.voiceList.querySelector('.voice.selected')?.scrollIntoView({ block: 'nearest' });
  }

  _voiceRow(voice, selected) {
    const meta = [languageLabel(voice.language), GENDER[voice.gender], voice.description].filter(Boolean).join(' · ');
    const preview = iconButton('play', { title: t('Listen'), className: 'icon-btn small', size: 14 });
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
      const remove = iconButton('trash', { title: t('Delete'), className: 'icon-btn small', size: 14 });
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
      // ElevenLabs offers an already recorded sample: it costs no characters.
      new Audio(voice.preview).play().catch(() => this.app.toast(t('Preview unavailable'), 'warn'));
      return;
    }
    const text = SAMPLES[voice.language] ?? SAMPLES.it;
    this.socket.send({ type: 'say', text, voice: voice.id });
  }
}
