/**
 * The painter's kit for the scenes behind the agents (dashboard/scenes.js):
 * colours, a seeded random, and the Japanese props drawn on a canvas, from
 * roofs and torii to lanterns, ponds and paper cranes. Everything is drawn,
 * nothing is loaded: the scenes ship no images.
 */

export const TAU = Math.PI * 2;
/** The scene's fixed height, the tile's. */
export const HEIGHT = 270;
/** Kana and kanji on the signs: the system's Japanese faces, then any. */
export const JP = "'Yu Gothic UI', 'Yu Gothic', 'Meiryo', 'Hiragino Sans', 'Noto Sans JP', sans-serif";

// ----------------------------------------------------------------- colour
export const rgb = (color) => {
  const value = parseInt(color.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};
export const toHex = (channels) => `#${channels.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`;
export const mix = (a, b, amount) => {
  const from = rgb(a);
  const to = rgb(b);
  return toHex(from.map((c, i) => c + (to[i] - c) * amount));
};
export const alpha = (color, value) => `rgba(${rgb(color).join(', ')}, ${value})`;
/** Lighter (amount > 0) or darker (< 0). */
export const shade = (color, amount) => mix(color, amount > 0 ? '#ffffff' : '#000000', Math.abs(amount));
/** A colour under the hour's light: what the painted scenery gets, for the things that move. */
export const mul = (color, tint) => {
  const tone = rgb(tint);
  return toHex(rgb(color).map((c, i) => (c * tone[i]) / 255));
};

/** Always the same trees and stones for the same width: a seeded random. */
export function seeded(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let x = Math.imul(value ^ (value >>> 15), 1 | value);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export const lerp = (a, b, amount) => a + (b - a) * amount;
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** A point on a straight (a → b) or curved (a, c, b) path. */
export function along(path, u) {
  if (!path.c) return [lerp(path.a[0], path.b[0], u), lerp(path.a[1], path.b[1], u)];
  const v = 1 - u;
  return [v * v * path.a[0] + 2 * v * u * path.c[0] + u * u * path.b[0], v * v * path.a[1] + 2 * v * u * path.c[1] + u * u * path.b[1]];
}

// ------------------------------------------------------------------- text
/** Centred text, made smaller until it fits. */
export function fitText(ctx, text, x, y, maxWidth, size, weight = 700) {
  let px = size;
  ctx.font = `${weight} ${px}px ${JP}`;
  while (px > 4 && ctx.measureText(text).width > maxWidth) {
    px -= 0.5;
    ctx.font = `${weight} ${px}px ${JP}`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.textBaseline = 'alphabetic';
}

/** Top to bottom, as on the shop signs; the long vowel mark turns upright. */
export function verticalText(ctx, text, x, y, size, color) {
  ctx.fillStyle = color;
  ctx.font = `700 ${size}px ${JP}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  [...text].forEach((char, i) => ctx.fillText(char === 'ー' ? '｜' : char, x, y + i * size * 1.06));
  ctx.textBaseline = 'alphabetic';
}

// -------------------------------------------------------------- landscape
export function ridge(ctx, width, height, base, amp, freq, color, seed) {
  const random = seeded(seed);
  const p1 = random() * 10;
  const p2 = random() * 10;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, height);
  for (let x = 0; x <= width + 8; x += 8) ctx.lineTo(x, base - amp * (Math.sin(x * freq + p1) * 0.6 + Math.sin(x * freq * 2.3 + p2) * 0.4));
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();
}

export function speckle(ctx, x, y, w, h, color, count, seed) {
  const random = seeded(seed);
  ctx.fillStyle = alpha(color, 0.5);
  for (let i = 0; i < count; i += 1) ctx.fillRect(x + random() * w, y + random() * h, 1.3, 1);
}

/** A stone sitting at y: a lumpy dome, lit on top, snow on it in winter. */
export function rock(ctx, x, y, w, h, color, seed, snow) {
  const random = seeded(seed);
  const n = 7;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < n; i += 1) {
    const angle = Math.PI + (i / (n - 1)) * Math.PI;
    const k = 0.8 + random() * 0.25;
    const px = x + Math.cos(angle) * (w / 2) * k;
    const py = y + Math.sin(angle) * h * k;
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.beginPath();
  ctx.ellipse(x - w * 0.14, y - h * 0.6, w * 0.22, h * 0.18, 0, 0, TAU);
  ctx.fill();
  if (snow) {
    ctx.fillStyle = '#f2f5fa';
    ctx.beginPath();
    ctx.ellipse(x, y - h * 0.72, w * 0.36, h * 0.3, 0, Math.PI, 0);
    ctx.fill();
  }
}

/** A cherry or a maple: pink in spring, green in summer, red in autumn, bare in winter. */
export function deciduous(ctx, x, ground, h, season, seed, kind = 'sakura') {
  const random = seeded(seed);
  ctx.strokeStyle = '#5a4334';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, h * 0.08);
  ctx.beginPath();
  ctx.moveTo(x, ground);
  ctx.quadraticCurveTo(x - h * 0.06, ground - h * 0.4, x + h * 0.02, ground - h * 0.62);
  ctx.stroke();
  const tips = [];
  for (let i = 0; i < 5; i += 1) {
    const angle = -Math.PI / 2 + (i - 2) * 0.55 + (random() - 0.5) * 0.3;
    const length = h * (0.32 + random() * 0.18);
    const sx = x + h * 0.02;
    const sy = ground - h * 0.55 + (random() - 0.5) * h * 0.1;
    const ex = sx + Math.cos(angle) * length;
    const ey = sy + Math.sin(angle) * length * 0.8;
    ctx.lineWidth = Math.max(1, h * 0.035);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo((sx + ex) / 2 + (random() - 0.5) * 8, (sy + ey) / 2, ex, ey);
    ctx.stroke();
    tips.push([ex, ey]);
  }
  ctx.lineCap = 'butt';
  if (!season.leaf) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 1.3;
    for (const [ex, ey] of tips) {
      ctx.beginPath();
      ctx.moveTo(ex - 4, ey - 1);
      ctx.lineTo(ex + 3, ey - 2);
      ctx.stroke();
    }
    return;
  }
  let leaf = season.leaf;
  if (season.name === 'spring' && kind === 'maple') leaf = '#9ccf6a';
  if (season.name === 'autumn' && kind === 'sakura') leaf = '#e8873a';
  const deep = shade(leaf, -0.25);
  const puffs = [...tips, [x, ground - h * 0.85]];
  for (const [px, py] of puffs) {
    for (let k = 0; k < 3; k += 1) {
      ctx.fillStyle = k === 0 ? deep : leaf;
      ctx.beginPath();
      ctx.arc(px + (random() - 0.5) * h * 0.18, py + (random() - 0.5) * h * 0.12 + (k === 0 ? 3 : 0), h * (0.13 + random() * 0.08), 0, TAU);
      ctx.fill();
    }
  }
  ctx.fillStyle = alpha(shade(leaf, 0.3), 0.7);
  for (const [px, py] of puffs) {
    ctx.beginPath();
    ctx.arc(px - h * 0.05, py - h * 0.06, h * 0.07, 0, TAU);
    ctx.fill();
  }
  if (season.name === 'spring' && kind === 'sakura') {
    ctx.fillStyle = 'rgba(255, 245, 250, 0.9)';
    for (let i = 0; i < 30; i += 1) {
      const [px, py] = puffs[i % puffs.length];
      ctx.fillRect(px + (random() - 0.5) * h * 0.4, py + (random() - 0.5) * h * 0.3, 1.5, 1.5);
    }
  }
}

/** A garden pine: a leaning trunk and flat pads of needles. */
export function pine(ctx, x, ground, h, season) {
  ctx.strokeStyle = '#4b3a2e';
  ctx.lineWidth = Math.max(2, h * 0.07);
  ctx.lineCap = 'round';
  const topX = x + h * 0.25;
  const topY = ground - h * 0.85;
  ctx.beginPath();
  ctx.moveTo(x, ground);
  ctx.bezierCurveTo(x - h * 0.1, ground - h * 0.4, x + h * 0.3, ground - h * 0.5, topX, topY);
  ctx.stroke();
  ctx.lineCap = 'butt';
  for (const [px, py, pw] of [
    [x - h * 0.18, ground - h * 0.45, h * 0.28],
    [x + h * 0.32, ground - h * 0.62, h * 0.3],
    [topX - h * 0.05, topY - h * 0.05, h * 0.24],
    [x + h * 0.05, ground - h * 0.72, h * 0.2],
  ]) {
    ctx.fillStyle = '#2b4a3c';
    ctx.beginPath();
    ctx.ellipse(px, py, pw, pw * 0.32, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#3f6a52';
    ctx.beginPath();
    ctx.ellipse(px - pw * 0.1, py - pw * 0.1, pw * 0.8, pw * 0.2, 0, 0, TAU);
    ctx.fill();
    if (season.snow) {
      ctx.fillStyle = '#f4f7fb';
      ctx.beginPath();
      ctx.ellipse(px - pw * 0.05, py - pw * 0.18, pw * 0.85, pw * 0.15, 0, Math.PI, 0);
      ctx.fill();
    }
  }
}

/** A Japanese cedar (sugi): tall, narrow, in tiers. */
export function cedar(ctx, x, ground, h, color, season) {
  const w = h * 0.26;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, ground - h);
  for (let i = 1; i <= 5; i += 1) {
    const y = ground - h + (h * i) / 5;
    ctx.lineTo(x + (w * i) / 5, y);
    if (i < 5) ctx.lineTo(x + ((w * i) / 5) * 0.7, y);
  }
  for (let i = 5; i >= 1; i -= 1) {
    const y = ground - h + (h * i) / 5;
    if (i < 5) ctx.lineTo(x - ((w * i) / 5) * 0.7, y);
    ctx.lineTo(x - (w * i) / 5, y);
  }
  ctx.closePath();
  ctx.fill();
  if (season.snow) {
    ctx.strokeStyle = 'rgba(244, 247, 251, 0.9)';
    ctx.lineWidth = 1.4;
    for (let i = 1; i < 5; i += 1) {
      const y = ground - h + (h * i) / 5 - 1;
      ctx.beginPath();
      ctx.moveTo(x - ((w * i) / 5) * 0.8, y);
      ctx.lineTo(x, y - 3);
      ctx.lineTo(x + ((w * i) / 5) * 0.8, y);
      ctx.stroke();
    }
  }
}

// ----------------------------------------------------------- architecture
/** A Japanese roof: concave slopes, upturned eaves, a ridge cap. y is the eave line. */
export function roof(ctx, cx, y, w, h, color, snow = false, liftK = 0.35) {
  const lift = h * liftK;
  const rw = w * 0.28;
  const half = w / 2;
  const eave = (path) => {
    path.moveTo(cx - half, y - lift);
    path.quadraticCurveTo(cx - half + w * 0.1, y + 1, cx - half + w * 0.24, y + 1);
    path.lineTo(cx + half - w * 0.24, y + 1);
    path.quadraticCurveTo(cx + half - w * 0.1, y + 1, cx + half, y - lift);
  };
  const shape = new Path2D();
  eave(shape);
  shape.quadraticCurveTo(cx + rw + (half - rw) * 0.3, y - h * 0.55, cx + rw, y - h);
  shape.lineTo(cx - rw, y - h);
  shape.quadraticCurveTo(cx - rw - (half - rw) * 0.3, y - h * 0.55, cx - half, y - lift);
  shape.closePath();
  ctx.fillStyle = color;
  ctx.fill(shape);
  ctx.save();
  ctx.clip(shape);
  if (w > 60) {
    ctx.strokeStyle = alpha(shade(color, -0.3), 0.45);
    ctx.lineWidth = 1;
    for (let k = -1; k <= 1.001; k += 0.1) {
      ctx.beginPath();
      ctx.moveTo(cx + k * rw, y - h);
      ctx.lineTo(cx + k * (half - w * 0.06), y + 1);
      ctx.stroke();
    }
  }
  if (snow) {
    ctx.fillStyle = '#f3f6fb';
    ctx.fillRect(cx - half - 2, y - h - 2, w + 4, h * 0.72);
  }
  ctx.restore();
  const edge = new Path2D();
  eave(edge);
  ctx.strokeStyle = shade(color, -0.4);
  ctx.lineWidth = Math.max(1, h * 0.06);
  ctx.stroke(edge);
  const cap = Math.min(4, Math.max(1.5, h * 0.12));
  ctx.fillStyle = snow ? '#f3f6fb' : shade(color, -0.35);
  ctx.fillRect(cx - rw - 2, y - h - cap + 1, rw * 2 + 4, cap);
}

export function torii(ctx, cx, base, w, h, color, snow) {
  const pw = Math.max(5, w * 0.075);
  const leg = w * 0.34;
  for (const s of [-1, 1]) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx + s * leg - pw * 0.55, base);
    ctx.lineTo(cx + s * leg + pw * 0.55, base);
    ctx.lineTo(cx + s * leg * 0.97 + pw * 0.45, base - h * 0.9);
    ctx.lineTo(cx + s * leg * 0.97 - pw * 0.45, base - h * 0.9);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#1d1a1a';
    ctx.fillRect(cx + s * leg - pw * 0.65, base - h * 0.08, pw * 1.3, h * 0.08);
  }
  ctx.fillStyle = color;
  ctx.fillRect(cx - w * 0.44, base - h * 0.7, w * 0.88, pw * 0.75);
  ctx.fillRect(cx - pw * 0.4, base - h * 0.88, pw * 0.8, h * 0.18);
  const top = base - h;
  const lintel = (y0, thickness, fill) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(cx - w / 2 - 6, y0 - 6);
    ctx.quadraticCurveTo(cx, y0 + 5, cx + w / 2 + 6, y0 - 6);
    ctx.lineTo(cx + w / 2 + 4, y0 - 6 + thickness);
    ctx.quadraticCurveTo(cx, y0 + 5 + thickness, cx - w / 2 - 4, y0 - 6 + thickness);
    ctx.closePath();
    ctx.fill();
  };
  lintel(top + 6, pw * 0.9, color);
  lintel(top + 1, pw * 0.7, '#1d1a1a');
  if (snow) lintel(top - 1.5, 2.5, '#f4f7fb');
}

/** A stone lantern (tōrō); its light window is at (x, b - 25 s). */
export function toro(ctx, x, b, s, snow) {
  ctx.fillStyle = '#9a958c';
  ctx.fillRect(x - 7 * s, b - 4 * s, 14 * s, 4 * s);
  ctx.fillRect(x - 2.5 * s, b - 18 * s, 5 * s, 14 * s);
  ctx.fillRect(x - 7 * s, b - 21 * s, 14 * s, 3 * s);
  ctx.fillRect(x - 5 * s, b - 29 * s, 10 * s, 8 * s);
  ctx.fillStyle = '#3a332c';
  ctx.fillRect(x - 2.5 * s, b - 27.5 * s, 5 * s, 5 * s);
  ctx.fillStyle = '#8a857c';
  ctx.beginPath();
  ctx.moveTo(x - 11 * s, b - 28 * s);
  ctx.lineTo(x + 11 * s, b - 28 * s);
  ctx.lineTo(x + 4 * s, b - 35 * s);
  ctx.lineTo(x - 4 * s, b - 35 * s);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, b - 36.5 * s, 2 * s, 0, TAU);
  ctx.fill();
  if (snow) {
    ctx.fillStyle = '#f3f6fb';
    ctx.fillRect(x - 6 * s, b - 36 * s, 12 * s, 2.5 * s);
  }
}

/** The snow-viewing lantern by a pond: three legs and a wide hat. Light at (x, b - 18 s). */
export function yukimi(ctx, x, b, s, snow) {
  ctx.strokeStyle = '#8a857c';
  ctx.lineWidth = 3 * s;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - 13 * s, b);
  ctx.lineTo(x - 8 * s, b - 12 * s);
  ctx.moveTo(x + 13 * s, b);
  ctx.lineTo(x + 8 * s, b - 12 * s);
  ctx.moveTo(x, b + 2 * s);
  ctx.lineTo(x, b - 12 * s);
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.fillStyle = '#9a958c';
  ctx.fillRect(x - 10 * s, b - 15 * s, 20 * s, 3 * s);
  ctx.fillRect(x - 7 * s, b - 23 * s, 14 * s, 8 * s);
  ctx.fillStyle = '#3a332c';
  ctx.fillRect(x - 3.5 * s, b - 21.5 * s, 7 * s, 5 * s);
  ctx.fillStyle = '#8a857c';
  ctx.beginPath();
  ctx.moveTo(x - 21 * s, b - 22 * s);
  ctx.quadraticCurveTo(x, b - 26 * s, x + 21 * s, b - 22 * s);
  ctx.lineTo(x, b - 32 * s);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, b - 32 * s, 2.4 * s, 0, TAU);
  ctx.fill();
  if (snow) {
    ctx.fillStyle = '#f3f6fb';
    ctx.beginPath();
    ctx.ellipse(x, b - 27 * s, 13 * s, 4 * s, 0, Math.PI, 0);
    ctx.fill();
  }
}

export function shoji(ctx, x, y, w, h) {
  ctx.fillStyle = '#efe5cf';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#5b402f';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.beginPath();
  for (let i = 1; i < 3; i += 1) {
    ctx.moveTo(x + (i * w) / 3, y);
    ctx.lineTo(x + (i * w) / 3, y + h);
  }
  for (let j = 1; j < 4; j += 1) {
    ctx.moveTo(x, y + (j * h) / 4);
    ctx.lineTo(x + w, y + (j * h) / 4);
  }
  ctx.stroke();
}

// ------------------------------------------------------------------ props
/** A paper lantern (chōchin), red or white, with a character on it. */
export function chochin(ctx, x, y, w, h, color, text) {
  ctx.fillStyle = '#1e1a1a';
  ctx.fillRect(x - w * 0.32, y - h / 2 - 2, w * 0.64, 3);
  ctx.fillRect(x - w * 0.32, y + h / 2 - 1, w * 0.64, 3);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, w / 2, h / 2, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.14)';
  ctx.lineWidth = 0.7;
  for (let k = -0.6; k <= 0.61; k += 0.3) {
    ctx.beginPath();
    ctx.ellipse(x, y + k * h * 0.5, (w / 2) * Math.sqrt(1 - k * k * 0.9), 1.2, 0, 0, Math.PI);
    ctx.stroke();
  }
  if (text) {
    ctx.fillStyle = color === '#d8432f' ? '#2a1414' : '#c8352a';
    fitText(ctx, text, x, y + 0.5, w * 0.8, h * 0.5, 800);
  }
}

/** A pond ringed with stones; lily pads unless it's winter. */
export function pond(ctx, x, y, rx, ry, season, seed = 4) {
  ctx.fillStyle = '#7d7972';
  ctx.beginPath();
  ctx.ellipse(x, y, rx + 7, ry + 5, 0, 0, TAU);
  ctx.fill();
  const water = ctx.createLinearGradient(0, y - ry, 0, y + ry);
  water.addColorStop(0, '#6c9cc0');
  water.addColorStop(1, '#3d6b91');
  ctx.fillStyle = water;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
  ctx.fill();
  if (!season.snow) {
    ctx.fillStyle = '#4f7d45';
    for (const [dx, dy] of [
      [-0.5, -0.2],
      [0.35, 0.3],
      [-0.15, 0.45],
    ]) {
      ctx.beginPath();
      ctx.ellipse(x + dx * rx, y + dy * ry, 4.5, 1.8, 0, 0.3, TAU);
      ctx.fill();
    }
  }
  const random = seeded(seed);
  const stones = [];
  for (let i = 0; i < 14; i += 1) {
    const angle = (i / 14) * TAU;
    stones.push([x + Math.cos(angle) * (rx + 4), y + Math.sin(angle) * (ry + 3) + 3, i]);
  }
  stones.sort((a, b) => a[1] - b[1]);
  for (const [sx, sy, i] of stones) rock(ctx, sx, sy, 9 + random() * 7, 4 + random() * 3, mix('#8d8982', '#a8a39a', random()), seed * 10 + i, season.snow);
}

/** A bench with red felt, the tea-house kind; with its big red parasol if asked. Seat top at y - 12. */
export function bench(ctx, x, y, season, parasol, w = 76) {
  ctx.fillStyle = '#5b3e2a';
  ctx.fillRect(x - w / 2 + 4, y - 9, 3, 9);
  ctx.fillRect(x + w / 2 - 7, y - 9, 3, 9);
  ctx.fillStyle = '#c7362b';
  ctx.fillRect(x - w / 2, y - 12, w, 4);
  ctx.fillStyle = '#a42a22';
  ctx.fillRect(x - w / 2, y - 8, w, 2);
  if (season.snow) {
    ctx.fillStyle = '#f3f6fb';
    ctx.fillRect(x - w / 2, y - 13, w, 1.5);
  }
  if (!parasol) return;
  const px = x + w / 2;
  const py = y - 66;
  ctx.strokeStyle = '#5b3e2a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px + 2, y);
  ctx.lineTo(px, py);
  ctx.stroke();
  ctx.fillStyle = '#d0402f';
  ctx.beginPath();
  ctx.ellipse(px, py, 46, 17, 0, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = '#9e2b20';
  ctx.beginPath();
  ctx.ellipse(px, py, 46, 4, 0, 0, Math.PI);
  ctx.fill();
  ctx.strokeStyle = 'rgba(122, 31, 23, 0.55)';
  ctx.lineWidth = 1;
  for (let k = -4; k <= 4; k += 1) {
    ctx.beginPath();
    ctx.moveTo(px, py - 17);
    ctx.lineTo(px + k * 11, py);
    ctx.stroke();
  }
  if (season.snow) {
    ctx.fillStyle = '#f3f6fb';
    ctx.beginPath();
    ctx.ellipse(px, py - 6, 38, 11, 0, Math.PI, 0);
    ctx.fill();
  }
}

/** A Japanese vending machine, 34 × 54; a label on its top panel and one under the cans. */
export function vending(ctx, x, b, label, model, panel = '#7b5be6') {
  const w = 34;
  const h = 54;
  const left = x - w / 2;
  const top = b - h;
  ctx.fillStyle = '#e9edf3';
  ctx.beginPath();
  ctx.roundRect(left, top, w, h, 2);
  ctx.fill();
  ctx.fillStyle = panel;
  ctx.fillRect(left + 2, top + 2, w - 4, 9);
  if (label) {
    ctx.fillStyle = '#ffffff';
    fitText(ctx, label, x, top + 6.8, w - 6, 6.5, 700);
  }
  ctx.fillStyle = '#cfe2f3';
  ctx.fillRect(left + 3, top + 13, w - 6, 24);
  const cans = ['#e0533d', '#3a7bd5', '#f0b43a', '#3fae6a', '#e9e2d0', '#8a5ad8'];
  for (let row = 0; row < 3; row += 1) {
    for (let i = 0; i < 6; i += 1) {
      ctx.fillStyle = cans[(i + row * 2) % 6];
      ctx.fillRect(left + 4.5 + i * 4.6, top + 15 + row * 7.6, 3, 5);
    }
  }
  ctx.fillStyle = '#1f1d2b';
  ctx.fillRect(left + 3, top + 38, w - 6, 7);
  if (model) {
    ctx.fillStyle = '#9ff0c4';
    fitText(ctx, model, x, top + 41.6, w - 8, 5.6, 700);
  }
  ctx.fillStyle = '#3a3d4a';
  ctx.fillRect(left + 6, b - 7, w - 12, 4);
}

/** A paper floor lamp; its light is at (x, b - 13). */
export function andon(ctx, x, b) {
  ctx.fillStyle = '#3c2a1e';
  ctx.fillRect(x - 6, b - 4, 2, 4);
  ctx.fillRect(x + 4, b - 4, 2, 4);
  ctx.fillStyle = '#f1e3c2';
  ctx.fillRect(x - 6, b - 22, 12, 18);
  ctx.strokeStyle = '#3c2a1e';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(x - 6, b - 22, 12, 18);
  ctx.beginPath();
  ctx.moveTo(x, b - 22);
  ctx.lineTo(x, b - 4);
  ctx.stroke();
  ctx.fillStyle = '#3c2a1e';
  ctx.fillRect(x - 7, b - 24, 14, 2);
}

// ---------------------------------------------------------------- motion
/** Glints sliding on still water. */
export function shimmer(ctx, x, y, rx, ry, clock, strength = 0.35) {
  ctx.strokeStyle = `rgba(255, 255, 255, ${strength})`;
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i += 1) {
    const phase = clock * 0.8 + i * 1.7;
    const sx = x + Math.sin(phase) * rx * 0.55;
    const sy = y - ry * 0.4 + i * ry * 0.28;
    const length = 4 + (Math.sin(phase * 1.3) + 1) * 4;
    ctx.beginPath();
    ctx.moveTo(sx - length, sy);
    ctx.lineTo(sx + length, sy);
    ctx.stroke();
  }
}

/** Soft puffs rising and fading: hot water, a pot of broth. */
export function steam(ctx, x, y, spread, clock, count, strength, size = 1, rise = 80) {
  for (let i = 0; i < count; i += 1) {
    const p = (clock * 0.16 + i / count) % 1;
    const sx = x + (count > 1 ? (i / (count - 1) - 0.5) * spread : 0) + Math.sin(clock * 0.7 + i * 1.9) * 8 * size;
    const sy = y - p * rise;
    const r = (8 + p * 20) * size;
    const puff = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
    puff.addColorStop(0, `rgba(255, 255, 255, ${Math.sin(p * Math.PI) * strength})`);
    puff.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = puff;
    ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
  }
}

/** Three carp circling a pond (x, y, rx, ry), under the hour's light. */
export function koi(ctx, [px, py, rx, ry], clock, tint) {
  for (let i = 0; i < 3; i += 1) {
    const phase = clock * (0.5 + i * 0.13) + i * 2.1;
    const x = px + Math.cos(phase) * rx * 0.62;
    const y = py + Math.sin(phase) * ry * 0.5;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(Math.cos(phase) * ry * 0.5, -Math.sin(phase) * rx * 0.62));
    ctx.fillStyle = mul(i === 1 ? '#f4efe6' : '#f07a2e', tint);
    ctx.beginPath();
    ctx.ellipse(0, 0, 6, 2.4, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-5, 0);
    ctx.lineTo(-10, -3);
    ctx.lineTo(-10, 3);
    ctx.closePath();
    ctx.fill();
    if (i === 1) {
      ctx.fillStyle = mul('#e8572a', tint);
      ctx.beginPath();
      ctx.arc(1.5, 0, 1.6, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }
}

/** A folded paper crane, wings flapping: how a message travels here. */
export function crane(ctx, x, y, clock, face) {
  const flap = Math.sin(clock * 14);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(face, 1);
  ctx.fillStyle = '#fbf3ea';
  ctx.strokeStyle = 'rgba(120, 100, 140, 0.6)';
  ctx.lineWidth = 0.6;
  for (const points of [
    [[-9, 0], [0, 2.5], [9, 0], [0, -1.5]],
    [[6, 0], [13, -7], [15, -6], [9, 1]],
    [[-6, 0], [-13, -6], [-9, 1]],
  ]) {
    ctx.beginPath();
    points.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = '#ffd3e4';
  ctx.beginPath();
  ctx.moveTo(-4, -0.5);
  ctx.lineTo(1, -11 * flap);
  ctx.lineTo(4, -0.5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
