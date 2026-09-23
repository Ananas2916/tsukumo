/**
 * Punto di ingresso del frontend.
 *
 * Mette insieme i quattro pezzi:
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
 * pixel, lo prendi in mano e lo sposti (penzola, poi cade e atterra), e
 * reagisce quando lo tocchi.
 */

import { apiUrl, DEFAULT_BLENDSHAPES, wsUrl } from './config.js';
import { SpeechPlayer } from './audio.js';
import { LipSync } from './lipsync.js';
import { MusicListener } from './music.js';
import { UI } from './ui.js';
import { VoiceController } from './voice.js';
import { VrmStage } from './vrm.js';
import { CompanionSocket } from './ws.js';

const pet = window.companion?.isElectron ? window.companion : null;

const ui = new UI();
const stage = new VrmStage(document.getElementById('stage'));
const lipSync = new LipSync({ gain: Number(ui.elements.gain.value) });
const player = new SpeechPlayer({
  onClipStart: (payload) => {
    lipSync.setTimeline(payload.visemes);
    stage.startClip(payload);
    if (payload.text) ui.showBubble(payload.text, Math.max(2500, payload.duration * 1000 + 1200));
    refreshStatus();
  },
  onIdle: () => {
    lipSync.clear();
    refreshStatus();
  },
});
const socket = new CompanionSocket(wsUrl);
const voice = new VoiceController({
  socket,
  onEvent: (event) => {
    if (event.type === 'error') ui.showBubble(event.message, 4000);
    if (event.type === 'activity') document.body.classList.toggle('listening', event.speaking);
  },
});
/** Ritmo della musica di Spotify, ascoltando l'audio di sistema (solo Electron). */
const music = new MusicListener();

/** Stato locale, tenuto volutamente minimo. */
const state = {
  avatarLoaded: false,
  backendState: 'idle',
  /** Ultimo valore inviato a Electron per il click-through. */
  interactive: null,
};

// ---------------------------------------------------------------------------
// Render loop: unico punto in cui la bocca viene aggiornata.
// ---------------------------------------------------------------------------
stage.onFrame((dt) => {
  const level = player.update(dt);
  const weights = lipSync.update(player.currentTime, level, dt, player.playing);
  // Il corpo gesticola e annuisce a tempo con il volume della voce.
  stage.setSpeech(player.playing, level);
  stage.setMusic(music.update(dt));

  ui.updateDebug({
    viseme: player.playing ? lipSync.activeViseme : 'sil',
    level,
    fps: stage.fps,
    weights,
    driver: stage.mouthDriverLabel,
  });

  if (pet) updateClickThrough();

  return weights;
});
stage.start();

/**
 * Click-through per pixel: la finestra e' "solida" solo dove c'e' davvero il
 * personaggio (alpha del pixel sotto il cursore, letto dal framebuffer) o
 * dove c'e' un pezzo di interfaccia cliccabile. Ovunque altro il mouse passa
 * attraverso e va a finire sulle finestre sotto.
 */
