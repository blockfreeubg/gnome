/**
 * Screen-reader announcements through persistent live regions (rendered by <Announcer /> in the shell).
 * Used for route changes and toasts so announcements are reliable regardless of how content is inserted.
 */

export const announcerState = $state({ polite: '', assertive: '' });

let clearTimer: ReturnType<typeof setTimeout> | null = null;

export function announce(message: string, politeness: 'polite' | 'assertive' = 'polite'): void {
  if (!message) return;
  // Clear first so repeating the same message is announced again.
  announcerState[politeness] = '';
  requestAnimationFrame(() => {
    announcerState[politeness] = message;
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      announcerState.polite = '';
      announcerState.assertive = '';
    }, 7000);
  });
}
