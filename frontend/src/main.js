/**
 * Entry point of the character's window.
 *
 * It puts the pieces together:
 *
 *   WebSocket  ->  SpeechPlayer  ->  LipSync  ->  VrmStage
 *   (backend)      (WebAudio)        (weights)    (blendshapes)
 *
 * The backend sends a `speech` message for every sentence: base64 WAV +
 * viseme timeline. The player plays it and measures the instantaneous
 * volume, LipSync combines timeline and volume, VrmStage writes the weights
 * on the mouth's blendshapes every frame.
 *
 * In Electron there's also the mascot behaviour: per-pixel click-through,
 * you pick her up and move her (she dangles, then falls and lands; the flame
 * can also be thrown), she reacts when you touch her, and right-click opens
 * the menu (hud.js): the island around the flame, the docks beside the body.
 *
 * Tsukumo is the flame (flame.js), who now and then sprints along the
 * taskbar. The 3D body (VRM) is optional: whoever wants it gives it to her
 * and she enters and leaves it; without it, the VRM isn't even loaded.
 */

import { apiUrl, DEFAULT_BLENDSHAPES, wsUrl } from './config.js';
import { SpeechPlayer } from './audio.js';
import { readBody, readSetting, writeSetting } from './dom.js';
import { resolveOutfit } from './flame/wardrobe.js';
import { Hud } from './hud.js';
import { LANG, t, translateDom, tx, watchLanguage } from './i18n.js';
import { LipSync } from './lipsync.js';
import { MusicListener } from './music.js';
import { Presence, SLEEP_LEVEL } from './presence.js';
import { Sfx } from './sfx.js';
import { UI } from './ui.js';
import { greetingForNow, Vocals } from './vocals.js';
import { VoiceController } from './voice.js';
import { VrmStage } from './vrm.js';
import { CompanionSocket } from './ws.js';

const pet = window.companion?.isElectron ? window.companion : null;
translateDom();
watchLanguage();
// The tray menu and the dialogs speak the interface's language too.
pet?.setLanguage?.(LANG);

/** The chosen form: 'vrm' or 'flame'. The panel reads it too (same origin). */
const FORM_SETTING = 'dc:form';
/** With the body ('vrm') or without ('none': just the flame, the VRM isn't loaded). */
const BODY_SETTING = 'dc:body';

/** How often the flame sprints, if nothing holds her back (ms). */
const SPRINT_EVERY = [4 * 60_000, 9 * 60_000];
/** At the right moment she can't (she's speaking, you're in a meeting...): retry soon. */
const SPRINT_RETRY = 45_000;
/** Only if you're at the PC: nobody sees her run if you've been away longer than this (s). */
const SPRINT_MAX_IDLE = 90;

/** The flame's colour (flame/palettes.js): the panel chooses it. */
const COLOR_SETTING = 'dc:flame-color';
/** What she wears (flame/wardrobe.js): "auto" follows the seasons. */
const OUTFIT_SETTING = 'dc:flame-outfit';

const ui = new UI();
const hud = new Hud(ui.elements.hud, document.getElementById('island'));
const stage = new VrmStage(document.getElementById('stage'));
setFlameColor(readSetting(COLOR_SETTING, 'lilac'));
setFlameOutfit();
// "Automatic": at midnight on Halloween the hat changes by itself.
setInterval(setFlameOutfit, 10 * 60 * 1000);
// The choice is fixed at first start: after the introduction the default would change (see readBody).
const bodiless = readBody() === 'none';
writeSetting(BODY_SETTING, bodiless ? 'none' : 'vrm');
// Without a body the flame is there right away, even before the backend: no model to download.
if (bodiless) stage.useSpirit();
else stage.setForm(readSetting(FORM_SETTING, 'vrm'), { animate: false });
hud.setForm(stage.form);
hud.setBodiless(bodiless);
document.body.classList.toggle('flame-form', stage.form === 'flame');
const lipSync = new LipSync({ gain: readSetting('dc:gain', 1.15) });
const player = new SpeechPlayer({
  onClipStart: (payload) => {
    lipSync.setTimeline(payload.visemes);
    stage.startClip(payload);
    // A real reply wakes her; one of her vocals doesn't.
    if (!payload.vocal) presence.touch();
    if (payload.text) ui.showBubble(payload.text, Math.max(2500, payload.duration * 1000 + 1200));
    syncVoiceState();
    refreshStatus();
  },
  onIdle: () => {
    lipSync.clear();
    syncVoiceState();
    refreshStatus();
  },
});
const socket = new CompanionSocket(wsUrl);

/** Local state, kept minimal on purpose. */
const state = {
  /** There's something on stage: the loaded VRM, or the flame alone. */
  avatarLoaded: bodiless,
  /** 'vrm' or 'none' (see BODY_SETTING). */
  body: bodiless ? 'none' : 'vrm',
  /** The backend's default model: needed to give her the body back. */
  avatarUrl: null,
  /** She has already greeted on appearing (without a body that happens at the first contact with the backend). */
  greeted: false,
  /** The agents' usage from the backend (`usage` message), for the HUD's ring. */
  usage: null,
  backendState: 'idle',
  /** Last value sent to Electron for the click-through. */
  interactive: null,
  voiceAvailable: false,
  muted: readSetting('dc:muted', false),
  micLevel: 0,
  dancing: readSetting('dc:dance', true),
  musicPlaying: false,
  /** She lay down to sleep: on waking she gets up. */
  sleptLying: false,
  /** When the last drag ended: if she falls right after, you threw her. */
  droppedAt: -Infinity,
  /** The user's activity from the backend: `{kind, label, detail, dnd, watching}`. */
  activity: null,
  /** For how many seconds nobody has touched mouse and keyboard (from Electron). */
  idleSeconds: 0,
  /** When she may do the next sprint (performance.now()). */
  nextSprintAt: performance.now() + SPRINT_EVERY[0],
};

