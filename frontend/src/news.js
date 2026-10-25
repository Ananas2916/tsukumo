/**
 * What's new in each version, as she tells it right after an update: a few
 * short lines for the island's card (island.js) and one sentence to say.
 * Newest first. The lines follow the interface's language; the sentence
 * follows her voice's, like everything she says.
 */

export const NEWS = [
  {
    version: '3.3.1',
    en: [
      'When a new version is out I bring you a lantern: one click and I update myself.',
      "After each update I tell you what's new and how much we've done together.",
      'I count the words you dictate, our messages, reminders and ticked to-dos. It all stays on your PC.',
    ],
    it: [
      'Quando esce una versione nuova ti porto una lanterna: un clic e mi aggiorno da sola.',
      'Dopo ogni aggiornamento ti racconto le novità e quanto abbiamo fatto insieme.',
      'Conto le parole che mi detti, i messaggi, i promemoria e le cose spuntate. Resta tutto sul tuo PC.',
    ],
    say: {
      en: "Here I am, I'm version {version} now! Have a look at what's new.",
      it: 'Eccomi, adesso sono la {version}! Guarda cosa c’è di nuovo.',
    },
  },
  {
    version: '3.3.0',
    en: [
      'Ask me "where is…" or "where do I click…": I point at the spot on your screen with an arrow.',
      'Step by step: a click on the spot (or "done") and I move on.',
      'Choose my eye in Character → Show me where.',
    ],
    it: [
      'Chiedimi «dov’è…» o «dove clicco…»: ti indico il punto sullo schermo con una freccia.',
      'Passo dopo passo: un clic sul punto (o «fatto») e passo al successivo.',
      'Scegli il mio occhio in Personaggio → Indicare sullo schermo.',
    ],
    say: {
      en: "I'm version {version}: now I can show you where things are on the screen.",
      it: 'Sono la {version}: adesso ti posso indicare le cose sullo schermo.',
    },
  },
];

/** "3.3.1-privato" -> [3, 3, 1]. */
function numbers(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''));
  return match ? match.slice(1, 4).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * What's new from `from` (excluded; null = unknown) up to `to` (included):
 * at most `limit` lines, the newest version's first, and its sentence.
 *
 * @returns {{lines: string[], say: string} | null}
 */
export function newsBetween(from, to, uiLanguage = 'en', voiceLanguage = 'en', limit = 3) {
  const top = numbers(to);
  if (!top) return null;
  const bottom = numbers(from);
  const versions = NEWS.filter((entry) => {
    const own = numbers(entry.version);
    return compare(own, top) <= 0 && (!bottom || compare(own, bottom) > 0);
  });
  if (!versions.length) return null;
  const ui = uiLanguage === 'it' ? 'it' : 'en';
  const voice = voiceLanguage === 'it' ? 'it' : 'en';
  const lines = versions.flatMap((entry) => entry[ui]).slice(0, limit);
  const shown = top.join('.');
  return { lines, say: versions[0].say[voice].replace('{version}', shown) };
}
