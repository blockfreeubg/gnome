// Local "remote website" for deterministic checks (cookies, redirects, POST bodies, WebSockets, downloads,
// isolation probes, nested frames, keyboard/fullscreen/find, leak lab). It listens on 127.0.0.1:22090 and is
// reachable from the browsers ONLY through Wisp: the sentinel proxy blocks direct non-loopback egress, and
// only the TEST-ONLY HolyWisp (allow-loopback) may connect to it. Two "sites" are served: 127.0.0.1:22090 and
// localhost:22090 (cross-site to each other once proxied).
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { PORTS, HOST, APP_ORIGIN, PROXY_ORIGIN } from '../lib/config.mjs';
import { send, sendJson, readBody, parseCookies, report, listen } from './common.mjs';
import { handleIsolationLeak } from './isolation-leak-pages.mjs'; // /iso/* and /leak/* (isolation + leak suites)

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const page = (title, body, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${head}</head><body>${body}</body></html>`;
const html = (res, status, body, headers = {}) => send(res, status, body, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 16x16 PNG favicon (solid moss green)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGNkYPjPQApgIkn1qIZRDcMHAEn/AR/Ll1RuAAAAAElFTkSuQmCC', 'base64');

// The isolation probe page (runs inside a proxied document; results land in #out as JSON).
const ATTACK_JS = `
(async () => {
  const out = {};
  const t = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = 'threw ' + (e && e.name) + ': ' + String(e && e.message).slice(0, 120); } };
  const APP = ${JSON.stringify(APP_ORIGIN)};
  await t('locationHref', () => location.href);
  await t('selfIsTop', () => window === window.top);
  await t('parentIsSelf', () => window.parent === window);
  await t('frameElement', () => String(window.frameElement));
  await t('documentCookie', () => document.cookie);
  await t('localStorageKeys', () => Object.keys(localStorage));
  // Scramjet internals reachable from page JS (research: scramjet.md §10.2)
  await t('scramjetClientGlobal', () => { const c = window[Symbol.for('scramjet client global')]; if (!c) return 'absent'; let dump = null; try { dump = c.context && c.context.cookieJar && c.context.cookieJar.dump(); } catch (e) { dump = 'dump threw'; } return { present: true, jarHasHttpOnly: typeof dump === 'string' && dump.includes('srvhttp'), jarSites: typeof dump === 'string' ? Object.keys(JSON.parse(dump)).map((k) => k.split('@')[0]).filter((v, i, a) => a.indexOf(v) === i) : dump }; });
  // UV cookie store is exempt from UV's IndexedDB renaming (research: ultraviolet.md security notes)
  await t('uvCookieStore', () => new Promise((resolve) => { let r; try { r = indexedDB.open('__op'); } catch (e) { return resolve('open threw ' + e.name); } r.onerror = () => resolve('open error'); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('cookies')) { db.close(); return resolve('no cookies store'); } const q = db.transaction('cookies').objectStore('cookies').getAll(); q.onsuccess = () => { db.close(); resolve(q.result.map((c) => c.domain + ':' + c.name + (c.httpOnly ? '(httpOnly)' : ''))); }; q.onerror = () => resolve('getAll error'); }; }));
  // A proxied request to the app origin goes through Wisp (HolyWisp decides), never with the user's cookies
  await t('proxiedFetchApp', async () => { const r = await fetch(APP + '/api/secret', { credentials: 'include' }); return r.status + ' ' + (await r.text()).slice(0, 60); });
  document.getElementById('out').textContent = JSON.stringify(out);
  document.title = 'attack done';
  // Last: try to navigate the real top window (the app). Done after the results are written because a
  // virtualized "top" navigates this frame instead.
  if (new URLSearchParams(location.search).has('topnav')) setTimeout(() => { try { window.top.location.href = 'http://127.0.0.1:${PORTS.target}/escaped-top'; } catch (e) { document.title = 'topnav threw ' + e.name; } }, 100);
})();`;

function nestedPage() {
  const child = (src, name) => `<iframe name="${name}" src="${src}" width="420" height="200" allowfullscreen></iframe>`;
  return page('Nested frames', `<h1 id="top">Top document</h1><p>needle in the top document</p>
<input id="topInput" placeholder="type here">
${child('/nested-child?who=same-site', 'child-same')}
${child(`http://localhost:${PORTS.target}/nested-child?who=cross-site`, 'child-cross')}`);
}

function nestedChild(who) {
  return page(`Child ${who}`, `<p id="who">${esc(who)}</p><p>a needle in the ${esc(who)} child, and another needle</p>
