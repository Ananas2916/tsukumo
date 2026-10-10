/**
 * The wardrobe previews in the panel: the flame, in her colour, wearing each
 * accessory. Hand-drawn SVGs (the panel doesn't load three.js); they look
 * like flame/outfits.js without copying it to the millimetre.
 *
 * 64x64 coordinates: tip at (32, 12), bulb centred at (32, 42) with radius 15.
 */

import { palette } from '../flame/palettes.js';

const INK = '#1d1529';
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
let uid = 0;

const DROP = 'M32 12C40 22 47 30 47 42A15 15 0 0 1 17 42C17 30 24 22 32 12Z';

/** What is drawn behind (before) and in front of (after) the drop. */
const ART = {
  none: {},
  hachimaki: {
    front: `<path d="M17.4 34.5Q32 30 46.6 34.5L47 39Q32 34.6 17 39Z" fill="#f7f4ff" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="32" cy="35" r="2.3" fill="#e0404a"/>
      <path d="M46 36.2l9.5-4.6 1.1 2.6-9.6 4.3zM46.3 37.8l8.6 1 -.4 2.7-8.5-1.1z" fill="#f7f4ff" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round"/>`,
  },
  kitsune: {
    front: `<g transform="translate(42 30) rotate(18) scale(.62)">
      <path d="M0 15C-7 13-12 7-12 1L-11-14-3-6Q0-7 3-6L11-14 12 1C12 7 7 13 0 15Z" fill="#fbf7f2" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round"/>
      <path d="M-9.5-10.5-9 -3-4.5-5.5ZM9.5-10.5 9-3 4.5-5.5Z" fill="#d8343f"/>
      <path d="M-7 0q3 2 5 0M7 0q-3 2-5 0" stroke="${INK}" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      <path d="M0-6c1 2 2 3 1 4.5a1.3 1.3 0 0 1-2 0c-1-1.5 0-2.5 1-4.5z" fill="#d8343f"/>
      <ellipse cx="0" cy="9.5" rx="1.6" ry="1.1" fill="${INK}"/></g>`,
  },
  sakura: {
    front: `<g transform="translate(21 30)">${[0, 72, 144, 216, 288]
      .map((a) => `<path transform="rotate(${a})" d="M0-.8C-3.2-2-2.6-6.2-.8-7L0-6 .8-7C2.6-6.2 3.2-2 0-.8Z" fill="#ffc0dc" stroke="${INK}" stroke-width=".9" stroke-linejoin="round"/>`)
      .join('')}<circle r="1.6" fill="#ff6fa5"/></g>
      <path d="M20.5 32v6" stroke="#d9ad4f" stroke-width=".8"/><circle cx="20.5" cy="38.8" r="1.3" fill="#fff" stroke="${INK}" stroke-width=".7"/><circle cx="20.5" cy="41.8" r="1.6" fill="#ff86bd" stroke="${INK}" stroke-width=".7"/>`,
  },
  lantern: {
    front: `<circle cx="54" cy="41" r="9" fill="#ffb347" opacity=".28"/>
      <path d="M54 30.5v2" stroke="${INK}" stroke-width="1.2"/><path d="M51.3 31.5a2.7 2.7 0 0 1 5.4 0" stroke="${INK}" stroke-width="1.2" fill="none"/>
      <ellipse cx="54" cy="41" rx="6.2" ry="7.6" fill="#e8483c" stroke="${INK}" stroke-width="1.5"/>
      <path d="M48.3 38.3h11.4M48 41h12M48.3 43.7h11.4" stroke="#a52a22" stroke-width=".8"/>
      <rect x="50.5" y="32.6" width="7" height="2.4" rx=".8" fill="#2a1d2e"/><rect x="50.5" y="47" width="7" height="2.4" rx=".8" fill="#2a1d2e"/>`,
  },
  glasses: {
    front: `<g fill="rgba(255,255,255,.15)" stroke="${INK}" stroke-width="3"><circle cx="26.3" cy="42" r="4.6"/><circle cx="37.7" cy="42" r="4.6"/></g>
      <g fill="none" stroke="#d9ad4f" stroke-width="1.6"><circle cx="26.3" cy="42" r="4.6"/><circle cx="37.7" cy="42" r="4.6"/><path d="M30.9 41.4q1.1-1.2 2.2 0"/></g>`,
  },
  scarf: {
    front: (id) => `<clipPath id="sc${id}"><path d="M17.6 47.5Q32 52.5 46.4 47.5L45.2 53Q32 57.5 18.8 53Z"/></clipPath>
      <g clip-path="url(#sc${id})"><rect x="16" y="45" width="32" height="14" fill="#f5ead8"/>${[18, 26, 34, 42].map((x) => `<rect x="${x}" y="45" width="4" height="14" fill="#d9434e"/>`).join('')}</g>
      <path d="M17.6 47.5Q32 52.5 46.4 47.5L45.2 53Q32 57.5 18.8 53Z" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M23 53.5l-1.5 8 4.5.6 1.2-8z" fill="#d9434e" stroke="${INK}" stroke-width="1.3" stroke-linejoin="round"/>`,
  },
  kasa: {
    front: `<path d="M8 34.5L32 21.5 56 34.5Q32 39.5 8 34.5Z" fill="#ecc771" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M32 21.5 20 33.4M32 21.5 26 35.8M32 21.5 38 35.8M32 21.5 44 33.4" stroke="#b98a35" stroke-width=".7"/>
      <path d="M27.7 24.4Q32 25.6 36.3 24.4L37.8 25.6Q32 27.2 26.2 25.6Z" fill="#d9434e"/>`,
  },
  witch: {
    front: `<path d="M21 32.5L36 7.5Q39 4 43.5 6.5L40 9.5 43 32.5Z" fill="#5b3fa8" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>
      <ellipse cx="32" cy="33" rx="24" ry="4.4" fill="#4d3494" stroke="${INK}" stroke-width="1.6"/>
      <path d="M21.3 31.2L22.6 27.6Q32 29.5 41.6 27.6L42.4 31.2Q32 33.4 21.3 31.2Z" fill="#f59e2b"/>
      <rect x="29.8" y="28.2" width="4.4" height="3.6" rx=".6" fill="#ffd166" stroke="${INK}" stroke-width=".7"/>`,
  },
  santa: {
    front: `<path d="M18.5 32.5Q22 14 34 10Q47 8 53 17L49 19Q44 14 38 15Q44 22 45.5 32.5Z" fill="#d63846" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>
      <rect x="15.5" y="29.5" width="33" height="7" rx="3.5" fill="#f7f4ef" stroke="${INK}" stroke-width="1.6"/>
      <circle cx="53.5" cy="18.5" r="4.3" fill="#f7f4ef" stroke="${INK}" stroke-width="1.6"/>`,
  },
  party: {
    front: `<path d="M22.5 27.5L32 4 41.5 27.5Q32 30 22.5 27.5Z" fill="#ff7eb6" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M28.6 13.5L35.4 13.5M25.6 21 38.4 21" stroke="#fff" stroke-width="2.6"/>
      <circle cx="32" cy="4.5" r="3" fill="#ffd166" stroke="${INK}" stroke-width="1.3"/>`,
  },
};

