/**
 * Punto di ingresso della finestra del personaggio.
 *
 * Mette insieme i pezzi:
 *
 *   WebSocket  ->  SpeechPlayer  ->  LipSync  ->  VrmStage
 *   (backend)      (WebAudio)        (pesi)       (blendshape)
 *
 * Il backend manda un messaggio `speech` per ogni frase: WAV in base64 +
 * timeline dei visemi. Il player lo suona e misura il volume istantaneo,
 * LipSync combina timeline e volume, VrmStage scrive i pesi sulle blendshape
 * della bocca a ogni frame.
 *
 * In Electron c'e' in piu' il comportamento da mascotte: click-through per
 * pixel, lo prendi in mano e lo sposti (penzola, poi cade e atterra), reagisce
 * quando lo tocchi, e col tasto destro apre i dock ai suoi lati (hud.js).
 *
 * Due forme: il VRM oppure la fiammella (flame.js), la sua anima, che ogni
 * tanto fa uno sprint lungo la barra delle applicazioni. E chi non vuole il
 * corpo (lo si sceglie al primo avvio) tiene solo la fiammella: il VRM allora
 * non si carica nemmeno.
 */

import { apiUrl, DEFAULT_BLENDSHAPES, wsUrl } from './config.js';
import { SpeechPlayer } from './audio.js';
import { readSetting, writeSetting } from './dom.js';
import { Hud } from './hud.js';
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

/** La forma scelta: 'vrm' o 'flame'. La legge anche il pannello (stessa origine). */
const FORM_SETTING = 'dc:form';
/** Con il corpo ('vrm') o senza ('none': solo la fiammella, il VRM non si carica). */
const BODY_SETTING = 'dc:body';

/** Ogni quanto la fiammella fa uno sprint, se niente la trattiene (ms). */
const SPRINT_EVERY = [4 * 60_000, 9 * 60_000];
/** Al momento buono non si puo' (sta parlando, sei in riunione...): riprova tra poco. */
const SPRINT_RETRY = 45_000;
/** Solo se sei al PC: nessuno la vede correre se sei via da piu' di tanto (s). */
const SPRINT_MAX_IDLE = 90;

const ui = new UI();
const hud = new Hud(ui.elements.hud);
const stage = new VrmStage(document.getElementById('stage'));
const bodiless = readSetting(BODY_SETTING, 'vrm') === 'none';
// Senza corpo la fiammella c'e' subito, anche prima del backend: niente modello da scaricare.
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
    // Una risposta vera la sveglia; un suo versetto no.
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

/** Stato locale, tenuto volutamente minimo. */
const state = {
  /** C'e' qualcosa sul palco: il VRM caricato, o la fiammella da sola. */
  avatarLoaded: bodiless,
  /** 'vrm' o 'none' (vedi BODY_SETTING). */
  body: bodiless ? 'none' : 'vrm',
  /** Il modello di default dal backend: serve per ridarle il corpo. */
  avatarUrl: null,
  /** Ha gia' salutato comparendo (senza corpo succede al primo contatto col backend). */
  greeted: false,
  /** Consumi degli agenti dal backend (messaggio `usage`), per l'anello del HUD. */
  usage: null,
  backendState: 'idle',
  /** Ultimo valore inviato a Electron per il click-through. */
  interactive: null,
  voiceAvailable: false,
  muted: readSetting('dc:muted', false),
  micLevel: 0,
  dancing: readSetting('dc:dance', true),
  musicPlaying: false,
  /** Si e' stesa per dormire: al risveglio si rialza. */
  sleptLying: false,
  /** Quando e' finito l'ultimo trascinamento: se cade subito dopo, l'hai lanciata. */
  droppedAt: -Infinity,
  /** Attivita' dell'utente dal backend: `{kind, label, detail, dnd, watching}`. */
  activity: null,
  /** Da quanti secondi nessuno tocca mouse e tastiera (da Electron). */
  idleSeconds: 0,
  /** Quando potra' fare il prossimo sprint (performance.now()). */
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
    // L'hai chiamata per nome: alza la mano, "eccomi".
    if (event.type === 'summoned') stage.playClipRole('here');
  },
});

