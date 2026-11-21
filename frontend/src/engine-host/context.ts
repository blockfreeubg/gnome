/**
 * What the per-document observers, the popup router, the download taps and the tab manager share: one object built
 * by the composition root (core.ts) per engine-host load. Types only, so these modules do not import each other.
 */
import type { EngineId, EngineSettings, EnginePermission, EventMap, EventType, LogLevel, TabId } from '../shared/engine-protocol';
import type { UvContextSender } from '../extensions/host/uv-context';
import type { Announcements, BlockedCounts, WsMarks } from './blocked';
import type { EngineManager } from './engines/manager';
import type { Natives } from './natives';

export interface Counters {
  csp: { violations: number; byDirective: Record<string, number> };
  webrtc: { blocked: number };
  fallback: { switched: number; notRetried: number };
  sw: { held: number; unavailable: number };
  /** Errors inside the engines' hooks (they never throw into the engines). */
  hookErrors: number;
  popups: { routed: number; closeRequests: number };
  downloads: { started: number; ignoredUv: number };
  /** Wave B step 3 (EngineDiagnostics.blocker): WebSocket backstop decisions. */
  blocker: { wsBackstopBlocked: number; wsBackstopSkipped: number };
}

export function newCounters(): Counters {
  return {
    csp: { violations: 0, byDirective: {} },
    webrtc: { blocked: 0 },
    fallback: { switched: 0, notRetried: 0 },
    sw: { held: 0, unavailable: 0 },
    hookErrors: 0,
    popups: { routed: 0, closeRequests: 0 },
    downloads: { started: 0, ignoredUv: 0 },
    blocker: { wsBackstopBlocked: 0, wsBackstopSkipped: 0 },
  };
}

export interface HostContext {
  readonly N: Natives;
  readonly engines: EngineManager;
  readonly counters: Counters;
  /** The settings snapshot of the last init/settings command. */
  settings(): EngineSettings;
  /** The permissions this host enforces in this browser (InitResult.enforcedPermissions). */
  enforced(): readonly EnginePermission[];
  emit<T extends EventType>(type: T, p: EventMap[T]): void;
  log(level: LogLevel, message: string): void;
  now(): number;
  /** Wave B step 3: per-tab block counts (tab.blocked), navigation announcements, the UV context for the SW. */
  readonly blocking: BlockingLink;
}

/** What the tabs share with the content blocker (WAVE-B3 §4.4); present also without one (counts, announcements). */
export interface BlockingLink {
  readonly counts: BlockedCounts;
  readonly announcements: Announcements;
  /** D16: the per-document Scramjet WebSocket wrapper's decisions, for the transport backstop. */
  readonly wsMarks: WsMarks;
  /** Null while no blocker runs (then nothing is sent to the SW about UV documents). */
  uvContext(): UvContextSender | null;
  /** An Ultraviolet load of a tab of this engine host starts (the content blocker supplies the SW's engines). */
  onUvTab(): void;
}

/** Where a proxied document sits: its tab and how deep (1 = the tab's top document). */
export interface DocumentPlace {
  tabId: TabId;
  depth: number;
  engine: EngineId;
}