<input id="childInput" placeholder="child input">
<button id="fs" onclick="document.documentElement.requestFullscreen().then(()=>document.title='fs:on',e=>document.title='fs:error:'+e.name)">Fullscreen</button>
<a id="childLink" href="/nested-child?who=${encodeURIComponent(who)}-linked">a link</a>`);
}

// Leak lab: every construct points at its own unroutable host so the sentinel shows which ones escaped.
function leakLab() {
  const u = (c) => `https://leak-${c}.gnome-spike.invalid/${c}.png`;
  return page('Leak lab', `
<style>#css-static { background-image: url(${u('css-static')}); }</style>
<div id="css-static">static style element</div>
<div id="css-attr" style="background-image: url(${u('css-attr')})">style attribute</div>
<div id="css-js-text">style element filled with a Text node by JS</div>
<div id="css-js-textcontent">style element filled via textContent</div>
<div id="css-insertrule">CSSOM insertRule</div>
<div id="css-setproperty">element.style.setProperty</div>
<div id="css-cssText">element.style.cssText</div>
<div id="css-custom-prop">CSS custom property</div>
<div id="css-mask">mask-image via JS text node</div>
<div id="css-image-set">image-set()</div>
<div id="css-import">@import via JS text node</div>
<div id="css-replacesync">constructed stylesheet replaceSync</div>
<img id="img-srcset" srcset="${u('img-srcset')} 1x">
<script>
const u = ${u.toString()};
const st = (id, css, how) => { const s = document.createElement('style'); if (how === 'text') s.appendChild(document.createTextNode(css)); else s.textContent = css; document.head.appendChild(s); };
st(0, '#css-js-text { background-image: url(' + u('css-js-text') + '); }', 'text');
st(0, '#css-js-textcontent { background-image: url(' + u('css-js-textcontent') + '); }', 'textContent');
const ss = document.createElement('style'); document.head.appendChild(ss); ss.sheet.insertRule('#css-insertrule { background-image: url(' + u('css-insertrule') + '); }');
document.getElementById('css-setproperty').style.setProperty('background-image', 'url(' + u('css-setproperty') + ')');
document.getElementById('css-cssText').style.cssText = 'background-image: url(' + u('css-cssText') + ')';
st(0, ':root { --gnome-icon: url(' + u('css-custom-prop') + '); } #css-custom-prop { background-image: var(--gnome-icon); }', 'text');
st(0, '#css-mask { width: 20px; height: 20px; background: red; -webkit-mask-image: url(' + u('css-mask') + '); mask-image: url(' + u('css-mask') + '); }', 'text');
st(0, '#css-image-set { background-image: image-set(url(' + u('css-image-set') + ') 1x); }', 'text');
st(0, '@import url(' + u('css-import').replace('.png', '.css') + ');', 'text');
try { const sheet = new CSSStyleSheet(); sheet.replaceSync('#css-replacesync { background-image: url(' + u('css-replacesync') + '); }'); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; } catch (e) {}
setTimeout(() => { document.title = 'leak lab done'; }, 1500);
</script>`);
}

