// Test pages of the isolation and leak suites (suites/isolation.mjs, suites/leak.mjs; items 3 and 4 of
// docs/research/spike-engine-host.md). target.mjs mounts them under /iso/ and /leak/. Like every
// target page they are reachable only through Wisp (the TEST-ONLY HolyWisp), i.e. only as proxied documents.
//
//   /leak/matrix  one element per CSS/HTML/DOM construct that can load a URL; each construct points at its own
//                 unroutable host (https://leak-<id>.gnome-spike.invalid/...), so a native (unproxied) request
//                 names the construct that escaped the engine's rewriters.
//   /iso/probe    isolation probe: the page's own (engine-rewritten) JS tries to reach the app origin; the suite
//                 then runs the "escaped" probes as unrewritten code in the same document.
//   /iso/victim   a second proxied site with secrets (DOM, input value, cookies, localStorage).
import { PORTS, APP_ORIGIN, PROXY_ORIGIN } from '../lib/config.mjs';
import { send, randomId } from './common.mjs';

export const LEAK_DOMAIN = 'gnome-spike.invalid';
export const leakHost = (id) => `leak-${id}.${LEAK_DOMAIN}`;
const absUrl = (id, ext = 'png') => `https://${leakHost(id)}/${id}.${ext}`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const html = (res, body, headers = {}) => send(res, 200, body, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });

// Constructs. `url` picks the URL form: abs (https://leak-<id>.gnome-spike.invalid/<id>.png, default),
// rel (/leak-rel/<id>.png: unrewritten = request to the proxy origin, i.e. broken but not leaking) or
// pr (protocol-relative //leak-<id>...: unrewritten = native request with the proxy origin's scheme).
// `html(u, id)` is served markup (rewritten by the engine's HTML rewriter); `box(u)` adds attributes to the
// construct's own 10x10 element; `js` is the body of function (U, CSS, el, ID) run by the page's own script
// (rewritten by the engine's JS rewriter, as a site's script would be). CSS = "#c-<id> { background-image: url(U) }".
export const LEAK_CONSTRUCTS = [
  // ---- served HTML: the engines' HTML/CSS rewriters (controls, except the rarer syntaxes)
  { id: 'html-style', group: 'served-html', desc: '<style> element in the served HTML', html: (u, id) => `<style>#c-${id} { background-image: url(${u}); }</style>` },
  { id: 'html-style-attr', group: 'served-html', desc: 'style="" attribute in the served HTML', box: (u) => `style="background-image: url(${u})"` },
  { id: 'html-image-set', group: 'served-html', desc: 'image-set() with a bare string URL in a served <style>', html: (u, id) => `<style>#c-${id} { background-image: image-set("${u}" 1x); }</style>` },
  { id: 'html-import-string', group: 'served-html', desc: '@import "<url>" (string form) in a served <style>', html: (u) => `<style>@import "${u.replace('.png', '.css')}";</style>` },
  { id: 'html-svg-style', group: 'served-html', desc: '<style> inside an inline <svg> in the served HTML', html: (u, id) => `<svg width="10" height="10"><style>#c-${id} { background-image: url(${u}); }</style></svg>` },
  { id: 'html-dsd-style', group: 'served-html', desc: 'declarative shadow DOM (<template shadowrootmode>) with a <style>', html: (u) => `<div><template shadowrootmode="open"><style>i { display: block; width: 10px; height: 10px; background-image: url(${u}); }</style><i></i></template></div>` },
  { id: 'html-table-background', group: 'served-html', desc: 'legacy <table background=""> attribute', html: (u) => `<table background="${u}" width="10" height="10"><tr><td></td></tr></table>` },
  { id: 'html-svg-image', group: 'served-html', desc: '<svg><image href>', html: (u) => `<svg width="10" height="10"><image href="${u}" width="10" height="10"/></svg>` },
  { id: 'html-img-srcset', group: 'served-html', desc: '<img srcset>', html: (u) => `<img srcset="${u} 1x" width="10" height="10" alt="">` },
  { id: 'html-video-poster', group: 'served-html', desc: '<video poster>', html: (u) => `<video poster="${u}" width="10" height="10"></video>` },
  { id: 'html-input-image', group: 'served-html', desc: '<input type=image src>', html: (u) => `<input type="image" src="${u}" width="10" height="10" alt="">` },
  { id: 'html-preconnect', group: 'served-html', desc: '<link rel=preconnect> (connection only)', html: (u) => `<link rel="preconnect" href="${new URL(u).origin}">` },
  // ---- CSS text inserted by script into <style> elements (client-side hooks)
  { id: 'js-textnode', group: 'css-text', desc: 'style.appendChild(document.createTextNode(css)), then insert (MediaWiki ResourceLoader newStyleTag)', js: "const s = document.createElement('style'); s.appendChild(document.createTextNode(CSS)); document.head.appendChild(s);" },
  { id: 'js-textnode-rel', url: 'rel', group: 'css-text', desc: 'same, relative url(/path)', js: "const s = document.createElement('style'); s.appendChild(document.createTextNode(CSS)); document.head.appendChild(s);" },
  { id: 'js-textnode-pr', url: 'pr', group: 'css-text', desc: 'same, protocol-relative url(//host/path)', js: "const s = document.createElement('style'); s.appendChild(document.createTextNode(CSS)); document.head.appendChild(s);" },
  { id: 'js-textnode-after', group: 'css-text', desc: 'Text node appended to a <style> already in the document', js: "const s = document.createElement('style'); document.head.appendChild(s); s.appendChild(document.createTextNode(CSS));" },
  { id: 'js-textnode-data', group: 'css-text', desc: 'textNode.data = css', js: "const s = document.createElement('style'); const t = document.createTextNode(''); s.appendChild(t); document.head.appendChild(s); t.data = CSS;" },
  { id: 'js-textnode-nodevalue', group: 'css-text', desc: 'textNode.nodeValue = css', js: "const s = document.createElement('style'); const t = document.createTextNode(''); s.appendChild(t); document.head.appendChild(s); t.nodeValue = CSS;" },
  { id: 'js-append-string', group: 'css-text', desc: 'style.append(cssString)', js: "const s = document.createElement('style'); s.append(CSS); document.head.appendChild(s);" },
  { id: 'js-replacechildren', group: 'css-text', desc: 'style.replaceChildren(textNode)', js: "const s = document.createElement('style'); document.head.appendChild(s); s.replaceChildren(document.createTextNode(CSS));" },
  { id: 'js-appenddata', group: 'css-text', desc: 'textNode.appendData(css) (hooked)', js: "const s = document.createElement('style'); const t = document.createTextNode(''); s.appendChild(t); document.head.appendChild(s); t.appendData(CSS);" },
  { id: 'js-textcontent', group: 'css-text', desc: 'style.textContent = css', js: "const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s);" },
  { id: 'js-innerhtml', group: 'css-text', desc: 'style.innerHTML = css', js: "const s = document.createElement('style'); s.innerHTML = CSS; document.head.appendChild(s);" },
  { id: 'js-svg-style', group: 'css-text', desc: 'SVG <style> (SVGStyleElement) filled by textContent', js: "const NS = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(NS, 'svg'); const s = document.createElementNS(NS, 'style'); s.textContent = CSS; svg.appendChild(s); el.appendChild(svg);" },
  { id: 'js-shadow-innerhtml', group: 'css-text', desc: 'shadowRoot.innerHTML = "<style>…"', js: "const r = el.attachShadow({ mode: 'open' }); r.innerHTML = '<style>:host { background-image: url(' + U + '); }</style>';" },
  { id: 'js-insertadjacenthtml', group: 'css-text', desc: 'insertAdjacentHTML("<style>…") (hooked)', js: "document.body.insertAdjacentHTML('beforeend', '<style>' + CSS + '</style>');" },
  { id: 'js-iframe-srcdoc', group: 'css-text', desc: '<iframe srcdoc> with a <style>', js: "const f = document.createElement('iframe'); f.width = 20; f.height = 20; f.srcdoc = '<style>body { background-image: url(' + U + '); }</style>'; el.appendChild(f);" },
  // ---- CSSOM
  { id: 'cssom-insertrule', group: 'cssom', desc: 'CSSStyleSheet.insertRule (hooked)', js: "const s = document.createElement('style'); document.head.appendChild(s); s.sheet.insertRule(CSS);" },
  { id: 'cssom-media-insertrule', group: 'cssom', desc: 'CSSMediaRule.insertRule (grouping rule)', js: "const s = document.createElement('style'); document.head.appendChild(s); s.sheet.insertRule('@media all {}'); s.sheet.cssRules[0].insertRule(CSS);" },
  { id: 'cssom-addrule', group: 'cssom', desc: 'CSSStyleSheet.addRule (legacy)', js: "const s = document.createElement('style'); document.head.appendChild(s); s.sheet.addRule('#c-' + ID, 'background-image: url(' + U + ')');" },
  { id: 'cssom-replacesync', group: 'cssom', desc: 'constructed CSSStyleSheet.replaceSync + adoptedStyleSheets', js: "const sh = new CSSStyleSheet(); sh.replaceSync(CSS); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sh];" },
  { id: 'cssom-rule-style-prop', group: 'cssom', desc: 'cssRule.style.backgroundImage = …', js: "const s = document.createElement('style'); document.head.appendChild(s); s.sheet.insertRule('#c-' + ID + ' {}'); s.sheet.cssRules[0].style.backgroundImage = 'url(' + U + ')';" },
  { id: 'cssom-rule-setproperty', group: 'cssom', desc: 'cssRule.style.setProperty(…) (hooked)', js: "const s = document.createElement('style'); document.head.appendChild(s); s.sheet.insertRule('#c-' + ID + ' {}'); s.sheet.cssRules[0].style.setProperty('background-image', 'url(' + U + ')');" },
  // ---- inline style APIs
  { id: 'style-setproperty', group: 'inline-style', desc: 'el.style.setProperty("background-image", …)', js: "el.style.setProperty('background-image', 'url(' + U + ')');" },
  { id: 'style-camel', group: 'inline-style', desc: 'el.style.backgroundImage = …', js: "el.style.backgroundImage = 'url(' + U + ')';" },
  { id: 'style-dashed', group: 'inline-style', desc: 'el.style["background-image"] = …', js: "el.style['background-image'] = 'url(' + U + ')';" },
  { id: 'style-csstext', group: 'inline-style', desc: 'el.style.cssText = …', js: "el.style.cssText = 'background-image: url(' + U + ')';" },
  { id: 'style-mask', group: 'inline-style', desc: 'el.style.setProperty("mask-image", …)', js: "el.style.background = 'red'; el.style.setProperty('mask-image', 'url(' + U + ')'); el.style.setProperty('-webkit-mask-image', 'url(' + U + ')');" },
  { id: 'style-custom-prop', group: 'inline-style', desc: 'custom property --x: url(…) used through var()', js: "el.style.setProperty('--gnome-img', 'url(' + U + ')'); el.style.backgroundImage = 'var(--gnome-img)';" },
  { id: 'style-setattribute', group: 'inline-style', desc: 'el.setAttribute("style", …)', js: "el.setAttribute('style', 'background-image: url(' + U + ')');" },
  { id: 'style-setattributens', group: 'inline-style', desc: 'el.setAttributeNS(null, "style", …)', js: "el.setAttributeNS(null, 'style', 'background-image: url(' + U + ')');" },
  { id: 'style-attr-node', group: 'inline-style', desc: 'el.getAttributeNode("style").value = …', js: "el.setAttribute('style', 'color: red'); el.getAttributeNode('style').value = 'background-image: url(' + U + ')';" },
  { id: 'style-typed-om', group: 'inline-style', desc: 'el.attributeStyleMap.set(prop, "url(…)") (CSS Typed OM)', js: "if (!el.attributeStyleMap) throw new Error('unsupported'); el.attributeStyleMap.set('background-image', 'url(' + U + ')');" },
  { id: 'style-animate', group: 'inline-style', desc: 'el.animate([{backgroundImage: "url(…)"}]) (Web Animations)', js: "el.animate([{ backgroundImage: 'url(' + U + ')' }, { backgroundImage: 'url(' + U + ')' }], { duration: 60000 });" },
  // ---- other URL sinks set by script
  { id: 'js-img-src', group: 'dom-url', desc: 'img.src = … (hooked)', js: "const i = new Image(10, 10); i.src = U; el.appendChild(i);" },
  { id: 'js-img-setattributens', group: 'dom-url', desc: 'img.setAttributeNS(null, "src", …)', js: "const i = document.createElement('img'); i.setAttributeNS(null, 'src', U); el.appendChild(i);" },
  { id: 'js-img-srcset', group: 'dom-url', desc: 'img.srcset = …', js: "const i = document.createElement('img'); i.srcset = U + ' 1x'; el.appendChild(i);" },
  { id: 'js-svg-image-href', group: 'dom-url', desc: 'SVG <image>.setAttribute("href", …)', js: "const NS = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(NS, 'svg'); const im = document.createElementNS(NS, 'image'); im.setAttribute('width', '10'); im.setAttribute('height', '10'); im.setAttribute('href', U); svg.appendChild(im); el.appendChild(svg);" },
  { id: 'js-svg-image-baseval', group: 'dom-url', desc: 'SVG <image>.href.baseVal = … (SVGAnimatedString)', js: "const NS = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(NS, 'svg'); const im = document.createElementNS(NS, 'image'); im.setAttribute('width', '10'); im.setAttribute('height', '10'); im.href.baseVal = U; svg.appendChild(im); el.appendChild(svg);" },
  { id: 'js-link-preload', group: 'dom-url', desc: '<link rel=preload as=image> created by script', js: "const l = document.createElement('link'); l.rel = 'preload'; l.as = 'image'; l.href = U; document.head.appendChild(l);" },
  { id: 'js-fetch', group: 'dom-url', desc: 'fetch(url) (hooked)', js: "fetch(U).catch(() => {});" },
  { id: 'js-fontface', group: 'dom-url', desc: 'new FontFace(name, "url(…)").load() (hooked)', js: "new FontFace('gnome-leak-' + ID, 'url(' + U.replace('.png', '.woff2') + ')').load().catch(() => {});" },
  { id: 'js-beacon', group: 'dom-url', desc: 'navigator.sendBeacon(url) (hooked)', js: "navigator.sendBeacon(U, 'x');" },
];