function updateClickThrough() {
  const { x, y } = stage.pointerPx;
  const overUI = x >= 0 && ui.isOverSolidUI(x, y);
  const wanted = overUI || stage.pointerOnAvatar || ui.overlayOpen;

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
async function loadAvatar(url, label) {
  ui.showOverlay(`Carico ${label}...`, '');
  try {
    await stage.load(url, (progress) => {
      ui.showOverlay(`Carico ${label}... ${Math.round(progress * 100)}%`, '');
    });
    state.avatarLoaded = true;
    ui.hideOverlay();
    // Appena compare, saluta.
    setTimeout(() => stage.greet(), 700);

    if (stage.mouthDriver.kind === 'none') {
      ui.toast('Il modello non ha le blendshape della bocca: niente lip-sync.', true, 6000);
    }
    return true;
  } catch (error) {
    console.error(error);
    ui.showOverlay(
      'Non riesco a caricare il modello 3D',
      `${escapeHtml(String(error.message || error))}<br><br>` +
        'Copia un file <code>avatar.vrm</code> in <code>frontend/public/models/</code> ' +
        'oppure trascina un <code>.vrm</code> su questa finestra.',
      true,
    );
    return false;
  }
}

function showMissingAvatar() {
  ui.showOverlay(
    'Manca il modello 3D',
    'Copia un file <code>avatar.vrm</code> in <code>frontend/public/models/</code>, ' +
      'oppure <b>trascina un file .vrm su questa finestra</b>.<br><br>' +
      'Puoi crearne uno gratis con VRoid Studio.',
    true,
  );
}

ui.onModelFile = async (file) => {
  const url = URL.createObjectURL(file);
  const ok = await loadAvatar(url, file.name);
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

ui.onSay = async (text) => {
  await player.resume();
  socket.say(text, ui.voice);
};

ui.onStop = () => {
  player.stop();
  lipSync.clear();
  ui.hideBubble();
  socket.cancel();
};

ui.onReset = () => {
  player.stop();
  lipSync.clear();
  ui.hideBubble();
  socket.reset();
  ui.toast('Conversazione azzerata.');
};

ui.onGainChange = (value) => {
  lipSync.gain = value;
};

ui.onBackgroundChange = (visible) => {
  stage.setBackgroundVisible(visible);
};

// ---------------------------------------------------------------------------
// Backend -> interfaccia
// ---------------------------------------------------------------------------
/**
 * Lo stato mostrato dipende da DUE cose: cosa sta facendo il backend e se c'e'
 * ancora audio in coda. Il backend dichiara "idle" appena ha finito di
 * sintetizzare, ma il companion sta ancora parlando per qualche secondo.
 */
function refreshStatus() {
  if (!socket.connected) {
    ui.setStatus('offline', 'Backend non raggiungibile, riprovo...');
    ui.setBusy(false);
    return;
  }
  if (player.playing) {
    ui.setStatus('speaking', 'Sta parlando');
    ui.setBusy(true);
    return;
  }
  if (state.backendState === 'thinking') {
    ui.setStatus('thinking', 'Sta pensando...');
    ui.setBusy(true);
    return;
  }
  ui.setStatus('online', 'Pronto');
  ui.setBusy(false);
}

socket.on('open', () => refreshStatus());

socket.on('close', () => {
  state.backendState = 'idle';
  stage.setThinking(false);
  refreshStatus();
  // Senza backend non sappiamo piu' nulla di OpenClaw: meglio il grigio
  // "non so" che lasciare un verde bugiardo acceso.
  ui.setOpenClaw({ state: 'unknown', error: 'Backend non raggiungibile' });
});

// Il backend sonda il Gateway OpenClaw e avvisa solo quando lo stato cambia.
socket.on('openclaw', (message) => ui.setOpenClaw(message));

socket.on('hello', (message) => {
  refreshStatus();
  ui.setVoices(message.voices ?? [], message.config?.voice);
  ui.setOpenClaw(message.openclaw);

  const config = message.config ?? {};
  voice.setWakeWord(config.wakeWord ?? 'companion');
  voice.interruptOnSpeech = config.voiceInterrupt !== false;
  voice.mode = config.voiceMode ?? 'push';
  // Il microfono non si apre da solo: serve un gesto dell'utente, sia per il
  // permesso del browser sia perche' accendere il microfono a sua insaputa
  // sarebbe sgradevole. Il pannello e il tasto del push-to-talk lo attivano.
  state.voiceAvailable = (config.sttEngine ?? 'none') !== 'none';

  // Il guadagno della bocca scelto nel pannello vince sul default del backend.
  const gain = readSetting('dc:gain', message.config?.visemeGain);
  if (typeof gain === 'number') {
    lipSync.gain = gain;
    ui.setGain(gain);
  }
  if (message.blendshapes) {
    stage.blendshapes = { ...DEFAULT_BLENDSHAPES, ...message.blendshapes };
  }

  if (!state.avatarLoaded) {
    const avatar = message.avatar?.default;
    if (avatar) loadAvatar(apiUrl(avatar), avatar.split('/').pop());
    else showMissingAvatar();
  }
});

socket.on('state', (message) => {
  state.backendState = message.value;
  stage.setThinking(message.value === 'thinking');
  // Il microfono deve sapere quando il companion parla, o si risente da solo.
  voice.setCompanionState(message.value);
  refreshStatus();
});

// Quello che il companion ha capito: mostrarlo sempre, anche quando ha capito
// male, evita di dover indovinare il perche' di una risposta strana.
socket.on('transcript', (message) => {
  const text = (message.text ?? '').trim();
  if (!text) return;
  voice.handleTranscript(text);
  ui.showBubble(`« ${text} »`, 2500);
});

// Una frase pronta da pronunciare: WAV + timeline dei visemi. Senza questo
// handler l'audio arriva dal backend ma non viene mai suonato.
socket.on('speech', (message) => {
  player.enqueue(message);
});

socket.on('reply', (message) => {
  // La bolla mostra gia' le singole frasi mentre le pronuncia: qui serve solo
  // per le risposte che non vengono lette (per esempio se l'audio e' bloccato).
  if (message.text && !player.playing) ui.showBubble(message.text, 6000);
});

socket.on('notice', (message) => ui.toast(message?.message ?? ''));

socket.on('error', (message) => {
  ui.toast(message?.message ?? 'Errore sconosciuto', true, 6000);
  ui.setStatus('error', message?.message ?? 'Errore');
  ui.setBusy(false);
});

socket.on('cancel', () => {
  stage.setThinking(false);
  player.stop();
  lipSync.clear();
  ui.hideBubble();
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
  let dancing = readSetting('dc:dance', true);
  stage.setDancing(dancing);

  // Spotify suona: ascolta l'audio di sistema per ballare a tempo. Fra una
  // traccia e l'altra il titolo sparisce per un attimo: aspettiamo un po'
  // prima di spegnere la cattura.
  let musicPlaying = false;
  let musicStopTimer = null;
  const syncMusic = () => {
    const wanted = musicPlaying && dancing;
    if (wanted) {
      clearTimeout(musicStopTimer);
      musicStopTimer = null;
      if (!music.running) {
        music.start().catch((error) => console.error('[pet] cattura audio non disponibile:', error.message));
      }
    } else if (music.running && !musicStopTimer) {
      musicStopTimer = setTimeout(() => {
        musicStopTimer = null;
        music.stop();
      }, 4000);
    }
  };
  pet.onMusic((status) => {
    musicPlaying = Boolean(status?.playing);
    syncMusic();
  });
  pet.getState().then((initial) => {
    musicPlaying = Boolean(initial?.music?.playing);
    syncMusic();
  });

  // Chat e menu vivono nel pannello, staccato dal personaggio: qui resta
  // solo lei. Tasto destro apre il menu, doppio click (o iniziare a
  // scrivere) apre la chat.
  ui.onContextMenu = () => pet.togglePanel({ tab: 'menu' });
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
    } else {
      stage.poke(event.clientX, event.clientY);
    }
  });

  // Il processo main decide dove sta: cade, atterra sulla barra o su una
  // finestra, si siede, si aggrappa al bordo, viaggia con la finestra.
  pet.onMotion((motion) => {
    switch (motion.state) {
      case 'falling':
        stage.setFalling();
        break;
      case 'landed':
        stage.landed(motion.impact, motion.posture);
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
      default:
        break;
    }
  });

  // La posizione del cursore arriva dal processo main, non dagli eventi del
  // DOM: in click-through la pagina non ne riceve (vedi pushCursorPosition).
  // Arriva anche quando e' fuori dalla finestra, e lo sguardo lo segue.
  pet.onCursor(({ x, y, inside }) => stage.setPointer(x, y, inside));

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
        dancing = Boolean(command.value);
        stage.setDancing(dancing);
        syncMusic();
        break;
      case 'play':
        stage.body?.play(command.name, { sign: command.sign });
        break;
      case 'posture':
        pet.requestPosture(command.value);
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
  ui.elements.toggleBg.checked = true;
  document.body.classList.add('opaque-bg');
  stage.setBackgroundVisible(true);
}

