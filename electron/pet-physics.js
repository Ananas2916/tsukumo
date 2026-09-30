/**
 * Dove sta la mascotte e su cosa si appoggia, come in Desktop Mate.
 *
 * Stati:
 *  - `ground`  sulla barra delle applicazioni (in piedi, seduta sul bordo o sdraiata);
 *  - `window`  seduta sul bordo superiore di una finestra, con cui viaggia;
 *  - `edge`    aggrappata al bordo sinistro/destro dello schermo, che sbircia;
 *  - `falling` in caduta libera;
 *  - `held`    presa col mouse (la finestra la muove il trascinamento);
 *  - `sprint`  la fiammella corre lungo la barra a tutta velocita'.
 *
 * La finestra del personaggio e' piu' grande del personaggio: le "ancore"
 * dicono, in frazioni della finestra, dove stanno i piedi, la seduta (il
 * fondo del bacino) e l'asse del corpo. Le misura il renderer, che sa come e'
 * inquadrato il modello, e restano valide a qualunque scala.
 *
 * Il modulo non dipende da Electron: tutto quello che serve arriva da `env`,
 * cosi' si puo' provare con finestre finte.
 */

const GRAVITY = 2600; // px/s^2
const MAX_FALL = 1500; // px/s
const POSTURE_TIME = 0.45; // s: sedersi/alzarsi sulla barra

/**
 * Lo sprint della fiammella (frontend/src/flame.js): si carica, parte a tutta
 * velocita' lungo la barra, frena di colpo con un rimbalzo e si gode il
 * momento. Due giri: scatto in un altro punto dello schermo e ritorno, oppure
 * giro di pista (esce da un bordo, rientra dall'altro e torna a casa).
 * Velocita' in larghezze dello schermo, cosi' vale uguale su ogni monitor.
 */
const SPRINT = {
  ready: 0.38, // s: si carica prima di partire
  speed: 1.4, // schermi al secondo a tutta velocita'
  accel: 7, // schermi al secondo^2
  brake: 0.35, // frena quando al traguardo manca questa frazione della finestra
  stiffness: 160, // molla della frenata (1/s^2)
  damping: 15, // (1/s)
  settle: 0.5, // s di frenata
  look: 0.9, // s a guardarsi intorno prima di tornare
  proud: 0.7, // s di soddisfazione alla fine
};

const smoothstep = (t) => t * t * (3 - 2 * t);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

class PetPhysics {
  /**
   * @param {object} env
   * @param {() => {x:number,y:number,width:number,height:number}} env.bounds finestra del personaggio
   * @param {(x:number, y:number) => void} env.move
   * @param {(bounds:object) => {x:number,y:number,width:number,height:number}} env.workArea area utile del monitor
   * @param {() => Array} env.windows finestre degli altri programmi, dalla piu' in alto
   * @param {(hwnd:number) => object|null} env.windowRect
   * @param {(message:object) => void} env.emit messaggi per il renderer
   * @param {() => number} [env.random] per le prove: sceglie giro e traguardo dello sprint
   */
  constructor(env) {
    this.env = env;
    this.random = env.random ?? Math.random;
    this.state = 'ground';
    this.posture = 'stand';
    this.vy = 0;
    this.surface = null;
    this.transition = null;
    /** Lo sprint in corso: fase, traguardo, posizione e velocita' dell'asse del corpo. */
    this.run = null;
    /** Ancore in frazioni della finestra: piedi e seduta sulla verticale, asse del corpo sull'orizzontale. */
    this.anchors = { feet: 0.985, seat: 0.56, center: 0.5 };
    this.windowsEnabled = true;
  }

  setAnchors(anchors) {
    this.anchors = { ...this.anchors, ...anchors };
    this.snap();
  }

  // ------------------------------------------------------------- comandi
  grab() {
    if (this.run) this._endSprint();
    this.state = 'held';
    this.surface = null;
    this.transition = null;
    this.vy = 0;
  }

