/**
 * The DOM side of the engine client: the engine iframe exactly as ARCHITECTURE §4.6 / ENGINE-PROTOCOL §2.1 specify
 * (no allow-popups*, no allow-top-navigation*), inserted into the browser view's content area.
 *
 * `create()` always builds a new element and sets `src` once, before insertion; the client never navigates an
 * existing engine iframe (§2.3: that could add a joint session-history entry and make the Back button reload it).
 */
import type { ConnectMessage } from '../../shared/engine-protocol';
import type { EngineEmbedder, EngineFrame, WindowMessage } from './client';

export const ENGINE_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock allow-presentation';
export const ENGINE_ALLOW = 'fullscreen; clipboard-write; autoplay';

export interface DomEmbedder extends EngineEmbedder {
  /** The element the iframe lives in (the browser view's content area); set once it is mounted. */
  setContainer(el: HTMLElement | null): void;
  /** The current engine iframe element (for its bounding rect: context-menu coordinates). */
  readonly element: HTMLIFrameElement | null;
}

export function createDomEmbedder(): DomEmbedder {
  let container: HTMLElement | null = null;
  let element: HTMLIFrameElement | null = null;
  return {
    get element() {
      return element;
    },
    setContainer(el) {
      container = el;
      if (el && element && element.parentElement !== el) el.append(element);
    },
    create(src, onLoad): EngineFrame {
      const iframe = document.createElement('iframe');
      iframe.className = 'engine-frame';
      iframe.title = 'Browser content';
      iframe.setAttribute('sandbox', ENGINE_SANDBOX);
      iframe.setAttribute('allow', ENGINE_ALLOW);
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      iframe.addEventListener('load', onLoad);
      iframe.src = src;
      element = iframe;
      (container ?? document.body).append(iframe);
      return {
        get window() {
          return iframe.contentWindow;
        },
        remove() {
          iframe.removeEventListener('load', onLoad);
          iframe.remove();
          if (element === iframe) element = null;
        },
      };
    },
    onMessage(listener) {
      const fn = (ev: MessageEvent): void => listener({ source: ev.source, origin: ev.origin, data: ev.data } satisfies WindowMessage);
      window.addEventListener('message', fn);
      return () => window.removeEventListener('message', fn);
    },
    postConnect(frame, msg: ConnectMessage, targetOrigin, port) {
      const win = frame.window as Window | null;
      win?.postMessage(msg, targetOrigin, [port]);
    },
  };
}
