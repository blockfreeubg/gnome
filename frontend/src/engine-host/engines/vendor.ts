/**
 * The parts of the unmodified engine builds the engine-host core uses, typed structurally: the classic scripts of
 * `engine/index.html` (ENGINE_HOST_SCRIPTS: scramjet.js, controller.api.js, bare-mux, uv.bundle.js, uv.config.js)
 * define them as globals of this realm. Only what the core touches is listed; re-check these shapes on every engine
 * upgrade (scramjet 2.0.67-alpha.2, scramjet-controller 0.0.14, ultraviolet 3.2.10).
 */

export interface TapLike {
  // Tap instances are opaque; ManagedPlugin.tap() takes them.
  readonly __tap?: never;
}

export interface ScramjetFetchParsedLike {
  url: URL;
  destination: string;
  isIframe?: boolean;
}

export interface ScramjetFetchRequestLike {
  method: string;
  mode: string;
  rawDestination: string;
  rawUrl: URL;
  rawReferrer: string | null;
  rawClientUrl?: URL;
  clientId: string;
}

export interface ScramjetHeadersLike {
  get(name: string): string | null;
  set(name: string, value: string): void;
  delete?(name: string): void;
}

export interface ScramjetRequestCtx {
  request: ScramjetFetchRequestLike;
  parsed: ScramjetFetchParsedLike;
}

export interface ScramjetRequestProps {
  init: { method?: string; headers?: Array<[string, string]> | Record<string, string>; body?: unknown };
  url: URL;
  earlyResponse?: unknown;
}

export interface ScramjetResponseProps {
  response: { body: unknown; headers: ScramjetHeadersLike; status: number; statusText: string };
}

export interface ScramjetPreresponseProps {
  response: { status: number; rawHeaders: Array<[string, string]>; body: unknown };
}

export interface ScramjetErrorCtx {
  rawrequest: { rawUrl?: string; destination?: string; method?: string } | undefined;
  error: unknown;
}

export interface ScramjetErrorProps {
  setResponse?: { body: string; status: number; statusText: string; headers: Array<[string, string]> };
  suppressError: boolean;
}

export interface ScramjetClientLike {
  url?: URL;
  hooks?: { lifecycle?: { navigate?: TapLike } };
}

export interface FrameInitCtx {
  window: Window;
  client: ScramjetClientLike;
  isTopLevel: boolean;
}

export interface ScramjetFrameLike {
  prefix: string;
  context: unknown;
  element: HTMLIFrameElement;
  hooks: {
    fetch: { request: TapLike; preresponse: TapLike; response: TapLike; intercept: TapLike };
    init: { pre: TapLike; post: TapLike };
    error: { request: TapLike };
  };
}

export interface CookieJarLike {
  dump(): string;
  load(dump: string): void;
  clear?(): void;
}

export interface ScramjetControllerLike {
  id: string;
  prefix: string;
  frames: ScramjetFrameLike[];
  cookieJar: CookieJarLike;
  serviceWorkerController: ServiceWorker;
  wait(): Promise<void>;
  setTransport(transport: object): void;
  createFrame(element: HTMLIFrameElement, options: { plugins: ManagedPluginLike[] }): ScramjetFrameLike;
  persistCookies(): Promise<void>;
  propagateCookieSync?(cookies: Array<{ url: string; cookie: string }>, options?: { clear?: boolean }): Promise<void>;
  /**
   * The handlers of its RPC with the service worker (controller 0.0.14: an own field, looked up by name on every
   * call; `request` is an arrow function bound to the controller). GNOME wraps `request` (scramjet.ts).
   */
  methods?: Record<string, ((args: unknown) => Promise<unknown>) | undefined>;
}

export interface ManagedPluginLike {
  name: string;
  install(frame: ScramjetFrameLike): void;
}

export interface ManagedPluginCtor {
  new (name: string, dependencies: string[]): ManagedPluginLike & {
    tap<C, P>(tap: TapLike, fn: (ctx: C, props: P) => void | Promise<void>): void;
  };
}

export interface ScramjetControllerGlobal {
  Controller: new (init: {
    serviceworker: ServiceWorker;
    transport: object;
    config?: Record<string, unknown>;
    scramjetConfig?: Record<string, unknown>;
  }) => ScramjetControllerLike;
  ManagedPlugin: ManagedPluginCtor;
}

export interface ScramjetGlobal {
  rewriteUrl(url: string | URL, context: unknown, meta: { origin: URL; base: URL }): string;
  unrewriteUrl(url: string | URL, context: unknown): string;
}

export interface UvConfigLike {
  prefix: string;
  encodeUrl(url: string): string;
  decodeUrl(url: string): string;
}

export interface UltravioletGlobal {
  BareClient?: { prototype: { createWebSocket?: (...args: unknown[]) => unknown } };
}

interface VendorWindow {
  $scramjetController?: ScramjetControllerGlobal;
  $scramjet?: ScramjetGlobal;
  BareMux?: unknown;
  __uv$config?: UvConfigLike;
  Ultraviolet?: UltravioletGlobal;
}

export function vendor(win: Window = window): VendorWindow {
  return win as unknown as VendorWindow;
}

/** The key under which Scramjet keeps its client on every window it hooked (`SCRAMJETCLIENT`). */
export const SCRAMJET_CLIENT = Symbol.for('scramjet client global');
