/**
 * The shell's own words (tray menu, waiting card, dialogs) in the interface's
 * language. The pages decide it (frontend/src/i18n.js) and tell us at every
 * start (`app:language`); before that, the last one we heard, or the
 * system's. The source is English, IT maps it to Italian.
 */

const IT = {
  "Always in front of windows": "Sempre davanti alle finestre",
  "Character": "Personaggio",
  "Choose a VRM model": "Scegli un modello VRM",
  "Engines": "Motori",
  "Ghost mode": "Modalita fantasma",
  "I can't start Tsukumo": "Non riesco ad avviare Tsukumo",
  "Invalid login address.": "Indirizzo del login non valido.",
  "Look at the screen": "Guarda lo schermo",
  "No screen to capture": "Nessuno schermo da catturare",
  "One moment.": "Un attimo.",
  "Open the chat": "Apri la chat",
  "Open the log": "Apri il log",
  "Port {port} is taken by another program. Close it, then use \"Restart\" from the icon in the notification area.": "La porta {port} è occupata da un altro programma. Chiudilo, poi usa \"Riavvia\" dall'icona nell'area di notifica.",
  "Quit": "Esci",
  "Restart": "Riavvia",
  "Restarting…": "Riavvio…",
  "Show the commands beside her": "Mostra i comandi accanto a lei",
  "Starting the brain and the voice.": "Avvio il cervello e la voce.",
  "The backend closed by itself. The reason is below and in the log (notification area icon -> Open the log).": "Il backend si e' chiuso da solo. Il motivo e' qui sotto e nel log (icona nell'area di notifica -> Apri il log).",
  "The backend isn't answering. Check the log from the notification area icon.": "Il backend non risponde. Controlla il log dall'icona nell'area di notifica.",
  "The shortcut {key} is already in use.": "La scorciatoia {key} è già in uso.",
  "VRM models": "Modelli VRM",
  "{name} - panel": "{name} - pannello",
  "{name} is waking up…": "{name} si sta svegliando…",
};

let current = 'en';

/** 'it' or 'en' (anything else is English). Returns the language now in use. */
function setLanguage(value) {
  current = value === 'it' ? 'it' : 'en';
  return current;
}

/** English text in the interface's language, with `{name}` placeholders filled from `vars`. */
function t(text, vars) {
  const template = (current === 'it' && IT[text]) || text;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

module.exports = { setLanguage, t, language: () => current };
