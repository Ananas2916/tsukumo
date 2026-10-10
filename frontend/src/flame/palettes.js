/**
 * The flame's colours: only data and a little maths, no three.js, so the
 * panel (the swatches) and the node tests can use them too.
 *
 * Each palette: at the bottom (`low`), at the tip (`high`), the light inside
 * (`emissive`) and around (`glow`), rings and trails (`accent`), light
 * details (`soft`). Besides the named ones a free "#rrggbb" colour can be
 * given: the rest of the palette is derived from it.
 */

import { t } from '../i18n.js';

export const PALETTES = {
  lilac: { low: 0x9d84ff, high: 0xf4a6dc, emissive: 0x7a5cff, glow: 0xb89cff, accent: 0xa58bff, soft: 0xcbb8ff },
  blue: { low: 0x4f7dff, high: 0x9fe6ff, emissive: 0x2f5bff, glow: 0x86b4ff, accent: 0x6f9dff, soft: 0xb3d0ff },
  jade: { low: 0x2fc28c, high: 0xd2f7a0, emissive: 0x13a26e, glow: 0x78e0b0, accent: 0x4fd39c, soft: 0xa8efcf },
  ember: { low: 0xff6a3d, high: 0xffd56b, emissive: 0xff4d12, glow: 0xffa060, accent: 0xff8a4c, soft: 0xffc59a },
  sakura: { low: 0xff6fae, high: 0xffd6ea, emissive: 0xff3f8e, glow: 0xff9bc9, accent: 0xff86bd, soft: 0xffc4de },
  moon: { low: 0xa9b6ff, high: 0xffffff, emissive: 0x7d8cff, glow: 0xd6ddff, accent: 0xbfc8ff, soft: 0xe4e8ff },
};
export const DEFAULT_PALETTE = 'lilac';

/** The panel's swatches, in the order they are shown. */
export const PALETTE_LABELS = {
  lilac: t('Lilac'),
  blue: t("Will-o'-the-wisp"),
  jade: t('Jade'),
  ember: t('Ember'),
  sakura: t('Sakura'),
  moon: t('Moon'),
};

const HEX = /^#[0-9a-f]{6}$/i;

/** A palette name or a valid "#rrggbb"; otherwise null. */
export function paletteKey(value) {
  if (typeof value !== 'string') return null;
  if (PALETTES[value]) return value;
  return HEX.test(value) ? value.toLowerCase() : null;
}

/** The palette for a name or a free colour (the default one if it's not valid). */
export function palette(value) {
  const key = paletteKey(value);
  if (!key) return PALETTES[DEFAULT_PALETTE];
  return PALETTES[key] ?? fromColor(parseInt(key.slice(1), 16));
}

/** The swatch colour (the one shown in the panel), as "#rrggbb". */
export function swatchColor(value) {
  return `#${palette(value).accent.toString(16).padStart(6, '0')}`;
}

/**
 * From a single colour to a whole palette, like the named ones do: the tip
 * lighter and shifted in hue (lilac goes towards pink, ember towards
 * yellow), darker and more saturated inside, lighter around.
 */
export function fromColor(rgb) {
  const [h, s, l] = toHsl(rgb);
  // The tip turns the hue warmer if it's cold and vice versa, like the others.
  const shift = h > 0.5 && h < 0.85 ? 0.12 : h < 0.15 ? 0.06 : -0.08;
  return {
    low: fromHsl(h, s, clamp(l, 0.35, 0.68)),
    high: fromHsl(wrap(h + shift), clamp(s * 0.95, 0, 1), clamp(l + 0.24, 0.72, 0.9)),
    emissive: fromHsl(h, clamp(s * 1.1, 0, 1), clamp(l * 0.78, 0.25, 0.55)),
    glow: fromHsl(h, s, clamp(l + 0.12, 0.55, 0.82)),
    accent: rgb,
    soft: fromHsl(h, clamp(s * 0.9, 0, 1), 0.84),
  };
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrap = (h) => ((h % 1) + 1) % 1;

function toHsl(rgb) {
  const r = ((rgb >> 16) & 255) / 255;
  const g = ((rgb >> 8) & 255) / 255;
  const b = (rgb & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h, s, l) {
  const channel = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (channel(0) << 16) | (channel(8) << 8) | channel(4);
}
