/**
 * Un aiuto minimo per costruire il DOM senza innerHTML: tutto il testo che
 * arriva da agenti, servizi e utente finisce in nodi di testo, mai in markup.
 */

import { icon } from './icons.js';

/**
 * `el('button', {class: 'x', onClick: fn, dataset: {id: 1}}, 'testo', nodo)`.
 * Gli attributi `null`/`undefined`/`false` vengono saltati.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function') {
      node.addEventListener(name.slice(2).toLowerCase(), value);
    } else if (name === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (name === 'class') {
      node.className = value;
    } else if (name === 'text') {
      node.textContent = value;
    } else if (name === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (value === true) {
      node.setAttribute(name, '');
    } else {
      node.setAttribute(name, String(value));
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Bottone con icona (e testo facoltativo). */
export function iconButton(name, { label, title, className = 'icon-btn', size = 18, ...attrs } = {}) {
  return el(
    'button',
    { type: 'button', class: className, title: title ?? label, 'aria-label': title ?? label, ...attrs },
    icon(name, size),
    label && className !== 'icon-btn' ? el('span', {}, label) : null,
  );
}

/** Preferenza salvata (localStorage condiviso fra personaggio e pannello). */
export function readSetting(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeSetting(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage non disponibile: la preferenza vale fino alla chiusura */
  }
}

/** Nomi italiani delle lingue piu' comuni, per i codici corti delle voci. */
const LANGUAGES = {
  it: 'Italiano',
  en: 'Inglese',
  es: 'Spagnolo',
  fr: 'Francese',
  de: 'Tedesco',
  pt: 'Portoghese',
  ja: 'Giapponese',
  zh: 'Cinese',
  cmn: 'Cinese',
  hi: 'Hindi',
  ko: 'Coreano',
  ru: 'Russo',
  nl: 'Olandese',
  pl: 'Polacco',
  ar: 'Arabo',
  tr: 'Turco',
  sv: 'Svedese',
};

export function languageLabel(code) {
  if (!code) return 'Multilingua';
  return LANGUAGES[code] ?? code.toUpperCase();
}
