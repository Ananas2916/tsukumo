/**
 * Where the backend endpoints are.
 *
 * Two cases:
 *  1. build served by FastAPI (http://127.0.0.1:8770)  -> same origin
 *  2. Vite dev server (http://localhost:5173)          -> proxied to the backend
 *
 * There used to be `?backend=http://host:port` too, saved in localStorage:
 * one link was enough to make the page talk to any server, forever. The
 * backend now accepts only its own origin (security.py), so it would not
 * work anyway.
 */

const DEFAULT_BACKEND = 'http://127.0.0.1:8770';

try {
  // An override left over from an older version must not count any more.
  window.localStorage.removeItem('dc:backend');
} catch {
  /* localStorage may be disabled: not a problem */
}

/** HTTP origin of the backend (no trailing slash). */
export const httpBase = (() => {
  // With http/https we use the same origin: in dev Vite's proxy takes care of
  // it, in production the backend also serves the static files.
  if (window.location.protocol.startsWith('http')) return '';
  return DEFAULT_BACKEND;
})();

/** Full URL of the WebSocket. */
export const wsUrl = (() => {
  const base = httpBase || window.location.origin;
  const url = new URL('/ws', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
})();

/** Builds the URL of a resource served by the backend. */
export function apiUrl(path) {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${httpBase}${clean}`;
}

/** Blendshape/expression name for each viseme (VRoid/VRM defaults). */
export const DEFAULT_BLENDSHAPES = {
  a: { vrm0: 'fcl_mth_a', vrm1: 'aa' },
  i: { vrm0: 'fcl_mth_i', vrm1: 'ih' },
  u: { vrm0: 'fcl_mth_u', vrm1: 'ou' },
  e: { vrm0: 'fcl_mth_e', vrm1: 'ee' },
  o: { vrm0: 'fcl_mth_o', vrm1: 'oh' },
};

/** The five "open" visemes, in the order used by the debug UI. */
export const VISEME_KEYS = ['a', 'i', 'u', 'e', 'o'];
