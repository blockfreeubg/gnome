/**
 * What the transport manager needs from the engine-host page, behind small interfaces so the manager can be
 * unit-tested with fakes (manager.test.ts) and runs unchanged on the real page (index.ts wires the real ones).
 */

import type { TransportKind } from '../../shared/engine-protocol';
import type { ScramjetTransport, UvInstallReason } from '../../shared/transport';

/** A WebSocket the engine-host realm opened (the Scramjet-side transports' Wisp connections and anything else). */
export interface WindowSocketEvent {
  url: string;
  ev: 'connecting' | 'open' | 'close';
  wasOpen: boolean;
  code: number | null;
}

/** A Wisp WebSocket of the shared Ultraviolet transport (reported by the tap inside bare-mux's SharedWorker). */
export interface UvSocketEvent {
  ev: 'connecting' | 'open' | 'close';
  gen: number;
  key: string | null;
  wasOpen: boolean;
  code: number | null;
}

export interface RawResponse {
  status: number;
  headers: Array<[string, string]>;
  body: unknown;
}

/** Scramjet's side: proxy-transports 1.0.2 transports (libcurl-transport 2.0.6, epoxy-transport 3.0.2) in this realm. */
export interface ScramjetBackend {
  /** Imports the transport module, constructs it with `{wisp: url}` and resolves after `init()`. */
  build(kind: TransportKind, url: string): Promise<ScramjetTransport>;
  /** Every WebSocket created in the engine-host realm (installed before any transport module loads). */
  onSocket(listener: (e: WindowSocketEvent) => void): () => void;
  /** A plain request through a built transport (proxyFetch). */
  request(transport: ScramjetTransport, url: URL, headers: Array<[string, string]>, signal: AbortSignal): Promise<RawResponse>;
  /** Wraps the transport's `connect()` so every WebSocket of a Scramjet page asks `check` first (useHooks). */
  wrapConnect(transport: ScramjetTransport, check: (url: string) => 'allow' | 'block'): void;
}

export interface UvInstallResult {
  action: 'install' | 'keep';
  /** Generation of the transport that runs now. */
  gen: number;
  /** Its uvTransportKey() (another route's key when a rebuild kept a newer installation). */
  key: string;
}

/** Ultraviolet's side: the one transport in bare-mux's SharedWorker (uv-worker-code.ts). */
export interface UvBackend {
  /**
   * Installs or keeps the shared transport (uvTransportAction, decided inside the worker) and resolves once the
   * transport that runs is initialized; rejects when bare-mux refuses it or its init failed.
   */
  install(mode: UvInstallReason, key: string, kind: TransportKind, url: string, expectedGen: number | null): Promise<UvInstallResult>;
  onSocket(listener: (e: UvSocketEvent) => void): () => void;
  /** A plain request through bare-mux (proxyFetch when Scramjet has no transport). */
  request(url: URL, headers: Array<[string, string]>, signal: AbortSignal): Promise<RawResponse>;
}

export interface ProbeResponse {
  status: number;
  retryAfter: string | null;
  /** `error.code` of a JSON error body, else null. */
  errorCode: string | null;
}

export interface ManagerDeps {
  /** null: this page has no Scramjet-side support (the side fails). Created once, at construction. */
  scramjet: ScramjetBackend | null;
  /** Created lazily by start() (bare-mux must have loaded); a throw fails the Ultraviolet side. */
  uv: () => UvBackend;
  /** Plain GET of a probe URL (no Upgrade); null = the request failed at the network level. */
  probe(url: string): Promise<ProbeResponse | null>;
  now(): number;
  random(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Diagnostics log line (never with a ticket: the manager redacts URLs first). */
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  /**
   * Whether a WebSocket to a custom Wisp server opens (then closed at once), with a socket the watchdog's taps do not
   * see; false, with the socket closed, when nothing happened within `timeoutMs`. Absent: every custom server counts
   * as reachable until a transport's own socket fails.
   */
  testSocket?(url: string, timeoutMs: number): Promise<boolean>;
}

/** Reads a transport response body (ReadableStream, ArrayBuffer, typed array, Blob or string) with a size cap. */
export async function readBody(body: unknown, maxBytes: number): Promise<ArrayBuffer> {
  if (body === null || body === undefined) return new ArrayBuffer(0);
  if (typeof body === 'string') return capped(new TextEncoder().encode(body), maxBytes);
  if (body instanceof ArrayBuffer) return capped(new Uint8Array(body), maxBytes);
  if (ArrayBuffer.isView(body)) return capped(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), maxBytes);
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    if (body.size > maxBytes) throw new Error('response too large');
    return body.arrayBuffer();
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike);
      size += chunk.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('response too large');
      }
      chunks.push(chunk);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out.buffer;
  }
  throw new Error('unsupported response body');
}

function capped(bytes: Uint8Array, maxBytes: number): ArrayBuffer {
  if (bytes.byteLength > maxBytes) throw new Error('response too large');
  return bytes.slice().buffer;
}


