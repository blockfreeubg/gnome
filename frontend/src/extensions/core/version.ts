/** Versions that are part of the blocker cache key (WAVE-B3 §4.3). Pure. */

/** The cache layout of WAVE-B3 §4.3 (`gnome-blocker-v1`). */
export const BLOCKER_FORMAT = 1;

/**
 * `ENGINE_VERSION` of the pinned @ghostery/adblocker (2.20.3). A unit test compares it with the library's own
 * constant, so a library upgrade changes the cache key deliberately.
 */
export const ADBLOCKER_ENGINE_VERSION = 899;