// Every load gets its own query (n=): browsers keep failed image loads in a memory cache shared between documents
// (Firefox's image cache), so a URL already tried by an earlier load would not be requested again.
function constructUrl(c, nonce) {
  if (c.url === 'rel') return `/leak-rel/${c.id}.png?n=${nonce}`;
  if (c.url === 'pr') return `//${leakHost(c.id)}/${c.id}.png?n=${nonce}`;
  return `${absUrl(c.id)}?n=${nonce}`;
}

function leakMatrix() {
  const nonce = randomId(6);
  const parts = [];
  const boxes = [];
  const scripts = [];
  for (const c of LEAK_CONSTRUCTS) {
    const u = constructUrl(c, nonce);
    if (c.html) parts.push(c.html(u, c.id));
    boxes.push(`<div id="c-${c.id}" class="leak-box" title="${esc(c.desc)}" ${c.box ? c.box(u) : ''}></div>`);
    if (c.js) scripts.push(`[${JSON.stringify(c.id)}, ${JSON.stringify(u)}, function (U, CSS, el, ID) { ${c.js} }]`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Leak matrix</title>
<style>.leak-box { display: inline-block; width: 10px; height: 10px; margin: 1px; background-size: cover; } svg, table, img, video, input, iframe { vertical-align: top; }</style>
</head><body><h1>Leak matrix</h1>
<div id="boxes">${boxes.join('')}</div>
${parts.join('\n')}
<pre id="out">pending</pre>
<script>
(() => {
  const C = [
${scripts.join(',\n')}
  ];
  const out = {};
  for (const [id, U, run] of C) {
    const el = document.getElementById('c-' + id);
    const CSS = '#c-' + id + ' { background-image: url(' + U + '); }';
    try { run(U, CSS, el, id); out[id] = 'ran'; } catch (e) { out[id] = 'threw ' + (e && e.name) + ': ' + String(e && e.message).slice(0, 100); }
  }
  setTimeout(() => { document.getElementById('out').textContent = JSON.stringify(out); document.title = 'leak matrix done'; }, 2500);
})();
</script></body></html>`;
}

// In-page probe (engine-rewritten JS, i.e. what a proxied site's ordinary script observes). Results land in #out.
const PROBE_JS = `
(async () => {
  const out = {};
  const t = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = 'threw ' + (e && e.name) + ': ' + String(e && e.message).slice(0, 140); } };
  const APP = ${JSON.stringify(APP_ORIGIN)};
  await t('locationHref', () => location.href);
  await t('origin', () => self.origin);
  await t('topIsSelf', () => window.top === window);
  await t('parentIsSelf', () => window.parent === window);
  await t('frameElement', () => String(window.frameElement));
  await t('documentCookie', () => document.cookie);
  await t('appLocalStorageViaOwn', () => localStorage.getItem('gnome:secret'));
  await t('appLocalStorageViaTop', () => window.top.localStorage.getItem('gnome:secret'));
  await t('idbDatabases', async () => indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : 'unsupported');
  await t('serviceWorkerApi', () => typeof navigator.serviceWorker);
  await t('rtcPeerConnection', () => typeof RTCPeerConnection);
  await t('sharedWorker', () => typeof SharedWorker);
  await t('scramjetClientGlobal', () => { const c = window[Symbol.for('scramjet client global')]; if (!c) return 'absent'; let dump = null; try { dump = c.context.cookieJar.dump(); } catch (e) { return 'present, dump threw'; } return { present: true, jarSites: Object.keys(JSON.parse(dump)).map((k) => k.split('@')[0]).filter((v, i, a) => a.indexOf(v) === i) }; });
  await t('uvCookieStore', () => new Promise((resolve) => { let r; try { r = indexedDB.open('__op'); } catch (e) { return resolve('open threw ' + e.name); } r.onerror = () => resolve('open error'); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('cookies')) { db.close(); return resolve('no cookies store'); } const q = db.transaction('cookies').objectStore('cookies').getAll(); q.onsuccess = () => { db.close(); resolve(q.result.map((c) => c.domain + ':' + c.name + (c.httpOnly ? '(httpOnly)' : ''))); }; q.onerror = () => resolve('getAll error'); }; }));
  await t('engineBus', () => new Promise((resolve) => { const seen = []; let bc; try { bc = new BroadcastChannel('gnome-engine'); } catch (e) { return resolve('threw ' + e.name); } bc.onmessage = (e) => seen.push(e.data && typeof e.data === 'object' ? Object.keys(e.data).slice(0, 6).join(',') : typeof e.data); setTimeout(() => { bc.close(); resolve({ joined: true, received: seen.length, sample: seen.slice(0, 5) }); }, 1500); }));
  await t('proxiedGetSecret', async () => { const r = await fetch(APP + '/api/secret', { credentials: 'include' }); return r.status + ' ' + (await r.text()).slice(0, 80); });
  await t('proxiedPostState', async () => { const r = await fetch(APP + '/api/state', { method: 'POST', credentials: 'include', headers: { 'X-GNOME-Request': '1', 'content-type': 'application/json' }, body: '{}' }); return r.status + ' ' + (await r.text()).slice(0, 80); });
  document.getElementById('out').textContent = JSON.stringify(out);
  document.title = 'iso probe done';
  if (new URLSearchParams(location.search).has('topnav')) setTimeout(() => { try { window.top.location.href = APP + '/?escaped-top-virtualized'; } catch (e) { document.title = 'topnav threw ' + e.name; } }, 50);
})();`;

function isoProbe() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>iso probe</title></head><body>
<h1>Isolation probe</h1><p id="mark">attacker page</p><button id="go">go</button>
<pre id="out">pending</pre><script>${PROBE_JS}</script></body></html>`;
}

