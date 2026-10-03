/**
 * Risoluzione degli endpoint del backend.
 *
 * Due scenari:
 *  1. build servita da FastAPI (http://127.0.0.1:8770)  -> stessa origine
 *  2. dev server Vite (http://localhost:5173)           -> proxy verso il backend
 *
 * Prima c'era anche `?backend=http://host:porta`, salvato in localStorage:
 * bastava un link per far parlare la pagina con un server qualunque, per
 * sempre. Il backend ora accetta solo la propria origine (security.py),
 * quindi non servirebbe comunque.
 */

const DEFAULT_BACKEND = 'http://127.0.0.1:8770';

try {
  // Un override rimasto da una versione precedente non deve piu' contare.
  window.localStorage.removeItem('dc:backend');
} catch {
  /* localStorage puo' essere disabilitato: non e' un problema */
}

/** Origine HTTP del backend (senza slash finale). */
export const httpBase = (() => {
  // Con i protocolli http/https usiamo la stessa origine: in dev ci pensa il
  // proxy di Vite, in produzione il backend serve anche i file statici.
  if (window.location.protocol.startsWith('http')) return '';
  return DEFAULT_BACKEND;
})();

/** URL completo del WebSocket. */
export const wsUrl = (() => {
  const base = httpBase || window.location.origin;
  const url = new URL('/ws', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
})();

/** Costruisce l'URL di una risorsa servita dal backend. */
export function apiUrl(path) {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${httpBase}${clean}`;
}

/** Nome dei blendshape/espressioni per ciascun viseme (default VRoid/VRM). */
export const DEFAULT_BLENDSHAPES = {
  a: { vrm0: 'fcl_mth_a', vrm1: 'aa' },
  i: { vrm0: 'fcl_mth_i', vrm1: 'ih' },
  u: { vrm0: 'fcl_mth_u', vrm1: 'ou' },
  e: { vrm0: 'fcl_mth_e', vrm1: 'ee' },
  o: { vrm0: 'fcl_mth_o', vrm1: 'oh' },
};

/** I cinque visemi "aperti" nell'ordine usato dalla UI di debug. */
export const VISEME_KEYS = ['a', 'i', 'u', 'e', 'o'];