// L'audio richiede un gesto utente: il primo click/tasto sblocca il contesto.
const unlock = () => {
  player.resume().catch(() => {});
  window.removeEventListener('pointerdown', unlock);
  window.removeEventListener('keydown', unlock);
};
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

ui.setStatus('offline', 'Connessione...');
ui.showOverlay('Connessione al backend...', 'Assicurati che <code>python -m backend</code> sia in esecuzione.');
socket.connect();

// Se dopo qualche secondo il backend non risponde, spieghiamo cosa fare.
setTimeout(() => {
  if (!socket.connected && !state.avatarLoaded) {
    ui.showOverlay(
      'Backend non raggiungibile',
      'Avvia il server Python dalla cartella del progetto:<br>' +
        '<code>python -m backend</code><br><br>' +
        'Sto continuando a riprovare da solo.',
      true,
    );
  }
}, 4000);

// Primo avvio: un suggerimento, poi silenzio.
setTimeout(() => {
  if (state.avatarLoaded) {
    ui.toast(pet ? 'Tasto destro per il menu, doppio click per scriverle.' : 'Tasto destro per il menu.');
  }
}, 2500);

/** Preferenza salvata dal pannello (stessa origine: localStorage condiviso). */
function readSetting(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[char];
  });
}

// Utile per ispezionare lo stato dalla console del browser.
// ---------------------------------------------------------------------------
// Push-to-talk
// ---------------------------------------------------------------------------
// Due strade, perche' Electron non sa dire quando una scorciatoia globale
// viene *rilasciata*: da fuori il tasto fa da interruttore, da dentro la
// finestra usiamo keydown/keyup veri e il tieni-premuto funziona davvero.
let pushHeld = false;

async function pushToggle() {
  if (!state.voiceAvailable) {
    ui.showBubble('Il riconoscimento vocale non e’ attivo', 3000);
    return;
  }
  if (!voice.listening && !(await voice.enable({ mode: voice.mode }))) return;

  if (voice.mode !== 'push') {
    // Negli altri modi il microfono e' gia' aperto: il tasto lo accende e spegne.
    voice.disable();
    return;
  }
  pushHeld = !pushHeld;
  if (pushHeld) voice.pushStart();
  else voice.pushEnd();
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
});

window.addEventListener('keyup', (event) => {
  if (event.code !== 'Space' || !pushHeld) return;
  event.preventDefault();
  pushHeld = false;
  voice.pushEnd();
});

window.deskCompanion = { stage, player, lipSync, socket, ui, state, pet, voice, pushToggle };
