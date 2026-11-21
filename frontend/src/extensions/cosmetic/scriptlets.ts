/**
 * The scriptlet runner (WAVE-B3 D11, §5.1, §11.3). The sources come from `FilterEngines.cosmetics()`, which builds
 * each call itself from the verified `ubo-resources` list with the arguments as one JSON array (lane x1's
 * `scriptletCall`; never the library's own assembled strings, which let list text run as code, §11.4). They run:
 *  - in the PAGE realm, through `PageKit.run`, which compiles each with that realm's current `Function` after the
 *    engine's client hooked the window (Scramjet `init.post`; Ultraviolet right after its handler), so the engine
 *    rewrites the scriptlet like page code and it sees the virtual location, cookie jar and storage;
 *  - never through a `<script>` element (it would bypass the engine's rewriting), never in the engine-host realm;
 *  - inside `withPageAssignments`, so a scriptlet that wraps `window.open` by assignment (uBO's `prevent-window-open`,
 *    alias `nowoif`) keeps its wrapper in front of GNOME's own `open`;
 *  - at document start only (a document whose filters arrive late gets its styles, not its scriptlets).
 * `executionWorld: 'ISOLATED'` scriptlets run in the main world like uBO's MV2 build: a proxy has no other world.
 * [unproven] in both engines and browsers until rows CS11–CS17 pass (WAVE-B3 D11, O4, O12).
 */
import type { PageKit } from '../../engine-host/realm';

/** Runs `scripts` in `win`'s realm; returns how many did not run (logged as a count, never with page data). */
export function runScriptlets(
  win: Window,
  kit: Pick<PageKit, 'run'>,
  scripts: readonly string[],
  withPageAssignments: (win: Window, run: () => void) => void,
  log: (level: 'warn' | 'error', message: string) => void,
): number {
  if (scripts.length === 0) return 0;
  let failed = 0;
  let ran = 0;
  try {
    withPageAssignments(win, () => {
      for (const s of scripts) {
        ran++;
        let ok = false;
        try {
          ok = kit.run(s) === true;
        } catch {
          ok = false;
        }
        if (!ok) failed++;
      }
    });
  } catch {
    failed += scripts.length - ran;
  }
  if (failed > 0) log('warn', `cosmetic filtering: ${failed} of ${scripts.length} scriptlets did not run in a document`);
  return failed;
}
