// Fixture site of the `sw` suite's realm parts (lane b): documents that an engine leaves unrewritten or whose
// document-start hook a text search would misplace. Reached by the browsers only through the VPN profile's HolyWisp
// (`route=profile:e2e-vpn`, the allow-loopback overlay), like the spike's target site. Every page that runs a script
// writes a JSON report into #out (or the SVG's #t): whether WebRTC is there (the kill switch), whether an engine
// virtualizes the realm, and whether the realm reaches the engine host by walking `parent` (an escape).
//
//   const fx = await startRealmFixtures(port); fx.origin; fx.hits(); await fx.close();
import http from 'node:http';

/** Walks window.parent up to the engine host (`__gnomeEngineHost`); `i !== 6` because XML documents forbid a bare `<`. */
const HOST_WALK =
  "(function(){try{var w=window;for(var i=0;i!==6;i++){if(w.__gnomeEngineHost)return 'host@'+i;w=w.parent;}return 'nohost'}catch(e){return 'err:'+e.name}})()";
const REPORT_JS = `JSON.stringify({ran:true,rtc:typeof RTCPeerConnection,uv:typeof __uv,sj:typeof self[Symbol.for('scramjet client global')],host:${HOST_WALK}})`;
const REPORT = `<pre id="out">pending</pre><script>document.getElementById('out').textContent=${REPORT_JS};</script>`;

const html = (title, body, head = '') => `<!doctype html><html><head>${head}<title>${title}</title></head><body>${body}</body></html>`;

/** text/html pages. */
const PAGES = {
  '/plain': html('plain', REPORT),
  // The three shapes that fooled the text search for `<head>` (the hook ended up in a comment or an attribute).
  '/c-head': `<!doctype html><!--<head>--><html><head><title>c-head</title></head><body>${REPORT}</body></html>`,
  '/a-head': `<!doctype html><html><head data-x=">"><title>a-head</title></head><body>${REPORT}</body></html>`,
  '/h-attr': `<!doctype html><html data-x="<head>"><head><title>h-attr</title></head><body>${REPORT}</body></html>`,
  '/frameset': `<!doctype html><html><head><title>frameset</title></head><frameset cols="50%,50%"><frame name="kid-a" src="/kid"><frame name="kid-b" src="/plain"></frameset></html>`,
  '/kid': html('kid', REPORT),
  // <object>/<embed> with HTML: the page builds the proxied URL itself where it can (Ultraviolet's __uv$config). Service
// workers never see plugin loads (destination object/embed), so these reach gnome-server's engine-prefix 503 page.
  '/object': html(
    'object',
    `<div id="slot"></div><script>(function(){var u='/kid';try{if(self.__uv$config)u=__uv$config.prefix+__uv$config.encodeUrl(location.origin+'/kid')}catch(e){}
var s=document.getElementById('slot');var o=document.createElement('object');o.type='text/html';o.data=u;o.width=200;o.height=100;o.name='obj';s.appendChild(o);
var m=document.createElement('embed');m.type='text/html';m.src=u.replace('/kid','/kid2');m.width=200;m.height=100;s.appendChild(m);})();</script>`,
  ),
  '/kid2': html('kid2', REPORT),
  // An ordinary page that talks to bare-mux's SharedWorker (Ultraviolet does not wrap SharedWorker): it reads the
  // shared transport's name, then tries to replace the transport with a `bare-mux-remote` port of its own and records
  // every request that reaches that port (the transport manager's lock must refuse the `set`).
  '/baremux': html(
    'baremux',
    `<pre id="out">pending</pre><script>(function(){var out=document.getElementById('out');var r={get:null,set:null,intercepted:[]};
function show(){out.textContent=JSON.stringify(r)}
try{var w=new SharedWorker('/vendor/bare-mux/worker.js','bare-mux-worker');
var g=new MessageChannel();g.port1.onmessage=function(e){r.get=e.data&&e.data.name||null;show()};
w.port.postMessage({message:{type:'get'},port:g.port2},[g.port2]);
var spy=new MessageChannel();spy.port1.onmessage=function(e){var m=e.data&&e.data.message;r.intercepted.push(m&&m.fetch?String(m.fetch.remote):'other');show()};
var s=new MessageChannel();s.port1.onmessage=function(e){r.set=e.data&&e.data.type==='error'?'refused: '+String(e.data.error).slice(0,80):String(e.data&&e.data.type);show()};
w.port.postMessage({message:{type:'set',client:{function:'bare-mux-remote',args:[spy.port2,'page']}},port:s.port2},[s.port2,spy.port2]);
setTimeout(function(){if(r.set===null){r.set='no reply';show()}},3000);
}catch(e){r.set='threw '+e.name;show()}})();</script>`,
  ),
  // A SharedWorker the page starts with an engine-proxied URL: Ultraviolet would serve its script unrewritten.
  '/sharedworker': html(
    'sharedworker',
    `<pre id="out">pending</pre><script>(function(){var out=document.getElementById('out');try{
var u=self.__uv$config?__uv$config.prefix+__uv$config.encodeUrl(location.origin+'/shared.js'):'/shared.js';
var w=new SharedWorker(u,'gnome-e2e');w.onerror=function(){out.textContent='worker error'};
w.port.onmessage=function(e){out.textContent='worker says '+e.data};w.port.start();
setTimeout(function(){if(out.textContent==='pending')out.textContent='no reply'},4000);
}catch(e){out.textContent='threw '+e.name}})();</script>`,
  ),
  // A SharedWorker the page starts with its own relative URL: Scramjet rewrites shared workers (worklist A9): inside,
  // `location` is the site's real URL and the worker's fetch goes through the engine (the fixture sees it).
  '/sharedworker-sj': html(
    'sharedworker-sj',
    `<pre id="out">pending</pre><script>(function(){var out=document.getElementById('out');try{
var w=new SharedWorker('/shared-sj.js','gnome-e2e-sj');w.onerror=function(){out.textContent='worker error'};
w.port.onmessage=function(e){out.textContent='worker says '+e.data};w.port.start();
setTimeout(function(){if(out.textContent==='pending')out.textContent='no reply'},6000);
}catch(e){out.textContent='threw '+e.name}})();</script>`,
  ),
};