  /** Lasciata andare: si aggrappa al bordo dello schermo se e' fuori, altrimenti cade. */
  release() {
    const bounds = this.env.bounds();
    const area = this.env.workArea(bounds);
    const { center, feet } = this.anchors;
    const cx = bounds.x + bounds.width * center;
    const ground = area.y + area.height;
    const high = bounds.y + bounds.height * feet < ground - bounds.height * 0.2;
    const margin = bounds.width * 0.08;

    if (high && (cx > area.x + area.width - margin || cx < area.x + margin)) {
      const side = cx > area.x + area.width / 2 ? 'right' : 'left';
      this._cling(side, bounds, area);
      return;
    }
    this.state = 'falling';
    this.vy = 0;
    this.env.emit({ state: 'falling' });
  }

  /** Sedersi, alzarsi, sdraiarsi (a pancia in giu' o sul fianco): solo sulla barra; sulle finestre sta sempre seduta. */
  requestPosture(posture) {
    if (this.state !== 'ground' || !['stand', 'sit', 'lie', 'side'].includes(posture) || posture === this.posture) return false;
    const bounds = this.env.bounds();
    this.transition = { from: bounds.y, t: 0 };
    this.posture = posture;
    this.env.emit({ state: 'posture', posture });
    return true;
  }

  /**
   * Parte uno sprint, solo in piedi sulla barra. `kind`: 'dash' (scatto e
   * ritorno), 'lap' (giro di pista) o niente per sceglierne uno a caso.
   */
  sprint(kind) {
    if (this.state !== 'ground' || this.posture !== 'stand' || this.transition) return false;
    const bounds = this.env.bounds();
    const area = this.env.workArea(bounds);
    const cx = bounds.x + bounds.width * this.anchors.center;
    // Le fermate restano dentro lo schermo anche col rimbalzo della frenata.
    const margin = bounds.width * 0.6;
    const lo = area.x + margin;
    const hi = area.x + area.width - margin;
    const home = clamp(cx, lo, Math.max(lo, hi));
    const far = area.width / 3;
    const leftRoom = Math.max(0, home - far - lo);
    const rightRoom = Math.max(0, hi - (home + far));
    // Su uno schermo troppo stretto per uno scatto lungo fa il giro di pista.
    const lap = kind === 'lap' || leftRoom + rightRoom <= 0 || (kind !== 'dash' && this.random() < 0.45);
    let target = home;
    let dir = this.random() < 0.5 ? -1 : 1;
    if (!lap) {
      const pick = this.random() * (leftRoom + rightRoom);
      target = pick < leftRoom ? lo + pick : home + far + (pick - leftRoom);
      dir = Math.sign(target - home) || dir;
    }
    this.state = 'sprint';
    this.run = { phase: 'ready', t: 0, dir, target, home, lap, wrapped: false, legs: lap ? 1 : 2, x: cx, v: 0, area: { ...area } };
    this.env.emit({ state: 'sprint', phase: 'ready', dir, lap });
    return true;
  }

  // ------------------------------------------------------------- tempo
  step(dt) {
    switch (this.state) {
      case 'falling':
        this._fall(dt);
        break;
      case 'ground':
        this._ground(dt);
        break;
      case 'window':
        this._ride(dt);
        break;
      case 'sprint':
        this._sprint(dt);
        break;
      default:
        break;
    }
  }

  /** Riposiziona dopo un cambio di scala o di ancore, senza animazioni. */
  snap() {
    this.transition = null;
    if (this.state === 'ground') this._ground(0);
    else if (this.state === 'window') this._ride(0);
  }

  /**
   * Nuovi limiti per una nuova dimensione della finestra, tenendo fermo il
   * punto su cui poggia (piedi o seduta) e l'asse del corpo.
   */
  resized(bounds, width, height) {
    const { feet, seat, center } = this.anchors;
    const line = this.state === 'window' || this.posture === 'sit' ? seat : feet;
    const cx = bounds.x + bounds.width * center;
    let y;
    if (this.state === 'ground' || this.state === 'window' || this.state === 'sprint') {
      y = bounds.y + bounds.height * line - height * line;
    } else {
      y = bounds.y + bounds.height / 2 - height / 2;
    }
    return { x: Math.round(cx - width * center), y: Math.round(y), width, height };
  }

