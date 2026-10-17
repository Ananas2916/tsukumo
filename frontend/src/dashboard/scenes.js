/**
 * The six Japanese scenes the agents live in (dashboard/park.js picks one).
 *
 * Each scene gives the park its places: where Tsukumo floats (`tsukumo`), the
 * seats of who's idle (`seats`, sitting, perched or soaking), where who's
 * waiting for you stands (`front`), the water of OpenClaw's lobster (`pond`),
 * LM Studio's spot (`kiosk`), the way in (`gate`), the ground they wander on
 * (`zones`, rectangles or paths) and the two spots to talk to her (`ask`).
 *
 * And it paints itself: `far` (and `near`, drawn over what moves behind it,
 * like the train) into a backdrop repainted once a minute and multiplied by
 * the hour's light; `lights` that glow at dusk; `mid`, `props` and `front`
 * for what moves at every frame; `message` and `party` for its own way of
 * marking a message sent or a job done. `lm` is LM Studio ({model}) or null:
 * its prop shows the model when it runs, and an ordinary stall when it doesn't.
 */

import {
  HEIGHT as H,
  TAU,
  along,
  alpha,
  andon,
  bench,
  cedar,
  chochin,
  clamp,
  deciduous,
  fitText,
  koi,
  lerp,
  mix,
  mul,
  pine,
  pond,
  ridge,
  rock,
  roof,
  seeded,
  shade,
  shimmer,
  shoji,
  speckle,
  steam,
  toro,
  torii,
  verticalText,
  vending,
  yukimi,
} from './scenery.js';

/** Hills in the distance, by season. */
const FOREST = { spring: '#6f9a5e', summer: '#3f6e4d', autumn: '#9a5b3a', winter: '#d9e1ea' };

// ------------------------------------------------------------------ shrine
function hall(ctx, P, season) {
  const { hx, hb, hw } = P;
  ctx.fillStyle = '#a69d8d';
  ctx.fillRect(hx - hw * 0.44, hb - 7, hw * 0.88, 7);
  ctx.fillStyle = '#6a4630';
  ctx.fillRect(hx - hw * 0.46, hb - 13, hw * 0.92, 6);
  ctx.fillStyle = '#efe7d6';
  ctx.fillRect(hx - hw * 0.38, hb - 50, hw * 0.76, 37);
  ctx.fillStyle = '#5a3c29';
  for (const k of [-0.22, 0, 0.22]) ctx.fillRect(hx + k * hw - hw * 0.08, hb - 46, hw * 0.16, 33);
  ctx.strokeStyle = 'rgba(201, 167, 122, 0.6)';
  ctx.lineWidth = 0.8;
  for (const k of [-0.22, 0, 0.22]) {
    const left = hx + k * hw - hw * 0.08;
    ctx.beginPath();
    for (let i = 1; i < 4; i += 1) {
      ctx.moveTo(left + i * hw * 0.04, hb - 46);
      ctx.lineTo(left + i * hw * 0.04, hb - 13);
    }
    for (let j = 1; j < 5; j += 1) {
      ctx.moveTo(left, hb - 46 + j * 6.6);
      ctx.lineTo(left + hw * 0.16, hb - 46 + j * 6.6);
    }
    ctx.stroke();
  }
  ctx.fillStyle = '#c9452c';
  for (const k of [-0.38, -0.11, 0.11, 0.38]) ctx.fillRect(hx + k * hw - 3, hb - 52, 6, 39);
  ctx.fillRect(hx - hw * 0.42, hb - 56, hw * 0.84, 5);
  roof(ctx, hx, hb - 55, hw * 1.15, 46, '#5b8a7f', season.snow);
  // Crossed boards and logs on the ridge: what makes it a shrine, not a temple.
  const rw = hw * 1.15 * 0.28;
  const ry = hb - 101;
  ctx.strokeStyle = '#3d5f57';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  for (const s of [-1, 1]) {
    const ex = hx + s * rw;
    ctx.moveTo(ex - 5, ry + 2);
    ctx.lineTo(ex + 3, ry - 10);
    ctx.moveTo(ex + 5, ry + 2);
    ctx.lineTo(ex - 3, ry - 10);
  }
  ctx.stroke();
  ctx.fillStyle = '#3d5f57';
  for (const k of [-0.5, 0, 0.5]) {
    ctx.beginPath();
    ctx.roundRect(hx + k * rw - 5, ry - 6, 10, 4, 2);
    ctx.fill();
  }
  // The sacred rope and its paper zigzags.
  ctx.strokeStyle = '#d8c58e';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(hx - hw * 0.2, hb - 50);
  ctx.quadraticCurveTo(hx, hb - 40, hx + hw * 0.2, hb - 50);
  ctx.stroke();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.2;
  for (const k of [-0.13, -0.045, 0.045, 0.13]) {
    const x = hx + k * hw;
    const y = hb - 48 + (1 - (k / 0.2) ** 2) * 4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 3, y + 3);
    ctx.lineTo(x - 1, y + 6);
    ctx.lineTo(x + 2, y + 10);
    ctx.stroke();
  }
  ctx.fillStyle = '#8b6a4c';
  for (let i = 0; i < 3; i += 1) ctx.fillRect(hx - hw * 0.12 - i * 2, hb - 13 + i * 4.3, hw * 0.24 + i * 4, 4.3);
  // The offering box under the bell.
  ctx.fillStyle = '#6b4a33';
  ctx.fillRect(hx - 14, hb + 1, 28, 10);
  ctx.fillStyle = '#4e3524';
  for (let i = 0; i < 5; i += 1) ctx.fillRect(hx - 12 + i * 6, hb + 1, 2, 3);
}

/** A votive plaque (ema), the model written on it. */
function ema(ctx, x, y, text) {
  ctx.fillStyle = '#d9b27c';
  ctx.beginPath();
  ctx.moveTo(x - 17, y - 5);
  ctx.lineTo(x, y - 11);
  ctx.lineTo(x + 17, y - 5);
  ctx.lineTo(x + 17, y + 7);
  ctx.lineTo(x - 17, y + 7);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#c8352a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - 3, y - 13);
  ctx.lineTo(x, y - 9);
  ctx.lineTo(x + 3, y - 13);
  ctx.stroke();
  if (text) {
    ctx.fillStyle = '#4a2e1c';
    fitText(ctx, text, x, y + 1.5, 30, 6.5, 700);
  }
}

const shrine = {
  name: 'Shrine',
  pondText: 'in the pond',
  layout(W) {
    const hw = clamp(W * 0.28, 150, 250);
    const hx = W * 0.6;
    const basin = [W * 0.33, 236];
    const water = [W * 0.13, 246, clamp(W * 0.1, 46, 86), 15];
    const seat = [W * 0.8, 232];
    return {
      W,
      hx,
      hb: 140,
      hw,
      bx: W * 0.9,
      bb: 148,
      tx: W * 0.12,
      tb: 198,
      tw: clamp(W * 0.17, 84, 150),
      basin,
      water,
      seat,
      toro: [W * 0.27, W * 0.43, W * 0.79],
      tsukumo: { x: basin[0], y: basin[1] - 15, pool: true },
      seats: [
        { x: seat[0] - 20, y: seat[1] },
        { x: seat[0] + 20, y: seat[1] },
      ],
      front: { x: hx - 20, y: 170 },
      pond: { x: water[0], y: water[1], rx: water[2] * 0.5, ry: water[3] * 0.35 },
      kiosk: { x: W * 0.9, y: 128, w: 70, h: 44 },
      gate: [-14, 166],
      zones: [{ rect: [W * 0.17, 160, W * 0.55, 172] }, { rect: [W * 0.44, 192, W * 0.7, 222] }],
      ask: [
        [basin[0] - 46, basin[1] + 6],
        [basin[0] + 46, basin[1] + 6],
      ],
    };
  },
  far(ctx, P, season, lm) {
    const { W } = P;
    ridge(ctx, W, H, 96, 10, 0.011, '#8d9fc8', 3);
    const random = seeded(7);
    for (let x = -10; x < W + 12; x += 8 + random() * 9) cedar(ctx, x, 126 + random() * 5, 28 + random() * 30, mix('#2f5446', '#1d3a31', random()), season);
    const gravel = ctx.createLinearGradient(0, 120, 0, H);
    gravel.addColorStop(0, season.snow ? '#e9eef5' : '#d9d0bb');
    gravel.addColorStop(1, season.snow ? '#d3dbe6' : '#b8ac93');
    ctx.fillStyle = gravel;
    ctx.fillRect(0, 122, W, H - 122);
    speckle(ctx, 0, 124, W, H - 124, season.snow ? '#b9c3d1' : '#8c826e', Math.round(W * 0.4), 12);
    deciduous(ctx, P.hx - P.hw * 0.66, 134, 78, season, 21);
    deciduous(ctx, P.hx + P.hw * 0.68, 136, 70, season, 22);
    hall(ctx, P, season);
    // The amulet booth: LM Studio, its model on a plaque.
    const { bx, bb } = P;
    ctx.fillStyle = '#7b5538';
    ctx.fillRect(bx - 33, bb - 34, 66, 34);
    ctx.fillStyle = '#f2ece0';
    ctx.fillRect(bx - 28, bb - 29, 56, 14);
    ctx.fillStyle = '#c9452c';
    ctx.fillRect(bx - 28, bb - 15, 56, 3);
    roof(ctx, bx, bb - 33, 84, 18, '#4f5b63', season.snow);
    ema(ctx, bx, bb - 21, lm?.model ?? '');
    ctx.fillStyle = '#f6efe2';
    fitText(ctx, lm ? 'LM Studio' : 'お守り', bx, bb - 5.5, 56, 7, 700);
    // The stone approach to the hall.
    ctx.fillStyle = season.snow ? '#c9d0da' : '#b3ab9b';
    ctx.fillRect(0, 150, P.hx + P.hw * 0.14, 22);
    ctx.fillRect(P.hx - P.hw * 0.14, 140, P.hw * 0.28, 12);
    ctx.strokeStyle = 'rgba(111, 106, 96, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 6; x < P.hx + P.hw * 0.14; x += 17) {
      ctx.moveTo(x, 150);
      ctx.lineTo(x - 3, 172);
    }
    ctx.moveTo(0, 161);
    ctx.lineTo(P.hx + P.hw * 0.14, 161);
    ctx.stroke();
    for (const x of P.toro) toro(ctx, x, 150, 1, season.snow);
    torii(ctx, P.tx, P.tb, P.tw, P.tw * 0.84, '#d2462a', season.snow);
    // The purification basin, a bamboo spout and a ladle.
    const [x, y] = P.basin;
    ctx.fillStyle = '#8f8a83';
    ctx.fillRect(x - 17, y - 13, 34, 13);
    ctx.fillStyle = '#a7a29a';
    ctx.fillRect(x - 18, y - 15, 36, 4);
    ctx.fillStyle = season.snow ? '#cfe0ee' : '#6fa3c6';
    ctx.fillRect(x - 15, y - 14, 30, 2.5);
    ctx.strokeStyle = '#7f9a4a';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(x - 30, y - 24);
    ctx.lineTo(x - 10, y - 17);
    ctx.moveTo(x - 30, y - 24);
    ctx.lineTo(x - 30, y);
    ctx.stroke();
    ctx.strokeStyle = '#c8a46a';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x + 2, y - 15);
    ctx.lineTo(x + 16, y - 21);
    ctx.stroke();
    pond(ctx, ...P.water, season);
    bench(ctx, ...P.seat, season, true);
  },
  lights(P) {
    const lights = P.toro.map((x) => ({ x, y: 125, r: 30, color: '#ffc46e', flicker: 7 }));
    lights.push({ x: P.hx - P.hw * 0.3, y: P.hb - 46, w: P.hw * 0.6, h: 33, color: '#ffb562', a: 0.8 });
    lights.push({ x: P.bx - 28, y: P.bb - 29, w: 56, h: 14, color: '#ffd38a' });
    return lights;
  },
  mid(ctx, view) {
    const { P, sky, clock } = view;
    koi(ctx, P.water, clock, sky.tint);
    // The bell rope swings while someone waits under it for you.
    ctx.save();
    ctx.translate(P.hx, P.hb - 54);
    ctx.rotate(view.waiting ? Math.sin(clock * 7) * 0.1 : Math.sin(clock * 0.8) * 0.015);
    ctx.fillStyle = mul('#d9b04a', sky.tint);
    ctx.beginPath();
    ctx.arc(0, 4, 4.5, 0, TAU);
    ctx.fill();
    ['#c8352a', '#f3efe6', '#6b4aa0', '#f3efe6'].forEach((color, i) => {
      ctx.fillStyle = mul(color, sky.tint);
      ctx.fillRect(-1.6, 8 + i * 6, 3.2, 6);
    });
    ctx.restore();
  },
  props(ctx, view) {
    const [x, y, rx, ry] = view.P.water;
    shimmer(ctx, x, y, rx, ry, view.clock);
  },
};