function isoVictim() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>iso victim</title></head><body>
<h1>Victim site</h1><p id="secret">victim-dom-secret</p><input id="pw" type="password" value="hunter2-victim">
<script>try { localStorage.setItem('victim-ls', 'victim-localstorage-secret'); document.cookie = 'victim_js=victim-js-cookie; path=/'; } catch (e) {} document.title = 'victim ready';</script>
</body></html>`;
}

// Engine features a GNOME-imposed CSP on proxied documents must not break. Every check has its own timeout and
// the results are written to #out after each check ({..., done: true} at the end).
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGNkYPjPQApgIkn1qIZRDcMHAEn/AR/Ll1RuAAAAAElFTkSuQmCC';
function cspProbe() {
  const SITE = `http://127.0.0.1:${PORTS.target}`;
  const OTHER = `http://localhost:${PORTS.target}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>csp probe</title>
<style>#styled2 { color: rgb(4, 5, 6); } #bgserved { width: 8px; height: 8px; background-image: url(/leak/png?served); }</style>
<script>window.__inlineRan = true;</script>
<script type="module">import { v } from '/leak/mod.js'; window.__staticModule = v;</script>
</head><body><pre id="out">pending</pre>
<p id="styled" style="color: rgb(1, 2, 3)">styled</p><p id="styled2">styled2</p><div id="bgserved"></div>
<img id="imgsame" src="/leak/png?img" width="8" height="8" alt=""><img id="imgcross" src="${OTHER}/leak/png?cross" width="8" height="8" alt="">
<iframe id="fsame" src="/leak/frame?same" width="40" height="20"></iframe><iframe id="fcross" src="${OTHER}/leak/frame?cross" width="40" height="20"></iframe>
<script>
(async () => {
  const out = {};
  const write = () => { document.getElementById('out').textContent = JSON.stringify(out); };
  const t = async (k, f, ms = 6000) => {
    try { out[k] = await Promise.race([Promise.resolve().then(f), new Promise((r) => setTimeout(() => r('FAIL timeout'), ms))]); }
    catch (e) { out[k] = 'FAIL ' + (e && e.name) + ': ' + String(e && e.message).slice(0, 100); }
    write();
  };
  const loaded = (img) => new Promise((res) => { if (img.complete) return res(img.naturalWidth > 0 ? 'ok' : 'FAIL not loaded'); img.onload = () => res('ok'); img.onerror = () => res('FAIL error'); });
  await t('inlineScript', () => window.__inlineRan === true ? 'ok' : 'FAIL not run');
  await t('eval', () => eval('1+1') === 2 ? 'ok' : 'FAIL');
  await t('newFunction', () => new Function('return 3')() === 3 ? 'ok' : 'FAIL');
  await t('setTimeoutString', () => new Promise((res) => { window.__sts = () => res('ok'); setTimeout('window.__sts()', 0); }));
  await t('wasm', async () => (await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))) ? 'ok' : 'FAIL');
  await t('staticModule', async () => { for (let i = 0; i < 40 && window.__staticModule === undefined; i++) await new Promise((r) => setTimeout(r, 100)); return window.__staticModule === 42 ? 'ok' : 'FAIL ' + window.__staticModule; });
  await t('dynamicImport', async () => (await import('/leak/mod.js')).v === 42 ? 'ok' : 'FAIL');
  await t('fetchSameSite', async () => (await fetch('/echo-headers')).ok ? 'ok' : 'FAIL');
  await t('fetchCrossSite', async () => { const r = await fetch('${OTHER}/leak/cors'); return r.ok && (await r.text()) === 'cors-ok' ? 'ok' : 'FAIL ' + r.status; });
  await t('xhr', () => new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', '/echo-headers'); x.onload = () => res(x.status === 200 ? 'ok' : 'FAIL ' + x.status); x.onerror = () => res('FAIL error'); x.send(); }));
  await t('websocket', () => new Promise((res) => { const ws = new WebSocket('ws://127.0.0.1:${PORTS.target}/ws'); ws.onopen = () => ws.send('csp'); ws.onmessage = (e) => { res(e.data === 'csp' ? 'ok' : 'FAIL ' + e.data); ws.close(); }; ws.onerror = () => res('FAIL error'); }), 8000);
  await t('beacon', () => navigator.sendBeacon('/leak/beacon', 'x') ? 'ok' : 'FAIL false');
  await t('imgSameSite', () => loaded(document.getElementById('imgsame')));
  await t('imgCrossSite', () => loaded(document.getElementById('imgcross')));
  await t('imgDynamic', () => new Promise((res) => { const i = new Image(); i.onload = () => res('ok'); i.onerror = () => res('FAIL'); i.src = '${OTHER}/leak/png?dyn'; }));
  await t('dataImage', () => new Promise((res) => { const i = new Image(); i.onload = () => res('ok'); i.onerror = () => res('FAIL'); i.src = 'data:image/png;base64,${PNG_B64}'; }));
  await t('blobImage', () => new Promise((res) => { const i = new Image(); i.onload = () => res('ok'); i.onerror = () => res('FAIL'); i.src = URL.createObjectURL(new Blob([Uint8Array.from(atob('${PNG_B64}'), (c) => c.charCodeAt(0))], { type: 'image/png' })); }));
  await t('cssBackgroundServed', () => { const bg = getComputedStyle(document.getElementById('bgserved')).backgroundImage; return bg.startsWith('url(') ? 'ok' : 'FAIL ' + bg.slice(0, 60); });
  await t('inlineStyleAttr', () => getComputedStyle(document.getElementById('styled')).color === 'rgb(1, 2, 3)' ? 'ok' : 'FAIL');
  await t('styleElement', () => getComputedStyle(document.getElementById('styled2')).color === 'rgb(4, 5, 6)' ? 'ok' : 'FAIL');
  await t('iframeSameSite', () => new Promise((res) => { const f = document.getElementById('fsame'); const ok = () => { try { return f.contentDocument && f.contentDocument.getElementById('fr') ? 'ok' : null; } catch (e) { return 'FAIL ' + e.name; } }; const tick = () => { const r = ok(); if (r) res(r); else setTimeout(tick, 100); }; tick(); }));
  await t('iframeCrossSite', () => new Promise((res) => { const f = document.getElementById('fcross'); const tick = () => { try { if (f.contentWindow && f.contentWindow.length >= 0 && f.contentDocument && f.contentDocument.getElementById('fr')) return res('ok (readable: same proxy origin)'); } catch (e) { return res('ok (cross-origin)'); } setTimeout(tick, 100); }; tick(); }));
  await t('srcdocIframe', () => new Promise((res) => { const f = document.createElement('iframe'); f.srcdoc = '<p id=x>srcdoc</p>'; f.onload = () => { try { res(f.contentDocument.getElementById('x') ? 'ok' : 'FAIL'); } catch (e) { res('FAIL ' + e.name); } }; document.body.appendChild(f); }));
  await t('blobWorker', () => new Promise((res) => { const w = new Worker(URL.createObjectURL(new Blob(['postMessage(42)'], { type: 'text/javascript' }))); w.onmessage = (e) => res(e.data === 42 ? 'ok' : 'FAIL'); w.onerror = () => res('FAIL worker error'); }));
  await t('urlWorker', () => new Promise((res) => { const w = new Worker('/leak/worker.js'); w.onmessage = (e) => res(e.data === 'pong' ? 'ok' : 'FAIL ' + e.data); w.onerror = () => res('FAIL worker error'); w.postMessage('ping'); }));
  await t('postMessageFrame', () => new Promise((res) => { const f = document.createElement('iframe'); f.srcdoc = '<script>parent.postMessage("pm-ok", "*")<\\/script>'; const on = (e) => { if (e.data === 'pm-ok') { removeEventListener('message', on); res('ok'); } }; addEventListener('message', on); document.body.appendChild(f); }));
  await t('localStorage', () => { localStorage.setItem('csp-probe', '1'); return localStorage.getItem('csp-probe') === '1' ? 'ok' : 'FAIL'; });
  await t('indexedDB', () => new Promise((res) => { const r = indexedDB.open('csp-probe', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => { r.result.close(); res('ok'); }; r.onerror = () => res('FAIL'); }));
  await t('cookie', () => { document.cookie = 'cspprobe=1; path=/'; return /cspprobe=1/.test(document.cookie) ? 'ok' : 'FAIL'; });
  await t('pushState', () => { history.pushState({}, '', '?pushed=1'); return /pushed=1/.test(location.search) ? 'ok' : 'FAIL'; });
  out.done = true;
  write();
  document.title = 'csp probe done';
})();
</script></body></html>`;
}

