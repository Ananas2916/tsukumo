/**
 * Dove sta la mascotte e su cosa si appoggia, come in Desktop Mate.
 *
 * Stati:
 *  - `ground`  sulla barra delle applicazioni (in piedi, seduta sul bordo o sdraiata);
 *  - `window`  seduta sul bordo superiore di una finestra, con cui viaggia;
 *  - `edge`    aggrappata al bordo sinistro/destro dello schermo, che sbircia;
 *  - `falling` in caduta libera;
 *  - `held`    presa col mouse (la finestra la muove il trascinamento).
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
   */
  constructor(env) {
    this.env = env;
    this.state = 'ground';
    this.posture = 'stand';
    this.vy = 0;
    this.surface = null;
    this.transition = null;
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
    if (this.state === 'ground' || this.state === 'window') {
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

module.exports = { PetPhysics, GRAVITY, MAX_FALL };