const voice = new VoiceController({
  socket,
  onEvent: (event) => {
    if (event.type === 'error') ui.toast(event.message, true, 4000);
    if (event.type === 'activity') {
      document.body.classList.toggle('listening', event.speaking);
      stage.setListening(event.speaking);
    }
    if (event.type === 'level') state.micLevel = event.level;
    if (event.type === 'enabled') reportVoice();
    // You called her by name: she raises her hand, "here I am".
    if (event.type === 'summoned') stage.playClipRole('here');
  },
});

/** Rhythm of Spotify's music, listening to the system audio (Electron only). */
const music = new MusicListener();

/** Pop, thud, chime, knock-knock: synthesized, never over the mouth (see sfx.js). */
const sfx = new Sfx({ isMuted: () => state.muted });

/** "Hii!" when she greets, "Ehehe!" when petted: in the chosen voice (see vocals.js). */
const vocals = new Vocals({
  player,
  isQuiet: () => state.muted || player.playing || state.backendState !== 'idle',
});

/** The PC is idle: she dozes, then sleeps; when you come back she greets you (see presence.js). */
const presence = new Presence({
  onChange: (next, { welcome }) => {
    stage.setSleep(SLEEP_LEVEL[next]);
    if (next === 'asleep') lieDownToSleep();
    const stoodUp = next === 'awake' ? getUpFromSleep() : false;
    if (welcome) {
      setTimeout(() => {
        stage.greet();
        vocals.say('welcome');
      }, stoodUp ? 1400 : 500);
    }
  },
});

/**
 * Cursor circles around her head: three fast circles and her head spins.
 * The accumulated angle drains by itself, so it only counts if it's quick.
 */
const spin = { angle: null, total: 0, at: 0 };
function trackSpin(x, y) {
  const head = stage.headScreen();
  if (!head) return;
  const now = performance.now();
  spin.total *= Math.exp(-(now - spin.at) / 1500);
  spin.at = now;
  const radius = Math.hypot(x - head.x, y - head.y);
  if (radius < 30 || radius > 260) {
    spin.angle = null;
    return;
  }
  const angle = Math.atan2(y - head.y, x - head.x);
  if (spin.angle !== null) {
    let delta = angle - spin.angle;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    spin.total += delta;
  }
  spin.angle = angle;
  if (Math.abs(spin.total) > 3 * 2 * Math.PI) {
    spin.total = 0;
    if (stage.play('dizzy')) {
      sfx.blip(false);
      vocals.say('dizzy');
    }
  }
}

/**
 * Pokes in a row: three in just over a second and her head spins; five in
 * six seconds and she gets offended. Returns the reaction, or null.
 */
const pokes = [];
function pokeStreak() {
  const now = performance.now();
  pokes.push(now);
  while (pokes.length && now - pokes[0] > 6000) pokes.shift();
  if (pokes.filter((at) => now - at < 1200).length >= 3) return 'dizzy';
  return pokes.length >= 5 ? 'pout' : null;
}

/** Happy reactions speak like a pat, the others like a poke. */
const HAPPY_POKES = new Set(['pat', 'hearts', 'sing', 'cool']);

/** She's doing something, or the user is watching a video: no sleep. */
function busyForSleep() {
  return (
    Boolean(state.activity?.watching) ||
    player.playing ||
    state.backendState !== 'idle' ||
    (state.dancing && state.musicPlaying) ||
    document.body.classList.contains('dragging')
  );
}

/** Asleep on the taskbar: she lies on her side. On a window she stays where she is. */
function lieDownToSleep() {
  const body = stage.body;
  if (!pet || !body || stage.form === 'flame' || body.surface !== 'ground' || !['stand', 'sit'].includes(body.mode)) return;
  state.sleptLying = true;
  pet.requestPosture('side');
}

function getUpFromSleep() {
  if (!pet || !state.sleptLying) return false;
  state.sleptLying = false;
  pet.requestPosture('stand');
  return true;
}

/** The sleep "z"s rise from her head, wherever it is (lying down too). */
const zzz = document.getElementById('zzz');
function updateZzz() {
  const head = stage.asleep ? stage.headScreen() : null;
  zzz.classList.toggle('hidden', !head);
  if (head) zzz.style.transform = `translate(${Math.round(head.x + 12)}px, ${Math.round(head.y - 40)}px)`;
}

/**
 * The speech bubble sits at the top of the window; with the flame, who is
 * small and low, it sits above her, or above the island when the menu is open.
 */
function placeBubble() {
  const bubble = ui.elements.bubble;
  const flame = stage.form === 'flame' && !stage.morphing;
  let above = null;
  if (flame && hud.visible) above = hud.top > 48 ? hud.top - 8 : null;
  else if (flame) above = stage.headScreen()?.y - 14;
  if (Number.isFinite(above)) {
    bubble.style.top = 'auto';
    bubble.style.bottom = `${Math.round(window.innerHeight - above)}px`;
  } else if (bubble.style.bottom) {
    bubble.style.top = '';
    bubble.style.bottom = '';
  }
}

/** Changes form: the flame enters the body or leaves it (see VrmStage.setForm). */
function setForm(form) {
  const next = form === 'flame' ? 'flame' : 'vrm';
  if (!stage.setForm(next, { animate: state.avatarLoaded })) return false;
  writeSetting(FORM_SETTING, next);
  // The menu changes form with her (island or docks): the open one closes.
  hud.hide();
  showForm(next);
  if (state.avatarLoaded) sfx.pop();
  if (next === 'flame' && pet) {
    // Sitting or lying on the taskbar she couldn't sprint: when the switch is
    // over she stands up (on a window she stays seated).
    state.sleptLying = false;
    setTimeout(() => stage.form === 'flame' && pet.requestPosture('stand'), 1300);
  }
  return true;
}

function showForm(form) {
  hud.setForm(form);
  document.body.classList.toggle('flame-form', form === 'flame');
}