/** Documents with another (or no) Content-Type; [content-type or null, body]. */
const TYPED = {
  '/none': [null, html('none', REPORT)],
  '/upper': ['Text/HTML', html('upper', REPORT)],
  '/svg': [
    'image/svg+xml',
    `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="400" height="40"><title>svg</title><text id="t" x="5" y="20">pending</text><script>document.getElementById('t').textContent=${REPORT_JS};</script></svg>`,
  ],
  '/xhtml': [
    'application/xhtml+xml',
    `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>xhtml</title></head><body><pre id="out">pending</pre><script>document.getElementById('out').textContent=${REPORT_JS};</script></body></html>`,
  ],
  // XML that browsers render (an XHTML script element inside), and a `+xml` type that they may download instead.
  '/xml': [
    'text/xml',
    `<?xml version="1.0"?><root><x:pre xmlns:x="http://www.w3.org/1999/xhtml" id="out">pending</x:pre><x:script xmlns:x="http://www.w3.org/1999/xhtml">document.getElementById('out').textContent=${REPORT_JS};</x:script></root>`,
  ],
  '/plusxml': [
    'application/x-gnome+xml',
    `<?xml version="1.0"?><root><x:pre xmlns:x="http://www.w3.org/1999/xhtml" id="out">pending</x:pre><x:script xmlns:x="http://www.w3.org/1999/xhtml">document.getElementById('out').textContent=${REPORT_JS};</x:script></root>`,
  ],
  '/shared.js': ['text/javascript', "onconnect=function(e){e.ports[0].postMessage('raw:'+typeof __uv+' idb:'+typeof indexedDB)};"],
  '/shared-sj.js': [
    'text/javascript',
    "onconnect=function(e){var p=e.ports[0];fetch('/shared-fetch').then(function(r){return r.text()}).then(function(t){p.postMessage('loc:'+location.href+' fetch:'+t)},function(err){p.postMessage('loc:'+location.href+' fetch failed '+err)})};",
  ],
  '/shared-fetch': ['text/plain', 'from-the-site'],
};

export async function startRealmFixtures(port, host = '127.0.0.1') {
  const hits = [];
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    hits.push(p);
    if (PAGES[p]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(PAGES[p]);
    }
    if (TYPED[p]) {
      const [type, body] = TYPED[p];
      const headers = { 'cache-control': 'no-store' };
      if (type) headers['content-type'] = type;
      res.writeHead(200, headers);
      return res.end(body);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    origin: `http://${host}:${port}`,
    hits: () => [...hits],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
