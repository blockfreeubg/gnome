// Lane a (engine-host core) helpers for the host-*.mjs suites (docs/WAVE-B.md §2 Tests). Not a suite itself.
//
// The suites follow the suite contract of tests/e2e/engine/run.mjs (WAVE-B §3: `export async function run(ctx)`) and
// drive the REAL built engine host through the runner's e2e driver page (ctx.openApp → App of the spike's
// lib/drive.mjs). Pages come from the fixture site below: a local HTTP server on loopback that the browsers reach
// ONLY through Wisp, via the VPN profile whose HolyWisp has the test-only allow-loopback overlay (route
// `profile:<ctx.stack.profiles.live>`). Two "sites" are served (127.0.0.1:<port> and localhost:<port>, cross-site to
// each other once proxied). A UDP sink on loopback counts STUN packets (WebRTC leaks) and an HTTP "leak" listener
// counts requests that reach it directly (natively), without Wisp.
//
// Ports: HOST_E2E_PORT_BASE (default E2E_PORT_BASE + 200, lib/ports.mjs): +0 fixture site, +1 leak listener,
// +2 STUN sink.
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { suitePortBase } from '../lib/ports.mjs';

export function hostPortBase() {
  return suitePortBase('host');
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGNkYPjPQApgIkn1qIZRDcMHAEn/AR/Ll1RuAAAAAElFTkSuQmCC', 'base64');

function page(title, body, head = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="icon" href="/favicon.png">${head}</head><body><pre id="out">pending</pre>${body}</body></html>`;
}

const OUT = (expr) => `<script>(async()=>{let r;try{r=await (${expr});}catch(e){r={threw:String(e&&e.name)+': '+String(e&&e.message)}}document.getElementById('out').textContent=JSON.stringify(r);})();</script>`;

/** The WebRTC probe run by a page's own (engine-rewritten) script: STUN to the sink from every realm it can make. */
function webrtcProbe(stun) {
  return `(async () => {
  const stun = ${JSON.stringify(stun)};
  const tryRealm = async (w) => {
    if (!w) return 'no window';
    if (typeof w.RTCPeerConnection !== 'function') return 'absent';
    const pc = new w.RTCPeerConnection({ iceServers: [{ urls: stun }] });
    pc.createDataChannel('x');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => setTimeout(r, 1500));
    const n = (pc.localDescription && pc.localDescription.sdp || '').split('\\n').filter((l) => l.startsWith('a=candidate')).length;
    pc.close();
    return 'available; ' + n + ' candidates';
  };
  const out = {};
  const t = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = 'threw ' + (e && e.name); } };
  await t('page', () => tryRealm(window));
  await t('blankChild', () => { const f = document.createElement('iframe'); document.body.appendChild(f); return tryRealm(f.contentWindow); });
  await t('blankChildIndexed', () => { const f = document.createElement('iframe'); document.body.appendChild(f); return tryRealm(window[window.length - 1]); });
  await t('srcdocChild', () => new Promise((resolve) => { const f = document.createElement('iframe'); f.srcdoc = '<p>srcdoc</p>'; f.onload = () => tryRealm(f.contentWindow).then(resolve, (e) => resolve('threw ' + e.name)); document.body.appendChild(f); }));
  await t('innerHtmlChild', () => { const d = document.createElement('div'); d.innerHTML = '<iframe></iframe>'; document.body.appendChild(d); return tryRealm(window[window.length - 1]); });
  return out;
})()`;
}

/**
 * The fixture site. `origin` is how the browsers name it (through the proxy). Returns {origin, altOrigin, close(),
 * hits(path), leak: {origin, count(), reset()}, stun: {url, packets(), reset()}}.
 */
export async function startFixtures({ host = '127.0.0.1', base = hostPortBase() } = {}) {
  const port = base;
  const leakPort = base + 1;
  const stunPort = base + 2;
  const origin = `http://${host}:${port}`;
  const altOrigin = `http://localhost:${port}`;
  const leakOrigin = `http://${host}:${leakPort}`;
  const stunUrl = `stun:${host}:${stunPort}`;
  const hits = new Map();
  const count = (p) => hits.set(p, (hits.get(p) ?? 0) + 1);
  /** What each /xs/echo request brought: {at, via, cookie, site, referer, origin}. */
  const xsLog = [];

  const html = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(body);
  };
  const leakCss = (id) => `body{background-image:url(${leakOrigin}/leak/${id}.png)}`;

  const routes = {
    '/': () => [200, page('Fixture home', '<h1>GNOME fixture</h1><a id="next" href="/second">second</a>', '')],
    '/second': () => [200, page('Second page', '<h1>second</h1><a id="back" href="/">home</a>')],
    '/third': () => [200, page('Third page', '<h1>third</h1>')],
    // A pushState SPA (ENGINE-PROTOCOL §6.1 same-document commits).
    '/spa': () => [
      200,
      page(
        'SPA',
        `<h1 id="h">spa</h1><a id="frag" href="#section">fragment</a>
<script>
  window.spa = {
    push: (p) => { history.pushState({ p }, '', p); document.title = 'SPA ' + p; },
    replace: (p) => { history.replaceState({ p }, '', p); },
    back: () => history.back(),
  };
  addEventListener('popstate', () => { document.getElementById('h').textContent = 'pop ' + location.pathname; });
</script>`,
      ),
    ],
    '/spa/a': () => [200, page('SPA a (loaded fresh)', '<h1>spa a fresh</h1>')],
    '/spa/b': () => [200, page('SPA b (loaded fresh)', '<h1>spa b fresh</h1>')],
    // In-page navigations: a link, a GET form, a POST form, a failing link, a 204 link, a self reload.
    '/links': () => [
      200,
      page(
        'Links',
        `<a id="l-second" href="/second">second</a>
<a id="l-204" href="/204">no content</a>
<a id="l-dead" href="http://dead.invalid/">dead</a>
<form id="f-get" action="/echo" method="get"><input name="q" value="gnome"><button id="b-get">go</button></form>
<form id="f-post" action="/echo" method="post"><input name="q" value="posted"><button id="b-post">post</button></form>
<button id="reload" onclick="location.reload()">reload</button>
<button id="replace" onclick="location.replace('/third')">replace</button>`,
      ),
    ],
    '/204': () => [204, ''],
    '/echo': (req, body) => [200, page('Echo', `<pre id="echo">${esc(req.method)} ${esc(req.url)} ${esc(body)}</pre>`)],
    // History calls without a URL (none, undefined, null): a browser keeps the document's URL (worklist A12: Scramjet
    // 2.0.67-alpha.2 moved such a page to /undefined or /null).
    '/history-nourl': () => [
      200,
      page(
        'History without a URL',
        `<script>
history.replaceState({ a: 1 }, '');
history.pushState({ b: 2 }, '', undefined);
history.replaceState(null, '', null);
document.getElementById('out').textContent = JSON.stringify({ href: location.href, length: history.length, state: history.state });
</script>`,
      ),
    ],
    // A link to the other fixture site's /headers (a page-initiated, cross-site navigation).
    '/headers-link': () => [200, page('Headers link', `<a id="go" href="${altOrigin}/headers?from=link">to the other site</a>`)],
    // Requests a page chooses and GNOME makes (security review, integration part 2). This site is the "victim": it
    // sets a SameSite=Strict and a SameSite=Lax cookie, and /xs/echo records per `via` what each request brought
    // (fixtures.xs.log()). The "attacker" page, on the other site, names victim URLs as its favicon, as an
    // `<a download>` it clicks by script at load, and as a target=_blank link. A browser sends neither cookie with the
    // first two (cross-site subresource-like requests) and only the Lax one with the link (a cross-site navigation).
    '/xs/set': () => [200, page('Victim', '<p>cookies set</p>'), { 'set-cookie': ['xs_strict=1; Path=/; SameSite=Strict', 'xs_lax=1; Path=/; SameSite=Lax'] }],
    // The request headers this site received (what an engine sent upstream), as JSON in #out.
    '/headers': (req) => [200, page('Headers', `<script>document.getElementById('out').textContent=${JSON.stringify(JSON.stringify(req.headers)).replace(/</g, '\\u003c')};</script>`)],
    // Downloads (ENGINE-PROTOCOL §6.9).
    '/downloads': () => [
      200,
      page(
        'Downloads',
        `<a id="d-attach" href="/file/attach.bin">attachment</a>
<a id="d-zip" href="/file/archive.zip">zip without disposition</a>
<a id="d-adl" href="/file/plain.bin" download="saved.bin">a download</a>`,
      ),
    ],
    '/downloads-noref': () => [
      200,
      page('No referrer', '<a id="d-attach" href="/file/attach.bin" rel="noreferrer">attachment</a>', '<meta name="referrer" content="no-referrer">'),
      { 'referrer-policy': 'no-referrer' },
    ],
    // Popups (ENGINE-PROTOCOL §6.3).
    '/popups': () => [
      200,
      page(
        'Popups',
        `<button id="open" onclick="window.__r = window.open('/second')">open</button>
<button id="open-popup" onclick="window.__r = window.open('/second', 'w', 'popup,width=400,height=300')">popup</button>
<button id="open-blank" onclick="window.__r = window.open('about:blank')">blank</button>
<a id="blank" href="/third" target="_blank">blank target</a>
<a id="named" href="/third" target="somewhere">named target</a>
<a id="plain" href="/third">plain</a>
<form id="g" action="/echo" method="get" target="_blank"><input name="q" value="g1"><button id="g-submit">get</button></form>
<form id="p" action="/echo" method="post" target="_blank"><input name="q" value="p1"><button id="p-submit">post</button></form>
<button id="close" onclick="window.close()">close</button>
<script>setTimeout(() => { window.__timer = window.open('/timer'); }, 7000);</script>`,
      ),
    ],
    // Link and form targets the engine iframe's sandbox would refuse (a frame may navigate only itself and its
    // descendants): `_top`/`_parent` from the tab's top document and from a nested one, POST forms, form.submit(),
    // <base target>, a sibling frame of a frameset.
    '/targets': () => [
      200,
      page(
        'Targets',
        `<p><a id="top" href="/second?via=top" target="_top">top</a> <a id="parent" href="/second?via=parent" target="_parent">parent</a></p>
<form id="ftop" action="/echo" method="get" target="_top"><input name="q" value="ftop"><button id="ftop-b">ftop</button></form>
<form id="fparent" action="/echo" method="get" target="_parent"><input name="q" value="fparent"><button id="fparent-b">fparent</button></form>
<form id="fptop" action="/echo" method="post" target="_top"><input name="q" value="fptop"><button id="fptop-b">fptop</button></form>
<iframe id="nest" name="nest" src="/targets-nested" style="width:600px;height:160px"></iframe>`,
      ),
    ],
    '/targets-nested': () => [
      200,
      page(
        'Nested targets',
        `<p><a id="ntop" href="/second?via=ntop" target="_top">ntop</a> <a id="nparent" href="/second?via=nparent" target="_parent">nparent</a></p>
<form id="nftop" action="/echo" method="post" target="_top"><input name="q" value="nftop"><button id="nftop-b">nftop</button></form>
<form id="nsub" action="/echo" method="post" target="_top"><input name="q" value="nsubmit"></form><button id="nsub-b" onclick="document.getElementById('nsub').submit()">submit()</button>`,
      ),
    ],
    '/base-blank': () => [200, page('Base blank', '<p><a id="b" href="/second?via=base">base</a></p><form id="bf" action="/echo" method="get"><input name="q" value="basef"><button id="bf-b">bf</button></form>', '<base target="_blank">')],
    '/frames-targets': () => [
      200,
      `<!doctype html><html><head><meta charset="utf-8"><title>frames targets</title></head><frameset cols="50%,50%"><frame name="nav" src="/frames-nav"><frame name="main" src="/second"></frameset></html>`,
    ],
    '/frames-nav': () => [200, page('Frames nav', '<a id="sib" href="/echo?via=sibling" target="main">to main</a>')],
    // Nested frames that navigate themselves: none of it is a navigation of the tab (ENGINE-PROTOCOL §6.1).
    '/iframe-selfnav': () => [200, page('Iframe selfnav', '<iframe id="r" src="/selfnav" style="width:400px;height:80px"></iframe>')],
    '/selfnav': () => [200, page('selfnav', '<script>setTimeout(() => { location.href = "/second?via=selfnav"; }, 400);</script>')],
    '/iframe-redirect': () => [200, page('Iframe redirect', '<iframe id="r" src="/redirect?to=%2Fsecond%3Fvia%3Dredirect" style="width:400px;height:80px"></iframe>')],
    '/redirect': (req) => [302, '', { location: new URL(req.url, origin).searchParams.get('to') || '/second' }],
    '/iframe-link': () => [200, page('Iframe link', '<iframe id="r" name="inner" src="/inner-link" style="width:400px;height:80px"></iframe>')],
    '/inner-link': () => [200, page('Inner link', '<a id="go" href="/second?via=innerlink" style="display:block;padding:10px">go</a>')],
    // The Wave B step-3 hook points (host-hooks.mjs): a WebSocket and an image each with and without the marker the
    // e2e build's test.hooks blocks.
    '/hooks': () => [
      200,
      page(
        'Hooks',
        `<img id="ok" src="/favicon.png?hooks=ok" width="16" height="16"><img id="blocked" src="/favicon.png?gnome-block-req=1" width="16" height="16">
<script>
  window.wsTry = (u) => new Promise((resolve) => {
    let w;
    try { w = new WebSocket(u); } catch (e) { resolve('threw ' + e.name); return; }
    const t = setTimeout(() => resolve('timeout'), 8000);
    w.onopen = () => w.send('hi');
    w.onmessage = (e) => { clearTimeout(t); resolve('echo ' + e.data); w.close(); };
    w.onerror = () => { clearTimeout(t); resolve('error'); };
  });
  window.imgState = (id) => { const i = document.getElementById(id); return i.complete ? (i.naturalWidth > 0 ? 'loaded' : 'broken') : 'loading'; };
</script>`,
      ),
    ],
    // Realm hygiene (WAVE-B3 §3.3 rule R1, §11.2 finding F1): the page's OWN script (rewritten by its engine, i.e. an
    // ordinary page) looks for any function of the engine-host realm GNOME left within its reach. Such a function's
    // `constructor` is the engine host's Function, and `F('return this')()` the engine host's global (it has
    // `__gnomeEngineHost`): that would turn the ordinary page into escaped code. It walks every own property (values,
    // getters, setters) of the window, document, navigator, history and the prototypes GNOME wraps; it calls the
    // wrapped methods once with Function.prototype.apply/call replaced (a wrapper that forwarded its engine-host
    // arguments array through them would hand it over); and it checks the errors the wrapped functions throw.
    '/realm-walk': () => [
      200,
      page(
        'Realm walk',
        `<form id="f" action="/echo" method="get"><input name="q" value="x"></form>
<script>
(() => {
  const FP = Object.getPrototypeOf(function () {});
  const R = Reflect.apply;
  const out = { checked: 0, host: [], applyArrays: { page: 0, host: 0 }, callThis: { host: 0 }, errors: {} };
  const globalOf = (F) => {
    for (let i = 0; i < 4 && typeof F === 'function' && F.constructor !== F; i++) F = F.constructor;
    try { return typeof F === 'function' ? F('return this')() : null; } catch (e) { return null; }
  };
  const isHost = (v) => {
    if ((typeof v !== 'object' && typeof v !== 'function') || v === null) return false;
    // Fast path: a function (or an object's constructor) whose prototype chain reaches this realm's Function.prototype.
    try {
      let F = typeof v === 'function' ? v : v.constructor;
      for (let i = 0; i < 10 && typeof F === 'function'; i++) {
        const p = Object.getPrototypeOf(F);
        if (p === FP) return false;
        F = p;
      }
    } catch (e) { return false; }
    let g = null;
    try { g = globalOf(typeof v === 'function' ? v : v.constructor); } catch (e) { return false; }
    try { return !!(g && g !== window && g.__gnomeEngineHost); } catch (e) { return false; }
  };
  const check = (label, v) => { if (typeof v !== 'function') return; out.checked++; if (isHost(v)) out.host.push(label); };
  const walk = (label, obj) => {
    if (!obj) return;
    let keys = [];
    try { keys = Reflect.ownKeys(obj); } catch (e) { return; }
    for (const k of keys) {
      let d;
      try { d = Object.getOwnPropertyDescriptor(obj, k); } catch (e) { continue; }
      if (!d) continue;
      const name = label + '.' + String(k);
      check(name, d.value); check(name + ':get', d.get); check(name + ':set', d.set);
    }
  };
  const protos = ['Window', 'Document', 'HTMLDocument', 'Node', 'Element', 'HTMLElement', 'HTMLIFrameElement', 'HTMLFrameElement',
    'HTMLObjectElement', 'HTMLEmbedElement', 'HTMLFormElement', 'HTMLAnchorElement', 'DocumentFragment', 'ShadowRoot', 'Range',
    'Attr', 'NamedNodeMap', 'History', 'EventTarget', 'Navigator', 'Function', 'Object', 'Array', 'Promise', 'Error', 'DOMException'];
  walk('window', window); walk('document', document); walk('navigator', navigator); walk('history', history);
  for (const p of protos) { const C = window[p]; if (C) { walk(p, C); walk(p + '.prototype', C.prototype); } }
  const U = window.Ultraviolet;
  if (U && U.BareClient) walk('Ultraviolet.BareClient.prototype', U.BareClient.prototype);
  // Calls through the wrapped methods with apply/call replaced. The replacements only record (bounded); what they saw
  // is classified after the originals are back (the engines' own code calls them too).
  const A = Function.prototype.apply, C = Function.prototype.call;
  const arrays = [], receivers = [];
  Function.prototype.apply = function (t, a) { if (a && typeof a === 'object' && arrays.length < 5000) arrays.push(a); return R(this, t, a == null ? [] : a); };
  Function.prototype.call = function (t, ...a) { if (t && (typeof t === 'object' || typeof t === 'function') && receivers.length < 5000) receivers.push(t); return R(this, t, a); };
  try {
    const d = document.createElement('div');
    document.body.appendChild(d);
    d.innerHTML = '<b>x</b>';
    d.insertAdjacentHTML('beforeend', '<i>y</i>');
    d.append(document.createElement('span'));
    const f = document.createElement('iframe');
    d.appendChild(f);
    void f.contentWindow; void f.contentDocument;
    f.setAttribute('data-x', '1');
    d.remove();
  } catch (e) { out.errors.calls = String(e && e.name); }
  finally { Function.prototype.apply = A; Function.prototype.call = C; }
  for (const a of arrays) { if (isHost(a)) out.applyArrays.host++; else out.applyArrays.page++; }
  for (const t of receivers) if (isHost(t)) out.callThis.host++;
  // Errors the wrapped functions throw belong to the page.
  const thrown = (k, fn) => { try { fn(); out.errors[k] = 'none'; } catch (e) { out.errors[k] = isHost(e) ? 'HOST' : 'page'; } };
  thrown('appendChild', () => document.body.appendChild(5));
  thrown('submit', () => HTMLFormElement.prototype.submit.call({}));
  thrown('contentWindow', () => Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow').get.call({}));
  thrown('innerHTML', () => Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML').set.call({}, 'x'));
  out.open = String(window.open === undefined ? 'undefined' : typeof window.open);
  out.host = out.host.slice(0, 40);
  // Every node of the document (parser-made, never touched by this script) is an object of this realm, after the
  // engine host's observers saw them.
  setTimeout(() => {
    let nodes = 0;
    out.hostNodes = 0;
    const visit = (node) => { nodes++; if (isHost(node)) out.hostNodes++; for (let c = node.firstChild; c; c = c.nextSibling) visit(c); };
    visit(document);
    out.nodes = nodes;
    document.getElementById('out').textContent = JSON.stringify(out);
  }, 300);
})();
</script>`,
      ),
    ],
    // Realm hygiene, the converse (realm.ts header, rule 2): the page's own script replaces getters and methods that
    // engine-host code could read on its objects (events, nodes, node lists, DOMRects, form controls, files, the
    // array iterator, Scramjet's client `url`) with forwarding Proxies that record their arguments array. A Proxy
    // trap receives an arguments array of the CALLER's realm, so engine-host code that runs page code hands the page
    // an engine-host array (and with it the engine host's global). The harness then drives GNOME's paths; `report()`
    // counts the recorded arrays that belong to the engine host.
    '/realm-traps': () => [
      200,
      page(
        'Realm traps',
        `<a id="blank" href="/second?via=blank" target="_blank" style="display:inline-block;padding:8px">blank</a>
<a id="dl" href="/file/attach.bin" download="x.bin" style="display:inline-block;padding:8px">download</a>
<form id="fb" action="/echo" method="get" target="_blank"><input name="q" value="1"><input type="file" id="ff" name="f"><button id="fbb">go</button></form>
<p id="txt">needle text for find</p>
<iframe id="nested" src="/realm-traps-child" style="width:300px;height:80px"></iframe>
<script>
(() => {
  const R = Reflect.apply;
  const FP = Object.getPrototypeOf(function () {});
  const seen = [];
  const record = (args) => { if (seen.length < 50000) seen.push(args); };
  const trapGet = (proto, key) => {
    const d = proto && Object.getOwnPropertyDescriptor(proto, key);
    if (!d || !d.get || !d.configurable) return;
    const g = d.get;
    Object.defineProperty(proto, key, { configurable: true, enumerable: d.enumerable, set: d.set, get: new Proxy(g, { apply(t, th, args) { record(args); return R(g, th, args); } }) });
  };
  const trapFn = (proto, key) => {
    const d = proto && Object.getOwnPropertyDescriptor(proto, key);
    if (!d || typeof d.value !== 'function' || !d.configurable) return;
    const f = d.value;
    Object.defineProperty(proto, key, { configurable: true, enumerable: d.enumerable, writable: true, value: new Proxy(f, { apply(t, th, args) { record(args); return R(f, th, args); } }) });
  };
  const G = [
    [Event.prototype, ['type', 'target', 'defaultPrevented']],
    [MouseEvent.prototype, ['button', 'clientX', 'clientY', 'ctrlKey', 'metaKey', 'shiftKey', 'altKey']],
    [KeyboardEvent.prototype, ['key', 'code']],
    [SecurityPolicyViolationEvent.prototype, ['disposition', 'effectiveDirective']],
    [Node.prototype, ['nodeType', 'parentNode', 'ownerDocument', 'nodeName']],
    [Element.prototype, ['localName', 'tagName']],
    [NodeList.prototype, ['length']],
    [DOMRectReadOnly.prototype, ['left', 'top']],
    [HTMLTextAreaElement.prototype, ['value']],
    [Document.prototype, ['title']],
    [HTMLAnchorElement.prototype, ['href', 'target', 'download']],
    [HTMLFormElement.prototype, ['action', 'method', 'target']],
    [File.prototype, ['name']],
  ];
  for (const [p, keys] of G) for (const k of keys) trapGet(p, k);
  trapFn(Array.prototype, Symbol.iterator);
  trapFn(NodeList.prototype, 'item');
  trapFn(Object.prototype, 'toString');
  const sj = window[Symbol.for('scramjet client global')];
  if (sj) trapGet(Object.getPrototypeOf(sj), 'url');
  const isHost = (v) => {
    if (!v || typeof v !== 'object') return false;
    try { let F = v.constructor; for (let i = 0; i < 10 && typeof F === 'function'; i++) { const p = Object.getPrototypeOf(F); if (p === FP) return false; F = p; } } catch (e) { return false; }
    try { let F = v.constructor; for (let i = 0; i < 4 && typeof F === 'function' && F.constructor !== F; i++) F = F.constructor; const g = F('return this')(); return !!(g && g !== window && g.__gnomeEngineHost); } catch (e) { return false; }
  };
  window.openWithTrap = () => {
    const t = new Proxy(function () {}, { apply(tt, th, args) { record(args); return '/second?via=trap'; } });
    try { window.open({ toString: t }, '_blank'); } catch (e) {}
  };
  window.violate = () => {
    const s = document.createElement('style');
    s.appendChild(document.createTextNode('body{background-image:url(http://127.0.0.1:1/trap.png)}'));
    document.head.appendChild(s);
  };
  // Nodes the engine host reached first (its observers, find's text walk) must still be page-realm objects.
  const nodeSweep = () => {
    let n = 0, hostNodes = 0;
    const visit = (node) => { n++; if (isHost(node)) hostNodes++; for (let c = node.firstChild; c; c = c.nextSibling) visit(c); };
    visit(document);
    return { n, hostNodes };
  };
  window.report = () => { let host = 0; for (const a of seen) if (isHost(a)) host++; const nodes = nodeSweep(); return { calls: seen.length, host, scramjetClient: !!sj, nodes: nodes.n, hostNodes: nodes.hostNodes }; };
  document.title = 'Realm traps ready';
})();
</script>`,
      ),
    ],
    '/realm-traps-child': () => [200, page('child', '<p id="ctx" style="padding:10px">right-click here</p>')],
    // An ordinary page borrows a fresh child realm's NATIVE window getters (parent, top, frameElement) and calls them
    // on its own window: the engines virtualize these only in the realms their clients hooked.
    '/borrow-natives': () => [
      200,
      page(
        'Borrow natives',
        `<iframe id="p1" style="width:20px;height:20px"></iframe><script>
(() => {
  const out = {};
  const kind = (w) => { try { if (w === null || w === undefined) return String(w); if (w === window) return 'self'; if (w.__gnomeEngineHost) return 'ENGINE-HOST'; return 'other'; } catch (e) { return 'cross-origin'; } };
  const viaFresh = (label, cw) => {
    try {
      const desc = (k) => Object.getOwnPropertyDescriptor(cw, k) || Object.getOwnPropertyDescriptor(cw.Window.prototype, k);
      out[label + '.parent'] = kind(desc('parent').get.call(window));
      try { out[label + '.top[0]'] = kind(desc('top').get.call(window)[0]); } catch (e) { out[label + '.top[0]'] = 'threw ' + e.name; }
      const fe = desc('frameElement').get.call(window);
      out[label + '.frameElement'] = fe ? kind(fe.ownerDocument.defaultView) : 'null';
    } catch (e) { out[label] = 'threw ' + e.name; }
  };
  out['own.parent'] = kind(window.parent);
  const f = document.createElement('iframe'); document.body.appendChild(f);
  viaFresh('appended', f.contentWindow);
  viaFresh('parser', window[0]);
  document.getElementById('out').textContent = JSON.stringify(out);
})();
</script>`,
      ),
    ],
    // Context menus (ENGINE-PROTOCOL §6.8).
    '/ctx': () => [
      200,
      page(
        'Context',
        `<p style="margin:0"><a id="ln" href="/second" style="display:inline-block;padding:20px">link</a></p>
<img id="im" src="/favicon.png" width="64" height="64" style="display:block;margin:10px">
<input id="in" value="editable" style="display:block;margin:10px">
<p id="txt" style="margin:10px">selectable text</p>
<div id="big" style="height:40px;overflow:hidden"></div>
<script>document.getElementById('big').textContent = 'x'.repeat(120000);</script>`,
      ),
    ],
    // Keys, fullscreen and find in nested frames.
    '/input': () => [
      200,
      page(
        'Input',
        `<input id="in"><button id="fs" onclick="document.documentElement.requestFullscreen()">fullscreen</button>
<p>needle one</p><iframe id="nested" src="/input-child" style="width:400px;height:120px"></iframe>`,
      ),
    ],
    '/input-child': () => [200, page('child', '<p>needle two</p><input id="cin">')],
    // WebRTC (ENGINE-PROTOCOL §6.15): the page's own script, then the results in #out.
    '/webrtc': () => [200, page('WebRTC', OUT(webrtcProbe(stunUrl)))],
    // Fresh realms an ordinary page's own script can make without any engine escape: srcdoc written after the iframe
    // is in the document (property, setAttribute, an Attr, innerHTML), srcdoc and src with a sandbox, a data: iframe
    // and a data: <object>. Each realm runs the STUN probe and writes `rtc:<name>:<result>` into its own title.
    '/webrtc-realms': () => {
      const probe = (name) =>
        `<script>(async()=>{let r;try{r=typeof RTCPeerConnection;if(r==='function'){const pc=new RTCPeerConnection({iceServers:[{urls:${JSON.stringify(stunUrl)}}]});pc.createDataChannel('x');await pc.setLocalDescription(await pc.createOffer());r='RAN'}}catch(e){r='threw '+e.name}document.title='rtc:${name}:'+r})()<\/script><p>${name}</p>`;
      const J = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
      return [
        200,
        page(
          'WebRTC realms',
          `<script>
const add = (attrs, tag = 'iframe') => { const f = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, v); document.body.appendChild(f); return f; };
add({ srcdoc: ${J(probe('srcdoc-before-insert'))} });
add({ sandbox: 'allow-scripts', srcdoc: ${J(probe('sandboxed-srcdoc'))} });
add({ src: 'data:text/html,' + encodeURIComponent(${J(probe('data-iframe'))}) });
add({ data: 'data:text/html,' + encodeURIComponent(${J(probe('data-object'))}), type: 'text/html' }, 'object');
const a = document.createElement('iframe'); document.body.appendChild(a); a.srcdoc = ${J(probe('srcdoc-property-later'))};
const b = document.createElement('iframe'); document.body.appendChild(b); b.setAttribute('srcdoc', ${J(probe('srcdoc-setattribute-later'))});
const b2 = document.createElement('iframe'); document.body.appendChild(b2); b2.setAttribute('srcdoc', ${J(probe('srcdoc-setattribute-extra-arg'))}, 'ignored');
const c = document.createElement('iframe'); document.body.appendChild(c); const at = document.createAttribute('srcdoc'); c.setAttributeNode(at); at.value = ${J(probe('srcdoc-attr-value-later'))};
const d = document.createElement('div'); d.innerHTML = '<iframe srcdoc="' + ${J(probe('srcdoc-innerhtml'))}.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"></iframe>'; document.body.appendChild(d);
</script>`,
        ),
      ];
    },
    // Fresh realms an ordinary page reaches without any engine escape and without a getter the guard wraps: frames
    // the parser inserts (window[n] from the next inline script, an inline onload), a frame re-navigated to
    // about:blank (src, location) or to a proxied page and polled from a MessageChannel loop until its new realm
    // appears, <object>/<embed> documents, javascript: and blob: documents (their scripts run at parse time), a frame
    // in a shadow root, document.write, execCommand and replaceChildren. `#out` gets one result per case.
    // `?set=closed` runs the cases GNOME closes, `?set=open` the known-open ones (ENGINE-PROTOCOL §6.15 limits);
    // `renav=closed|open` puts the about:blank re-navigations in one of them (closed in Chromium, open in Firefox).
    '/webrtc-gaps': (req) => {
      const q = new URL(req.url, origin).searchParams;
      const set = q.get('set') === 'open' ? 'open' : 'closed';
      const renav = q.get('renav') === 'open' ? 'open' : 'closed';
      const S = JSON.stringify(stunUrl);
      const selfProbe = (name) => `<script>(async()=>{let r;try{r=typeof RTCPeerConnection;if(r==='function'){const pc=new RTCPeerConnection({iceServers:[{urls:${S}}]});pc.createDataChannel('x');await pc.setLocalDescription(await pc.createOffer());r='RAN'}}catch(e){r='threw '+e.name}try{parent.postMessage({gap:${JSON.stringify(name)},r},'*')}catch(e){}})()<\/script>`;
      const J = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
      return [
        200,
        page(
          'WebRTC gaps',
          `<script>
  window.res = {};
  window.__onloadTry = (f) => { window.res['inline-onload'] = typeof f.contentWindow.RTCPeerConnection === 'function' || typeof window[1].RTCPeerConnection === 'function' ? 'AVAILABLE' : 'absent'; };
</script>
<iframe id="p1" style="width:20px;height:20px"></iframe>
<iframe id="p2" style="width:20px;height:20px" onload="window.__onloadTry(this)"></iframe>
<script>
  const stun = ${S};
  window.tryRealm = async (w) => {
    if (!w) return 'no window';
    let C;
    try { C = w.RTCPeerConnection; } catch (e) { return 'unreadable'; }
    if (typeof C !== 'function') return 'absent';
    const pc = new C({ iceServers: [{ urls: stun }] });
    pc.createDataChannel('x');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => setTimeout(r, 300));
    pc.close();
    return 'RAN';
  };
  // Parser-inserted iframe, reached by index from the next inline script.
  window.res['parser-indexed'] = typeof window[0].RTCPeerConnection === 'function' ? 'AVAILABLE' : 'absent';
</script>
<script>
  document.write('<iframe id="dw" style="width:20px;height:20px"></iframe>');
  window.res['document-write'] = typeof window[window.length - 1].RTCPeerConnection === 'function' ? 'AVAILABLE' : 'absent';
</script>
<object id="ob" data="about:blank" type="text/html" style="width:20px;height:20px"></object>
<embed id="em" src="about:blank" type="text/html" style="width:20px;height:20px">
<div id="ed" contenteditable="true"></div>
<script>
(async () => {
  const res = window.res;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SET = ${JSON.stringify(set)}, RENAV = ${JSON.stringify(renav)};
  const run = async (k, fn, which = 'closed') => { if (which !== SET) return; try { res[k] = await Promise.race([fn(), sleep(4000).then(() => 'timeout')]); } catch (e) { res[k] = 'threw ' + e.name; } };
  if (SET === 'open') { for (const k of ['parser-indexed', 'inline-onload', 'document-write']) delete res[k]; }
  addEventListener('message', (e) => { if (e.data && e.data.gap) res[e.data.gap] = e.data.r === 'undefined' ? 'absent' : e.data.r; });
  const frame = () => { const f = document.createElement('iframe'); f.style.cssText = 'width:20px;height:20px'; document.body.appendChild(f); return f; };
  // Poll a child's WindowProxy from a MessageChannel loop until its realm is new, then try it at once.
  const poll = (w, start) => new Promise((resolve) => {
    try { w.__gnomeOld = 1; } catch (e) {}
    const ch = new MessageChannel();
    const t0 = Date.now();
    ch.port1.onmessage = () => {
      let fresh = false;
      try { fresh = !('__gnomeOld' in w); } catch (e) { fresh = false; }
      if (fresh) { tryRealm(w).then(resolve, (e) => resolve('threw ' + e.name)); return; }
      if (Date.now() - t0 > 3500) { resolve('no new realm'); return; }
      ch.port2.postMessage(0);
    };
    start();
    ch.port2.postMessage(0);
  });
  await sleep(300);
  await run('object-indexed', () => tryRealm(window[[...document.querySelectorAll('iframe,object,embed')].indexOf(document.getElementById('ob'))]));
  await run('embed-indexed', () => tryRealm(window[[...document.querySelectorAll('iframe,object,embed')].indexOf(document.getElementById('em'))]));
  await run('renavigate-src-blank', () => { const f = frame(); const w = f.contentWindow; return poll(w, () => { f.src = 'about:blank'; }); }, RENAV);
  await run('renavigate-location-blank', () => { const f = frame(); const w = f.contentWindow; return poll(w, () => { w.location.href = 'about:blank'; }); }, RENAV);
  await run('navigate-proxied-poll', () => { const f = frame(); const w = f.contentWindow; return poll(w, () => { f.src = '/second?gap=1'; }); }, 'open');
  await run('shadow-root', () => { const h = document.createElement('div'); document.body.appendChild(h); const r = h.attachShadow({ mode: 'open' }); r.innerHTML = '<iframe></iframe>'; return tryRealm(r.querySelector('iframe').contentWindow); });
  await run('exec-command', () => { const ed = document.getElementById('ed'); ed.focus(); document.execCommand('insertHTML', false, '<iframe></iframe>'); const fr = ed.querySelector('iframe'); return fr ? tryRealm(window[[...document.querySelectorAll('iframe,object,embed')].indexOf(fr)]) : 'not inserted'; });
  await run('replace-children', () => { const d = document.createElement('div'); document.body.appendChild(d); d.replaceChildren(document.createElement('iframe')); return tryRealm(window[window.length - 1]); });
  await run('javascript-url', () => { const f = frame(); f.src = 'javascript:' + JSON.stringify(${J('<!doctype html>' + selfProbe('javascript-url-doc'))}); return sleep(1500).then(() => res['javascript-url-doc'] ? 'reported' : 'not run'); }, 'open');
  await run('blob-url', () => { const f = frame(); f.src = URL.createObjectURL(new Blob([${J('<!doctype html>' + selfProbe('blob-url-doc'))}], { type: 'text/html' })); return sleep(1500).then(() => res['blob-url-doc'] ? 'reported' : 'not run'); }, 'open');
  await sleep(800);
  document.getElementById('out').textContent = JSON.stringify(res);
})();
</script>`,
        ),
      ];
    },
    '/webrtc.svg': () => [
      200,
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50"><title>pending</title><script>//<![CDATA[
(async () => { let r; try { r = typeof RTCPeerConnection === 'function' ? 'available' : 'absent';
  if (r === 'available') { const pc = new RTCPeerConnection({ iceServers: [{ urls: ${JSON.stringify(stunUrl)} }] }); pc.createDataChannel('x'); await pc.setLocalDescription(await pc.createOffer()); await new Promise((q) => setTimeout(q, 1500)); pc.close(); }
} catch (e) { r = 'threw ' + e.name; } document.querySelector('title').textContent = 'svg:' + r; })();
//]]></script><text x="5" y="30">svg</text></svg>`,
      { 'content-type': 'image/svg+xml' },
    ],
    // CSP (ENGINE-PROTOCOL §6.16): a construct both engines leave native (a text node in <style>, spike §5.2) in a
    // document loaded as frame/object/embed and in an SVG document.
    '/csp-doc': (req) => {
      const id = (new URL(req.url, origin).searchParams.get('id') || 'doc').replace(/[^a-z0-9-]/gi, '');
      return [
        200,
        page(
          `csp ${id}`,
          `<script>
  const v = []; const show = () => { document.getElementById('out').textContent = JSON.stringify({ violations: v }); };
  document.addEventListener('securitypolicyviolation', (e) => { v.push(e.effectiveDirective); show(); });
  document.body.style.minHeight = '40px';
  // Constructs both engines leave native without GNOME's policy (spike §5.2): a text node in <style>, Web Animations.
  const s = document.createElement('style'); s.appendChild(document.createTextNode(${JSON.stringify(leakCss(id))})); document.head.appendChild(s);
  try { document.body.animate([{ backgroundImage: 'url(${leakOrigin}/leak/' + ${JSON.stringify(id)} + '-anim.png)' }, { backgroundImage: 'none' }], 2000); } catch (e) {}
  setTimeout(show, 2000);
</script>`,
        ),
      ];
    },
    '/csp-frames': () => [
      200,
      page(
        'CSP frames',
        `<iframe id="if" src="/csp-doc?id=iframe" style="width:200px;height:80px"></iframe>
<object id="ob" data="/csp-doc?id=object" type="text/html" style="width:200px;height:80px"></object>
<embed id="em" src="/csp-doc?id=embed" type="text/html" style="width:200px;height:80px">`,
      ),
    ],
    '/csp-frameset': () => [
      200,
      `<!doctype html><html><head><meta charset="utf-8"><title>frameset</title></head><frameset cols="50%,50%"><frame name="f1" src="/csp-doc?id=frame"><frame name="f2" src="/second"></frameset></html>`,
    ],
    '/csp.svg': () => [
      200,
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50"><title>pending</title><style>svg{background-image:url(${leakOrigin}/leak/svgdoc.png)}</style><image href="${leakOrigin}/leak/svgimage.png" width="8" height="8"/><rect x="10" width="8" height="8" fill="url(${leakOrigin}/leak/svgfill.svg#p)"/><script>//<![CDATA[
const v = []; document.addEventListener('securitypolicyviolation', (e) => { v.push(e.effectiveDirective); document.querySelector('title').textContent = 'violations:' + v.length; });
try { document.documentElement.animate([{ backgroundImage: 'url(${leakOrigin}/leak/svganim.png)' }, { backgroundImage: 'url(${leakOrigin}/leak/svganim2.png)' }], { duration: 1000 }); } catch {}
setTimeout(() => { document.querySelector('title').textContent = 'violations:' + v.length; }, 1500);
//]]></script><text x="5" y="30">svg csp</text></svg>`,
      { 'content-type': 'image/svg+xml' },
    ],
    // Permissions (ENGINE-PROTOCOL §6.14): what the document's own policy says.
    '/perm': () => [
      200,
      page(
        'Permissions',
        OUT(`(async () => {
  const pp = document.permissionsPolicy || document.featurePolicy;
  const allowed = (f) => (pp && pp.allowsFeature ? pp.allowsFeature(f) : 'unknown');
  // Attempts without any user gesture, by the page's own script at load (an evaluate from the harness would carry one).
  const within = (p, ms, what) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(what + ' timeout')), ms))]);
  let play;
  try { const a = new Audio('data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAipOboqaop6SfmI+GfHJpYlxZWFpeZGx1f4mSmqGmqKiloJmQh31zamNdWVhZXWNrdH2HkZmgpaiopaGakoh+dGtkXVpYWVxiaXJ8hpCYn6WnqKahm5OKgHZtZF5aWFlcYWhxe4WOl5+kp6imopyUi4F3bmVfWlhYW2BncHmDjZaeo6eop6OdlYyCeG9mYFtYWFtfZm94goyVnaOnqKejnpaNhHpwZ2BbWVhaX2Vtd4GLlJyipqinpJ+Xj4V7cWlhXFlYWl5kbHZ/iZOboaaop6WgmJCGfHNqYlxZWFldY2t0foiRmqGlqKiloJmRiH50a2NdWVhZXWJqc32HkJmgpaiopqGakol/dWxkXlpYWVxiaXJ7hY+Yn6SnqKaim5OKgHZtZV5aWFlcYWhweoSOl56kp6imopyVi4J4bmZfW1hYW2Bnb3mDjZado6eop6Odlo2DeW9nYFtYWFtfZm53gYuUnKKmqKeknpeOhHpxaGFcWVhaXmVtdoCKk5uipqinpJ+Yj4Z8cmliXFlYWl5kbHV/iZKaoaaoqKWgmZCHfXNqY11ZWFldY2t0fYeRmaClqKiloZqSiH50a2NdWlhZXGJqcnyGkJifpaeopqGbk4mAdmxkXlpYWVxhaHF7hY6Xn6SnqKainJSLgXduZV9aWFhbYGdweYONlp6jp6ino52VjIJ4b2ZgW1hYW2Bmb3iCjJWdo6eop6Oelo2EenBnYFtZWFpfZW53gYuUnKKmqKekn5ePhXtxaGFcWVhaXmRsdn+Jk5uhpqinpZ+YkIZ8cmpiXFlYWV1ja3R+iJKaoaWoqKWgmZGHfnRrY11ZWFldYmpzfYeQmaClqKimoZqSiX91bGReWlhZXGJpcnuFj5ifpKeopqKbk4qAdm1lXlpYWVxhaHF6hI6XnqSnqKainJSLgnhuZl9bWFhbYGdveYONlp2jp6ino52WjYN5b2dgW1hYW19mbniCi5Scoqaop6Sel46EenFoYVxZWFpeZW12gIqTm6KmqKekn5iPhXtyaWJcWVhaXmRsdX+JkpqhpqiopaCZkId9c2piXVlYWQ=='); await within(a.play(), 3000, 'play'); a.pause(); play = 'played'; } catch (e) { play = String(e.name === 'Error' ? e.message : e.name); }
  let clip;
  try { window.focus(); await within(navigator.clipboard.writeText('gnome'), 3000, 'clipboard'); clip = 'written'; } catch (e) { clip = String(e.name === 'Error' ? e.message : e.name); }
  return { autoplay: allowed('autoplay'), fullscreen: allowed('fullscreen'), clipboard: allowed('clipboard-write'), fullscreenEnabled: document.fullscreenEnabled, play, clip };
})()`),
      ),
    ],
    // A clipboard write from a click (focus and the user's activation in the frame): the permissions policy alone then
    // decides whether it is allowed (worklist A5). #out says 'written' or the error's name; the policy as the page sees it.
    '/perm-clip': () => [
      200,
      page(
        'Clipboard',
        `<button id="clip" style="position:absolute;left:40px;top:60px;width:200px;height:60px">copy</button><script>
const pp = document.permissionsPolicy || document.featurePolicy;
const policy = pp && pp.allowsFeature ? pp.allowsFeature('clipboard-write') : 'unknown';
document.getElementById('clip').addEventListener('click', async () => {
  // document.execCommand('copy') first (synchronously in the click, as sites do), then the asynchronous API. A block
  // that stops only one of them does not stop a site from writing the clipboard (security review, integration part 2).
  let exec;
  let copied = false;
  const onCopy = (e) => { e.clipboardData.setData('text/plain', 'gnome-exec'); e.preventDefault(); copied = true; };
  document.addEventListener('copy', onCopy, { once: true });
  try { exec = document.execCommand('copy') && copied ? 'written' : 'refused'; } catch (e) { exec = String(e && e.name); }
  document.removeEventListener('copy', onCopy);
  let r;
  try { await navigator.clipboard.writeText('gnome-clip'); r = 'written'; } catch (e) { r = String(e && e.name); }
  document.getElementById('out').textContent = JSON.stringify({ clip: r, exec, policy, focus: document.hasFocus() });
});
</script>`,
      ),
    ],
    // Controlled fallback (ENGINE-PROTOCOL §6.2): cookies to copy (HttpOnly included), their echo, a POST form whose
    // Scramjet attempt fails (the engine host's e2e fault `sj-throw-marker` fails requests whose URL has the marker),
    // and a server that never answers.
    '/cookies/set': () => [200, page('Cookies set', '<p>set</p>'), { 'set-cookie': ['sid=s3cr3t; Path=/; HttpOnly', 'pref=dark; Path=/; Max-Age=3600'] }],
    '/cookies': (req) => [200, page('Cookies', `<pre id="cookies">${esc(req.headers.cookie ?? '')}</pre>`)],
    '/form-fault': () => [200, page('Form fault', '<form method="post" action="/echo?gnome-fault=sj-throw"><input name="q" value="once"><button id="post">post</button></form>')],
    '/hang': () => new Promise(() => {}),
    // Capabilities (ENGINE-PROTOCOL §6.10, §6.11).
    '/storage': () => [200, page('Storage', OUT(`(async () => { const before = localStorage.getItem('gnome-k'); localStorage.setItem('gnome-k', 'v'); return { before }; })()`))],
    '/print': () => [
      200,
      page('Print', `<p id="p">printable text</p><script>window.__events = []; addEventListener('beforeprint', () => window.__events.push('beforeprint')); addEventListener('afterprint', () => window.__events.push('afterprint'));</script>`),
    ],
    '/wide': () => [200, page('Wide', '<p id="w">width</p><a id="ln" href="/second" style="position:absolute;left:300px;top:200px">link</a>')],
    '/title-change': () => [200, page('t0', `<script>let n = 0; const i = setInterval(() => { document.title = 't' + (++n); if (n >= 40) clearInterval(i); }, 25);</script>`)],
    '/slow': async () => {
      await new Promise((r) => setTimeout(r, 1500));
      return [200, page('Slow', '<h1>slow</h1>')];
    },
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    count(url.pathname);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    if (url.pathname === '/favicon.png' || url.pathname === '/favicon.ico') {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(PNG);
      return;
    }
    if (url.pathname === '/xs/echo') {
      const via = url.searchParams.get('via') ?? '';
      xsLog.push({ at: Date.now(), via, cookie: String(req.headers.cookie ?? ''), site: req.headers['sec-fetch-site'] ?? null, referer: req.headers.referer ?? null, origin: req.headers.origin ?? null });
      if (via === 'favicon') {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        res.end(PNG);
        return;
      }
      html(res, 200, page(`Echo ${via}`, `<p>${esc(via)}</p>`));
      return;
    }
    if (url.pathname === '/xs/attacker') {
      // Written by hand: page()'s own icon link would compete with the victim URL.
      html(
        res,
        200,
        `<!doctype html><html><head><meta charset="utf-8"><title>Attacker</title><link rel="icon" href="${origin}/xs/echo?via=favicon"></head><body><pre id="out">attacker</pre>` +
          `<a id="blank" target="_blank" href="${origin}/xs/echo?via=blank" style="position:absolute;left:40px;top:60px;width:200px;height:40px;display:block">open</a>` +
          `<a id="dl" download href="${origin}/xs/echo?via=adownload">dl</a>` +
          `<script>setTimeout(() => document.getElementById('dl').click(), 300);</script></body></html>`,
      );
      return;
    }
    if (url.pathname.startsWith('/file/')) {
      const name = url.pathname.slice('/file/'.length);
      const data = Buffer.alloc(256 * 1024, 7);
      const headers = { 'cache-control': 'no-store', 'content-length': String(data.length) };
      if (name === 'attach.bin') Object.assign(headers, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="attach.bin"' });
      else if (name === 'archive.zip') Object.assign(headers, { 'content-type': 'application/zip' });
      else Object.assign(headers, { 'content-type': 'application/octet-stream' });
      res.writeHead(200, headers);
      res.end(data);
      return;
    }
    const route = routes[url.pathname];
    if (!route) {
      html(res, 404, page('Not found', '<h1>404</h1>'));
      return;
    }
    try {
      const [status, out, headers] = await route(req, body);
      if (status === 204) {
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      html(res, status, out, headers ?? {});
    } catch (e) {
      html(res, 500, page('error', esc(e && e.message)));
    }
  });
  // A request that came through an engine carries the real page as its Referer (the fixture site); one that left the
  // browser natively carries the proxy origin (or none). Only native ones are leaks.
  const leakHits = [];
  const proxiedHits = [];
  const leak = createServer((req, res) => {
    const ref = String(req.headers.referer ?? '');
    const viaEngine = ref.startsWith(origin) || ref.startsWith(altOrigin);
    (viaEngine ? proxiedHits : leakHits).push({ at: Date.now(), url: req.url, referer: ref.slice(0, 120) });
    res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' });
    res.end(PNG);
  });
  const stunPackets = [];
  const stun = createSocket('udp4');
  stun.on('message', (msg, rinfo) => stunPackets.push({ at: Date.now(), len: msg.length, from: `${rinfo.address}:${rinfo.port}` }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => {
    leak.once('error', reject);
    leak.listen(leakPort, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => {
    stun.once('error', reject);
    stun.bind(stunPort, '127.0.0.1', resolve);
  });
  return {
    origin,
    altOrigin,
    hits: (p) => hits.get(p) ?? 0,
    leak: {
      origin: leakOrigin,
      count: () => leakHits.length,
      proxied: () => proxiedHits.length,
      /** Every request, however it came (for documents no engine touches, every request is native). */
      all: () => leakHits.length + proxiedHits.length,
      hits: () => [...leakHits],
      reset: () => {
        leakHits.length = 0;
        proxiedHits.length = 0;
      },
    },
    stun: { url: stunUrl, packets: () => stunPackets.length, reset: () => (stunPackets.length = 0) },
    xs: { log: () => [...xsLog], reset: () => (xsLog.length = 0) },
    async close() {
      await new Promise((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await new Promise((r) => leak.close(() => r()));
      leak.closeAllConnections?.();
      await new Promise((r) => stun.close(() => r()));
    },
  };
}

// ── Driving helpers on top of the runner's App (spike lib/drive.mjs) ─────────────────────────────────────────────

/** The query that routes the driver's engine host through the allow-loopback HolyWisp (the fixture site). */
export function fixtureQuery(ctx, extra = {}) {
  return { route: `profile:${ctx.stack.profiles.live}`, ...extra };
}

/** Evaluates in a tab frame with a deadline (playwright-core + Firefox can leave frame reads pending). */
export async function inFrame(frame, fn, arg, ms = 8000) {
  let timer;
  const t = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`frame.evaluate: no answer within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([frame.evaluate(fn, arg), t]);
  } finally {
    clearTimeout(timer);
  }
}

/** Reads #out (JSON) of the frame named `name` (a tab frame `tab-<id>` by default), waiting until it is not pending. */
export async function readOutOf(app, name, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    const m = /^tab-(\d+)$/.exec(name);
    const f = m ? app.tabFrame(Number(m[1])) : app.page.frames().find((fr) => fr.name() === name);
    if (f) {
      try {
        const txt = await inFrame(f, () => {
          const el = document.getElementById('out');
          return el ? el.textContent : null;
        }, undefined, 3000);
        if (txt && txt !== 'pending') return JSON.parse(txt);
      } catch {
        /* navigating */
      }
    }
    if (Date.now() - t0 > timeout) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Events of a type (optionally for one tab) since a mark. */
export async function eventsOf(app, since, type, tabId) {
  return (await app.eventsSince(since)).filter((e) => e.type === type && (tabId === undefined || e.p.tabId === tabId || e.p.openerTabId === tabId));
}

/** Waits for an event matching `pred` after `since`. */
export function waitEvent(app, since, pred, timeout = 20000) {
  return app.waitFor(since, pred, timeout);
}

export const PERMS = { autoplay: 'allow', fullscreen: 'allow', clipboard: 'allow' };
export const ENGINES = ['scramjet', 'ultraviolet'];

/** One record per engine: `fn(engine)` returns {result, notes}; exceptions are failures. */
export async function perEngine(ctx, test, fn, { engines = ENGINES, transport } = {}) {
  for (const engine of engines) {
    try {
      const r = await fn(engine);
      ctx.record({ test, engine, ...(transport ? { transport } : {}), result: r.result, notes: r.notes, ...(r.expectFail ? { expectFail: true } : {}) });
    } catch (e) {
      ctx.record({ test, engine, ...(transport ? { transport } : {}), result: 'fail', notes: `threw: ${String(e && e.stack ? e.stack : e).slice(0, 400)}` });
    }
  }
}

/** Clicks the centre of an element in a frame with a real (trusted) mouse event, without evaluating in the page. */
export async function realClick(app, frame, selector, opts = {}) {
  const el = await frame.waitForSelector(selector, { timeout: 10000 });
  const box = await el.boundingBox();
  if (!box) throw new Error(`${selector} has no box`);
  await app.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, opts);
}