  // ------------------------------------------------------------- stati
  _fall(dt) {
    const bounds = this.env.bounds();
    const area = this.env.workArea(bounds);
    const { feet, seat, center } = this.anchors;
    this.vy = Math.min(MAX_FALL, this.vy + GRAVITY * dt);
    const dy = this.vy * dt;
    const cx = bounds.x + bounds.width * center;

    // Prima le finestre: atterra seduta sul primo bordo che incontra.
    if (this.windowsEnabled) {
      const seatBefore = bounds.y + bounds.height * seat;
      const target = this._landingWindow(seatBefore, seatBefore + dy, cx, bounds, area);
      if (target) {
        const y = Math.round(target.y - bounds.height * seat);
        this.env.move(bounds.x, y);
        this.state = 'window';
        this.posture = 'sit';
        this.surface = { hwnd: target.hwnd, dx: bounds.x - target.x, x: target.x, y: target.y };
        this.env.emit({ state: 'landed', surface: 'window', posture: 'sit', impact: this.vy / MAX_FALL });
        this.vy = 0;
        return;
      }
    }

    const ground = area.y + area.height;
    const feetAfter = bounds.y + dy + bounds.height * feet;
    if (feetAfter >= ground) {
      // A terra resta tutta dentro lo schermo.
      const half = bounds.width * 0.22;
      const x = clamp(cx, area.x + half, area.x + area.width - half) - bounds.width * center;
      this.env.move(Math.round(x), Math.round(ground - bounds.height * feet));
      this.state = 'ground';
      this.posture = 'stand';
      this.env.emit({ state: 'landed', surface: 'ground', posture: 'stand', impact: this.vy / MAX_FALL });
      this.vy = 0;
      return;
    }
    this.env.move(bounds.x, Math.round(bounds.y + dy));
  }

  /**
   * La finestra su cui atterrare: il suo bordo superiore viene attraversato
   * dalla linea della seduta in questo passo, il personaggio ci sta sopra in
   * orizzontale, sopra c'e' spazio per il corpo e quel pezzo di bordo non e'
   * coperto da un'altra finestra.
   */
  _landingWindow(before, after, cx, bounds, area) {
    const windows = this.env.windows();
    const margin = bounds.width * 0.12;
    const room = bounds.height * this.anchors.seat * 0.85;
    for (let i = 0; i < windows.length; i += 1) {
      const w = windows[i];
      if (w.maximized || w.y < before - 2 || w.y > after) continue;
      if (cx < w.x + margin || cx > w.x + w.width - margin) continue;
      if (w.y - area.y < room) continue;
      if (this._covered(windows, i, cx, w.y + 3)) continue;
      return w;
    }
    return null;
  }

  _covered(windows, index, x, y) {
    for (let j = 0; j < index; j += 1) {
      const w = windows[j];
      if (x >= w.x && x <= w.x + w.width && y >= w.y && y <= w.y + w.height) return true;
    }
    return false;
  }

  _ground(dt) {
    const bounds = this.env.bounds();
    const area = this.env.workArea(bounds);
    const line = this.posture === 'sit' ? this.anchors.seat : this.anchors.feet;
    const target = area.y + area.height - bounds.height * line;
    let y = target;
    if (this.transition) {
      this.transition.t = Math.min(1, this.transition.t + dt / POSTURE_TIME);
      y = this.transition.from + (target - this.transition.from) * smoothstep(this.transition.t);
      if (this.transition.t >= 1) this.transition = null;
    }
    if (Math.round(y) !== bounds.y) this.env.move(bounds.x, Math.round(y));
  }

  /** Seduta su una finestra: la segue se si sposta, cade se sparisce. */
  _ride() {
    const surface = this.surface;
    const rect = surface ? this.env.windowRect(surface.hwnd) : null;
    const bounds = this.env.bounds();
    const area = this.env.workArea(bounds);
    const { seat, center } = this.anchors;
    const cx = (rect ? rect.x + surface.dx : bounds.x) + bounds.width * center;
    const margin = bounds.width * 0.08;
    const lost =
      !rect ||
      rect.maximized ||
      rect.y - area.y < bounds.height * seat * 0.6 ||
      cx < rect.x + margin ||
      cx > rect.x + rect.width - margin;
    if (lost) {
      this.state = 'falling';
      this.surface = null;
      this.vy = 0;
      this.env.emit({ state: 'falling' });
      return;
    }

    const x = Math.round(rect.x + surface.dx);
    const y = Math.round(rect.y - bounds.height * seat);
    if (x !== bounds.x || y !== bounds.y) {
      this.env.move(x, y);
      // Il renderer usa queste posizioni per farla sballottare.
      this.env.emit({ state: 'carried', x, y });
    }
    surface.x = rect.x;
    surface.y = rect.y;
  }