// --------------------------------------------------------------- zen garden
/** The bamboo deer-scarer: fills, tips into the pond, knocks back on its stone. */
function shishiOdoshi(ctx, view) {
  const { P, sky, clock, state } = view;
  const [px, py, prx] = P.water;
  const sx = px + prx * 0.72;
  const sy = py - 12;
  if (state.tip === undefined || clock - state.tip > 14) state.tip = clock;
  const e = clock - state.tip;
  const rest = Math.PI + 0.42;
  const down = Math.PI - 0.5;
  let angle = rest;
  if (e >= 1.4 && e < 1.7) angle = lerp(rest, down, ((e - 1.4) / 0.3) ** 2);
  else if (e >= 1.7 && e < 1.95) angle = down;
  else if (e >= 1.95 && e < 2.25) angle = lerp(down, rest, ((e - 1.95) / 0.3) ** 2);
  const tube = mul('#9cb35a', sky.tint);
  const post = mul('#5a4332', sky.tint);
  ctx.lineCap = 'round';
  ctx.strokeStyle = post;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(sx + 26, sy - 32);
  ctx.lineTo(sx + 26, sy + 4);
  ctx.stroke();
  ctx.strokeStyle = tube;
  ctx.lineWidth = 3.4;
  ctx.beginPath();
  ctx.moveTo(sx + 26, sy - 30);
  ctx.lineTo(sx - 24, sy - 27);
  ctx.stroke();
  if (e < 1.45 || e > 2.3) {
    ctx.strokeStyle = 'rgba(207, 230, 255, 0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx - 25, sy - 25);
    ctx.lineTo(sx - 25, sy - 16);
    ctx.stroke();
  }
  ctx.fillStyle = post;
  ctx.fillRect(sx - 2, sy - 4, 4, 14);
  ctx.save();
  ctx.translate(sx, sy - 4);
  ctx.rotate(angle);
  ctx.strokeStyle = tube;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(-16, 0);
  ctx.lineTo(28, 0);
  ctx.stroke();
  ctx.strokeStyle = mul('#5f7434', sky.tint);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(6, -2.6);
  ctx.lineTo(6, 2.6);
  ctx.stroke();
  ctx.restore();
  ctx.lineCap = 'butt';
  if (e >= 1.6 && e < 3.6) {
    const k = (e - 1.6) / 2;
    for (let i = 0; i < 2; i += 1) {
      const kk = k - i * 0.25;
      if (kk <= 0) continue;
      ctx.strokeStyle = `rgba(232, 244, 255, ${0.55 * (1 - kk)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(sx - 25, py + 1, 4 + kk * 24, 1.5 + kk * 6, 0, 0, TAU);
      ctx.stroke();
    }
  }
  if (e >= 2.2 && e < 3.2) {
    const k = e - 2.2;
    ctx.fillStyle = `rgba(255, 255, 255, ${1 - k})`;
    ctx.font = `800 11px 'Yu Gothic UI', 'Meiryo', sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('コン', sx + 18, sy - 12 - k * 12);
  }
}

const zen = {
  name: 'Zen garden',
  pondText: 'in the pond',
  layout(W) {
    const water = [W * 0.17, 214, clamp(W * 0.1, 46, 88), 16];
    const islands = [
      [W * 0.5, 186, 1],
      [W * 0.67, 160, 1.2],
      [W * 0.83, 198, 0.85],
    ];
    const tea = [W * 0.13, 142, clamp(W * 0.15, 80, 120)];
    const stones = { a: [W * 0.44, 236], c: [W * 0.34, 172], b: [W * 0.19, 148] };
    const cushions = [W * 0.56, W * 0.64, W * 0.72];
    return {
      W,
      water,
      islands,
      tea,
      stones,
      cushions,
      maple: [W * 0.96, 224],
      yuki: [W * 0.27, 200],
      ver: 238,
      lamp: W * 0.07,
      tsukumo: { x: islands[1][0], y: islands[1][1], pool: true },
      seats: cushions.map((x) => ({ x, y: 262 })),
      front: { x: W * 0.84, y: 264 },
      pond: { x: water[0] - water[2] * 0.15, y: water[1], rx: water[2] * 0.4, ry: water[3] * 0.3 },
      kiosk: { x: tea[0], y: tea[1] - 22, w: tea[2], h: 50 },
      gate: [-14, 262],
      zones: [{ path: stones }, { rect: [W * 0.13, 258, W * 0.48, 266] }],
      ask: [
        [W * 0.6, 248],
        [W * 0.74, 248],
      ],
    };
  },
  far(ctx, P, season, lm) {
    const { W } = P;
    ridge(ctx, W, H, 90, 8, 0.013, '#93a5cc', 5);
    const random = seeded(31);
    for (let x = -20; x < W + 30; x += 34 + random() * 30) deciduous(ctx, x, 112, 46 + random() * 22, season, 100 + Math.round(x), random() > 0.5 ? 'maple' : 'sakura');
    pine(ctx, W * 0.4, 110, 72, season);
    // The old clay wall, its tile cap, its oil stains.
    ctx.fillStyle = '#cfae7b';
    ctx.fillRect(0, 102, W, 30);
    for (let i = 0; i < 26; i += 1) {
      const x = random() * W;
      const w = 10 + random() * 40;
      const stain = ctx.createLinearGradient(0, 104, 0, 132);
      stain.addColorStop(0, 'rgba(138, 106, 68, 0)');
      stain.addColorStop(1, `rgba(138, 106, 68, ${0.25 + random() * 0.2})`);
      ctx.fillStyle = stain;
      ctx.fillRect(x, 104, w, 28);
    }
    ctx.fillStyle = '#474b55';
    ctx.fillRect(0, 96, W, 7);
    ctx.fillStyle = '#5b606b';
    ctx.fillRect(0, 95, W, 2);
    ctx.fillStyle = '#3a3e47';
    for (let x = 0; x < W; x += 6) ctx.fillRect(x, 100, 1, 3);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.fillRect(0, 103, W, 3);
    if (season.snow) {
      ctx.fillStyle = '#f2f5fa';
      ctx.fillRect(0, 93, W, 3.5);
    }
    // Raked gravel, rippling around the islands.
    const base = season.snow ? '#f1f4f8' : '#e9e5da';
    ctx.fillStyle = base;
    ctx.fillRect(0, 132, W, P.ver - 132);
    ctx.strokeStyle = season.snow ? '#d7dee8' : '#cdc7b8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = 136; y < P.ver; y += 4.5) {
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();
    for (const [x, y, s] of P.islands) {
      const rx = 66 * s;
      const ry = 19 * s;
      ctx.fillStyle = base;
      ctx.beginPath();
      ctx.ellipse(x, y, rx + 4, ry + 3, 0, 0, TAU);
      ctx.fill();
      for (let k = 0; k < 4; k += 1) {
        ctx.beginPath();
        ctx.ellipse(x, y, rx - k * 9 * s, ry - k * 2.6 * s, 0, 0, TAU);
        ctx.stroke();
      }
      ctx.fillStyle = season.snow ? '#e3e9f0' : season.name === 'autumn' ? '#7b7d48' : '#5f8448';
      ctx.beginPath();
      ctx.ellipse(x, y, 30 * s, 8.5 * s, 0, 0, TAU);
      ctx.fill();
      rock(ctx, x - 8 * s, y + 2, 26 * s, 20 * s, '#7f7b75', Math.round(x), season.snow);
      rock(ctx, x + 12 * s, y + 3, 16 * s, 11 * s, '#8c8780', Math.round(x) + 1, season.snow);
    }
    for (let i = 0; i <= 9; i += 1) {
      const [x, y] = along(P.stones, i / 9);
      ctx.fillStyle = '#a19b90';
      ctx.beginPath();
      ctx.ellipse(x, y, 9 - i * 0.25, 3.6 - i * 0.12, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.beginPath();
      ctx.ellipse(x - 2, y - 1, 4, 1.2, 0, 0, TAU);
      ctx.fill();
    }
    // The tea house: LM Studio, its model on the plaque under the eave.
    const [tx, tb, tw] = P.tea;
    ctx.fillStyle = '#9b938a';
    ctx.fillRect(tx - tw * 0.46, tb - 5, tw * 0.92, 5);
    ctx.fillStyle = '#c9b48c';
    ctx.fillRect(tx - tw * 0.42, tb - 40, tw * 0.84, 35);
    ctx.fillStyle = '#4e3626';
    for (const k of [-0.42, -0.1, 0.42]) ctx.fillRect(tx + k * tw - 2, tb - 42, 4, 37);
    const wx = tx - tw * 0.26;
    ctx.fillStyle = '#efe6cf';
    ctx.beginPath();
    ctx.arc(wx, tb - 22, 8, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#4e3626';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(wx, tb - 22, 8, 0, TAU);
    ctx.moveTo(wx, tb - 30);
    ctx.lineTo(wx, tb - 14);
    ctx.moveTo(wx - 8, tb - 22);
    ctx.lineTo(wx + 8, tb - 22);
    ctx.stroke();
    ctx.fillStyle = '#6b4a30';
    ctx.fillRect(tx + tw * 0.05, tb - 18, 15, 13);
    shoji(ctx, tx + tw * 0.2, tb - 34, tw * 0.18, 22);
    roof(ctx, tx, tb - 40, tw * 1.22, 30, '#6f6046', season.snow, 0.15);
    ctx.fillStyle = '#3b2a1e';
    ctx.fillRect(tx - 21, tb - 38, 42, 16);
    if (lm) {
      ctx.fillStyle = '#e9d9b8';
      fitText(ctx, 'LM Studio', tx, tb - 33.5, 38, 5.6, 500);
      ctx.fillStyle = '#ffffff';
      fitText(ctx, lm.model || '—', tx, tb - 26.5, 38, 7, 700);
    } else {
      ctx.fillStyle = '#e9d9b8';
      fitText(ctx, '茶室', tx, tb - 30, 38, 10, 700);
    }
    yukimi(ctx, ...P.yuki, 1, season.snow);
    pond(ctx, ...P.water, season, 6);
    rock(ctx, P.water[0] + P.water[2] * 0.72 + 15, P.water[1] - 6, 11, 5, '#8d8982', 81, season.snow);
    deciduous(ctx, ...P.maple, 132, season, 77, 'maple');
    // The veranda you look out from, the house's posts and eave, a bamboo blind.
    const v = P.ver;
    ctx.fillStyle = '#3c2a1e';
    ctx.fillRect(0, v, W, 5);
    const boards = ctx.createLinearGradient(0, v + 5, 0, H);
    boards.addColorStop(0, '#8a6242');
    boards.addColorStop(1, '#6b4a32');
    ctx.fillStyle = boards;
    ctx.fillRect(0, v + 5, W, H - v - 5);
    ctx.strokeStyle = 'rgba(74, 50, 34, 0.6)';
    ctx.beginPath();
    for (const y of [v + 12, v + 20, v + 29]) {
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();
    for (const x of P.cushions) {
      ctx.fillStyle = '#4b3f86';
      ctx.beginPath();
      ctx.roundRect(x - 15, 250, 30, 8, 3);
      ctx.fill();
      ctx.fillStyle = '#5d50a0';
      ctx.fillRect(x - 13, 250, 26, 2);
    }
    andon(ctx, P.lamp, 256);
    ctx.fillStyle = '#2e221a';
    ctx.fillRect(0, 0, 10, v + 5);
    ctx.fillRect(W - 10, 0, 10, v + 5);
    ctx.fillStyle = '#261c16';
    ctx.fillRect(0, 0, W, 8);
    ctx.fillStyle = '#c8ae72';
    ctx.fillRect(W * 0.64, 8, W * 0.36 - 10, 22);
    ctx.fillStyle = '#a88f58';
    for (let y = 10; y < 30; y += 2) ctx.fillRect(W * 0.64, y, W * 0.36 - 10, 0.7);
    ctx.fillStyle = '#7d6a40';
    ctx.fillRect(W * 0.64, 29, W * 0.36 - 10, 3);
  },
  lights(P) {
    const [tx, tb, tw] = P.tea;
    return [
      { x: P.yuki[0], y: P.yuki[1] - 18, r: 30, color: '#ffc46e', flicker: 6 },
      { x: tx + tw * 0.2, y: tb - 34, w: tw * 0.18, h: 22, color: '#ffbf70' },
      { x: tx - tw * 0.26, y: tb - 22, r: 16, color: '#ffbf70' },
      { x: P.lamp, y: 243, r: 38, color: '#ffcf80', flicker: 4 },
    ];
  },
  props(ctx, view) {
    const [x, y, rx, ry] = view.P.water;
    shimmer(ctx, x, y, rx, ry, view.clock);
    shishiOdoshi(ctx, view);
  },
  /** A message: the bamboo tips now, not at its next turn. */
  message(state, clock) {
    if (state.tip === undefined || clock - state.tip > 3.6) state.tip = clock - 1.2;
  },
};

// ---------------------------------------------------------- summer festival
const STALLS = {
  kingyo: { sign: '金魚すくい', ink: '#1f5fae', stripe: '#2f7fd0', cloth: '#2f7fd0' },
  tako: { sign: 'たこ焼き', ink: '#c8352a', stripe: '#d8432f', cloth: '#d8432f' },
  kori: { sign: 'かき氷', ink: '#1f5fae', stripe: '#d8432f', cloth: '#e9e4d6' },
  omen: { sign: 'お面', ink: '#2d2a2a', stripe: '#3a8f5c', cloth: '#3a8f5c' },
  lm: { sign: 'LM Studio', ink: '#6b4fd8', stripe: '#8c6cf0', cloth: '#8c6cf0' },
  yoyo: { sign: 'ヨーヨー', ink: '#c8352a', stripe: '#e88aa8', cloth: '#e88aa8' },
};

function stallGoods(ctx, x, b, w, kind, lm) {
  if (kind === 'kingyo') {
    for (let i = 0; i < 4; i += 1) {
      const bx = x - w * 0.3 + i * w * 0.2;
      ctx.strokeStyle = '#d9d2c4';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(bx, b - 62);
      ctx.lineTo(bx, b - 54);
      ctx.stroke();
      ctx.fillStyle = 'rgba(207, 232, 255, 0.85)';
      ctx.beginPath();
      ctx.ellipse(bx, b - 48, 4, 5.5, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#f07a2e';
      ctx.fillRect(bx - 1.5, b - 48, 3, 1.6);
    }
  } else if (kind === 'tako') {
    ctx.fillStyle = '#1f1d22';
    ctx.fillRect(x - w * 0.3, b - 32, w * 0.6, 6);
    ctx.fillStyle = '#c98a3e';
    for (let i = 0; i < 8; i += 1) {
      ctx.beginPath();
      ctx.arc(x - w * 0.26 + i * w * 0.075, b - 32, 2.6, Math.PI, 0);
      ctx.fill();
    }
  } else if (kind === 'kori') {
    // The shaved-ice flag: 氷 over blue waves.
    const fx = x + w * 0.14;
    ctx.fillStyle = '#f7f4ec';
    ctx.fillRect(fx, b - 62, 22, 26);
    ctx.fillStyle = '#2f7fd0';
    ctx.fillRect(fx, b - 42, 22, 6);
    ctx.fillStyle = '#d8432f';
    fitText(ctx, '氷', fx + 11, b - 52, 18, 14, 800);
    ['#d8432f', '#3fae6a', '#2f7fd0'].forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.fillRect(x - w * 0.3 + i * 7, b - 36, 4, 10);
    });
  } else if (kind === 'omen') {
    for (let i = 0; i < 4; i += 1) {
      const mx = x - w * 0.3 + i * w * 0.2;
      const my = b - 44;
      ctx.fillStyle = ['#f6f1e8', '#e2463a', '#f6f1e8', '#3a7bd5'][i];
      if (i % 2 === 0) {
        // A fox, ears up.
        ctx.beginPath();
        ctx.moveTo(mx - 6, my - 4);
        ctx.lineTo(mx - 4, my - 11);
        ctx.lineTo(mx - 1, my - 5);
        ctx.lineTo(mx + 1, my - 5);
        ctx.lineTo(mx + 4, my - 11);
        ctx.lineTo(mx + 6, my - 4);
        ctx.closePath();
        ctx.fill();
      }
      ctx.beginPath();
      ctx.ellipse(mx, my, 6, 7, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = i % 2 === 0 ? '#c8352a' : '#1d1a1a';
      ctx.fillRect(mx - 4, my - 2, 2.5, 1.2);
      ctx.fillRect(mx + 1.5, my - 2, 2.5, 1.2);
    }
  } else if (kind === 'lm') {
    ctx.fillStyle = '#f7f2e6';
    ctx.fillRect(x - 27, b - 41, 54, 13);
    ctx.fillStyle = '#2a1f45';
    fitText(ctx, lm?.model || '—', x, b - 34.5, 50, 8, 700);
    ['#c6b3ff', '#9d84ff', '#f4a6dc'].forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.fillRect(x - w * 0.34 + i * 8, b - 56, 5, 5);
    });
  } else {
    // Water balloons on strings.
    ['#f4a6c8', '#7cc0f0', '#ffd36b', '#9be08a', '#c6b3ff'].forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x - w * 0.3 + i * w * 0.15, b - 34, 4.2, 0, TAU);
      ctx.fill();
    });
  }
}

