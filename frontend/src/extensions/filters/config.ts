/**
 * The engine configuration of v1 (WAVE-B3 D12) and its id in the cache key (§4.3). Pure data: no import of the
 * library, so the engine host's entry chunk stays free of it.
 */

/** `Partial<Config>` of @ghostery/adblocker 2.20.3 (the 16 serialized flags; the rest keep their defaults). */
export const ENGINE_CONFIG = {
  loadPreprocessors: true,
  loadExtendedSelectors: false,
  loadCSPFilters: false,
  enableHtmlFiltering: false,
  enableCompression: false,
  integrityCheck: true,
} as const;

/** Names the flags above in the cache key: change it with any flag. */
export const ENGINE_CONFIG_ID = 'v1:pre1:ext0:csp0:html0:cmp0:crc1';

/** The preprocessor environment (`!#if`), applied with updateEnv after every build and every deserialize. */
export function preprocessorEnv(browser: 'chromium' | 'gecko' | 'other'): Map<string, boolean> {
  return new Map([
    ['env_chromium', browser === 'chromium'],
    ['env_firefox', browser === 'gecko'],
  ]);
}

/** The browser family from a User-Agent only (the service worker has no document to check features on). */
export function browserFromUa(ua: string): 'chromium' | 'gecko' | 'other' {
  if (/\bFirefox\//.test(ua)) return 'gecko';
  if (/Chrom(?:e|ium)\/\d/.test(ua)) return 'chromium';
  return 'other';
}
