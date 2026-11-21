/** A 16×16 PNG (the fixture favicon of the e2e suites), for unit tests. */
export const PNG_BYTES = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGNkYPjPQApgIkn1qIZRDcMHAEn/AR/Ll1RuAAAAAElFTkSuQmCC'),
  (c) => c.charCodeAt(0),
);
