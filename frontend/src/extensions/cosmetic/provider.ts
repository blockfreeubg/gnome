/**
 * The `cosmetic` provider (WAVE-B3 §5.1, §5.2): element hiding, GNOME's own generic-rule monitor and scriptlets for
 * every proxied document the core attaches (any depth: Scramjet `init.post`; Ultraviolet right after UV's client,
 * §4.4), under the tab's policy (`ctx.policy`, D2/D3: frames inherit their tab's) and the document's own URL (a
 * site-b frame inside site-a gets site-b's rules). Only `onDocument`; window side only; rule R1 binds every line:
 * everything it puts into a page realm comes from that realm's kit (`kit.sheet`, `kit.adopt`, `kit.setSheet`,
 * `kit.observe`, `kit.run`) or from the page document's own factory (`createElement` reached through the page
 * document), and it reads page objects only with engine-host natives. No kit (a realm whose Function is not the
 * browser's own, or that forbids eval) → nothing at all.
 *
 *  - Engines not ready: nothing now; the document (weakly held, at most 256) gets its styles and its monitor when the
 *    engines become ready (`engines.onChange`), not its scriptlets (too late to matter, and order-dependent).
 *  - Allowlisted site: nothing (no styles, no scriptlets; D3).
 *  - `styles` (only with `policy.hide`; the generic base stylesheet only with `policy.genericHide`): one page-realm
 *    constructed stylesheet, adopted by the document; else a page-made `<style>` element.
 *  - `policy.genericHide`: the generic-rule monitor (monitor.ts) into a second sheet, stopped at the trusted
 *    `pagehide`.
 *  - scriptlets (per group toggle, D2): scriptlets.ts.
 * The engine-host document is never touched: the core calls onDocument only for documents in a tab's frame tree.
 */
import type { DocumentInfo, ProxiedWindow } from '../../shared/engine-hooks';
import type { Natives } from '../../engine-host/natives';
import { injectStyles } from './inject';
import { MONITOR_LIMITS, startMonitor } from './monitor';
import { cosmeticNatives } from './natives';
import type { CosmeticNatives } from './natives';
import { runScriptlets } from './scriptlets';
import type { PageKit } from '../../engine-host/realm';
import type { HookProvider, RequestContext } from '../core/compose';
import type { SitePolicy } from '../core/policy';
import type { FilterEngines } from '../filters/engines';

export interface CosmeticProviderDeps {
  N: Natives;
  engines: FilterEngines;
  kitOf(win: Window): PageKit | null;
  withPageAssignments(win: Window, run: () => void): void;
  log(level: 'warn' | 'error', message: string): void;
}

/** Documents that arrived before the engines were ready (WAVE-B3 §5.1). */
export const LATE_DOCUMENTS = 256;

/** What the provider needs beyond its deps (the engine-host natives of cosmetic/natives.ts and a timer). */
export interface CosmeticRuntime {
  readonly CN: CosmeticNatives;
  schedule(fn: () => void, ms: number): void;
  now(): number;
}

interface Late {
  readonly win: Window;
  readonly url: string;
  readonly policy: SitePolicy;
  readonly kit: PageKit;
}

export function createCosmeticProvider(deps: CosmeticProviderDeps): HookProvider {
  const N = deps.N;
  return createCosmeticProviderWith(deps, {
    CN: cosmeticNatives(),
    schedule: (fn, ms) => {
      N.setTimeout(fn, ms);
    },
    now: () => Date.now(),
  });
}

/** createCosmeticProvider with its runtime passed in (unit tests use fake natives and a fake clock). */
export function createCosmeticProviderWith(deps: CosmeticProviderDeps, rt: CosmeticRuntime): HookProvider {
  const { N, engines, log } = deps;
  const { CN } = rt;
  /** Documents already handled (an engine may report a document twice). */
  const handled = new WeakSet<object>();
  let late: Array<WeakRef<Document>> = [];
  const lateInfo = new WeakMap<Document, Late>();

  /** Styles and, with genericHide, the monitor (both paths: at document start and late). */
  const hide = (win: Window, doc: Document, url: string, policy: SitePolicy, kit: PageKit, styles: string): void => {
    let initialChars = 0;
    if (styles.length > MONITOR_LIMITS.cssChars) {
      log('warn', 'cosmetic filtering: a document\'s styles exceed 512 KiB and were not applied');
    } else if (styles.length > 0) {
      try {
        if (injectStyles(CN, kit, doc, styles) === null) log('warn', 'cosmetic filtering: a document took no stylesheet');
        else initialChars = styles.length;
      } catch {
        log('warn', 'cosmetic filtering: styles could not be applied to a document');
      }
    }
    if (!policy.genericHide) return;
    try {
      const monitor = startMonitor(doc, {
        CN,
        kit,
        rulesFor: (features) => engines.cosmeticsForFeatures(url, policy, features),
        inject: (css) => injectStyles(CN, kit, doc, css),
        schedule: rt.schedule,
        now: rt.now,
        initialChars,
        log,
      });
      // Engine-host listener on a page target: its events are page-realm; synthetic ones (isTrusted, an unforgeable
      // own property of every event, false) are ignored.
      N.on.call(win, 'pagehide', (ev: Event) => {
        if (ev.isTrusted) monitor.stop();
      });
    } catch {
      log('warn', 'cosmetic filtering: the generic-rule monitor could not start in a document');
    }
  };

  const onLateReady = (): void => {
    if (late.length === 0 || !engines.ready()) return;
    const docs = late;
    late = [];
    for (const ref of docs) {
      const doc = ref.deref();
      const info = doc && lateInfo.get(doc);
      if (!doc || !info) continue;
      lateInfo.delete(doc);
      try {
        const { styles } = engines.cosmetics(info.url, info.policy);
        hide(info.win, doc, info.url, info.policy, info.kit, typeof styles === 'string' ? styles : '');
      } catch {
        log('warn', 'cosmetic filtering: late styles could not be read');
      }
    }
  };
  engines.onChange(onLateReady);

  return {
    name: 'cosmetic',
    onDocument(pw: ProxiedWindow, info: DocumentInfo, ctx: RequestContext): void {
      const policy = ctx.policy;
      if (policy.allowlisted) return;
      const win = pw as Window;
      const kit = deps.kitOf(win);
      if (kit === null) return;
      const doc = N.winDocument.call(win);
      if (handled.has(doc)) return;
      handled.add(doc);
      if (!engines.ready()) {
        if (late.length >= LATE_DOCUMENTS) late.shift();
        late.push(new WeakRef(doc));
        lateInfo.set(doc, { win, url: info.url, policy, kit });
        return;
      }
      const { styles, scripts } = engines.cosmetics(info.url, policy);
      // Scriptlets first: they must run before the page's own scripts (both steps are synchronous here).
      runScriptlets(win, kit, Array.isArray(scripts) ? scripts : [], deps.withPageAssignments, log);
      hide(win, doc, info.url, policy, kit, typeof styles === 'string' ? styles : '');
    },
  };
}