function stall(ctx, x, b, w, kind, season, lm) {
  const look = STALLS[kind];
  const left = x - w / 2;
  const right = x + w / 2;
  ctx.fillStyle = '#2d2226';
  ctx.fillRect(left + 4, b - 62, w - 8, 40);
  ctx.fillStyle = '#5b4030';
  ctx.fillRect(left + 2, b - 70, 4, 70);
  ctx.fillRect(right - 6, b - 70, 4, 70);
  stallGoods(ctx, x, b, w, kind, lm);
  ctx.fillStyle = '#7a5a40';
  ctx.fillRect(left, b - 26, w, 4);
  ctx.fillStyle = look.cloth;
  ctx.fillRect(left + 2, b - 22, w - 4, 22);
  if (kind === 'kingyo') {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 1;
    for (let wx = left + 6; wx < right - 8; wx += 10) {
      ctx.beginPath();
      ctx.arc(wx + 5, b - 9, 5, Math.PI, 0);
      ctx.stroke();
    }
  }
  ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
  ctx.fillRect(left + 2, b - 6, w - 4, 6);
  // The striped awning with its scalloped edge, bulbs under it.
  const top = b - 78;
  const eave = b - 64;
  const n = 9;
  const step = (w + 12) / n;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(left - 6, eave);
  ctx.lineTo(right + 6, eave);
  ctx.lineTo(right - 4, top);
  ctx.lineTo(left + 4, top);
  ctx.closePath();
  ctx.clip();
  for (let i = 0; i < n; i += 1) {
    ctx.fillStyle = i % 2 ? '#f4efe4' : look.stripe;
    ctx.fillRect(left - 6 + i * step, top, step + 0.5, eave - top);
  }
  ctx.restore();
  for (let i = 0; i < n; i += 1) {
    ctx.fillStyle = i % 2 ? '#f4efe4' : look.stripe;
    ctx.beginPath();
    ctx.arc(left - 6 + (i + 0.5) * step, eave, step / 2, 0, Math.PI);
    ctx.fill();
  }
  ctx.fillStyle = '#fff3c4';
  for (let i = 0; i < 4; i += 1) {
    ctx.beginPath();
    ctx.arc(left + 10 + (i * (w - 20)) / 3, b - 58, 2, 0, TAU);
    ctx.fill();
  }
  if (season.snow) {
    ctx.fillStyle = '#f4f7fb';
    ctx.fillRect(left + 4, top - 2, w - 8, 3);
  }
  ctx.fillStyle = '#f7f2e6';
  ctx.fillRect(x - w * 0.42, top - 17, w * 0.84, 15);
  ctx.strokeStyle = '#2b2020';
  ctx.lineWidth = 1;
  ctx.strokeRect(x - w * 0.42 + 0.5, top - 16.5, w * 0.84 - 1, 14);
  ctx.fillStyle = look.ink;
  fitText(ctx, look.sign, x, top - 9.5, w * 0.76, 11, 800);
}

