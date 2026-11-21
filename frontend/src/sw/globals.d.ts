/**
 * Globals of the service worker realm (tsconfig.sw.json, WebWorker lib): the build constants (vite.sw.config.ts
 * `define`, the same values as the app/engine-host build) and what the imported vendor scripts define.
 */

declare const __GNOME_BUILD__: string;
declare const __GNOME_ENGINE_TEST__: boolean;
/** WAVE-B3 D19 (vite.config.ts `engineTestCapabilities`): [] outside e2e builds. */
declare const __GNOME_ENGINE_TEST_CAPABILITIES__: readonly string[];

/** scramjet-controller 0.0.14 `controller.sw.js`. */
declare const $scramjetController: {
  shouldRoute(event: FetchEvent): boolean;
  route(event: FetchEvent): Promise<Response>;
};

/** Ultraviolet 3.2.10 `uv.sw.js` (an EventEmitter with `request`, `beforemod` and `response` events). */
interface UvEvent<T> {
  readonly data: T;
  readonly intercepted: boolean;
  respondWith(response: Response | Promise<Response>): void;
}

interface UvRequestContext {
  /** Lower-case header map sent upstream (mutable). */
  headers: Record<string, string>;
  method: string;
  /** The real destination URL. */
  readonly url: URL;
  /** The intercepted Request (as the SW handed it to UV: pure.ts forEngines). */
  readonly request: Request;
  /** The Ultraviolet instance handling this request (created per request; `config.construct` saw it first). */
  readonly ultraviolet: { createHtmlInject?: unknown; js?: { rewrite(code: string): string } };
}

interface UvResponseContext {
  /** Lower-case header map of the upstream response (mutable; values may be arrays). */
  headers: Record<string, string | string[]>;
  status: number;
  statusText: string;
  body: unknown;
  readonly request: UvRequestContext;
  /** The real URL. */
  readonly url: URL;
  getHeader(name: string): string | undefined;
}

declare class UVServiceWorker {
  constructor();
  /** The `__uv$config` object; UV calls `construct(instance, 'service')` on every Ultraviolet instance it creates. */
  readonly config: { prefix: string; construct?: (instance: { createHtmlInject?: unknown }, context: string) => void };
  bareClient: { fetch(target: unknown, init?: { body?: unknown; [k: string]: unknown }): Promise<Response> };
  on(event: 'request', fn: (e: UvEvent<UvRequestContext>) => void): void;
  on(event: 'beforemod' | 'response', fn: (e: UvEvent<UvResponseContext>) => void): void;
  route(event: FetchEvent): boolean;
  fetch(event: FetchEvent): Promise<Response>;
}

interface UvConfig {
  prefix: string;
  encodeUrl(url: string): string;
  decodeUrl(url: string): string;
}

/**
 * src/shared/site-rules.ts `browserFamily()` probes these with `typeof` (the SW has neither; it reaches that file
 * through the content blocker's policy, which needs `inHostList`/`ruleFor`). Declared so the WebWorker scope compiles;
 * at run time both are undefined.
 */
declare const document: object | undefined;
declare const window: object | undefined;
