/**
 * Scramjet 2.0.67-alpha.2 + scramjet-controller 0.0.14 in the engine host (spike §4.7): wasm check, Controller with
 * the first initialized transport, `controller.wait()` (10 s), later transports through the transport manager's sink,
 * the Controller re-pointed when another service worker takes control, URL rewriting both ways, and the cookie jar.
 */
import { LIMITS } from '../../shared/engine-protocol';
import type { EngineStatus } from '../../shared/engine-protocol';
import { PROXY_PATHS, VENDOR } from '../../shared/proxy-origin';
import type { SwClient } from '../../shared/proxy-origin';
import { RECOVERY } from '../../shared/transport';
import type { TransportManager } from '../../shared/transport';
import { parseScramjetDump } from '../cookies';
import type { ScramjetCookie } from '../cookies';
import { GnomeLoads, withInitiator } from '../sj-requests';
import type { SjRequestRpc } from '../sj-requests';
import { vendor } from './vendor';
import type { ManagedPluginLike, ScramjetControllerLike, ScramjetFrameLike } from './vendor';

export const SCRAMJET_CONFIG = {
  prefix: PROXY_PATHS.scramjetPrefix,
  scramjetPath: VENDOR.scramjet,
  injectPath: VENDOR.controllerInject,
  wasmPath: VENDOR.scramjetWasm,
} as const;

