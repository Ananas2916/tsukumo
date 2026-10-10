/**
 * A minimal helper to build the DOM without innerHTML: all text coming from
 * agents, services and the user ends up in text nodes, never in markup.
 */

import { t } from './i18n.js';
import { icon } from './icons.js';

/**
 * `el('button', {class: 'x', onClick: fn, dataset: {id: 1}}, 'text', node)`.
 * `null`/`undefined`/`false` attributes are skipped.
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

/** A button with an icon (and optional text). */
export function iconButton(name, { label, title, className = 'icon-btn', size = 18, ...attrs } = {}) {
  return el(
    'button',
    { type: 'button', class: className, title: title ?? label, 'aria-label': title ?? label, ...attrs },
    icon(name, size),
    label && className !== 'icon-btn' ? el('span', {}, label) : null,
  );
}

/** A saved preference (localStorage shared by the character and the panel). */
/**
 * With the 3D body ('vrm') or without ('none'), from `dc:body`. The flame is
 * Tsukumo and the VRM an optional body: newcomers start without one; whoever
 * had already done the introduction when the body came by default keeps it.
 */
export function readBody() {
  const fallback = readSetting('dc:onboarded', false) ? 'vrm' : 'none';
  return readSetting('dc:body', fallback) === 'none' ? 'none' : 'vrm';
}

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
    /* localStorage unavailable: the preference lasts until the window closes */
  }
}

/** Names of the most common languages, for the short codes of the voices. */
const LANGUAGES = {
  it: t('Italian'),
  en: t('English'),
  es: t('Spanish'),
  fr: t('French'),
  de: t('German'),
  pt: t('Portuguese'),
  ja: t('Japanese'),
  zh: t('Chinese'),
  cmn: t('Chinese'),
  hi: 'Hindi',
  ko: t('Korean'),
  ru: t('Russian'),
  nl: t('Dutch'),
  pl: t('Polish'),
  ar: t('Arabic'),
  tr: t('Turkish'),
  sv: t('Swedish'),
};

export function languageLabel(code) {
  if (!code) return t('Multilingual');
  return LANGUAGES[code] ?? code.toUpperCase();
}
