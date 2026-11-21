/** Shell-level UI state shared between the shell, features and the command palette. */

class ShellState {
  /** Command palette visibility. */
  paletteOpen = $state(false);
  /** Hide all chrome (rail, bottom bar) — used by fullscreen browsing and the game player. */
  immersive = $state(false);
  /** Rail revealed as an overlay while the sidebar setting is "hidden". */
  railOverlay = $state(false);
  /**
   * The shell paints Home's backdrop (appearance.homeBackground) behind the whole window, chrome included: on Home and
   * on a browser tab showing the new-tab page. Home then leaves its own backdrop out.
   */
  backdrop = $state(false);
  /** Effective rail presentation, resolved by the shell from settings, route and viewport. */
  railMode = $state<'expanded' | 'compact' | 'hidden' | 'mobile'>('expanded');

  openPalette(): void {
    this.paletteOpen = true;
  }

  closePalette(): void {
    this.paletteOpen = false;
  }

  togglePalette(): void {
    this.paletteOpen = !this.paletteOpen;
  }
}

export const shell = new ShellState();
