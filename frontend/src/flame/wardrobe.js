/**
 * The flame's wardrobe: what she can wear and what she puts on by herself
 * in each season. Only logic (no three.js): her page, the panel and the node
 * tests use it. How the accessories are made is in flame/outfits.js.
 *
 * Her own things, tied to her name (tsukumogami are Japanese objects that
 * come to life): the hachimaki headband when she works hard, the festival
 * fox mask, the sakura hair clip, a chochin lantern floating beside her...
 * pointed hats, which suit a flame perfectly, and for every mood a bow tie,
 * a crown, an angel's halo or a little devil's horns, headphones for the
 * music, cat ears, a top hat.
 */

import { t } from '../i18n.js';

/** Everything she can wear, in the panel's order. */
export const OUTFITS = [
  'bowtie',
  'crown',
  'angel',
  'devil',
  'headphones',
  'catears',
  'tophat',
  'hachimaki',
  'kitsune',
  'sakura',
  'lantern',
  'glasses',
  'scarf',
  'kasa',
  'witch',
  'santa',
  'party',
];

/** The possible choices: "auto" follows the seasons, "none" nothing. */
export const SELECTIONS = ['auto', 'none', ...OUTFITS];
export const DEFAULT_OUTFIT = 'auto';

export const OUTFIT_LABELS = {
  auto: t('Automatic'),
  none: t('Nothing'),
  bowtie: t('Bow tie'),
  crown: t('Crown'),
  angel: t('Angel halo and wings'),
  devil: t('Little devil'),
  headphones: t('Headphones'),
  catears: t('Cat ears'),
  tophat: t('Top hat'),
  hachimaki: t('Hachimaki'),
  kitsune: t('Kitsune mask'),
  sakura: t('Sakura hair clip'),
  lantern: t('Lantern'),
  glasses: t('Round glasses'),
  scarf: t('Scarf'),
  kasa: t('Straw hat'),
  witch: t('Witch hat'),
  santa: t('Santa hat'),
  party: t('Party hat'),
};

/** A saved choice; anything unknown (other versions, garbage) counts as "auto". */
export function parseOutfit(raw) {
  return typeof raw === 'string' && SELECTIONS.includes(raw) ? raw : DEFAULT_OUTFIT;
}

/**
 * What she puts on by herself on `date` (local calendar). New Year beats
 * Christmas, then Halloween, cherry blossom, summer, winter.
 */
export function seasonalOutfit(date = new Date()) {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if ((month === 12 && day === 31) || (month === 1 && day <= 2)) return 'party';
  if (month === 12 && day <= 26) return 'santa';
  if (month === 10 || (month === 11 && day === 1)) return 'witch';
  if ((month === 3 && day >= 25) || (month === 4 && day <= 15)) return 'sakura';
  if (month === 7 || month === 8) return 'kasa';
  if (month === 1 || month === 2) return 'scarf';
  return 'none';
}

/** "auto" becomes the season's accessory; the rest is worn as it is. */
export function resolveOutfit(selection, date = new Date()) {
  const choice = parseOutfit(selection);
  return choice === 'auto' ? seasonalOutfit(date) : choice;
}
