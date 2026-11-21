/**
 * The document-start hook with Ultraviolet's REAL HTML rewriter: the pinned uv.bundle.js (3.2.10, the file
 * copy-vendor serves) and GNOME's uv.config.js run in a node vm with the few globals they touch at load, an instance
 * gets GNOME's wrapper (injectDocumentHook, as the SW's `__uv$config.construct` does), and the serialized documents are
 * checked. The inputs include the ones that defeated a text search for `<head>` (measured in both browsers: the WebRTC
 * kill switch was then missing in such pages): the hook must sit right before UV's own first script, i.e. at the start
 * of the parsed `<head>`.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { documentHookInstalled, injectDocumentHook } from './pure';

const UV_DIST = new URL('../../node_modules/@titaniumnetwork-dev/ultraviolet/dist/', import.meta.url);
const UV_CONFIG = new URL('../../public/engine/uv.config.js', import.meta.url);
const HOOK_TAG = '<script src="/engine/uv-doc-hook.js" __uv-script="1"></script>';
/** UV's first injected node (its cookie script) as its rewriter serializes it. */
const UV_FIRST = '<script __uv-script="1">self.__uv$cookies';

interface UvInstance {
  meta: { origin: string; base: URL; url: URL };
  handlerScript: string;
  bundleScript: string;
  clientScript: string;
  configScript: string;
  createHtmlInject?: unknown;
  rewriteHtml(html: string, opts: { document: boolean; injectHead: unknown }): string;
}

/** Loads uv.bundle.js and uv.config.js into a fresh vm context; returns UV's class and GNOME's config object. */
function loadUltraviolet(): { Ultraviolet: new (config: unknown) => UvInstance; config: unknown } {
  const noop = (): void => {};
  const ctx: Record<string, unknown> = {
    console: { ...console, log: noop, info: noop },
    URL,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    atob,
    btoa,
    location: new URL('http://127.0.0.1:27501/'),
    navigator: { userAgent: 'vitest', serviceWorker: { addEventListener: noop } },
    MessagePort,
    MessageChannel,
    BroadcastChannel,
    EventTarget,
    Event,
    Request,
    Response,
    Headers,
    fetch,
    localStorage: {},
    SharedWorker: undefined,
    WebSocket: class {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
    },
  };
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('uv.bundle.js', UV_DIST), 'utf8'), ctx);
  vm.runInContext(readFileSync(UV_CONFIG, 'utf8'), ctx);
  return { Ultraviolet: ctx.Ultraviolet as new (config: unknown) => UvInstance, config: ctx.__uv$config };
}

const { Ultraviolet, config } = loadUltraviolet();

/** Rewrites `html` as UV's service worker does for a document (createHtmlInject → rewriteHtml). */
function rewrite(html: string, hooked = true): string {
  const t = new Ultraviolet(config);
  if (hooked) expect(injectDocumentHook(t)).toBe(true);
  t.meta.origin = 'http://127.0.0.1:27501';
  t.meta.base = t.meta.url = new URL('https://site.example/page.html');
  const inject = (t.createHtmlInject as (...a: unknown[]) => unknown)(t.handlerScript, t.bundleScript, t.clientScript, t.configScript, 'c=1', '');
  return t.rewriteHtml(html, { document: true, injectHead: inject });
}

const TRICKY: Record<string, string> = {
  plain: '<!doctype html><html><head><title>t</title></head><body><script>1</script></body></html>',
  'a comment that contains <head> before the real one': '<!doctype html><!--<head>--><html><head><title>t</title></head><body><script>1</script></body></html>',
  '<html> with an attribute value "<head>"': '<!doctype html><html data-x="<head>"><head><title>t</title></head><body></body></html>',
  '<head> with an attribute value ">"': '<html><head data-x=">"><title>t</title></head><body></body></html>',
  'no <head> at all': '<p>no head</p><script>x()</script>',
  'a frameset': '<!doctype html><html><head><title>f</title></head><frameset cols="50%,50%"><frame src="/a"><frame src="/b"></frameset></html>',
  'upper-case tags and a BOM': '﻿<!DOCTYPE HTML><HTML><HEAD><TITLE>t</TITLE></HEAD><BODY><SCRIPT>1</SCRIPT></BODY></HTML>',
};

describe('the document-start hook through UV 3.2.10’s own injection', () => {
  for (const [name, html] of Object.entries(TRICKY)) {
    it(`${name}: the hook is first in the parsed <head>, right before UV's scripts, exactly once`, () => {
      const out = rewrite(html);
      expect(out.split(HOOK_TAG).length - 1).toBe(1);
      expect(out).toContain(`${HOOK_TAG}${UV_FIRST}`);
      // only the head start tag precedes it inside <head>: comments and attribute values cannot hide it
      const before = out.slice(0, out.indexOf(HOOK_TAG)).replace(/<!--[\s\S]*?-->/g, '');
      expect(before).toMatch(/<head(?:\s[^>]*(?:"[^"]*"[^>]*)*)?>$/i);
    });
  }

  it('srcdoc documents inside a page get the hook too (UV passes the same injected nodes down)', () => {
    const out = rewrite('<!doctype html><html><head></head><body><iframe srcdoc="<p>child</p><script>c()</script>"></iframe></body></html>');
    const m = /<iframe [^>]*srcdoc="([^"]*)"/.exec(out);
    expect(m).not.toBeNull();
    const child = (m?.[1] ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    expect(child).toContain(`${HOOK_TAG}${UV_FIRST}`);
  });

  it('without the wrapper UV injects no hook (the control), and the instance says so', () => {
    expect(documentHookInstalled(new Ultraviolet(config))).toBe(false);
    expect(rewrite(TRICKY.plain ?? '', false)).not.toContain('/engine/uv-doc-hook.js');
  });
});