/** Ritmo della musica di Spotify, ascoltando l'audio di sistema (solo Electron). */
const music = new MusicListener();

/** Pop, tonfo, campanello, toc-toc: sintetizzati, mai sopra la bocca (vedi sfx.js). */
const sfx = new Sfx({ isMuted: () => state.muted });

/** "Hii!" quando saluta, "Ehehe!" a una carezza: con la voce scelta (vedi vocals.js). */
const vocals = new Vocals({
  player,
  isQuiet: () => state.muted || player.playing || state.backendState !== 'idle',
});

/** Il PC e' fermo: si assopisce, poi dorme; quando torni ti saluta (vedi presence.js). */
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
 * Giri del cursore intorno alla testa: tre giri veloci e le gira la testa.
 * L'angolo accumulato si scarica da solo, quindi conta solo se e' rapido.
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

/** Troppi colpetti di fila (5 in 6 secondi): si offende. */
const pokes = [];
function tooManyPokes() {
  const now = performance.now();
  pokes.push(now);
  while (pokes.length && now - pokes[0] > 6000) pokes.shift();
  return pokes.length >= 5;
}

/** Sta facendo qualcosa lei, o l'utente sta guardando un video: niente sonno. */
function busyForSleep() {
  return (
    Boolean(state.activity?.watching) ||
    player.playing ||
    state.backendState !== 'idle' ||
    (state.dancing && state.musicPlaying) ||
    document.body.classList.contains('dragging')
  );
}

/** Addormentata sulla barra: si stende sul fianco. Su una finestra resta dov'e'. */
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

/** Le "zeta" del sonno salgono dalla testa, ovunque sia (anche sdraiata). */
const zzz = document.getElementById('zzz');
function updateZzz() {
  const head = stage.asleep ? stage.headScreen() : null;
  zzz.classList.toggle('hidden', !head);
  if (head) zzz.style.transform = `translate(${Math.round(head.x + 12)}px, ${Math.round(head.y - 40)}px)`;
}

/** Il fumetto sta in cima alla finestra; con la fiammella, che e' piccola e bassa, le sta sopra. */
function placeBubble() {
  const bubble = ui.elements.bubble;
  const tip = stage.form === 'flame' && !stage.morphing ? stage.headScreen() : null;
  if (tip) {
    bubble.style.top = 'auto';
    bubble.style.bottom = `${Math.round(window.innerHeight - tip.y + 14)}px`;
  } else if (bubble.style.bottom) {
    bubble.style.top = '';
    bubble.style.bottom = '';
  }
}