  /**
   * Un passo dello sprint. Il traguardo e le velocita' riguardano l'asse del
   * corpo; la finestra si ricava da li', perche' durante la corsa si allarga
   * (vedi updatePetShape in main.js) per lasciare posto alla scia.
   */
  _sprint(dt) {
    const run = this.run;
    const bounds = this.env.bounds();
    const { area } = run;
    run.t += dt;
    if (run.phase === 'ready') {
      if (run.t >= SPRINT.ready) this._sprintPhase('go');
    } else if (run.phase === 'go') {
      const top = SPRINT.speed * area.width;
      run.v = Math.min(top, Math.abs(run.v) + SPRINT.accel * area.width * dt) * run.dir;
      run.x += run.v * dt;
      // Giro di pista: sparita del tutto da un lato, rientra dall'altro.
      const off = bounds.width * 0.8;
      if (run.lap && !run.wrapped && (run.dir > 0 ? run.x > area.x + area.width + off : run.x < area.x - off)) {
        run.x = run.dir > 0 ? area.x - off : area.x + area.width + off;
        run.wrapped = true;
      }
      if ((!run.lap || run.wrapped) && (run.target - run.x) * run.dir < bounds.width * SPRINT.brake) this._sprintPhase('brake');
    } else if (run.phase === 'brake') {
      run.v += (-SPRINT.stiffness * (run.x - run.target) - SPRINT.damping * run.v) * dt;
      run.x += run.v * dt;
      if (run.t >= SPRINT.settle) {
        run.x = run.target;
        run.v = 0;
        this._sprintPhase('proud');
      }
    } else if (run.phase === 'proud' && run.t >= (run.legs > 1 ? SPRINT.look : SPRINT.proud)) {
      if (run.legs === 1) {
        this._endSprint();
        return;
      }
      run.legs -= 1;
      run.target = run.home;
      run.dir = Math.sign(run.home - run.x) || 1;
      this._sprintPhase('ready');
    }

    const x = Math.round(run.x - bounds.width * this.anchors.center);
    const y = Math.round(area.y + area.height - bounds.height * this.anchors.feet);
    this.env.move(x, y);
    // Il renderer sposta la scia all'indietro di quanto e' avanzata la finestra.
    if (run.phase === 'go' || run.phase === 'brake') {
      this.env.emit({ state: 'sprint-move', x, speed: Math.min(1, Math.abs(run.v) / (SPRINT.speed * area.width)) });
    }
  }

  _sprintPhase(phase) {
    this.run.phase = phase;
    this.run.t = 0;
    this.env.emit({ state: 'sprint', phase, dir: this.run.dir });
  }

  _endSprint() {
    this.run = null;
    if (this.state === 'sprint') this.state = 'ground';
    this.env.emit({ state: 'sprint', phase: 'end' });
  }

  _cling(side, bounds, area) {
    const { center, feet } = this.anchors;
    // Il bordo dello schermo passa un po' dentro al corpo: si vede la testa
    // che sbircia, il resto sta fuori.
    const edge = side === 'right' ? center - 0.14 : center + 0.14;
    const x = side === 'right' ? area.x + area.width - bounds.width * edge : area.x - bounds.width * edge;
    const ground = area.y + area.height;
    const y = clamp(bounds.y, area.y - bounds.height * 0.15, ground - bounds.height * (feet + 0.2));
    this.env.move(Math.round(x), Math.round(y));
    this.state = 'edge';
    this.surface = null;
    this.env.emit({ state: 'edge', side, edge });
  }
}

module.exports = { PetPhysics, GRAVITY, MAX_FALL, SPRINT };