// leak suite part "cspbus": an ordinary proxied page (its own script, no escape) tries to switch the SW's UV CSP off
// through the gnome-engine BroadcastChannel, which any proxied page can join (session-3 sw.js took its config there).
function busPoison() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>bus poison</title></head><body><p>bus poison</p>
<script>
const bc = new BroadcastChannel('gnome-engine');
const msg = { type: 'sw-config', config: { csp: 'off', cspPolicy: '' } };
bc.postMessage(msg);
const iv = setInterval(() => bc.postMessage(msg), 100);
setTimeout(() => { clearInterval(iv); document.title = 'bus poison done'; }, 3000);
</script></body></html>`;
}

// Returns true when the request was handled.
export function handleIsolationLeak(url, req, res) {
  const p = url.pathname;
  if (p === '/leak/matrix') { html(res, leakMatrix()); return true; }
  if (p === '/leak/csp-probe') { html(res, cspProbe()); return true; }
  if (p === '/leak/frame') { html(res, '<!doctype html><title>frame</title><p id="fr">frame</p>'); return true; }
  if (p === '/leak/mod.js') { send(res, 200, 'export const v = 42;', { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); return true; }
  if (p === '/leak/worker.js') { send(res, 200, "onmessage = (e) => postMessage(e.data === 'ping' ? 'pong' : 'bad');", { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); return true; }
  if (p === '/leak/png') { send(res, 200, Buffer.from(PNG_B64, 'base64'), { 'content-type': 'image/png', 'cache-control': 'no-store' }); return true; }
  if (p === '/leak/cors') { send(res, 200, 'cors-ok', { 'content-type': 'text/plain', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }); return true; }
  if (p === '/leak/beacon') { send(res, 204, '', {}); return true; }
  if (p === '/leak/bus-poison') { html(res, busPoison()); return true; }
  if (p === '/iso/probe') { html(res, isoProbe()); return true; }
  if (p === '/iso/victim') {
    html(res, isoVictim(), { 'set-cookie': ['victim_http=victim-httponly-cookie; Path=/; HttpOnly', 'victim_srv=victim-server-cookie; Path=/'] });
    return true;
  }
  if (p.startsWith('/leak-rel/')) { send(res, 204, '', { 'cache-control': 'no-store' }); return true; }
  return false;
}

export const ISO = { probePath: '/iso/probe', victimPath: '/iso/victim', PORTS, PROXY_ORIGIN };
