/**
 * Interface language. The source is English; `i18n/it.js` maps English text
 * to Italian. Every page reads the choice once at load: changing it reloads
 * the windows (see `watchLanguage`), so plain `t()` calls at module level are
 * fine.
 *
 * - `t(text, vars)` for text written in the frontend. `{name}` placeholders
 *   are filled from `vars`.
 * - `tx(text)` for text that comes from the backend (engine descriptions,
 *   errors, hints): exact match first, then catalog keys with `{0}`, `{1}`...
 *   used as patterns, so "Working folder does not exist: C:\x" still finds
 *   its Italian.
 *
 * This is the interface only: what Tsukumo says follows the voice language.
 */

import { IT } from './i18n/it.js';

export const LANGUAGE_SETTING = 'dc:ui-language';
export const UI_LANGUAGES = { en: 'English', it: 'Italiano' };

/** The saved choice ('en', 'it') or 'auto' (the system language: Italian on an Italian PC, English otherwise). */
export function savedLanguage() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(LANGUAGE_SETTING) ?? 'null');
    return raw in UI_LANGUAGES ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

function systemLanguage() {
  if (typeof navigator === 'undefined') return 'en';
  const first = navigator.languages?.[0] ?? navigator.language ?? 'en';
  return first.toLowerCase().startsWith('it') ? 'it' : 'en';
}

/** The language the interface is in now. */
export const LANG = savedLanguage() === 'auto' ? systemLanguage() : savedLanguage();
const CATALOG = LANG === 'it' ? IT : null;
/** For dates and numbers: Italian, or the system's English (12 or 24 hours as the user is used to). */
export const LOCALE = LANG === 'it' ? 'it-IT' : typeof navigator !== 'undefined' && navigator.language?.startsWith('en') ? navigator.language : 'en-GB';

if (typeof document !== 'undefined') document.documentElement.lang = LANG;

function fill(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, key) => (key in vars && vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : match));
}

/** "Connected|integration": the part after "|" only picks the translation (the same English, two Italians). */
function english(text) {
  const bar = text.indexOf('|');
  return bar < 0 ? text : text.slice(0, bar);
}

/** Interface text written in English, in the language of the interface. */
export function t(text, vars) {
  return fill(CATALOG?.[text] ?? english(text), vars);
}

let patterns = null;

/** Catalog keys with {0}, {1}...: regular expressions built once, the first time they are needed. */
function catalogPatterns() {
  if (patterns) return patterns;
  patterns = [];
  for (const [key, value] of Object.entries(CATALOG ?? {})) {
    if (!/\{\d+\}/.test(key)) continue;
    const parts = key.split(/(\{\d+\})/);
    const order = [];
    const source = parts
      .map((part) => {
        const slot = /^\{(\d+)\}$/.exec(part);
        if (!slot) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        order.push(Number(slot[1]));
        return '([\\s\\S]+?)';
      })
      .join('');
    patterns.push({ re: new RegExp(`^${source}$`), order, value, length: key.length });
  }
  // The most specific first: "{0} (weighted {1})" before "{0}".
  patterns.sort((a, b) => b.length - a.length);
  return patterns;
}

/** Text that comes from the backend. Unknown text stays as it is. */
export function tx(text) {
  if (!CATALOG || typeof text !== 'string' || !text) return text;
  if (CATALOG[text] !== undefined) return CATALOG[text];
  for (const { re, order, value } of catalogPatterns()) {
    const match = re.exec(text);
    if (!match) continue;
    const values = {};
    order.forEach((slot, index) => (values[slot] = match[index + 1]));
    return value.replace(/\{(\d+)\}/g, (all, slot) => values[slot] ?? all);
  }
  return text;
}

/** Saves the choice ('auto', 'en', 'it'); every open window reloads (see watchLanguage). */
export function setLanguage(value) {
  try {
    if (value === 'auto') window.localStorage.removeItem(LANGUAGE_SETTING);
    else window.localStorage.setItem(LANGUAGE_SETTING, JSON.stringify(value));
  } catch {
    /* storage off: stays as it is */
  }
}

/** Another window changed the language: this page reloads in the new one. */
export function watchLanguage(onChange = () => window.location.reload()) {
  window.addEventListener('storage', (event) => {
    if (event.key === LANGUAGE_SETTING || event.key === null) onChange();
  });
}

/**
 * Static text in the HTML pages: elements marked `data-i18n` get their text
 * translated, `data-i18n-attrs="title,placeholder,aria-label"` the listed
 * attributes. The English stays in the HTML.
 */
export function translateDom(root = document) {
  if (!CATALOG) return;
  for (const node of root.querySelectorAll('[data-i18n]')) {
    // Only the element's own text nodes: icons and nested markup stay.
    for (const child of node.childNodes) {
      if (child.nodeType === 3 && child.textContent.trim()) {
        const text = child.textContent.trim();
        child.textContent = child.textContent.replace(text, t(text));
      }
    }
  }
  for (const node of root.querySelectorAll('[data-i18n-attrs]')) {
    for (const name of node.getAttribute('data-i18n-attrs').split(',')) {
      const value = node.getAttribute(name.trim());
      if (value) node.setAttribute(name.trim(), t(value));
    }
  }
  if (root === document && document.title) document.title = t(document.title);
}