/** Two strings of paper lanterns across the sky: [x, y, red, marked, string]. */
function lanternSpots(W) {
  const spots = [];
  [
    [26, 22, 46, 10],
    [40, 18, 52, 36],
  ].forEach(([y0, sag, step, offset], string) => {
    let i = 0;
    for (let x = offset; x < W; x += step, i += 1) spots.push([x, y0 + sag * (1 - ((2 * x) / W - 1) ** 2) + 9, i % 2 === 0, i % 3 === 0, string]);
  });
  return spots;
}

const FIREWORK_COLORS = ['#ffcf6b', '#ff7ab8', '#8fd3ff', '#b6ff9a', '#ffa45c'];

function launch(state, clock, W, count = 1) {
  state.fireworks ??= [];
  for (let i = 0; i < count; i += 1) {
    const n = (state.launched = (state.launched ?? 0) + 1);
    state.fireworks.push({ t0: clock + i * 0.7, x: W * (0.2 + ((n * 0.37) % 0.65)), top: 34 + ((n * 13) % 28), color: FIREWORK_COLORS[n % FIREWORK_COLORS.length], seed: n });
  }
}

const festival = {
  name: 'Summer festival',
  pondText: 'in the goldfish tub',
  layout(W) {
    const sw = clamp(W * 0.17, 92, 150);
    const tub = [W * 0.15, 228, clamp(W * 0.11, 52, 96), 15];
    const seat = [W * 0.74, 238];
    return {
      W,
      sw,
      base: 172,
      pagoda: W * 0.78,
      stalls: [
        [0.09, 'kingyo'],
        [0.27, 'tako'],
        [0.46, 'kori'],
        [0.66, 'omen'],
        [0.87, 'lm'],
      ].map(([f, kind]) => [W * f, kind]),
      tub,
      seat,
      tsukumo: { x: W * 0.365, y: 128, pool: false },
      seats: [
        { x: seat[0] - 20, y: seat[1] },
        { x: seat[0] + 20, y: seat[1] },
      ],
      front: { x: W * 0.44, y: 256 },
      pond: { x: tub[0], y: tub[1] + 2, rx: tub[2] * 0.45, ry: tub[3] * 0.3 },
      kiosk: { x: W * 0.87, y: 132, w: sw, h: 90 },
      gate: [-14, 204],
      zones: [{ rect: [W * 0.2, 188, W * 0.84, 222] }],
      ask: [
        [W * 0.3, 196],
        [W * 0.43, 196],
      ],
    };
  },
  far(ctx, P, season) {
    const { W } = P;
    // A five-storey pagoda over the trees.
    const color = '#4a3f52';
    let y = 150;
    for (let i = 0; i < 5; i += 1) {
      const w = 44 - i * 5;
      ctx.fillStyle = color;
      ctx.fillRect(P.pagoda - w * 0.3, y - 9, w * 0.6, 9);
      y -= 9;
      roof(ctx, P.pagoda, y, w, 7, color, season.snow, 0.5);
      y -= 6;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(P.pagoda, y);
    ctx.lineTo(P.pagoda, y - 22);
    for (let i = 0; i < 5; i += 1) {
      ctx.moveTo(P.pagoda - 3, y - 4 - i * 3.5);
      ctx.lineTo(P.pagoda + 3, y - 4 - i * 3.5);
    }
    ctx.stroke();
    const random = seeded(41);
    const leaf = season.leaf ? shade(season.leaf, -0.35) : '#4f4a52';
    const puffs = [];
    for (let x = -20; x < W + 20; x += 16 + random() * 14) {
      const r = 16 + random() * 16;
      puffs.push([x, 150 - r * 0.9 - random() * 10, r, random()]);
    }
    for (const [x, py, r, k] of puffs) {
      ctx.fillStyle = mix(leaf, '#1f2c2a', k * 0.4);
      ctx.beginPath();
      ctx.arc(x, py, r, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = mix(leaf, '#1f2c2a', 0.2);
    ctx.fillRect(0, 134, W, 16);
    if (season.snow) {
      ctx.fillStyle = '#eef2f8';
      for (const [x, py, r] of puffs) {
        ctx.beginPath();
        ctx.ellipse(x, py - r * 0.6, r * 0.7, r * 0.3, 0, Math.PI, 0);
        ctx.fill();
      }
    }
    const earth = ctx.createLinearGradient(0, 146, 0, H);
    earth.addColorStop(0, season.snow ? '#e6ebf2' : '#9a8164');
    earth.addColorStop(1, season.snow ? '#cdd5e0' : '#6f5a44');
    ctx.fillStyle = earth;
    ctx.fillRect(0, 146, W, H - 146);
    speckle(ctx, 0, 150, W, H - 150, season.snow ? '#aeb8c6' : '#4f3f30', Math.round(W * 0.33), 44);
  },
  near(ctx, P, season, lm) {
    const { W } = P;
    for (const [x, kind] of P.stalls) stall(ctx, x, P.base, P.sw, kind === 'lm' && !lm ? 'yoyo' : kind, season, lm);
    ctx.strokeStyle = '#2a2224';
    ctx.lineWidth = 1;
    for (const [y0, sag] of [
      [26, 22],
      [40, 18],
    ]) {
      ctx.beginPath();
      for (let x = -10; x <= W + 10; x += 6) {
        const y = y0 + sag * (1 - ((2 * x) / W - 1) ** 2);
        if (x === -10) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (const [x, y, red, marked] of lanternSpots(W)) chochin(ctx, x, y, 11, 14, red ? '#d8432f' : '#f4eee2', marked ? '祭' : '');
    // The goldfish tub, paper scoops on its rim.
    const [x, y, rx, ry] = P.tub;
    ctx.fillStyle = '#2a6fb8';
    ctx.beginPath();
    ctx.roundRect(x - rx - 6, y - ry - 4, (rx + 6) * 2, (ry + 4) * 2 + 6, 10);
    ctx.fill();
    ctx.fillStyle = '#4c9be0';
    ctx.beginPath();
    ctx.roundRect(x - rx - 6, y - ry - 4, (rx + 6) * 2, (ry + 4) * 2, 10);
    ctx.fill();
    ctx.fillStyle = '#7cc0f0';
    ctx.beginPath();
    ctx.roundRect(x - rx, y - ry, rx * 2, ry * 2, 8);
    ctx.fill();
    for (const dx of [-rx + 4, rx - 14]) {
      ctx.strokeStyle = '#f4a6c8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + dx, y + ry + 3);
      ctx.lineTo(x + dx + 10, y + ry + 6);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.beginPath();
      ctx.arc(x + dx - 3, y + ry + 2, 4, 0, TAU);
      ctx.fill();
    }
    bench(ctx, ...P.seat, season, false);
  },
  lights(P) {
    const lights = lanternSpots(P.W).map(([x, y, red]) => ({ x, y, r: 26, color: red ? '#ff8a5a' : '#ffe0a0', flicker: 5 }));
    for (const [x] of P.stalls) {
      lights.push({ x: x - P.sw / 2 + 4, y: P.base - 62, w: P.sw - 8, h: 40, color: '#ff9f5a', a: 0.45 });
      for (let i = 0; i < 4; i += 1) lights.push({ x: x - P.sw / 2 + 10 + (i * (P.sw - 20)) / 3, y: P.base - 58, r: 16, color: '#ffd27a' });
    }
    return lights;
  },
  /** Fireworks, behind the lanterns: one per message, two per job done, now and then after dark. */
  mid(ctx, view) {
    const { W, sky, clock, state } = view;
    if (sky.lamps > 0.5 && clock - (state.ambient ?? -99) > 28) {
      state.ambient = clock;
      launch(state, clock, W);
    }
    state.fireworks = (state.fireworks ?? []).filter((item) => clock - item.t0 < 3.6);
    const dark = 1 - sky.light * 0.6;
    for (const item of state.fireworks) {
      const e = clock - item.t0;
      if (e < 0) continue;
      const { x, top, color } = item;
      if (e < 0.9) {
        const k = e / 0.9;
        ctx.fillStyle = `rgba(255, 242, 201, ${0.9 * dark})`;
        ctx.fillRect(x - 0.8, lerp(150, top, 1 - (1 - k) * (1 - k)), 1.6, 6);
        continue;
      }
      const k = (e - 0.9) / 2.7;
      const random = seeded(item.seed);
      const radius = 46 * (1 - (1 - Math.min(1, k * 1.6)) ** 3);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      if (k < 0.25) {
        const flash = ctx.createRadialGradient(x, top, 0, x, top, 90);
        flash.addColorStop(0, alpha(color, (0.25 - k) * 1.2 * dark));
        flash.addColorStop(1, alpha(color, 0));
        ctx.fillStyle = flash;
        ctx.fillRect(x - 90, top - 90, 180, 180);
      }
      for (let i = 0; i < 34; i += 1) {
        const angle = (i / 34) * TAU + random() * 0.1;
        const r = radius * (0.85 + random() * 0.25);
        const px = x + Math.cos(angle) * r;
        const py = top + Math.sin(angle) * r + k * k * 26;
        ctx.strokeStyle = alpha(color, (1 - k) * 0.4 * dark);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(angle) * r * 0.75, top + Math.sin(angle) * r * 0.75 + k * k * 20);
        ctx.lineTo(px, py);
        ctx.stroke();
        ctx.fillStyle = alpha(color, (1 - k) * dark);
        ctx.beginPath();
        ctx.arc(px, py, 1.6, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  },
  props(ctx, view) {
    const { sky, clock } = view;
    const [x, y, rx, ry] = view.P.tub;
    for (let i = 0; i < 6; i += 1) {
      const phase = clock * (0.7 + i * 0.11) + i * 1.3;
      ctx.save();
      ctx.translate(x + Math.cos(phase) * rx * 0.75, y + Math.sin(phase * 1.3) * ry * 0.6);
      ctx.rotate(Math.atan2(Math.cos(phase * 1.3) * ry * 0.78, -Math.sin(phase) * rx * 0.75));
      ctx.fillStyle = mul(i % 3 === 2 ? '#1f1d22' : '#f2652a', sky.tint);
      ctx.beginPath();
      ctx.ellipse(0, 0, 3.6, 1.6, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-3, 0);
      ctx.lineTo(-6.5, -2.4);
      ctx.lineTo(-6.5, 2.4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    shimmer(ctx, x, y, rx, ry, clock, 0.5);
  },
  message(state, clock, W) {
    launch(state, clock, W);
  },
  party(state, clock, W) {
    launch(state, clock, W, 2);
  },
};

// ------------------------------------------------------------------- onsen
const onsen = {
  name: 'Hot spring',
  pondText: 'in the cold tub',
  layout(W) {
    const r1 = clamp(W * 0.34, 130, 320);
    const bath = [W * 0.66, 222, clamp(W * 0.19, 96, 180), 26];
    const [bx, by, brx] = bath;
    const vend = [r1 + 28, 202];
    const tub = [W * 0.92, 236];
    return {
      W,
      r1,
      rb: 188,
      vend,
      bath,
      tub,
      fuji: W * 0.64,
      fence: r1 + 52,
      lamps: [
        [r1 + 64, 214],
        [W * 0.82, 190],
      ],
      tsukumo: { x: bx, y: by - 18, pool: true },
      seats: [
        { x: bx - brx * 0.5, y: by - 4, pose: 'soak' },
        { x: bx + brx * 0.45, y: by + 4, pose: 'soak' },
        { x: bx + brx * 0.02, y: by + 10, pose: 'soak' },
      ],
      front: { x: vend[0] + 6, y: 260 },
      pond: { x: tub[0], y: tub[1] + 2, rx: 5, ry: 1.5 },
      kiosk: { x: vend[0], y: vend[1] - 27, w: 34, h: 54 },
      gate: [-14, 194],
      zones: [{ rect: [16, 193, r1 - 54, 195] }, { rect: [W * 0.04, 250, W * 0.3, 262] }],
      ask: [
        [bx - 50, 264],
        [bx + 50, 264],
      ],
    };
  },
  far(ctx, P, season, lm) {
    const { W } = P;
    // Mount Fuji; its snow cap follows the season.
    const fx = P.fuji;
    const hw = clamp(W * 0.42, 170, 400);
    const foot = 134;
    const peak = 38;
    const body = ctx.createLinearGradient(0, peak, 0, foot);
    body.addColorStop(0, '#8296c8');
    body.addColorStop(1, '#5d74a6');
    const mountain = new Path2D();
    mountain.moveTo(fx - hw, foot);
    mountain.quadraticCurveTo(fx - hw * 0.32, foot - 30, fx - 16, peak);
    mountain.lineTo(fx - 6, peak - 2);
    mountain.lineTo(fx + 4, peak + 1);
    mountain.lineTo(fx + 16, peak);
    mountain.quadraticCurveTo(fx + hw * 0.32, foot - 30, fx + hw, foot);
    mountain.closePath();
    ctx.fillStyle = body;
    ctx.fill(mountain);
    const line = { winter: 98, spring: 76, autumn: 66, summer: 50 }[season.name];
    const random = seeded(17);
    ctx.save();
    ctx.clip(mountain);
    ctx.fillStyle = '#f4f6fb';
    ctx.beginPath();
    ctx.moveTo(fx - hw, peak - 10);
    ctx.lineTo(fx + hw, peak - 10);
    let streak = false;
    for (let x = fx + hw; x >= fx - hw; x -= 6) {
      ctx.lineTo(x, line + (streak ? 9 : 0) + (random() - 0.5) * 6);
      streak = !streak;
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    const forest = FOREST[season.name];
    ridge(ctx, W, H, 130, 8, 0.02, forest, 13);
    ridge(ctx, W, H, 144, 6, 0.03, shade(forest, -0.15), 14);
    const dots = { spring: ['#f4b8cc', '#ffffff'], summer: ['#4f8a55', '#2f5a3e'], autumn: ['#e05a2e', '#f0a43a', '#c9402a'], winter: ['#5d6a63', '#8a9490'] }[season.name];
    for (let i = 0; i < W * 0.18; i += 1) {
      ctx.fillStyle = dots[i % dots.length];
      ctx.beginPath();
      ctx.arc(random() * W, 136 + random() * 14, 1.4 + random() * 2, 0, TAU);
      ctx.fill();
    }
    const ground = ctx.createLinearGradient(0, 150, 0, H);
    ground.addColorStop(0, season.snow ? '#e9eef5' : '#8a8f78');
    ground.addColorStop(1, season.snow ? '#d3dbe6' : '#6b705d');
    ctx.fillStyle = ground;
    ctx.fillRect(0, 150, W, H - 150);
    deciduous(ctx, P.fence + 20, 166, 96, season, 61, 'maple');
    // The bamboo fence behind the bath.
    for (let x = P.fence; x < W; x += 4) {
      ctx.fillStyle = Math.floor(x / 4) % 2 ? '#b9a66b' : '#a8955d';
      ctx.fillRect(x, 152 + ((x * 7) % 3), 4, 26);
    }
    ctx.fillStyle = '#5a4630';
    ctx.fillRect(P.fence, 158, W - P.fence, 2.4);
    ctx.fillRect(P.fence, 170, W - P.fence, 2.4);
    ctx.fillStyle = '#7b6a48';
    ctx.fillRect(P.fence, 150, W - P.fence, 3);
    if (season.snow) {
      ctx.fillStyle = '#f4f7fb';
      ctx.fillRect(P.fence, 147, W - P.fence, 3.5);
    }
    // The inn: two floors of paper windows, a balcony, the bath's blue curtain.
    const R = P.r1;
    const b = P.rb;
    ctx.fillStyle = '#5b402f';
    ctx.fillRect(-4, b - 46, R + 4, 46);
    ctx.fillStyle = '#634634';
    ctx.fillRect(-4, b - 92, R - 14, 40);
    for (let x = 10; x + 24 < R - 44; x += 34) shoji(ctx, x, b - 40, 24, 26);
    for (let x = 14; x + 22 < R - 20; x += 34) shoji(ctx, x, b - 86, 22, 22);
    ctx.fillStyle = '#4a3324';
    ctx.fillRect(-4, b - 66, R - 14, 2);
    for (let x = 0; x < R - 14; x += 6) ctx.fillRect(x, b - 66, 1.4, 10);
    ctx.fillStyle = '#3c434c';
    ctx.beginPath();
    ctx.moveTo(-6, b - 50);
    ctx.lineTo(R + 10, b - 50);
    ctx.lineTo(R + 4, b - 57);
    ctx.lineTo(-6, b - 57);
    ctx.closePath();
    ctx.fill();
    if (season.snow) {
      ctx.fillStyle = '#f3f6fb';
      ctx.fillRect(-6, b - 59, R + 12, 3);
    }
    roof(ctx, (R - 14) / 2, b - 92, R + 40, 28, '#3c434c', season.snow, 0.3);
    const door = R - 26;
    ctx.fillStyle = '#2a1d16';
    ctx.fillRect(door - 16, b - 42, 32, 42);
    ctx.fillStyle = '#2f4f8a';
    for (let i = 0; i < 3; i += 1) ctx.fillRect(door - 15 + i * 10.3, b - 42, 9.4, 20);
    ctx.fillStyle = '#ffffff';
    fitText(ctx, 'ゆ', door, b - 33, 20, 13, 800);
    ctx.fillStyle = '#8a6545';
    ctx.fillRect(-4, b, R + 18, 8);
    ctx.fillStyle = '#6d4e35';
    ctx.fillRect(-4, b + 8, R + 18, 3);
    vending(ctx, ...P.vend, lm ? 'LM Studio' : '', lm?.model ?? '', lm ? '#7b5be6' : '#3a7bd5');
    // The bath: stones around milky water.
    const [bx, by, brx, bry] = P.bath;
    ctx.fillStyle = '#6f6c66';
    ctx.beginPath();
    ctx.ellipse(bx, by, brx + 10, bry + 8, 0, 0, TAU);
    ctx.fill();
    const water = ctx.createLinearGradient(0, by - bry, 0, by + bry);
    water.addColorStop(0, '#a3d6de');
    water.addColorStop(1, '#5fa6b9');
    ctx.fillStyle = water;
    ctx.beginPath();
    ctx.ellipse(bx, by, brx, bry, 0, 0, TAU);
    ctx.fill();
    const stones = [];
    const n = Math.round(brx / 8);
    for (let i = 0; i < n; i += 1) {
      const angle = (i / n) * TAU;
      stones.push([bx + Math.cos(angle) * (brx + 6), by + Math.sin(angle) * (bry + 5) + 4, i, Math.sin(angle) > 0]);
    }
    stones.sort((a, c) => a[1] - c[1]);
    for (const [x, y, i, front] of stones) rock(ctx, x, y, 14 + random() * 12, 6 + random() * 6 + (front ? 2 : 0), mix('#7d7a73', '#9a968e', random()), 200 + i, season.snow);
    // The cold tub, and its sign.
    const [ox, oy] = P.tub;
    ctx.fillStyle = '#9b7348';
    ctx.fillRect(ox - 30, oy, 60, 14);
    ctx.beginPath();
    ctx.ellipse(ox, oy + 14, 30, 9, 0, 0, Math.PI);
    ctx.fill();
    ctx.strokeStyle = '#4a4f57';
    ctx.lineWidth = 1.6;
    for (const y of [oy + 4, oy + 12]) {
      ctx.beginPath();
      ctx.ellipse(ox, y, 30, 9, 0, 0, Math.PI);
      ctx.stroke();
    }
    ctx.fillStyle = '#c49a68';
    ctx.beginPath();
    ctx.ellipse(ox, oy, 30, 9, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#a9dcef';
    ctx.beginPath();
    ctx.ellipse(ox, oy + 1, 27, 6.5, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#5b402f';
    ctx.fillRect(ox + 36, oy - 22, 2, 34);
    ctx.fillStyle = '#e9dcc0';
    ctx.fillRect(ox + 31, oy - 28, 12, 30);
    verticalText(ctx, '水風呂', ox + 37, oy - 22, 8, '#2f4f8a');
    for (const [x, y] of P.lamps) andon(ctx, x, y);
    ctx.fillStyle = season.snow ? '#c2cbd7' : '#8d8980';
    for (let i = 0; i < 6; i += 1) {
      ctx.beginPath();
      ctx.ellipse(W * 0.04 + i * W * 0.055, 258 - (i % 2) * 4, 10, 3.6, 0, 0, TAU);
      ctx.fill();
    }
  },
  lights(P) {
    const R = P.r1;
    const b = P.rb;
    const lights = [];
    for (let x = 10; x + 24 < R - 44; x += 34) lights.push({ x, y: b - 40, w: 24, h: 26, color: '#ffc26b' });
    for (let x = 14; x + 22 < R - 20; x += 34) lights.push({ x, y: b - 86, w: 22, h: 22, color: '#ffc26b' });
    lights.push({ x: R - 41, y: b - 42, w: 30, h: 40, color: '#ffb35a', a: 0.6 });
    lights.push({ x: P.vend[0] - 14, y: P.vend[1] - 41, w: 28, h: 24, color: '#dff0ff', a: 0.8 });
    lights.push({ x: P.vend[0], y: P.vend[1] - 30, r: 34, color: '#cfe6ff' });
    for (const [x, y] of P.lamps) lights.push({ x, y: y - 13, r: 36, color: '#ffcf80', flicker: 4 });
    return lights;
  },
  props(ctx, view) {
    const [bx, by, brx, bry] = view.P.bath;
    shimmer(ctx, bx, by, brx, bry, view.clock, 0.4);
  },
  front(ctx, view) {
    const { P, season, sky, clock } = view;
    const [bx, by, brx] = P.bath;
    steam(ctx, bx, by - 4, brx * 1.4, clock, 9, 0.2 * (season.snow ? 1.6 : 1) * (0.6 + 0.4 * sky.light));
  },
};

// ---------------------------------------------------------- country station
const TRAIN = 4.6;

const station = {
  name: 'Country station',
  pondText: 'in the ditch',
  layout(W) {
    const shelter = W * 0.69;
    const ditch = [W * 0.09, 238, clamp(W * 0.08, 44, 72), 11];
    return {
      W,
      deck: [W * 0.2, W * 0.95],
      shelter,
      sign: W * 0.43,
      vend: W * 0.88,
      posts: [W * 0.27, W * 0.57],
      crossing: W * 0.1,
      poles: [W * 0.05, W * 0.52, W * 1.0],
      ditch,
      tsukumo: { x: W * 0.32, y: 186, pool: true },
      seats: [
        { x: shelter - 16, y: 188 },
        { x: shelter + 16, y: 188 },
      ],
      front: { x: W * 0.8, y: 194 },
      pond: { x: ditch[0], y: ditch[1], rx: ditch[2] * 0.5, ry: ditch[3] * 0.3 },
      kiosk: { x: W * 0.88, y: 163, w: 34, h: 54 },
      gate: [-14, 204],
      zones: [{ rect: [W * 0.23, 189, W * 0.6, 197] }],
      ask: [
        [W * 0.32 - 34, 193],
        [W * 0.32 + 34, 193],
      ],
    };
  },
  far(ctx, P, season) {
    const { W } = P;
    // Summer's tall clouds, smaller the rest of the year.
    const random = seeded(71);
    const big = season.name === 'summer' ? 1 : 0.6;
    const under = [];
    const over = [];
    for (const f of [0.16, 0.6, 0.88]) {
      const cx = W * f;
      const s = (0.8 + random() * 0.5) * big;
      for (let i = 0; i < 9; i += 1) {
        const x = cx + (random() - 0.5) * 90 * s;
        const r = (14 + random() * 16) * s;
        const y = 104 - r * 0.6 - random() * 40 * s * Math.max(0, 1 - Math.abs(x - cx) / (60 * s));
        under.push([x, y + 3, r]);
        over.push([x - 2, y, r * 0.92]);
      }
    }
    for (const [list, color] of [
      [under, '#dde5f1'],
      [over, '#ffffff'],
    ]) {
      ctx.fillStyle = color;
      for (const [x, y, r] of list) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
      }
    }
    ridge(ctx, W, H, 104, 14, 0.008, '#7f95c2', 51);
    ridge(ctx, W, H, 120, 9, 0.016, FOREST[season.name], 52);
    // Rice paddies, terrace after terrace: water, green, gold, snow.
    const fields = { spring: ['#a9c6e2', '#9dbcd9'], summer: ['#6aa84f', '#5e9a45'], autumn: ['#d9b24c', '#cda243'], winter: ['#eef2f7', '#e3e9f1'] }[season.name];
    const bank = season.snow ? '#c9d2de' : '#6d8a4e';
    let y = 122;
    for (let i = 0; y < 172; i += 1) {
      const h = 5 + (y - 122) * 0.18;
      ctx.fillStyle = fields[i % 2];
      ctx.fillRect(0, y, W, h);
      ctx.fillStyle = bank;
      ctx.fillRect(0, y + h - 1, W, 1.2);
      if (season.name === 'spring' || season.name === 'winter') {
        ctx.fillStyle = season.name === 'spring' ? '#5f9a4a' : '#9aa2ad';
        const step = season.name === 'spring' ? 6 : 9;
        for (let x = (i * 3) % step; x < W; x += step) ctx.fillRect(x, y + h / 2, 1, season.name === 'spring' ? 1.6 : 1);
      }
      y += h;
    }
    ctx.strokeStyle = bank;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let k = 0; k < 6; k += 1) {
      const x = random() * W;
      ctx.moveTo(x, 122);
      ctx.lineTo(x + (x - W / 2) * 0.15, 172);
    }
    ctx.stroke();
    if (season.name === 'autumn') {
      // Rice hung to dry on wooden racks.
      for (const f of [0.3, 0.74]) {
        const x0 = W * f;
        ctx.fillStyle = '#5a4332';
        for (let k = 0; k < 4; k += 1) ctx.fillRect(x0 + k * 22, 140, 2, 22);
        ctx.fillRect(x0, 144, 68, 2);
        ctx.fillStyle = '#c9a03e';
        for (let k = 0; k < 16; k += 1) ctx.fillRect(x0 + 1 + k * 4.2, 146, 3.4, 9);
      }
    }
    // Wooden poles and their sagging wires.
    const top = 44;
    ctx.fillStyle = '#4a3b30';
    for (const x of P.poles) {
      ctx.fillRect(x - 2, top, 4, 174 - top);
      ctx.fillRect(x - 12, top + 8, 24, 2.5);
      ctx.fillRect(x - 9, top + 16, 18, 2);
    }
    ctx.strokeStyle = '#2b2a30';
    ctx.lineWidth = 0.9;
    const xs = [-W * 0.4, ...P.poles, W * 1.4];
    ctx.beginPath();
    for (let k = 0; k < xs.length - 1; k += 1) {
      for (const [dx, dy] of [
        [-10, 8],
        [10, 8],
        [0, 16],
      ]) {
        const x0 = xs[k] + dx;
        const x1 = xs[k + 1] + dx;
        ctx.moveTo(x0, top + dy);
        ctx.quadraticCurveTo((x0 + x1) / 2, top + dy + 16, x1, top + dy);
      }
    }
    ctx.stroke();
    ctx.fillStyle = season.snow ? '#dfe5ec' : '#8d877c';
    ctx.fillRect(0, 170, W, 14);
    ctx.fillStyle = '#5a4a3c';
    for (let x = 0; x < W; x += 9) ctx.fillRect(x, 175, 4, 7);
    ctx.fillStyle = '#b6bcc4';
    ctx.fillRect(0, 175, W, 1.6);
    ctx.fillRect(0, 180, W, 1.6);
  },
  near(ctx, P, season, lm) {
    const { W } = P;
    const [left, right] = P.deck;
    const grass = { spring: '#8cbf63', summer: '#5e9a4a', autumn: '#a49a58', winter: '#eef2f7' }[season.name];
    ctx.fillStyle = grass;
    ctx.fillRect(0, 184, W, H - 184);
    ctx.fillStyle = shade(grass, -0.12);
    ctx.fillRect(0, 184, W, 4);
    const [dx, dy, drx, dry] = P.ditch;
    ctx.fillStyle = season.snow ? '#b9c6d4' : '#6c7f4a';
    ctx.beginPath();
    ctx.ellipse(dx, dy, drx + 5, dry + 4, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = season.snow ? '#c9dbea' : '#6f9fbf';
    ctx.beginPath();
    ctx.ellipse(dx, dy, drx, dry, 0, 0, TAU);
    ctx.fill();
    // The platform, its yellow line, its ramp.
    ctx.fillStyle = season.snow ? '#e7ecf2' : '#c3beb4';
    ctx.beginPath();
    ctx.moveTo(left, 182);
    ctx.lineTo(right, 182);
    ctx.lineTo(right + 4, 196);
    ctx.lineTo(left - 4, 196);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#e6c33c';
    ctx.fillRect(left + 2, 184, right - left - 4, 2);
    ctx.fillStyle = '#8e897f';
    ctx.fillRect(left - 4, 196, right - left + 8, 12);
    ctx.fillStyle = '#6f6a61';
    ctx.fillRect(left - 4, 206, right - left + 8, 2);
    ctx.fillStyle = '#a7a297';
    ctx.beginPath();
    ctx.moveTo(left - 4, 196);
    ctx.lineTo(left - 4, 208);
    ctx.lineTo(left - 26, 208);
    ctx.closePath();
    ctx.fill();
    for (const x of P.posts) {
      ctx.fillStyle = '#7d828c';
      ctx.fillRect(x - 1, 128, 2, 60);
      ctx.fillStyle = '#f4f6f8';
      ctx.fillRect(x - 14, 124, 28, 5);
      ctx.fillStyle = '#5c616b';
      ctx.fillRect(x - 15, 122, 30, 2);
    }
    // The name board: Tsukumo station, between two made-up neighbours.
    const sx = P.sign;
    const sb = 190;
    ctx.fillStyle = '#5f6670';
    ctx.fillRect(sx - 34, sb - 46, 3, 46);
    ctx.fillRect(sx + 31, sb - 46, 3, 46);
    ctx.fillStyle = '#f7f5ef';
    ctx.fillRect(sx - 42, sb - 52, 84, 34);
    ctx.strokeStyle = '#5f6670';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx - 41.5, sb - 51.5, 83, 33);
    ctx.fillStyle = '#1f1f26';
    fitText(ctx, 'つくも', sx, sb - 42, 76, 14, 800);
    fitText(ctx, 'TSUKUMO', sx, sb - 32.5, 76, 6.5, 500);
    ctx.fillStyle = '#2f7d5b';
    ctx.fillRect(sx - 41, sb - 27, 82, 8);
    ctx.fillStyle = '#ffffff';
    fitText(ctx, '← こだま', sx - 22, sb - 23, 36, 6, 500);
    fitText(ctx, 'しずく →', sx + 22, sb - 23, 36, 6, 500);
    // The shelter: boards, a bench, the timetable, a tin roof.
    const hx = P.shelter;
    const hb = 188;
    ctx.fillStyle = '#7a5a3e';
    ctx.fillRect(hx - 40, hb - 48, 80, 40);
    ctx.strokeStyle = 'rgba(78, 56, 38, 0.6)';
    ctx.beginPath();
    for (let x = hx - 40; x < hx + 40; x += 6) {
      ctx.moveTo(x, hb - 48);
      ctx.lineTo(x, hb - 8);
    }
    ctx.stroke();
    ctx.fillStyle = '#4e3826';
    ctx.fillRect(hx - 42, hb - 52, 4, 52);
    ctx.fillRect(hx + 38, hb - 52, 4, 52);
    ctx.fillStyle = '#f2efe6';
    ctx.fillRect(hx + 16, hb - 44, 16, 20);
    ctx.fillStyle = '#5a5e68';
    for (let k = 0; k < 5; k += 1) ctx.fillRect(hx + 18, hb - 40 + k * 3.4, 12 - (k % 2) * 4, 1);
    ctx.fillStyle = '#9b7a55';
    ctx.fillRect(hx - 32, hb - 12, 64, 4);
    ctx.fillStyle = '#5b4632';
    ctx.fillRect(hx - 29, hb - 8, 3, 8);
    ctx.fillRect(hx + 26, hb - 8, 3, 8);
    ctx.fillStyle = '#b0583e';
    ctx.beginPath();
    ctx.moveTo(hx - 48, hb - 50);
    ctx.lineTo(hx + 48, hb - 50);
    ctx.lineTo(hx + 44, hb - 60);
    ctx.lineTo(hx - 44, hb - 60);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(90, 40, 28, 0.6)';
    ctx.beginPath();
    for (let x = hx - 44; x < hx + 46; x += 4) {
      ctx.moveTo(x, hb - 60);
      ctx.lineTo(x - 1, hb - 50);
    }
    ctx.stroke();
    if (season.snow) {
      ctx.fillStyle = '#f3f6fb';
      ctx.fillRect(hx - 44, hb - 63, 88, 4);
    }
    vending(ctx, P.vend, 190, lm ? 'LM Studio' : '', lm?.model ?? '', lm ? '#7b5be6' : '#3a7bd5');
    // The level crossing: striped post, crossbuck, two red lamps.
    const cx = P.crossing;
    const cb = 192;
    for (let y = cb - 70, k = 0; y < cb; y += 6, k += 1) {
      ctx.fillStyle = k % 2 ? '#1d1d22' : '#f2c230';
      ctx.fillRect(cx - 2, y, 4, 6);
    }
    ctx.save();
    ctx.translate(cx, cb - 72);
    for (const angle of [0.6, -0.6]) {
      ctx.save();
      ctx.rotate(angle);
      ctx.fillStyle = '#f2c230';
      ctx.fillRect(-16, -2.5, 32, 5);
      ctx.fillStyle = '#1d1d22';
      for (let k = -14; k < 16; k += 8) ctx.fillRect(k, -2.5, 4, 5);
      ctx.restore();
    }
    ctx.restore();
    ctx.fillStyle = '#1d1d22';
    ctx.fillRect(cx - 14, cb - 58, 28, 3);
    for (const [color, r] of [
      ['#1d1d22', 4.5],
      ['#5a1a16', 3],
    ]) {
      ctx.fillStyle = color;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(cx + s * 11, cb - 52, r, 0, TAU);
        ctx.fill();
      }
    }
    // Flowers of the season in the foreground.
    const random = seeded(91);
    if (season.name === 'summer') {
      for (const f of [0.025, 0.155, 0.975, 0.93]) {
        const x = W * f;
        const top = 196 + random() * 16;
        ctx.strokeStyle = '#3f7a35';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, H);
        ctx.lineTo(x + 2, top);
        ctx.stroke();
        ctx.fillStyle = '#f2c230';
        for (let k = 0; k < 12; k += 1) {
          const angle = (k / 12) * TAU;
          ctx.beginPath();
          ctx.ellipse(x + 2 + Math.cos(angle) * 6, top + Math.sin(angle) * 6, 3.2, 1.6, angle, 0, TAU);
          ctx.fill();
        }
        ctx.fillStyle = '#6b4523';
        ctx.beginPath();
        ctx.arc(x + 2, top, 4, 0, TAU);
        ctx.fill();
      }
    } else if (season.name !== 'winter') {
      const tones = season.name === 'spring' ? ['#f2d43a', '#e8c52a'] : ['#f08fb8', '#ffffff', '#d6418a'];
      for (let k = 0; k < 70; k += 1) {
        const x = random() < 0.5 ? random() * W * 0.18 : W * 0.6 + random() * W * 0.4;
        const y = 214 + random() * 50;
        if (Math.hypot((x - dx) / (drx + 10), (y - dy) / (dry + 8)) < 1) continue;
        ctx.strokeStyle = '#4f7d3c';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(x, y + 8);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.fillStyle = tones[k % tones.length];
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, TAU);
        ctx.fill();
      }
    } else {
      ctx.strokeStyle = '#7a6a58';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 0; k < 24; k += 1) {
        const x = random() < 0.5 ? random() * W * 0.18 : W * 0.6 + random() * W * 0.4;
        const y = 220 + random() * 40;
        ctx.moveTo(x, y + 10);
        ctx.lineTo(x + 2, y);
      }
      ctx.stroke();
    }
  },
  lights(P) {
    const lights = P.posts.map((x) => ({ x, y: 132, r: 40, color: '#e8f2ff' }));
    lights.push({ x: P.vend - 14, y: 149, w: 28, h: 24, color: '#dff0ff', a: 0.8 });
    lights.push({ x: P.vend, y: 160, r: 32, color: '#cfe6ff' });
    return lights;
  },
  /** The two-tone local train, behind the platform: on a message, and every few minutes. */
  mid(ctx, view) {
    const { W, sky, clock, state } = view;
    if (state.train === undefined || clock - state.train > 150) state.train = clock;
    const e = clock - state.train;
    if (e > TRAIN || e < 0) return;
    const length = 230;
    const x0 = W + 30 - (W + length + 60) * (e / TRAIN);
    const base = 176;
    const top = 128;
    const c = (color) => mul(color, sky.tint);
    ctx.fillStyle = c('#3a3d44');
    ctx.fillRect(x0 + 20, base - 6, 40, 6);
    ctx.fillRect(x0 + length - 60, base - 6, 40, 6);
    ctx.fillStyle = c('#1f2026');
    for (const wx of [x0 + 28, x0 + 52, x0 + length - 52, x0 + length - 28]) {
      ctx.beginPath();
      ctx.arc(wx, base - 1, 4, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = c('#efe7d2');
    ctx.beginPath();
    ctx.roundRect(x0, top, length, base - top - 6, [10, 4, 4, 6]);
    ctx.fill();
    ctx.fillStyle = c('#c9532c');
    ctx.fillRect(x0, top + 30, length, 5);
    ctx.fillStyle = c('#5b6068');
    ctx.fillRect(x0, base - 12, length, 6);
    ctx.fillStyle = c('#9aa0a8');
    ctx.fillRect(x0 + 60, top - 5, 50, 5);
    const glass = mix(c('#a9c3dc'), '#ffd890', sky.lamps * 0.8);
    ctx.fillStyle = glass;
    ctx.beginPath();
    ctx.roundRect(x0 + 3, top + 7, 14, 16, [6, 2, 2, 2]);
    ctx.fill();
    for (let wx = x0 + 28; wx < x0 + length - 16; wx += 19) {
      if (Math.abs(wx - (x0 + length / 2)) < 10) {
        ctx.fillStyle = c('#c8bfa8');
        ctx.fillRect(wx, top + 8, 12, 30);
        ctx.fillStyle = glass;
        continue;
      }
      ctx.fillRect(wx, top + 9, 14, 15);
    }
    if (sky.lamps > 0.2) {
      const beam = ctx.createRadialGradient(x0, base - 14, 0, x0, base - 14, 40);
      beam.addColorStop(0, `rgba(255, 240, 200, ${0.7 * sky.lamps})`);
      beam.addColorStop(1, 'rgba(255, 240, 200, 0)');
      ctx.fillStyle = beam;
      ctx.fillRect(x0 - 40, base - 54, 80, 80);
    }
    ctx.fillStyle = '#fff6d8';
    ctx.beginPath();
    ctx.arc(x0 + 5, base - 14, 2, 0, TAU);
    ctx.fill();
  },
  props(ctx, view) {
    const { P, clock, state } = view;
    const [dx, dy, drx, dry] = P.ditch;
    shimmer(ctx, dx, dy, drx, dry, clock, 0.4);
    // The crossing rings while the train goes by: its lamps take turns.
    const e = clock - (state.train ?? -99);
    if (e < 0 || e > TRAIN + 0.6) return;
    const side = Math.floor(clock * 3) % 2 ? 1 : -1;
    const x = P.crossing + side * 11;
    const y = 140;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, 18);
    glow.addColorStop(0, 'rgba(255, 70, 50, 0.85)');
    glow.addColorStop(1, 'rgba(255, 70, 50, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(x - 18, y - 18, 36, 36);
    ctx.fillStyle = '#ff5a40';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, TAU);
    ctx.fill();
  },
  message(state, clock) {
    if (state.train === undefined || clock - state.train > TRAIN + 1) state.train = clock;
  },
};

// ------------------------------------------------------------- Tokyo alley
const SIGNS = [
  ['酒', '#f5efe0', '#b8261c'],
  ['喫茶', '#f3d36b', '#3a2a1a'],
  ['バー', '#e2463a', '#fff6e8'],
  ['焼鳥', '#f5efe0', '#1f1a1a'],
  ['らーめん', '#f3d36b', '#b8261c'],
  ['スナック', '#ff7ab8', '#2a0f1f'],
  ['居酒屋', '#f5efe0', '#1f1a1a'],
];

/** The row of tiny bars, the same for the same width. */
function buildings(W) {
  const random = seeded(123);
  const list = [];
  let x = -6;
  for (let i = 0; x < W + 6; i += 1) {
    const w = 72 + random() * 40;
    const top = 54 + random() * 34;
    const [text, bg, ink] = SIGNS[i % SIGNS.length];
    list.push({ x, w, top, text, bg, ink, color: ['#2a2433', '#302a2c', '#24303a', '#352a2c', '#2b2c3a'][i % 5], sx: x + 8 + random() * (w - 32), sy: top + 14, sh: [...text].length * 10.6 + 8, lantern: random() > 0.45, door: x + 10 + random() * (w - 40), blink: i === 2, seed: i });
    x += w + 2;
  }
  return list;
}

const alley = {
  name: 'Tokyo alley',
  pondText: 'in the fish tank',
  night: true,
  sky: { low: '#4a2f55' },
  particles: { summer: 'rain', autumn: 'rain' },
  layout(W) {
    const crates = W * 0.33;
    const cart = [W * 0.83, 242];
    const tank = [W * 0.11, 214];
    return {
      W,
      crates,
      cart,
      tank,
      vend: W * 0.6,
      blds: buildings(W),
      tsukumo: { x: W * 0.48, y: 192, pool: false },
      seats: [
        { x: crates - 15, y: 238, perch: true },
        { x: crates + 15, y: 238, perch: true },
        { x: cart[0] - 8, y: cart[1], perch: true },
        { x: cart[0] + 24, y: cart[1], perch: true },
      ],
      front: { x: W * 0.62, y: 262 },
      pond: { x: tank[0], y: tank[1] - 7, rx: 14, ry: 2 },
      kiosk: { x: cart[0], y: cart[1] - 45, w: 110, h: 90 },
      gate: [-14, 244],
      zones: [{ rect: [W * 0.2, 226, W * 0.72, 262] }],
      blocked: [[crates - 32, 220, crates + 32, 246]],
      ask: [
        [W * 0.43, 232],
        [W * 0.53, 232],
      ],
    };
  },
  far(ctx, P, season, lm) {
    const { W } = P;
    const random = seeded(5);
    for (let x = -10; x < W; x += 40 + random() * 50) {
      const top = 30 + random() * 60;
      const w = 26 + random() * 30;
      ctx.fillStyle = '#1a1b30';
      ctx.fillRect(x, top, w, 120);
      ctx.fillStyle = 'rgba(255, 217, 138, 0.45)';
      for (let y = top + 6; y < 112; y += 7) for (let wx = x + 4; wx < x + w - 4; wx += 6) if (random() > 0.55) ctx.fillRect(wx, y, 2, 2.5);
    }
    for (const b of P.blds) {
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x, b.top, b.w, 208 - b.top);
      ctx.fillStyle = shade(b.color, -0.35);
      ctx.fillRect(b.x - 1, b.top - 3, b.w + 2, 3);
      const lit = seeded(b.seed + 50);
      for (let y = b.top + 10; y < 140; y += 22) {
        for (let x = b.x + 6; x + 16 < b.x + b.w - 4; x += 22) {
          if (x < b.sx + 18 && x + 16 > b.sx - 2) continue;
          ctx.fillStyle = lit() > 0.4 ? 'rgba(255, 207, 138, 0.75)' : '#17151d';
          ctx.fillRect(x, y, 16, 12);
        }
      }
      ctx.fillStyle = '#b9bcc4';
      ctx.fillRect(b.x + b.w - 26, 132, 18, 12);
      ctx.strokeStyle = '#6f737c';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(b.x + b.w - 17, 138, 4, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = '#16141c';
      ctx.fillRect(b.x + 4, 158, b.w - 8, 50);
      ctx.fillStyle = 'rgba(255, 183, 96, 0.55)';
      ctx.fillRect(b.door, 168, 22, 40);
      ctx.fillStyle = shade(b.bg, -0.3);
      ctx.fillRect(b.door - 2, 162, 26, 10);
      ctx.fillStyle = b.bg;
      ctx.fillRect(b.sx, b.sy, 16, b.sh);
      verticalText(ctx, b.text, b.sx + 8, b.sy + 9, 10, b.ink);
      if (b.lantern) chochin(ctx, b.door + 30, 168, 12, 17, '#d8432f', '酒');
    }
    ctx.strokeStyle = '#0c0b12';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k < 9; k += 1) {
      const x0 = random() * W;
      const x1 = random() * W;
      const y0 = 60 + random() * 50;
      const y1 = 60 + random() * 50;
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo((x0 + x1) / 2, Math.max(y0, y1) + 18, x1, y1);
    }
    ctx.stroke();
    const street = ctx.createLinearGradient(0, 208, 0, H);
    street.addColorStop(0, '#26232f');
    street.addColorStop(1, '#17161e');
    ctx.fillStyle = street;
    ctx.fillRect(0, 208, W, H - 208);
    if (season.snow) {
      ctx.fillStyle = 'rgba(230, 236, 245, 0.35)';
      ctx.fillRect(0, 208, W, H - 208);
    }
    // The neon, mirrored in the wet street.
    for (const b of P.blds) {
      for (const [x, w, color, a] of [
        [b.sx, 16, b.bg, 0.3],
        [b.door, 22, '#ffb760', 0.22],
      ]) {
        const mirror = ctx.createLinearGradient(0, 210, 0, 262);
        mirror.addColorStop(0, alpha(color, a));
        mirror.addColorStop(1, alpha(color, 0));
        ctx.fillStyle = mirror;
        ctx.fillRect(x, 210, w, 52);
      }
    }
    ctx.fillStyle = 'rgba(80, 76, 104, 0.35)';
    for (let k = 0; k < 6; k += 1) {
      ctx.beginPath();
      ctx.ellipse(random() * W, 222 + random() * 40, 18 + random() * 24, 3 + random() * 2, 0, 0, TAU);
      ctx.fill();
    }
    // The izakaya's fish tank, under 活: alive.
    const [tx, ty] = P.tank;
    ctx.fillStyle = '#3a3f4a';
    ctx.fillRect(tx - 36, ty, 72, 26);
    ctx.fillStyle = 'rgba(46, 138, 153, 0.85)';
    ctx.fillRect(tx - 38, ty - 40, 76, 40);
    ctx.fillStyle = '#c8b48a';
    ctx.fillRect(tx - 38, ty - 5, 76, 5);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.fillRect(tx - 34, ty - 37, 3, 30);
    ctx.fillRect(tx - 28, ty - 37, 1.5, 22);
    ctx.fillStyle = '#9aa3ad';
    ctx.fillRect(tx - 39, ty - 42, 78, 3);
    ctx.fillStyle = '#c8261c';
    ctx.fillRect(tx - 9, ty - 62, 18, 18);
    ctx.fillStyle = '#fff6e8';
    fitText(ctx, '活', tx, ty - 53, 16, 13, 800);
    // Beer crates to sit on.
    for (const [dx, color] of [
      [-15, '#e2b23a'],
      [15, '#c8463a'],
    ]) {
      const x = P.crates + dx;
      ctx.fillStyle = color;
      ctx.fillRect(x - 13, 226, 26, 14);
      ctx.fillStyle = shade(color, -0.35);
      for (let i = 0; i < 3; i += 1) for (let j = 0; j < 2; j += 1) ctx.fillRect(x - 10 + i * 8, 229 + j * 6, 5, 3);
    }
    vending(ctx, P.vend - 19, 208, '', '', '#e2463a');
    vending(ctx, P.vend + 19, 208, '', '', '#3a7bd5');
    // The ramen cart: LM Studio on its curtain, the model on the counter.
    const [kx, kb] = P.cart;
    const kw = 104;
    const left = kx - kw / 2;
    ctx.fillStyle = '#7a4a2c';
    ctx.fillRect(left, kb - 34, kw, 26);
    ctx.fillStyle = '#5c3720';
    ctx.fillRect(left - 3, kb - 36, kw + 6, 4);
    ctx.fillRect(left + 2, kb - 86, 3, 50);
    ctx.fillRect(left + kw - 5, kb - 86, 3, 50);
    ctx.strokeStyle = '#3a2416';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(left + 16, kb - 10, 10, 0, TAU);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k < 4; k += 1) {
      const angle = (k / 4) * Math.PI;
      ctx.moveTo(left + 16 - Math.cos(angle) * 9, kb - 10 - Math.sin(angle) * 9);
      ctx.lineTo(left + 16 + Math.cos(angle) * 9, kb - 10 + Math.sin(angle) * 9);
    }
    ctx.stroke();
    ctx.fillStyle = '#3d2a1e';
    ctx.beginPath();
    ctx.moveTo(left - 8, kb - 84);
    ctx.lineTo(left + kw + 8, kb - 84);
    ctx.lineTo(left + kw + 2, kb - 92);
    ctx.lineTo(left - 2, kb - 92);
    ctx.closePath();
    ctx.fill();
    if (season.snow) {
      ctx.fillStyle = '#e8edf4';
      ctx.fillRect(left - 2, kb - 95, kw + 4, 3);
    }
    ctx.fillStyle = '#a8231c';
    for (let i = 0; i < 4; i += 1) ctx.fillRect(left + 5 + (i * (kw - 8)) / 4, kb - 84, (kw - 8) / 4 - 2, 16);
    ctx.fillStyle = '#fff4e6';
    fitText(ctx, lm ? 'LM Studio' : 'ラーメン', kx, kb - 76, kw - 16, 9, 800);
    ctx.fillStyle = '#9aa0a8';
    ctx.fillRect(left + 12, kb - 46, 22, 10);
    ctx.fillStyle = '#c2c8d0';
    ctx.fillRect(left + 10, kb - 48, 26, 3);
    if (lm) {
      ctx.fillStyle = '#f5efe0';
      ctx.fillRect(kx - 4, kb - 50, 46, 13);
      ctx.fillStyle = '#2a1a12';
      fitText(ctx, lm.model || '—', kx + 19, kb - 43.5, 42, 7.5, 700);
    }
    chochin(ctx, left + kw + 8, kb - 66, 13, 20, '#d8432f', '麺');
    for (const sx of [kx - 8, kx + 24]) {
      ctx.fillStyle = '#c8463a';
      ctx.beginPath();
      ctx.ellipse(sx, kb - 12, 7, 2.5, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#4a4f5a';
      ctx.fillRect(sx - 1, kb - 11, 2, 11);
    }
  },
  lights(P) {
    const lights = [];
    for (const b of P.blds) {
      lights.push({ x: b.sx - 2, y: b.sy - 2, w: 20, h: b.sh + 4, color: b.bg, a: 0.35, flicker: 13, blink: b.blink });
      lights.push({ x: b.sx + 8, y: b.sy + b.sh / 2, r: 30, color: b.bg, a: 0.6, flicker: 11, blink: b.blink });
      lights.push({ x: b.door + 11, y: 186, r: 30, color: '#ffb760', a: 0.5 });
      if (b.lantern) lights.push({ x: b.door + 30, y: 168, r: 26, color: '#ff7a4a', flicker: 6 });
    }
    lights.push({ x: P.tank[0], y: P.tank[1] - 20, r: 44, color: '#5fd0e0', a: 0.5 });
    lights.push({ x: P.vend - 19, y: 180, r: 34, color: '#e8f2ff', a: 0.7 });
    lights.push({ x: P.vend + 19, y: 180, r: 34, color: '#e8f2ff', a: 0.7 });
    const [kx, kb] = P.cart;
    lights.push({ x: kx + 60, y: kb - 66, r: 34, color: '#ff7a4a', flicker: 6 });
    lights.push({ x: kx - 48, y: kb - 66, w: 96, h: 30, color: '#ffb760', a: 0.35 });
    return lights;
  },
  props(ctx, view) {
    const { P, clock } = view;
    const [tx, ty] = P.tank;
    ctx.lineWidth = 0.8;
    for (let i = 0; i < 6; i += 1) {
      const p = (clock * 0.5 + i / 6) % 1;
      ctx.strokeStyle = `rgba(220, 250, 255, ${0.6 * (1 - p)})`;
      ctx.beginPath();
      ctx.arc(tx - 24 + i * 9 + Math.sin(clock * 3 + i) * 2, ty - 6 - p * 32, 1.4, 0, TAU);
      ctx.stroke();
    }
    const [kx, kb] = P.cart;
    steam(ctx, kx - 29, kb - 50, 10, clock * 1.4, 4, 0.22, 0.5, 40);
  },
};

/** In the picker's order; the first is the default. */
export const SCENES = { shrine, zen, festival, onsen, station, alley };
export const SCENE_IDS = Object.keys(SCENES);