/**
 * With or without the body. Without: the flame leaves the body and the VRM is
 * unloaded (and at the next starts it isn't loaded at all). With: the VRM is
 * loaded and the flame enters it, in the requested form.
 */
async function setBody(body, form = 'vrm') {
  const next = body === 'none' ? 'none' : 'vrm';
  state.body = next;
  writeSetting(BODY_SETTING, next);
  hud.setBodiless(next === 'none');
  if (next === 'none') {
    writeSetting(FORM_SETTING, 'flame');
    if (stage.spiritOnly) return;
    // She leaves the body with her animation; the VRM is unloaded at the end (onMorphEnd).
    if (stage.vrm && stage.form === 'vrm' && setForm('flame')) return;
    if (!stage.morphing) {
      stage.useSpirit();
      showForm('flame');
    }
    return;
  }
  if (stage.spiritOnly || !stage.vrm) {
    if (!state.avatarUrl) {
      ui.toast(t('The 3D model is missing: choose it from Character → Look.'), true, 5000);
      return;
    }
    if (!(await loadAvatar(state.avatarUrl, state.avatarUrl.split('/').pop(), { greet: false }))) return;
  }
  if (form === 'vrm') setForm('vrm');
  else {
    writeSetting(FORM_SETTING, 'flame');
    showForm(stage.form);
  }
}

// Leaving the body is over and the body isn't wanted any more: the VRM's memory is freed.
stage.onMorphEnd = (form) => {
  if (form === 'flame' && state.body === 'none' && !stage.spiritOnly) stage.useSpirit();
};

/** She appears: a "pop", then she waves her hand (or the flame her own way) and greets. */
function appear() {
  state.greeted = true;
  sfx.pop();
  setTimeout(() => {
    stage.greet();
    vocals.say(greetingForNow());
  }, 700);
}

/**
 * The sprint starts only if nobody needs her: flame at rest, no voice or
 * thoughts in progress, you at the PC but not in a meeting, full screen, a
 * game or watching a video (the rules of the spontaneous comments).
 */
function sprintAllowed() {
  return (
    stage.form === 'flame' &&
    !stage.morphing &&
    socket.connected &&
    !player.playing &&
    state.backendState === 'idle' &&
    presence.state === 'awake' &&
    state.idleSeconds < SPRINT_MAX_IDLE &&
    !state.activity?.dnd &&
    !state.activity?.watching &&
    !hud.visible &&
    !document.body.classList.contains('listening') &&
    !document.body.classList.contains('dragging')
  );
}

function maybeSprint(now) {
  if (!pet || now < state.nextSprintAt) return;
  if (!sprintAllowed()) {
    state.nextSprintAt = now + SPRINT_RETRY;
    return;
  }
  const [min, max] = SPRINT_EVERY;
  state.nextSprintAt = now + min + Math.random() * (max - min);
  pet.sprint();
}

hud.setMuted(state.muted);
hud.setDancing(state.dancing);

// ---------------------------------------------------------------------------
// Render loop: the only place where the mouth is updated.
// ---------------------------------------------------------------------------
stage.onFrame((dt) => {
  const level = player.update(dt);
  const weights = lipSync.update(player.currentTime, level, dt, player.playing);
  // The body gestures and nods in time with the voice's volume.
  stage.setSpeech(player.playing, level);
  const rhythm = music.update(dt);
  stage.setMusic(rhythm);

  // The island open: the flame slides into her slot in the card.
  stage.setMenu(hud.visible && hud.layout === 'island', hud.flameSlot);
  if (hud.visible) {
    hud.setFrame(stage.hudFrame());
    hud.update({
      voice: level,
      mic: voice.listening ? state.micLevel : 0,
      music: rhythm.active ? Math.max(0, 1 - rhythm.phase * 2.5) * Math.min(1, rhythm.energy * 4) : 0,
    });
  }

  ui.updateDebug({
    viseme: player.playing ? lipSync.activeViseme : 'sil',
    level,
    fps: stage.fps,
    weights,
    driver: stage.mouthDriverLabel,
  });

  updateZzz();
  placeBubble();
  if (pet) {
    updateClickThrough();
    maybeSprint(performance.now());
  }
  return weights;
});
stage.start();

/**
 * Per-pixel click-through: the window is "solid" only where the character
 * really is (alpha of the pixel under the cursor, read from the framebuffer)
 * or where there's a clickable piece of interface (the docks, a notice).
 * Everywhere else the mouse passes through to the windows below.
 */
function updateClickThrough() {
  const { x, y } = stage.pointerPx;
  const overUI = x >= 0 && ui.isOverSolidUI(x, y);
  const wanted = overUI || stage.pointerOnAvatar;
  if (wanted) hud.touch();

  if (window.__petDebug) {
    const now = performance.now();
    if (now - (state.lastDebugLog || 0) > 700) {
      state.lastDebugLog = now;
      console.log(
        `[pet] cursor=(${Math.round(x)},${Math.round(y)}) alpha=${stage.lastAlpha?.toFixed(2)} ` +
          `onAvatar=${stage.pointerOnAvatar} onUI=${overUI} -> interactive=${wanted}`,
      );
    }
  }

  if (wanted === state.interactive) return;
  state.interactive = wanted;
  pet.setInteractive(wanted);
}

// ---------------------------------------------------------------------------
// Loading the avatar
// ---------------------------------------------------------------------------
async function loadAvatar(url, label, { greet = true } = {}) {
  ui.showOverlay(t('Loading {name}…', { name: label }));
  try {
    await stage.load(url, (progress) => ui.showOverlay(t('Loading {name}… {percent}%', { name: label, percent: Math.round(progress * 100) })));
    state.avatarLoaded = true;
    ui.hideOverlay();
    // As soon as she appears she greets: with her hand and her voice, fitting the hour.
    if (greet) appear();
    if (stage.mouthDriver.kind === 'none') {
      ui.toast(t("The model has no mouth blendshapes: no lip-sync."), true, 6000);
    }
    return true;
  } catch (error) {
    console.error(error);
    ui.showOverlay(
      t("I can't load the 3D model"),
      t('{error}. Copy an avatar.vrm file into frontend/public/models/ or drop a .vrm here.', { error: error.message || error }),
      true,
    );
    return false;
  }
}

