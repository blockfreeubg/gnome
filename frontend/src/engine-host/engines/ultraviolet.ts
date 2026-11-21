/**
 * Ultraviolet 3.2.10 in the engine host (spike §4.7): its globals (uv.bundle.js, GNOME's uv.config.js, bare-mux) and
 * a working shared transport in bare-mux's SharedWorker (the transport manager's `ultravioletReady()`), then URL
 * encoding both ways. UV's request handling itself runs in the service worker (lane b).
 */
import { LIMITS } from '../../shared/engine-protocol';
import type { EngineStatus } from '../../shared/engine-protocol';
import { RECOVERY } from '../../shared/transport';
import type { TransportManager } from '../../shared/transport';
import { withTimeout } from './scramjet';
import { vendor } from './vendor';

export class UltravioletEngine {
  readonly status: EngineStatus;
  initMs: number | null = null;

  constructor(version: string, enabled: boolean) {
    this.status = { state: enabled ? 'initializing' : 'disabled', version, detail: null };
  }

  get ready(): boolean {
    return this.status.state === 'ready';
  }

  get prefix(): string | null {
    return vendor().__uv$config?.prefix ?? null;
  }

  async init(transport: TransportManager): Promise<void> {
    if (this.status.state === 'disabled') return;
    const t0 = performance.now();
    try {
      const v = vendor();
      if (!v.BareMux || !v.__uv$config || !v.Ultraviolet) throw new Error('bare-mux, uv.bundle.js or uv.config.js did not load');
      await withTimeout(transport.ultravioletReady(), RECOVERY.initTimeoutMs, 'the Ultraviolet transport did not start');
      this.status.state = 'ready';
      this.status.detail = null;
    } catch (err) {
      this.status.state = 'failed';
      this.status.detail = String(err instanceof Error ? err.message : err).slice(0, LIMITS.maxDetailLength);
    }
    this.initMs = Math.round(performance.now() - t0);
  }

  proxiedUrl(url: string): string {
    const c = vendor().__uv$config;
    if (!c) throw new Error('Ultraviolet is not loaded');
    return location.origin + c.prefix + c.encodeUrl(url);
  }

  /** The real URL of a UV URL (`/uv/service/<xor-encoded>`, fragment kept as is), or null. */
  decode(raw: URL): string | null {
    const c = vendor().__uv$config;
    if (!c) return null;
    const base = location.origin + c.prefix;
    if (!raw.href.startsWith(base)) return null;
    const tail = raw.href.slice(base.length);
    const hashAt = tail.indexOf('#');
    const enc = hashAt >= 0 ? tail.slice(0, hashAt) : tail;
    try {
      return c.decodeUrl(enc) + (hashAt >= 0 ? tail.slice(hashAt) : '');
    } catch {
      return null;
    }
  }
}