// CSP probe: the engine-relevant features a GNOME-imposed CSP must not break.
const CSP_PROBE_JS = `
(async () => {
  const out = {};
  const t = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = 'FAIL ' + (e && e.name) + ': ' + String(e && e.message).slice(0, 100); } };
  await t('inlineScript', () => window.__inlineRan === true ? 'ok' : 'FAIL not run');
  await t('eval', () => eval('1+1') === 2 ? 'ok' : 'FAIL');
  await t('newFunction', () => new Function('return 3')() === 3 ? 'ok' : 'FAIL');
  await t('wasm', async () => { const m = await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])); return m ? 'ok' : 'FAIL'; });
  await t('blobWorker', () => new Promise((res) => { const w = new Worker(URL.createObjectURL(new Blob(['postMessage(42)'], { type: 'text/javascript' }))); w.onmessage = (e) => res(e.data === 42 ? 'ok' : 'FAIL'); w.onerror = (e) => res('FAIL worker error'); setTimeout(() => res('FAIL timeout'), 4000); }));
  await t('urlWorker', () => new Promise((res) => { const w = new Worker('/worker.js'); w.onmessage = (e) => res(e.data === 'pong' ? 'ok' : 'FAIL'); w.onerror = () => res('FAIL worker error'); w.postMessage('ping'); setTimeout(() => res('FAIL timeout'), 4000); }));
  await t('fetchSameSite', async () => (await fetch('/echo-headers')).ok ? 'ok' : 'FAIL');
  await t('xhr', () => new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', '/echo-headers'); x.onload = () => res(x.status === 200 ? 'ok' : 'FAIL ' + x.status); x.onerror = () => res('FAIL error'); x.send(); }));
  await t('websocket', () => new Promise((res) => { const ws = new WebSocket('ws://127.0.0.1:${PORTS.target}/ws'); ws.onopen = () => ws.send('csp'); ws.onmessage = (e) => { res(e.data === 'csp' ? 'ok' : 'FAIL ' + e.data); ws.close(); }; ws.onerror = () => res('FAIL error'); setTimeout(() => res('FAIL timeout'), 6000); }));
  await t('dataImage', () => new Promise((res) => { const i = new Image(); i.onload = () => res('ok'); i.onerror = () => res('FAIL'); i.src = 'data:image/png;base64,${PNG.toString('base64')}'; }));
  await t('blobImage', () => new Promise((res) => { const i = new Image(); i.onload = () => res('ok'); i.onerror = () => res('FAIL'); i.src = URL.createObjectURL(new Blob([Uint8Array.from(atob('${PNG.toString('base64')}'), (c) => c.charCodeAt(0))], { type: 'image/png' })); }));
  await t('image', () => new Promise((res) => { const i = new Image(); i.onload = () => res('ok'); i.onerror = () => res('FAIL'); i.src = '/favicon.png?probe'; }));
  await t('inlineStyleAttr', () => getComputedStyle(document.getElementById('styled')).color === 'rgb(1, 2, 3)' ? 'ok' : 'FAIL ' + getComputedStyle(document.getElementById('styled')).color);
  await t('styleElement', () => getComputedStyle(document.getElementById('styled2')).color === 'rgb(4, 5, 6)' ? 'ok' : 'FAIL');
  await t('setTimeoutString', () => new Promise((res) => { window.__sts = () => res('ok'); setTimeout('window.__sts()', 0); setTimeout(() => res('FAIL not run'), 1500); }));
  await t('srcdocIframe', () => new Promise((res) => { const f = document.createElement('iframe'); f.srcdoc = '<p id=x>srcdoc</p>'; f.onload = () => { try { res(f.contentDocument.getElementById('x') ? 'ok' : 'FAIL'); } catch (e) { res('FAIL ' + e.name); } }; document.body.appendChild(f); setTimeout(() => res('FAIL timeout'), 3000); }));
  await t('formPost', () => 'skipped (navigation)');
  document.getElementById('out').textContent = JSON.stringify(out);
  document.title = 'csp probe done';
})();`;

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const p = url.pathname;
  const cookies = parseCookies(req.headers.cookie);
  report('target-request', {
    method: req.method,
    host: req.headers.host,
    path: p,
    cookieNames: Object.keys(cookies),
    acceptEncoding: req.headers['accept-encoding'] || null,
    secFetchDest: req.headers['sec-fetch-dest'] || null,
    referer: req.headers.referer ? String(req.headers.referer).slice(0, 120) : null,
  });
  switch (p) {
    case '/':
      return html(res, 200, page('GNOME spike target', '<h1>Target home</h1><p id="hello">hello from the target</p><a id="toForm" href="/form">form</a>', '<link rel="icon" href="/favicon.png">'));
    case '/favicon.png':
    case '/favicon.ico':
      return send(res, 200, PNG, { 'content-type': 'image/png', 'cache-control': 'max-age=60' });
    case '/echo-headers':
      return sendJson(res, 200, { headers: req.headers }, { 'cache-control': 'no-store' });
    case '/cookies/set': {
      const set = [...url.searchParams].map(([k, v]) => `${k}=${encodeURIComponent(v)}; Path=/`);
      set.push('srvhttp=1; Path=/; HttpOnly');
      return send(res, 302, '', { 'set-cookie': set, location: '/cookies' });
    }
    case '/cookies':
      return html(res, 200, page('cookies', `<pre id="out">${esc(JSON.stringify({ cookies }))}</pre>`));
    case '/form':
      return html(res, 200, page('form', `<form id="f" method="post" action="/post"><input name="greeting" value="hello gnome"><input type="hidden" name="n" value="42"><button id="submit">send</button></form>`));
    case '/form-fault': // fallback suite: a form POST whose Scramjet attempt fails (engine-host fault sj-throw-marker)
      return html(res, 200, page('form fault', `<form id="f" method="post" action="/post?gnome-fault=sj-throw"><input name="greeting" value="hello gnome"><button id="submit">send</button></form>`));
    case '/post': {
      const body = (await readBody(req)).toString('utf8');
      return html(res, 200, page('post result', `<pre id="out">${esc(JSON.stringify({ method: req.method, contentType: req.headers['content-type'] || null, length: Buffer.byteLength(body), body }))}</pre>`));
    }
    case '/ws-page': {
      const target = url.searchParams.get('url') || `ws://127.0.0.1:${PORTS.target}/ws`;
      return html(res, 200, page('ws page', `<pre id="out">pending</pre><script>
const out = document.getElementById('out');
const ws = new WebSocket(${JSON.stringify(target)});
const msg = 'gnome-ping-' + Math.random().toString(36).slice(2, 8);
let seen = [];
ws.onopen = () => ws.send(msg);
ws.onmessage = (e) => { seen.push(String(e.data).slice(0, 80)); if (String(e.data) === msg) { out.textContent = JSON.stringify({ ok: true, echoed: msg, seen }); document.title = 'ws:ok'; ws.close(); } };
ws.onerror = () => { out.textContent = JSON.stringify({ ok: false, error: 'error event', seen }); document.title = 'ws:error'; };
ws.onclose = (e) => { if (document.title !== 'ws:ok') { out.textContent = JSON.stringify({ ok: false, close: e.code, seen }); document.title = 'ws:closed'; } };
</script>`));
    }
    case '/download-page':
      return html(res, 200, page('download page', `<a id="dl" href="/download?size=${url.searchParams.get('size') || 2097152}&delay=${url.searchParams.get('delay') || 40}">download</a>`));
    case '/download': {
      const size = Math.min(Number(url.searchParams.get('size')) || 2 * 1024 * 1024, 64 << 20);
      const chunk = 65536;
      const delay = Math.min(Number(url.searchParams.get('delay')) || 40, 1000);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="gnome-spike.bin"',
        'content-length': size,
        'cache-control': 'no-store',
      });
      let sent = 0;
      while (sent < size && !res.destroyed) {
        const n = Math.min(chunk, size - sent);
        res.write(Buffer.alloc(n, 0x47));
        sent += n;
        await sleep(delay);
      }
      return res.end();
    }
    case '/attack':
      return html(res, 200, page('attack', `<pre id="out">pending</pre><script>${ATTACK_JS}</script>`));
    case '/nested':
      return html(res, 200, nestedPage());
    case '/nested-child':
      return html(res, 200, nestedChild(url.searchParams.get('who') || 'child'));
    case '/slow': {
      await sleep(Math.min(Number(url.searchParams.get('ms')) || 3000, 120000));
      return html(res, 200, page('slow done', '<p id="slow">slow page</p>'));
    }
    case '/hang':
      req.on('close', () => {});
      return; // never answers
    case '/title-change':
      return html(res, 200, page('Initial title', `<p>title changes</p><script>setTimeout(() => { document.title = 'Changed title'; }, 300);</script>`, '<link rel="icon" href="/favicon.png">'));
    case '/leak-lab':
      return html(res, 200, leakLab());
    case '/csp-probe':
      return html(res, 200, page('csp probe', `<pre id="out">pending</pre><p id="styled" style="color: rgb(1, 2, 3)">styled</p><p id="styled2">styled2</p><style>#styled2 { color: rgb(4, 5, 6); }</style>
<script>window.__inlineRan = true;</script><script>${CSP_PROBE_JS}</script>`));
    case '/worker.js':
      return send(res, 200, "onmessage = (e) => postMessage(e.data === 'ping' ? 'pong' : 'bad');", { 'content-type': 'text/javascript' });
    case '/popup':
      return html(res, 200, page('popup', `<a id="blank" href="/" target="_blank">new tab link</a><button id="open" onclick="window.open('/title-change')">window.open</button>`));
    case '/redirect-done':
      return html(res, 200, page('redirect done', `<pre id="out">${esc(JSON.stringify({ done: true, via: url.searchParams.get('via') }))}</pre>`));
    default: {
      const m = /^\/redirect\/(\d+)$/.exec(p);
      if (m) {
        const n = Number(m[1]);
        const status = [302, 301, 307, 303][n % 4];
        return send(res, status, '', { location: n > 1 ? `/redirect/${n - 1}` : `/redirect-done?via=chain`, 'cache-control': 'no-store' });
      }
      if (handleIsolationLeak(url, req, res)) return;
      return html(res, 404, page('not found', '<p>not found</p>'));
    }
  }
}

// Only WebSocket upgrades go to the upgrade handler: curl-based transports (libcurl-transport 1.5.2) send
// "Upgrade: h2c" on plain-http requests, which real servers ignore and answer as HTTP/1.1.
const server = http.createServer({ shouldUpgradeCallback: (req) => /\bwebsocket\b/i.test(req.headers.upgrade || '') }, (req, res) => {
  handle(req, res).catch((e) => { try { send(res, 500, String(e)); } catch { /* gone */ } });
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  report('target-upgrade', { path: p, origin: req.headers.origin || null, host: req.headers.host });
  if (p !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
  });
});

await listen(server, PORTS.target, HOST);
report('listening', { role: 'target', port: PORTS.target, app: APP_ORIGIN, proxy: PROXY_ORIGIN });