ui.onModelFile = async (file) => {
  const url = URL.createObjectURL(file);
  const ok = await loadAvatar(url, file.name);
  // A model chosen on purpose: it means the body is wanted.
  if (ok && state.body === 'none') {
    state.body = 'vrm';
    writeSetting(BODY_SETTING, 'vrm');
    hud.setBodiless(false);
    setForm('vrm');
  }
  // The blob stays referenced by the textures while the model is on stage:
  // we revoke it only if loading failed.
  if (!ok) URL.revokeObjectURL(url);
};

// ---------------------------------------------------------------------------
// Interface -> backend
// ---------------------------------------------------------------------------
ui.onSend = async (text) => {
  await player.resume(); // unlock the audio at the user's first gesture
  socket.chat(text);
};

ui.onStop = () => stopSpeaking(true);

ui.onEscape = () => {
  if (!hud.visible) return false;
  hud.hide();
  return true;
};

ui.onContextMenu = () => toggleMenu();
// The open island widens the window around her (electron/main.js,
// setIslandWide); near the edge on one side only, and the framing shifts so
// she stays where she was.
hud.onIslandShape = (open) => pet?.setIslandWide?.(open) ?? null;
hud.locate = () => stage.hudFrame();
pet?.onFrameShift?.(({ shift }) => stage.setFrameShift(shift));

/** The right-click menu: it starts from where she is now (the island grows from her centre). */
function toggleMenu(open = !hud.visible) {
  if (!open) {
    hud.hide();
    return;
  }
  if (stage.morphing) return;
  hud.setFrame(stage.hudFrame());
  hud.show();
}

/** The flame's colour: her, and her card's halo in the island. */
function setFlameColor(name) {
  stage.setFlamePalette(name);
  hud.setTint(stage.flame.colors.accent);
  hud.setWardrobe(readSetting(OUTFIT_SETTING, 'auto'), name);
}

/** What she wears: the saved choice, with "auto" resolved for today. */
function setFlameOutfit() {
  const selection = readSetting(OUTFIT_SETTING, 'auto');
  stage.setFlameOutfit(resolveOutfit(selection));
  hud.setWardrobe(selection, readSetting(COLOR_SETTING, 'lilac'));
}

function stopSpeaking(tellBackend) {
  player.stop();
  lipSync.clear();
  ui.hideBubble();
  if (tellBackend) socket.cancel();
}

function setMuted(muted) {
  state.muted = Boolean(muted);
  writeSetting('dc:muted', state.muted);
  hud.setMuted(state.muted);
  if (state.muted) stopSpeaking(false);
}

// The menu: what each button does.
hud.onAction = async (id, detail) => {
  switch (id) {
    case 'agent':
      openPanel({ tab: 'engines', section: 'llm' });
      break;
    case 'voice':
      setMuted(!state.muted);
      socket.send({ type: 'settings', muted: state.muted });
      ui.toast(state.muted ? t('Voice off: she answers only in writing.') : t('Voice on.'));
      break;
    case 'mic':
      if (!state.voiceAvailable) {
        openPanel({ tab: 'engines', section: 'stt' });
        ui.toast(t('Choose a listening engine first.'));
        break;
      }
      await pushToggle();
      break;
    case 'music':
      setDancing(!state.dancing);
      ui.toast(state.dancing ? t('Dancing to Spotify.') : t('No dancing.'));
      break;
    case 'form':
      if (state.body === 'none') setBody('vrm');
      else setForm(stage.form === 'flame' ? 'vrm' : 'flame');
      break;
    case 'usage':
      openPanel({ tab: 'work' });
      break;
    // The island's wardrobe: it changes and she sees it fall onto her head.
    case 'outfit':
      writeSetting(OUTFIT_SETTING, detail);
      setFlameOutfit();
      break;
    // A click on her inside the island: a pat.
    case 'flame':
      stage.play('pat');
      vocals.say('pat');
      break;
    case 'dashboard':
      if (pet?.openDashboard) pet.openDashboard();
      else window.open('./dashboard.html', '_self');
      break;
    case 'chat':
    case 'character':
    case 'engines':
      if (pet) pet.togglePanel({ tab: id });
      else if (id === 'chat') ui.openComposer();
      else openPanel({ tab: id });
      break;
    case 'power':
      if (pet) pet.quit();
      else hud.hide();
      break;
    default:
      break;
  }
};

function openPanel(focus) {
  if (pet) pet.openPanel(focus);
  else window.open(`./panel.html#${focus.tab}`, 'tsukumo-panel', 'width=420,height=640');
}

// ---------------------------------------------------------------------------
// Backend -> interface
// ---------------------------------------------------------------------------
/**
 * The state shown depends on TWO things: what the backend is doing and
 * whether there's still audio in the queue. The backend says "idle" as soon
 * as it has finished synthesizing, but the character keeps speaking for a
 * few seconds.
 */
function refreshStatus() {
  if (!socket.connected) {
    hud.setBusy('idle');
    return;
  }
  if (player.playing) hud.setBusy('speaking');
  else hud.setBusy(state.backendState === 'thinking' ? 'thinking' : 'idle');
}

socket.on('open', () => {
  refreshStatus();
  // Only the character's window in Electron can take screenshots.
  if (pet?.captureScreen) socket.send({ type: 'capabilities', screen: true });
});

/** Screenshot and the same message, with the file attached ("look at the screen"). */
async function lookAtScreen(text = '') {
  if (!pet?.captureScreen) return;
  try {
    const file = await pet.captureScreen();
    stage.play('lookAround');
    socket.send({ type: 'chat', text, files: [file], screen: true });
  } catch (error) {
    ui.toast(t("I can't see the screen: {error}", { error: error.message }), true, 4000);
  }
}