/**
 * The SVG of a flame in `color` (a name or "#rrggbb") wearing `outfit` (one
 * of OUTFITS or 'none'). `badge`: an "A" dot for "automatic".
 */
export function outfitPreview(outfit, color, { badge = false } = {}) {
  const colors = palette(color);
  const id = (uid += 1);
  const art = ART[outfit] ?? ART.none;
  const draw = (part) => (typeof part === 'function' ? part(id) : (part ?? ''));
  return `<svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true">
    <defs><linearGradient id="g${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hex(colors.high)}"/><stop offset="1" stop-color="${hex(colors.low)}"/></linearGradient></defs>
    ${draw(art.back)}
    <path d="${DROP}" fill="url(#g${id})" stroke="${INK}" stroke-width="2.2" stroke-linejoin="round"/>
    <ellipse cx="26.3" cy="42" rx="2.1" ry="2.9" fill="${INK}"/><ellipse cx="37.7" cy="42" rx="2.1" ry="2.9" fill="${INK}"/>
    <circle cx="27" cy="40.8" r=".8" fill="#fff"/><circle cx="38.4" cy="40.8" r=".8" fill="#fff"/>
    ${draw(art.front)}
    ${badge ? `<circle cx="54" cy="54" r="7" fill="${hex(colors.accent)}" stroke="${INK}" stroke-width="1.4"/><text x="54" y="57.6" text-anchor="middle" font-size="9.5" font-weight="800" fill="${INK}" font-family="system-ui,Segoe UI,sans-serif">A</text>` : ''}
  </svg>`;
}