/** Cambia forma: la fiammella entra nel corpo o ne esce (vedi VrmStage.setForm). */
function setForm(form) {
  const next = form === 'flame' ? 'flame' : 'vrm';
  if (!stage.setForm(next, { animate: state.avatarLoaded })) return false;
  writeSetting(FORM_SETTING, next);
  showForm(next);
  if (state.avatarLoaded) sfx.pop();
  if (next === 'flame' && pet) {
    // Seduta o stesa sulla barra non potrebbe fare gli sprint: finito il
    // passaggio si rimette dritta (su una finestra resta seduta).
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
 * Con o senza corpo. Senza: la fiammella esce dal corpo e il VRM si scarica
 * (e ai prossimi avvii non si carica proprio). Con: il VRM si carica e la
 * fiammella ci entra, nella forma chiesta.
 */
async function setBody(body, form = 'vrm') {
  const next = body === 'none' ? 'none' : 'vrm';
  state.body = next;
  writeSetting(BODY_SETTING, next);
  hud.setBodiless(next === 'none');
  if (next === 'none') {
    writeSetting(FORM_SETTING, 'flame');
    if (stage.spiritOnly) return;
    // Esce dal corpo con la sua animazione; il VRM si scarica alla fine (onMorphEnd).
    if (stage.vrm && stage.form === 'vrm' && setForm('flame')) return;
    if (!stage.morphing) {
      stage.useSpirit();
      showForm('flame');
    }
    return;
  }
  if (stage.spiritOnly || !stage.vrm) {
    if (!state.avatarUrl) {
      ui.toast('Manca il modello 3D: sceglilo da Personaggio → Aspetto.', true, 5000);
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

// Uscita dal corpo finita e il corpo non lo vuole piu': si libera la memoria del VRM.
stage.onMorphEnd = (form) => {
  if (form === 'flame' && state.body === 'none' && !stage.spiritOnly) stage.useSpirit();
};

/** Compare: un "pop", poi saluta con la mano (o la fiammella a modo suo) e con la voce. */
function appear() {
  state.greeted = true;
  sfx.pop();
  setTimeout(() => {
    stage.greet();
    vocals.say(greetingForNow());
  }, 700);
}

/**
 * Lo sprint parte solo se nessuno ne ha bisogno: fiammella a riposo, niente
 * voce ne' pensieri in corso, tu al PC ma non in riunione, a schermo intero,
 * in un gioco o davanti a un video (le regole dei commenti spontanei).
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

// ---------------------------------------------------------------------------
// Render loop: unico punto in cui la bocca viene aggiornata.
// ---------------------------------------------------------------------------
stage.onFrame((dt) => {
  const level = player.update(dt);
  const weights = lipSync.update(player.currentTime, level, dt, player.playing);
  // Il corpo gesticola e annuisce a tempo con il volume della voce.
  stage.setSpeech(player.playing, level);
  const rhythm = music.update(dt);
  stage.setMusic(rhythm);

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
 * Click-through per pixel: la finestra e' "solida" solo dove c'e' davvero il
 * personaggio (alpha del pixel sotto il cursore, letto dal framebuffer) o
 * dove c'e' un pezzo di interfaccia cliccabile (i dock, un avviso). Ovunque
 * altro il mouse passa attraverso e va a finire sulle finestre sotto.
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
        `[pet] cursore=(${Math.round(x)},${Math.round(y)}) alpha=${stage.lastAlpha?.toFixed(2)} ` +
          `suAvatar=${stage.pointerOnAvatar} suUI=${overUI} -> interattiva=${wanted}`,
      );
    }
  }

  if (wanted === state.interactive) return;
  state.interactive = wanted;
  pet.setInteractive(wanted);
}

// ---------------------------------------------------------------------------
// Caricamento dell'avatar
// ---------------------------------------------------------------------------
async function loadAvatar(url, label, { greet = true } = {}) {
  ui.showOverlay(`Carico ${label}…`);
  try {
    await stage.load(url, (progress) => ui.showOverlay(`Carico ${label}… ${Math.round(progress * 100)}%`));
    state.avatarLoaded = true;
    ui.hideOverlay();
    // Appena compare, saluta: con la mano e con la voce, adatto all'ora.
    if (greet) appear();
    if (stage.mouthDriver.kind === 'none') {
      ui.toast('Il modello non ha le blendshape della bocca: niente lip-sync.', true, 6000);
    }
    return true;
  } catch (error) {
    console.error(error);
    ui.showOverlay(
      'Non riesco a caricare il modello 3D',
      `${error.message || error}. Copia un file avatar.vrm in frontend/public/models/ oppure trascina un .vrm qui.`,
      true,
    );
    return false;
  }
}

ui.onModelFile = async (file) => {
  const url = URL.createObjectURL(file);
  const ok = await loadAvatar(url, file.name);
  // Un modello scelto apposta: vuol dire che il corpo lo vuole.
  if (ok && state.body === 'none') {
    state.body = 'vrm';
    writeSetting(BODY_SETTING, 'vrm');
    hud.setBodiless(false);
    setForm('vrm');
  }
  // Il blob resta referenziato dalle texture finche' il modello e' in scena:
  // lo revochiamo solo se il caricamento e' fallito.
  if (!ok) URL.revokeObjectURL(url);
};

// ---------------------------------------------------------------------------
// Interfaccia -> backend
// ---------------------------------------------------------------------------
ui.onSend = async (text) => {
  await player.resume(); // sblocca l'audio al primo gesto dell'utente
  socket.chat(text);
};

ui.onStop = () => stopSpeaking(true);

ui.onEscape = () => {
  if (!hud.visible) return false;
  hud.hide();
  return true;
};

ui.onContextMenu = () => hud.toggle();

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

// I dock: cosa fa ogni bottone.
hud.onAction = async (id) => {
  switch (id) {
    case 'agent':
      openPanel({ tab: 'engines', section: 'llm' });
      break;
    case 'voice':
      setMuted(!state.muted);
      socket.send({ type: 'settings', muted: state.muted });
      ui.toast(state.muted ? 'Voce spenta: risponde solo per iscritto.' : 'Voce accesa.');
      break;
    case 'mic':
      if (!state.voiceAvailable) {
        openPanel({ tab: 'engines', section: 'stt' });
        ui.toast('Scegli prima un motore di ascolto.');
        break;
      }
      await pushToggle();
      break;
    case 'music':
      setDancing(!state.dancing);
      ui.toast(state.dancing ? 'Ballo con Spotify.' : 'Niente balli.');
      break;
    case 'form':
      if (state.body === 'none') setBody('vrm');
      else setForm(stage.form === 'flame' ? 'vrm' : 'flame');
      break;
    case 'usage':
      openPanel({ tab: 'work' });
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
// Backend -> interfaccia
// ---------------------------------------------------------------------------
/**
 * Lo stato mostrato dipende da DUE cose: cosa sta facendo il backend e se c'e'
 * ancora audio in coda. Il backend dichiara "idle" appena ha finito di
 * sintetizzare, ma il personaggio sta ancora parlando per qualche secondo.
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
  // Solo la finestra del personaggio in Electron sa fare gli screenshot.
  if (pet?.captureScreen) socket.send({ type: 'capabilities', screen: true });
});

/** Screenshot e stesso messaggio, col file allegato ("guarda lo schermo"). */
async function lookAtScreen(text = '') {
  if (!pet?.captureScreen) return;
  try {
    const file = await pet.captureScreen();
    stage.play('lookAround');
    socket.send({ type: 'chat', text, files: [file], screen: true });
  } catch (error) {
    ui.toast(`Non riesco a vedere lo schermo: ${error.message}`, true, 4000);
  }
}

// Il backend ha capito "guarda lo schermo": lo screenshot lo facciamo qui.
socket.on('capture', (message) => lookAtScreen(message.text ?? ''));

socket.on('close', () => {
  state.backendState = 'idle';
  stage.setThinking(false);
  refreshStatus();
  // Senza backend non sappiamo piu' nulla dei motori: meglio il grigio
  // "non so" che lasciare un verde bugiardo acceso.
  hud.setEngines(null);
  if (!state.avatarLoaded) ui.showOverlay('Aspetto il backend…', 'Riprovo da sola, non serve fare niente.');
});

socket.on('hello', (message) => {
  refreshStatus();
  const config = message.config ?? {};
  if (message.context) state.activity = message.context.activity ?? null;
  // Clip .vrma della cartella animations (vedi clips.js).
  stage.setClipList(message.animations ?? []).then((loaded) => {
    if (loaded?.length) console.info(`[clips] ${loaded.length} animazioni:`, loaded.map((clip) => clip.name).join(', '));
  });
  hud.setEngines(message.engines);
  state.usage = message.usage ?? null;
  hud.setUsage(state.usage, message.engines?.llm?.id);
  voice.setWakeWord(config.wakeWord ?? 'companion');
  voice.interruptOnSpeech = config.voiceInterrupt !== false;
  voice.mode = config.voiceMode ?? 'push';
  // Il microfono non si apre da solo: serve un gesto dell'utente, sia per il
  // permesso del browser sia perche' accendere il microfono a sua insaputa
  // sarebbe sgradevole. I dock, il pannello e il push-to-talk lo attivano.
  state.voiceAvailable = (config.sttEngine ?? 'none') !== 'none';
  reportVoice();

  // Il muto scelto qui vale anche dopo un riavvio del backend.
  if (Boolean(config.muted) !== state.muted) socket.send({ type: 'settings', muted: state.muted });

  if (message.blendshapes) {
    stage.blendshapes = { ...DEFAULT_BLENDSHAPES, ...message.blendshapes };
  }
  const avatar = message.avatar?.default;
  if (avatar) state.avatarUrl = apiUrl(avatar);
  if (state.body === 'none') {
    // Senza corpo non c'e' niente da caricare: compare appena il backend risponde.
    ui.hideOverlay();
    if (!state.greeted) appear();
  } else if (!state.avatarLoaded) {
    if (avatar) {
      loadAvatar(apiUrl(avatar), avatar.split('/').pop());
    } else {
      ui.showOverlay(
        'Manca il modello 3D',
        'Copia un file avatar.vrm in frontend/public/models/, oppure trascina un .vrm su questa finestra. Puoi crearne uno gratis con VRoid Studio.',
        true,
      );
    }
  }
});

// Il gesto che accompagna un commento spontaneo (sbadiglio, brividi, aria con la mano...).
socket.on('gesture', (message) => {
  if (!player.playing || message.name === 'yawn') stage.play(message.name);
});

/** Ti chiama: campanello, bussa sul vetro, notifica di Windows. */
function callUser(title, body) {
  presence.touch();
  sfx.chime();
  if (stage.play('knock')) setTimeout(() => sfx.knock(), 520);
  else stage.play('wave');
  pet?.notify?.(title, body);
}

// Un agente che usi per conto tuo (Claude Code, Codex) ha finito o ti aspetta.
socket.on('notify', (message) => {
  const title = message.kind === 'waiting' ? `${message.title} ti aspetta` : `${message.title} ha finito`;
  if (message.silent) {
    pet?.notify?.(title, message.message ?? '');
  } else if (message.quiet) {
    ui.showBubble(`${title} ✓`, 3000);
  } else {
    callUser(title, message.message ?? '');
  }
});

// Una risposta sua che ci ha messo tanto (un agente al lavoro): quando arriva ti chiama.
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
  if (waited > LONG_TURN_MS && state.activity?.kind !== 'tsukumo') callUser('Tsukumo', message.text ?? 'Ho finito!');
});

// Un promemoria o un timer e' scattato: campanello, bussa sul vetro, notifica.
socket.on('reminder', (message) => {
  if (message.event !== 'fired') return;
  // Il toc-toc arriva quando il pugno tocca il vetro (vedi l'azione knock).
  callUser('Tsukumo', message.reminder?.label ?? 'Promemoria');
});

// Cosa fa l'utente al PC (vedi backend/context.py): guarda un video, e' in riunione...
socket.on('context', (message) => {
  state.activity = message.activity ?? null;
});

socket.on('engines', (message) => {
  hud.setEngines(message);
  state.voiceAvailable = (message.stt?.state ?? 'off') !== 'off';
  reportVoice();
  hud.setUsage(state.usage, message?.llm?.id);
});

// Quanto hanno consumato Claude Code e Codex (backend/usage.py): l'anello nel dock di sinistra.
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
 * Il microfono deve sapere quando il personaggio parla, o si risente da solo.
 * Conta l'audio che sta suonando, non solo lo stato del backend: il backend
 * torna "idle" appena ha sintetizzato l'ultima frase, lei la sta ancora dicendo.
 */
function syncVoiceState() {
  voice.setCompanionState(player.playing || state.backendState === 'speaking' ? 'speaking' : state.backendState);
}

// Quello che ha capito: mostrarlo sempre, anche quando ha capito male, evita
// di dover indovinare il perche' di una risposta strana.
socket.on('transcript', (message) => {
  const text = (message.text ?? '').trim();
  if (!text) return;
  voice.handleTranscript(text, Boolean(message.echo));
  // La sua stessa voce tornata dal microfono (vedi pipeline.is_echo): niente bolla.
  if (!message.echo) ui.showBubble(`« ${text} »`, 2500);
});

// La ringrazi: un piccolo inchino (se c'e' una clip bow/inchino).
const THANKS = /\b(grazie|thanks|thank you|thx|arigat[oō]|merci|danke|gracias|obrigad[oa])\b/i;
socket.on('user', (message) => {
  if (THANKS.test(message.text ?? '')) stage.playClipRole('bow');
});

// Una frase pronta da pronunciare: WAV + timeline dei visemi.
socket.on('speech', (message) => {
  // "Un attimo, ci sto lavorando" e' un versetto: tace se i versetti sono spenti.
  if (message.vocal && !vocals.enabled) return;
  if (!state.muted) player.enqueue(message);
});

// L'agente sta usando un tool: posa da lavoro e, finche' tace, la bolla con il passo.
socket.on('working', (message) => {
  stage.setWorking(message.kind);
  const label = message.label ?? '';
  if (label && !player.playing) ui.showBubble(`${label.charAt(0).toUpperCase()}${label.slice(1)}…`, 8000);
});

// Una frase senza audio (muta, o voce guasta): la bolla basta.
socket.on('caption', (message) => {
  if (message.text) ui.showBubble(message.text, Math.min(9000, 1800 + message.text.length * 55));
});

socket.on('reply', (message) => {
  // La bolla mostra gia' le singole frasi mentre le pronuncia: qui serve solo
  // per le risposte che non vengono lette (per esempio se l'audio e' bloccato).
  if (message.text && !player.playing && !message.failed) ui.showBubble(message.text, 6000);
});

socket.on('notice', (message) => ui.toast(message?.message ?? ''));

socket.on('error', (message) => {
  ui.toast(message?.message ?? 'Errore sconosciuto', true, 7000);
  refreshStatus();
});

socket.on('cancel', () => {
  stage.setThinking(false);
  stopSpeaking(false);
});

// ---------------------------------------------------------------------------
// Musica
// ---------------------------------------------------------------------------
let musicStopTimer = null;
function syncMusic() {
  hud.setMusic(state.musicPlaying);
  const wanted = state.musicPlaying && state.dancing;
  if (wanted) {
    clearTimeout(musicStopTimer);
    musicStopTimer = null;
    if (!music.running) {
      music.start().catch((error) => console.error('[pet] cattura audio non disponibile:', error.message));
    }
  } else if (music.running && !musicStopTimer) {
    // Fra una traccia e l'altra il titolo sparisce per un attimo: aspettiamo
    // un po' prima di spegnere la cattura.
    musicStopTimer = setTimeout(() => {
      musicStopTimer = null;
      music.stop();
    }, 4000);
  }
}

function setDancing(value) {
  state.dancing = Boolean(value);
  writeSetting('dc:dance', state.dancing);
  stage.setDancing(state.dancing);
  syncMusic();
}

// ---------------------------------------------------------------------------
// Voce: push-to-talk
// ---------------------------------------------------------------------------
// Due strade, perche' Electron non sa dire quando una scorciatoia globale
// viene *rilasciata*: da fuori il tasto fa da interruttore, da dentro la
// finestra usiamo keydown/keyup veri e il tieni-premuto funziona davvero.
let pushHeld = false;

function reportVoice() {
  const snapshot = { available: state.voiceAvailable, enabled: voice.listening, mode: voice.mode, held: pushHeld };
  hud.setMic({ available: state.voiceAvailable, enabled: voice.listening && (voice.mode !== 'push' || pushHeld) });
  pet?.setVoiceState(snapshot);
}

async function pushToggle() {
  if (!state.voiceAvailable) {
    ui.showBubble('Il riconoscimento vocale non è attivo', 3000);
    return;
  }
  await player.resume();
  if (!voice.listening && !(await voice.enable({ mode: voice.mode }))) return;

  if (voice.mode !== 'push') {
    // Negli altri modi il microfono e' gia' aperto: il tasto lo accende e spegne.
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

// Tieni premuto, quando la finestra ha il fuoco. `repeat` va ignorato o la
// pressione prolungata farebbe ripartire la registrazione a ogni ripetizione.
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
// Modalita' mascotte (solo Electron)
// ---------------------------------------------------------------------------
if (pet) {
  window.__petDebug = new URLSearchParams(location.search).has('petdebug');
  document.body.classList.add('pet-mode');
  // Figura intera: e' l'aspetto giusto per una mascotte sulla scrivania.
  stage.setFraming('full');
  // Il trascinamento sposta la finestra, non ruota la camera.
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

  // Chat e impostazioni vivono nel pannello, staccato dal personaggio.
  // Doppio click (o iniziare a scrivere) apre la chat.
  ui.onOpenChat = (text) => pet.openPanel({ tab: 'chat', text });

  // La rotellina la ingrandisce: cambia la finestra, non la camera.
  stage.onWheelScale = (factor) => pet.scaleBy(factor);
  // Dove stanno piedi e seduta nella finestra: servono per appoggiarla.
  stage.onAnchors = (anchors) => pet.setAnchors(anchors);
  // Ogni tanto si siede o si sdraia sulla barra: la finestra la sposta Electron.
  stage.onPostureRequest = (posture) => pet.requestPosture(posture);

  // Prendila col mouse: la solleva per la collottola e penzola. Un click
  // senza trascinare e' un tocco (carezza sulla testa, colpetto sul corpo).
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
    };
    ui.elements.stage.setPointerCapture?.(event.pointerId);
  });

  window.addEventListener('pointermove', (event) => {
    if (!drag) return;
    drag.dx = event.screenX - drag.screenX;
    drag.dy = event.screenY - drag.screenY;
    if (drag.moved || Math.abs(drag.dx) + Math.abs(drag.dy) <= 4) return;

    // Parte la presa solo quando il mouse si muove davvero: un semplice
    // click non deve far cadere o rialzare nessuno.
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

  // La finestra segue il cursore a ogni frame; nei primi istanti scivola
  // fino a portare la collottola sotto il puntatore ("presa con le pinze").
  function dragFrame(current) {
    if (drag !== current) return;
    const snap = Math.min(1, (performance.now() - current.startedAt) / 180);
    const k = snap * snap * (3 - 2 * snap);
    const x = Math.round(current.origin.x + current.dx + current.offset.x * k);
    const y = Math.round(current.origin.y + current.dy + current.offset.y * k);
    pet.dragMove(x, y);
    stage.moveHold(x, y);
    requestAnimationFrame(() => dragFrame(current));
  }

  window.addEventListener('pointerup', (event) => {
    if (!drag) return;
    const finished = drag;
    drag = null;
    document.body.classList.remove('dragging');
    if (finished.moved) {
      pet.dragEnd();
      stage.endHold();
      state.droppedAt = performance.now();
    } else {
      presence.touch();
      if (tooManyPokes() && stage.play('pout')) {
        pokes.length = 0;
        vocals.say('pout');
        return;
      }
      const reaction = stage.poke(event.clientX, event.clientY);
      if (reaction) vocals.say(reaction === 'pat' ? 'pat' : 'poke');
    }
  });

  // Il processo main decide dove sta: cade, atterra sulla barra o su una
  // finestra, si siede, si aggrappa al bordo, viaggia con la finestra.
  pet.onMotion((motion) => {
    switch (motion.state) {
      case 'falling':
        stage.setFalling();
        // "Waah!" solo se l'hai lanciata tu, non quando cade all'avvio.
        if (performance.now() - state.droppedAt < 1500) vocals.say('fall');
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
      // Lo sprint della fiammella: le fasi e, mentre corre, dove e' arrivata la finestra.
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

  // La posizione del cursore arriva dal processo main, non dagli eventi del
  // DOM: in click-through la pagina non ne riceve (vedi pushCursorPosition).
  // Arriva anche quando e' fuori dalla finestra, e lo sguardo lo segue.
  pet.onCursor(({ x, y, inside }) => {
    stage.setPointer(x, y, inside);
    trackSpin(x, y);
  });

  // Da quanto il PC e' fermo, blocco e sblocco dello schermo: sonno e risveglio.
  pet.onPresence?.((message) => {
    if (typeof message?.idle === 'number') state.idleSeconds = message.idle;
    presence.update(message, busyForSleep());
  });

  // Comandi dal pannello.
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
        // 'spirit' = senza corpo (dalla presentazione o da Personaggio -> Aspetto).
        if (command.value === 'spirit') setBody('none');
        else if (state.body === 'none') setBody('vrm', command.value);
        // Sta ancora cambiando: resta com'e', e il pannello torna a dire la verita'.
        else if (!setForm(command.value) && command.value !== stage.form) writeSetting(FORM_SETTING, stage.form);
        break;
      case 'sprint':
        // Dal pannello: subito, se e' la fiammella e sta in piedi sulla barra.
        if (stage.form !== 'flame') ui.toast('Gli sprint li fa la fiammella: cambia forma dal pannello.');
        else pet.sprint(command.kind).then((ok) => ok || ui.toast('Può scattare solo quando è a terra sulla barra.'));
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
      case 'hud':
        hud.show();
        break;
      case 'stop':
        stopSpeaking(true);
        break;
      default:
        break;
    }
  });

  // Un modello scelto dal pannello arriva come dati binari.
  pet.onModel(({ name, data }) => {
    ui.onModelFile(new File([data], name));
  });
} else {
  // Nel browser lo sfondo trasparente non serve: lo accendiamo di default.
  document.body.classList.add('opaque-bg');
  stage.setBackgroundVisible(true);
  stage.setDancing(state.dancing);
}

// Un file trascinato su di lei: lo prende e lo passa al cervello.
if (pet) {
  window.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    document.body.classList.add('drop-target');
  });
  window.addEventListener('dragleave', () => document.body.classList.remove('drop-target'));
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    document.body.classList.remove('drop-target');
    const files = [...(event.dataTransfer?.files ?? [])].map((file) => pet.pathForFile?.(file)).filter(Boolean);
    if (!files.length) return;
    presence.touch();
    stage.play('pat');
    vocals.say('pat');
    socket.send({ type: 'chat', text: '', files });
  });
}

// L'audio richiede un gesto utente: il primo click/tasto sblocca il contesto.
const unlock = () => {
  player.resume().catch(() => {});
  window.removeEventListener('pointerdown', unlock);
  window.removeEventListener('keydown', unlock);
};
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

ui.showOverlay('Tsukumo si sta svegliando…');
socket.connect();

// Primo avvio: un suggerimento, poi silenzio.
setTimeout(() => {
  if (state.avatarLoaded && !readSetting('dc:hint-seen', false)) {
    writeSetting('dc:hint-seen', true);
    ui.toast(pet ? 'Tasto destro su di lei per i comandi, doppio click per scriverle.' : 'Tasto destro per i comandi.', false, 6000);
  }
}, 2500);

// Utile per ispezionare lo stato dalla console.
window.deskCompanion = { stage, player, lipSync, socket, ui, hud, state, pet, voice, pushToggle, vocals, presence, sfx, setForm, setBody };