// The backend understood "look at the screen": we take the screenshot here.
socket.on('capture', (message) => lookAtScreen(message.text ?? ''));

socket.on('close', () => {
  state.backendState = 'idle';
  stage.setThinking(false);
  refreshStatus();
  // Without the backend we know nothing about the engines any more: better
  // the grey "don't know" than leaving a lying green on.
  hud.setEngines(null);
  if (!state.avatarLoaded) ui.showOverlay(t('Waiting for the backend…'), t("I'll retry by myself, nothing to do."));
});

socket.on('hello', (message) => {
  refreshStatus();
  const config = message.config ?? {};
  if (message.context) state.activity = message.context.activity ?? null;
  // .vrma clips from the animations folder (see clips.js).
  stage.setClipList(message.animations ?? []).then((loaded) => {
    if (loaded?.length) console.info(`[clips] ${loaded.length} animations:`, loaded.map((clip) => clip.name).join(', '));
  });
  hud.setEngines(message.engines);
  state.usage = message.usage ?? null;
  hud.setUsage(state.usage, message.engines?.llm?.id);
  voice.setWakeWord(config.wakeWord ?? 'companion');
  voice.interruptOnSpeech = config.voiceInterrupt !== false;
  voice.mode = config.voiceMode ?? 'push';
  // The microphone doesn't open by itself: it needs a user gesture, both for
  // the browser's permission and because turning on the microphone behind
  // your back would be unpleasant. The docks, the panel and push-to-talk turn
  // it on.
  state.voiceAvailable = (config.sttEngine ?? 'none') !== 'none';
  reportVoice();

  // The mute chosen here holds after a backend restart too.
  if (Boolean(config.muted) !== state.muted) socket.send({ type: 'settings', muted: state.muted });

  if (message.blendshapes) {
    stage.blendshapes = { ...DEFAULT_BLENDSHAPES, ...message.blendshapes };
  }
  const avatar = message.avatar?.default;
  if (avatar) state.avatarUrl = apiUrl(avatar);
  if (state.body === 'none') {
    // Without a body there's nothing to load: she appears as soon as the backend answers.
    ui.hideOverlay();
    if (!state.greeted) appear();
  } else if (!state.avatarLoaded) {
    if (avatar) {
      loadAvatar(apiUrl(avatar), avatar.split('/').pop());
    } else {
      ui.showOverlay(
        t('The 3D model is missing'),
        t('Copy an avatar.vrm file into frontend/public/models/, or drop a .vrm on this window. You can create one for free with VRoid Studio.'),
        true,
      );
    }
  }
});

// The gesture that goes with a spontaneous comment (yawn, shivers, fanning herself...).
socket.on('gesture', (message) => {
  if (!player.playing || message.name === 'yawn') stage.play(message.name);
});

/**
 * She calls you: chime, Windows notification and a gesture. If it's a
 * finished job the flame celebrates (jump with a twirl and stars); if it's
 * waiting for you, or with the body, she knocks on the glass (the flame hops
 * with the "!").
 */
function callUser(title, body, { done = false } = {}) {
  presence.touch();
  sfx.chime();
  const celebrated = done && stage.form === 'flame' && stage.play('cheer');
  if (!celebrated) {
    if (stage.play('knock')) setTimeout(() => sfx.knock(), 520);
    else stage.play('wave');
  }
  pet?.notify?.(title, body);
}

// An agent you use on your own (Claude Code, Codex) is done or waiting for you.
socket.on('notify', (message) => {
  const waiting = message.kind === 'waiting';
  const title = waiting ? t('{name} is waiting for you', { name: message.title }) : t('{name} is done', { name: message.title });
  if (message.silent) {
    pet?.notify?.(title, message.message ?? '');
  } else if (message.quiet) {
    ui.showBubble(`${title} ✓`, 3000);
    if (!waiting) stage.play('hop');
  } else {
    callUser(title, message.message ?? '', { done: !waiting });
  }
});

// One of her replies that took long (an agent at work): when it arrives she calls you.
const LONG_TURN_MS = 25_000;
const turnWatch = { since: 0, called: false };
socket.on('state', (message) => {
  if (message.value === 'thinking') {
    turnWatch.since = performance.now();
    turnWatch.called = false;
  }
});
socket.on('speech', (message) => {
  if (turnWatch.called || !turnWatch.since || message.vocal || message.index !== 0) return;
  turnWatch.called = true;
  const waited = performance.now() - turnWatch.since;
  if (waited > LONG_TURN_MS && state.activity?.kind !== 'tsukumo') callUser('Tsukumo', message.text ?? t("I'm done!"), { done: true });
});

// A reminder or a timer went off: chime, knock on the glass, notification.
socket.on('reminder', (message) => {
  if (message.event !== 'fired') return;
  // The knock-knock comes when the fist touches the glass (see the knock action).
  callUser('Tsukumo', message.reminder?.label ?? t('Reminder'));
});

// What the user is doing at the PC (see backend/context.py): watching a video, in a meeting...
socket.on('context', (message) => {
  state.activity = message.activity ?? null;
});

socket.on('engines', (message) => {
  hud.setEngines(message);
  state.voiceAvailable = (message.stt?.state ?? 'off') !== 'off';
  reportVoice();
  hud.setUsage(state.usage, message?.llm?.id);
});

// How much Claude Code and Codex have used (backend/usage.py): the ring in the left dock.
socket.on('usage', (message) => {
  state.usage = message;
  hud.setUsage(message, hud.engines?.llm?.id);
});

socket.on('settings', (message) => {
  if (typeof message.muted === 'boolean' && message.muted !== state.muted) setMuted(message.muted);
});

socket.on('state', (message) => {
  state.backendState = message.value;
  stage.setThinking(message.value === 'thinking');
  syncVoiceState();
  refreshStatus();
});