const WASM_MAGIC = '0,97,115,109';

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export class ScramjetEngine {
  readonly status: EngineStatus;
  controller: ScramjetControllerLike | null = null;
  initMs: number | null = null;
  /**
   * The navigations GNOME starts in Scramjet tab frames (tabs.ts) and the initiator each carries (withInitiator):
   * none for GNOME's own, the opener page for a tab a page asked for.
   */
  readonly gnomeLoads = new GnomeLoads();
  /** Requests the engine host makes for a page (its favicon, a download it started): that page is their initiator. */
  readonly pageFetches = new GnomeLoads();

  constructor(version: string, enabled: boolean) {
    this.status = { state: enabled ? 'initializing' : 'disabled', version, detail: null };
  }

  get ready(): boolean {
    return this.status.state === 'ready' && this.controller !== null;
  }

  async init(transport: TransportManager, sw: SwClient): Promise<void> {
    if (this.status.state === 'disabled') return;
    const t0 = performance.now();
    try {
      const v = vendor();
      if (!v.$scramjetController || !v.$scramjet) throw new Error('scramjet.js or controller.api.js did not load (load order?)');
      // The controller does not validate the rewriter wasm (a 404 still "inits"): check the magic bytes.
      const res = await fetch(SCRAMJET_CONFIG.wasmPath, { cache: 'no-cache' });
      const head = new Uint8Array(await res.arrayBuffer()).subarray(0, 4);
      if (!res.ok || head.join() !== WASM_MAGIC) throw new Error('scramjet.wasm is missing or corrupt');
      const first = await withTimeout(transport.scramjetTransport(), RECOVERY.initTimeoutMs, 'the Scramjet transport did not start');
      const worker = sw.controller();
      if (!worker) throw new Error('no service worker controls the engine host');
      const { Controller } = v.$scramjetController;
      const controller = new Controller({
        serviceworker: worker,
        transport: first,
        config: { ...SCRAMJET_CONFIG },
        // The controller's own allowFailedIntercepts default is lost in its deepMerge order: set it again.
        scramjetConfig: { flags: { allowFailedIntercepts: true } },
      });
      this.wrapRequests(controller);
      await withTimeout(controller.wait(), RECOVERY.initTimeoutMs, 'controller.wait() timed out');
      this.controller = controller;
      transport.bindScramjet({ setTransport: (t) => controller.setTransport(t) });
      // Scramjet's Controller announces its prefix only to the worker it was built with (a field of controller
      // 0.0.14: re-check on upgrades). Point it at a new controller; the SW's revive then reaches the new worker.
      sw.onControllerChange((c) => {
        controller.serviceWorkerController = c;
      });
      this.status.state = 'ready';
      this.status.detail = null;
    } catch (err) {
      this.status.state = 'failed';
      this.status.detail = String(err instanceof Error ? err.message : err).slice(0, LIMITS.maxDetailLength);
    }
    this.initMs = Math.round(performance.now() - t0);
  }

  /**
   * Every request the service worker hands the controller passes withInitiator (sj-requests.ts) first: no engine-host
   * client (its "unrewriteurl: unexpected url …/engine/" console.error), no initiator for GNOME's own navigations,
   * the opener for a tab a page asked for, and the page for what the engine host fetches on its behalf.
   * A controller build without `methods.request` is left as it is (re-check on upgrades, vendor.ts).
   */
  wrapRequests(controller: ScramjetControllerLike, now: () => number = () => performance.now()): void {
    const methods = controller.methods;
    const request = methods?.request;
    if (!methods || typeof request !== 'function') return;
    const loads = this.gnomeLoads;
    const fetches = this.pageFetches;
    methods.request = (args: unknown) =>
      request(
        withInitiator(
          args as SjRequestRpc,
          (raw) => loads.initiatorOf(raw, now()),
          (raw) => fetches.initiatorOf(raw, now()) ?? undefined,
        ),
      );
  }

  createFrame(iframe: HTMLIFrameElement, plugin: ManagedPluginLike): ScramjetFrameLike {
    if (!this.controller) throw new Error('Scramjet is not ready');
    return this.controller.createFrame(iframe, { plugins: [plugin] });
  }

  /** The controller has no removal API: drop the frame from its list so its prefix no longer routes. */
  removeFrame(frame: ScramjetFrameLike): void {
    const frames = this.controller?.frames;
    if (!frames) return;
    const i = frames.indexOf(frame);
    if (i >= 0) frames.splice(i, 1);
  }

  proxiedUrl(frame: ScramjetFrameLike, url: string): string {
    const $scramjet = vendor().$scramjet;
    if (!$scramjet) throw new Error('Scramjet is not loaded');
    return $scramjet.rewriteUrl(url, frame.context, { origin: new URL(location.href), base: new URL(location.href) });
  }

  /**
   * The real URL of a Scramjet URL (`/~/sj/<controller>/<frame>/<encoded>`), or null. Scramjet's `unrewriteUrl` runs
   * only with the context of the frame whose prefix the URL has: for any other URL (another frame's, or one an earlier
   * engine host made: its controller id differs) it logs "unrewriteurl: unexpected url" with console.error and
   * returns the proxied URL unchanged, which is not a real URL. Those go through the codec below.
   */
  decode(raw: URL, frame: ScramjetFrameLike | null): string | null {
    const $scramjet = vendor().$scramjet;
    const owns = (f: ScramjetFrameLike | null | undefined): f is ScramjetFrameLike => !!f && typeof f.prefix === 'string' && f.prefix !== '' && raw.pathname.startsWith(f.prefix);
    const owner = owns(frame) ? frame : (this.controller?.frames.find(owns) ?? null);
    if ($scramjet && owner) {
      try {
        return String($scramjet.unrewriteUrl(raw.href, owner.context));
      } catch {
        /* fall through to the codec */
      }
    }
    // /~/sj/<controller id>/<frame id>/<encodeURIComponent(url)>
    const rest = raw.pathname.slice(PROXY_PATHS.scramjetPrefix.length).split('/').slice(2).join('/');
    try {
      return decodeURIComponent(rest) + raw.hash;
    } catch {
      return null;
    }
  }

  jar(): Record<string, ScramjetCookie> {
    return this.controller ? parseScramjetDump(this.controller.cookieJar.dump()) : {};
  }

  /** Replaces the jar and persists it (other engine hosts reload it through the controller's cookie sync). */
  async setJar(jar: Record<string, ScramjetCookie>): Promise<void> {
    const c = this.controller;
    if (!c) return;
    c.cookieJar.load(JSON.stringify(jar));
    await c.persistCookies();
  }
}