/**
 * The microphone must know when the character speaks, or it hears itself.
 * What counts is the audio playing, not just the backend's state: the
 * backend goes back to "idle" as soon as it has synthesized the last
 * sentence, while she's still saying it.
 */
function syncVoiceState() {
  voice.setCompanionState(player.playing || state.backendState === 'speaking' ? 'speaking' : state.backendState);
}

// What she understood: always showing it, even when she misunderstood,
// avoids guessing the reason for a strange reply.
socket.on('transcript', (message) => {
  const text = (message.text ?? '').trim();
  if (!text) return;
  voice.handleTranscript(text, Boolean(message.echo));
  // Her own voice coming back from the microphone (see pipeline.is_echo): no bubble.
  if (!message.echo) ui.showBubble(`« ${text} »`, 2500);
});

// You thank her: a small bow (if there's a bow/inchino clip).
const THANKS = /\b(grazie|thanks|thank you|thx|arigat[oō]|merci|danke|gracias|obrigad[oa])\b/i;
socket.on('user', (message) => {
  if (THANKS.test(message.text ?? '')) stage.playClipRole('bow');
});

// A sentence ready to be spoken: WAV + viseme timeline.
socket.on('speech', (message) => {
  // "One moment, I'm working on it" is a vocal: silent if vocals are off.
  if (message.vocal && !vocals.enabled) return;
  if (!state.muted) player.enqueue(message);
});

// The agent is using a tool: work pose and, while it's quiet, the bubble with the step.
socket.on('working', (message) => {
  stage.setWorking(message.kind);
  const label = tx(message.label) ?? '';
  // The turn's steps, for the island's card (done, in progress).
  hud.setWorking(label);
  if (label && !player.playing) ui.showBubble(`${label.charAt(0).toUpperCase()}${label.slice(1)}…`, 8000);
});

// A sentence without audio (muted, or broken voice): the bubble is enough.
socket.on('caption', (message) => {
  if (message.text) ui.showBubble(message.text, Math.min(9000, 1800 + message.text.length * 55));
});

socket.on('reply', (message) => {
  // The bubble already shows the single sentences while she speaks them:
  // here it's only needed for replies that aren't read (e.g. if audio is blocked).
  if (message.text && !player.playing && !message.failed) ui.showBubble(message.text, 6000);
});

socket.on('notice', (message) => ui.toast(message?.message ?? ''));

socket.on('error', (message) => {
  ui.toast(message?.message ?? t('Unknown error'), true, 7000);
  refreshStatus();
});

socket.on('cancel', () => {
  stage.setThinking(false);
  stopSpeaking(false);
});

// ---------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------
let musicStopTimer = null;
function syncMusic() {
  hud.setMusic(state.musicPlaying);
  const wanted = state.musicPlaying && state.dancing;
  if (wanted) {
    clearTimeout(musicStopTimer);
    musicStopTimer = null;
    if (!music.running) {
      music.start().catch((error) => console.error('[pet] audio capture unavailable:', error.message));
    }
  } else if (music.running && !musicStopTimer) {
    // Between one track and the next the title disappears for a moment: we
    // wait a bit before turning off the capture.
    musicStopTimer = setTimeout(() => {
      musicStopTimer = null;
      music.stop();
    }, 4000);
  }
}

function setDancing(value) {
  state.dancing = Boolean(value);
  hud.setDancing(state.dancing);
  writeSetting('dc:dance', state.dancing);
  stage.setDancing(state.dancing);
  syncMusic();
}

// ---------------------------------------------------------------------------
// Voice: push-to-talk
// ---------------------------------------------------------------------------
// Two ways, because Electron can't tell when a global shortcut is
// *released*: from outside the key works as a toggle, inside the window we
// use real keydown/keyup and press-and-hold really works.
let pushHeld = false;

function reportVoice() {
  const snapshot = { available: state.voiceAvailable, enabled: voice.listening, mode: voice.mode, held: pushHeld };
  hud.setMic({ available: state.voiceAvailable, enabled: voice.listening && (voice.mode !== 'push' || pushHeld) });
  pet?.setVoiceState(snapshot);
}

async function pushToggle() {
  if (!state.voiceAvailable) {
    ui.showBubble(t('Speech recognition is not active'), 3000);
    return;
  }
  await player.resume();
  if (!voice.listening && !(await voice.enable({ mode: voice.mode }))) return;

  if (voice.mode !== 'push') {
    // In the other modes the microphone is already open: the key turns it on and off.
    voice.disable();
    pushHeld = false;
    reportVoice();
    return;
  }
  pushHeld = !pushHeld;
  if (pushHeld) voice.pushStart();
  else voice.pushEnd();
  reportVoice();
}

window.companion?.onPushToTalk?.(({ action }) => {
  if (action === 'toggle') pushToggle();
});

// Press and hold, when the window has focus. `repeat` must be ignored or the
// long press would restart the recording at every repeat.
window.addEventListener('keydown', async (event) => {
  if (event.code !== 'Space' || !event.ctrlKey || event.repeat) return;
  if (!state.voiceAvailable || voice.mode !== 'push') return;
  event.preventDefault();
  if (!voice.listening && !(await voice.enable({ mode: 'push' }))) return;
  pushHeld = true;
  voice.pushStart();
  reportVoice();
});

window.addEventListener('keyup', (event) => {
  if (event.code !== 'Space' || !pushHeld) return;
  event.preventDefault();
  pushHeld = false;
  voice.pushEnd();
  reportVoice();
});

// ---------------------------------------------------------------------------
// Mascot mode (Electron only)
// ---------------------------------------------------------------------------
if (pet) {
  window.__petDebug = new URLSearchParams(location.search).has('petdebug');
  document.body.classList.add('pet-mode');
  // Full figure: the right look for a desktop mascot.
  stage.setFraming('full');
  // Dragging moves the window, it doesn't rotate the camera.
  stage.dragEnabled = false;
  stage.setSpontaneous(readSetting('dc:spontaneous', true));
  stage.setStance(readSetting('dc:stance', 'standard'));
  stage.setDancing(state.dancing);

  pet.onMusic((status) => {
    state.musicPlaying = Boolean(status?.playing);
    syncMusic();
  });
  pet.getState().then((initial) => {
    state.musicPlaying = Boolean(initial?.music?.playing);
    syncMusic();
    hud.setActiveTab(initial?.panelVisible ? initial.panelTab : null);
  });
  pet.onPetState((current) => hud.setActiveTab(current?.panelVisible ? current.panelTab : null));

  // Chat and settings live in the panel, detached from the character.
  // Double click (or starting to type) opens the chat.
  ui.onOpenChat = (text) => pet.openPanel({ tab: 'chat', text });

  // The wheel makes her bigger: it changes the window, not the camera.
  stage.onWheelScale = (factor) => pet.scaleBy(factor);
  // Where feet and seat are in the window: needed to set her down.
  stage.onAnchors = (anchors) => pet.setAnchors(anchors);
  // Now and then she sits or lies down on the taskbar: Electron moves the window.
  stage.onPostureRequest = (posture) => pet.requestPosture(posture);

  // Grab her with the mouse: she's lifted by the scruff and dangles. A click
  // without dragging is a touch (pat on the head, poke on the body).
  let drag = null;
  ui.elements.stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !stage.pointerOnAvatar) return;
    drag = {
      origin: null,
      screenX: event.screenX,
      screenY: event.screenY,
      clientX: event.clientX,
      clientY: event.clientY,
      dx: 0,
      dy: 0,
      moved: false,
      offset: { x: 0, y: 0 },
      startedAt: 0,
      /** Last positions of the window: at the end they tell how fast you threw her. */
      samples: [],
    };
    ui.elements.stage.setPointerCapture?.(event.pointerId);
  });

  /**
   * The window's speed in the last 100 ms (px/s), to throw the flame. Below a
   * certain speed it's just letting her go: null.
   */
  function releaseVelocity(samples) {
    const now = performance.now();
    const recent = samples.filter((sample) => now - sample.at < 100);
    if (recent.length < 2) return null;
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dt = Math.max(16, last.at - first.at) / 1000;
    const vx = (last.x - first.x) / dt;
    const vy = (last.y - first.y) / dt;
    return Math.hypot(vx, vy) > 650 ? { vx, vy } : null;
  }

  window.addEventListener('pointermove', (event) => {
    if (!drag) return;
    drag.dx = event.screenX - drag.screenX;
    drag.dy = event.screenY - drag.screenY;
    if (drag.moved || Math.abs(drag.dx) + Math.abs(drag.dy) <= 4) return;

    // The grab starts only when the mouse really moves: a simple click must not
    // make anyone fall or stand up.
    const current = drag;
    current.moved = true;
    current.startedAt = performance.now();
    current.offset = stage.beginHold(current.clientX, current.clientY);
    document.body.classList.add('dragging');
    presence.touch();
    vocals.say('lift');
    hud.hide();
    pet.dragStart().then((origin) => {
      current.origin = origin;
      requestAnimationFrame(() => dragFrame(current));
    });
  });

  // The window follows the cursor every frame; in the first moments it slides
  // until the scruff is under the pointer ("picked up with tongs").
  function dragFrame(current) {
    if (drag !== current) return;
    const snap = Math.min(1, (performance.now() - current.startedAt) / 180);
    const k = snap * snap * (3 - 2 * snap);
    const x = Math.round(current.origin.x + current.dx + current.offset.x * k);
    const y = Math.round(current.origin.y + current.dy + current.offset.y * k);
    pet.dragMove(x, y);
    stage.moveHold(x, y);
    current.samples.push({ x, y, at: performance.now() });
    if (current.samples.length > 12) current.samples.shift();
    requestAnimationFrame(() => dragFrame(current));
  }

  window.addEventListener('pointerup', (event) => {
    if (!drag) return;
    const finished = drag;
    drag = null;
    document.body.classList.remove('dragging');
    if (finished.moved) {
      // The flame is thrown (like Blobby): she flies, hits the edges, lands. The body just falls.
      pet.dragEnd(stage.form === 'flame' && !stage.morphing ? releaseVelocity(finished.samples) : null);
      stage.endHold();
      state.droppedAt = performance.now();
    } else {
      presence.touch();
      const streak = pokeStreak();
      if (streak && stage.play(streak)) {
        pokes.length = 0;
        if (streak === 'dizzy') sfx.blip(false);
        vocals.say(streak);
        return;
      }
      const reaction = stage.poke(event.clientX, event.clientY);
      if (reaction) vocals.say(HAPPY_POKES.has(reaction) ? 'pat' : 'poke');
    }
  });

  // The main process decides where she is: falls, lands on the taskbar or on
  // a window, sits, clings to the edge, travels with the window.
  pet.onMotion((motion) => {
    switch (motion.state) {
      case 'falling':
        stage.setFalling();
        if (motion.thrown) stage.flyStart(motion.vx);
        // "Waah!" only if you threw her, not when she falls at startup.
        if (performance.now() - state.droppedAt < 1500) vocals.say('fall');
        break;
      // Thrown: where the window got to (the trail stays behind) and the bumps on the edges.
      case 'fly':
        stage.flyMove(motion.x, motion.y);
        break;
      case 'bonk':
        stage.bonk(motion.side, motion.impact);
        sfx.thud(Math.min(1, motion.impact * 0.7));
        break;
      case 'landed':
        stage.landed(motion.impact, motion.posture);
        if (motion.impact > 0.15) sfx.thud(motion.impact);
        break;
      case 'posture':
        stage.setPosture(motion.posture);
        break;
      case 'edge':
        stage.setEdge(motion.side, motion.edge);
        break;
      case 'carried':
        stage.carried(motion.x, motion.y);
        break;
      // The flame's sprint: the phases and, while she runs, where the window got to.
      case 'sprint':
        stage.setSprint(motion.phase, motion.dir);
        if (motion.phase === 'ready') {
          presence.touch();
          hud.hide();
        }
        break;
      case 'sprint-move':
        stage.sprintMove(motion.x, motion.speed);
        break;
      default:
        break;
    }
  });

  // The cursor position comes from the main process, not from DOM events: in
  // click-through the page receives none (see pushCursorPosition). It comes
  // even when it's outside the window, and the gaze follows it.
  pet.onCursor(({ x, y, inside }) => {
    stage.setPointer(x, y, inside);
    trackSpin(x, y);
  });

  // How long the PC has been idle, screen lock and unlock: sleep and waking up.
  pet.onPresence?.((message) => {
    if (typeof message?.idle === 'number') state.idleSeconds = message.idle;
    presence.update(message, busyForSleep());
  });

  // Commands from the panel.
  pet.onCommand((command) => {
    switch (command?.type) {
      case 'gain':
        lipSync.gain = Number(command.value);
        break;
      case 'debug':
        ui.setDebugVisible(Boolean(command.value));
        break;
      case 'spontaneous':
        stage.setSpontaneous(command.value);
        break;
      case 'dance':
        setDancing(command.value);
        break;
      case 'vocals':
        vocals.setEnabled(command.value);
        break;
      case 'sfx':
        sfx.setEnabled(command.value);
        break;
      case 'look-screen':
        lookAtScreen();
        break;
      case 'play-clip':
        stage.playClip(command.name);
        break;
      case 'sleep':
        presence.setEnabled(command.value);
        break;
      case 'sleep-times':
        presence.setTimes(command.drowsy, command.asleep);
        break;
      case 'play':
        stage.play(command.name, { sign: command.sign });
        break;
      case 'form':
        // 'spirit' = without a body (from the introduction or from Character -> Look).
        if (command.value === 'spirit') setBody('none');
        else if (state.body === 'none') setBody('vrm', command.value);
        // Still changing: she stays as she is, and the panel goes back to telling the truth.
        else if (!setForm(command.value) && command.value !== stage.form) writeSetting(FORM_SETTING, stage.form);
        break;
      case 'sprint':
        // From the panel: right away, if she's the flame and standing on the taskbar.
        if (stage.form !== 'flame') ui.toast(t('Sprints are done by the flame: change form from the panel.'));
        else pet.sprint(command.kind).then((ok) => ok || ui.toast(t('She can only sprint when she is down on the taskbar.')));
        break;
      case 'greet':
        stage.greet();
        break;
      case 'posture':
        pet.requestPosture(command.value);
        break;
      case 'mic':
        pushToggle();
        break;
      case 'mic-device':
        voice.setDevice(command.value).then(reportVoice);
        break;
      case 'mic-test':
        voice.setPaused(command.value);
        break;
      case 'barge-in':
        voice.setBargeIn(command.value);
        break;
      case 'stance':
        writeSetting('dc:stance', command.value);
        stage.setStance(command.value);
        break;
      case 'flame-color':
        writeSetting(COLOR_SETTING, command.value);
        setFlameColor(command.value);
        if (stage.form === 'flame') stage.play('flare');
        break;
      // Writing in the panel's or the dashboard's chat: she watches you, attentive.
      case 'typing':
        stage.userTyping();
        break;
      case 'flame-outfit':
        writeSetting(OUTFIT_SETTING, command.value);
        setFlameOutfit();
        break;
      case 'hud':
        toggleMenu(true);
        break;
      case 'stop':
        stopSpeaking(true);
        break;
      default:
        break;
    }
  });

  // A model chosen from the panel arrives as binary data.
  pet.onModel(({ name, data }) => {
    ui.onModelFile(new File([data], name));
  });
} else {
  // In the browser the background is given by the page, not the canvas: the
  // canvas stays transparent because under it there's the menu island, which
  // she's drawn on.
  document.body.classList.add('opaque-bg');
  stage.setDancing(state.dancing);
}

// A file dragged onto her: the flame opens her mouth, then eats it (like
// Mochi swallowing it) and passes it to the brain.
if (pet) {
  let hungryTimer = null;
  const stopHungry = () => {
    clearTimeout(hungryTimer);
    stage.setHungry(false);
    document.body.classList.remove('drop-target');
  };
  window.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    document.body.classList.add('drop-target');
    stage.setHungry(true);
    // dragleave arrives even moving from one element to another: the silence of the dragovers counts.
    clearTimeout(hungryTimer);
    hungryTimer = setTimeout(stopHungry, 300);
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    stopHungry();
    const files = [...(event.dataTransfer?.files ?? [])].map((file) => pet.pathForFile?.(file)).filter(Boolean);
    if (!files.length) return;
    presence.touch();
    if (!stage.play('gulp')) stage.play('pat');
    vocals.say('pat');
    socket.send({ type: 'chat', text: '', files });
  });
}

// Audio needs a user gesture: the first click/key unlocks the context.
const unlock = () => {
  player.resume().catch(() => {});
  window.removeEventListener('pointerdown', unlock);
  window.removeEventListener('keydown', unlock);
};
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

ui.showOverlay(t('Tsukumo is waking up…'));
socket.connect();

// First start: a hint, then silence.
setTimeout(() => {
  if (state.avatarLoaded && !readSetting('dc:hint-seen', false)) {
    writeSetting('dc:hint-seen', true);
    ui.toast(pet ? t('Right-click on her for the commands, double click to write to her.') : t('Right-click for the commands.'), false, 6000);
  }
}, 2500);

// Handy to inspect the state from the console.
window.deskCompanion = { stage, player, lipSync, socket, ui, hud, state, pet, voice, pushToggle, vocals, presence, sfx, setForm, setBody };
