// The VPN exit check service fixture (docs/WAVE-C.md §9.1): GET /json answers like a check service
// ({"ip": "192.0.2.10", "country": "Sweden", "city": "E2E", "mullvad_exit_ip": false}: a documentation address; the
// field name is the one am.i.mullvad.net uses, to test the generic provider_exit wording). Requests whose User-Agent
// is gnome-server's check (`exit-check/1`) are counted apart from the browser's. POST /control {"browserIp"?: string,
// "stopped"?: boolean} sets another ip for browser requests (mismatch rows) or makes /json stop answering (the
// connection is held open and dropped). GET /stats → {server, browser, lastServerAt}. Reached by HolyWisp only through the
// `e2e-vpn` instance's TEST-ONLY allow-loopback overlay (the direct instance refuses loopback, as in production).
//
//   node tests/e2e/engine/servers/vpn-check.mjs   # E2E_VPN_CHECK_PORT, default E2E_PORT_BASE + 60
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ANSWER = { ip: '192.0.2.10', country: 'Sweden', city: 'E2E', mullvad_exit_ip: false };

export function startVpnCheck(port, host = '127.0.0.1') {
  const stats = { server: 0, browser: 0, lastServerAt: 0 };
  const control = { browserIp: null, stopped: false };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/control') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        try {
          Object.assign(control, JSON.parse(body || '{}'));
        } catch {
          /* ignored */
        }
        res.writeHead(204).end();
      });
      return;
    }
    if (url.pathname === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stats));
      return;
    }
    if (url.pathname === '/json') {
      const fromServer = /exit-check\/1/.test(req.headers['user-agent'] ?? '');
      if (fromServer) {
        stats.server++;
        stats.lastServerAt = Date.now();
      }
      else stats.browser++;
      if (control.stopped) {
        req.socket.destroy();
        return;
      }
      const answer = { ...ANSWER, ...(fromServer || !control.browserIp ? {} : { ip: control.browserIp }) };
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }).end(JSON.stringify(answer));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () =>
      resolve({
        port,
        url: `http://${host}:${port}/json`,
        service: `${host}:${port}`,
        stats: () => ({ ...stats }),
        set: (c) => Object.assign(control, c),
        reset: () => Object.assign(control, { browserIp: null, stopped: false }),
        close: () => new Promise((r) => {
          server.close(() => r());
          server.closeAllConnections();
        }),
      }),
    );
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = Number(process.env.E2E_PORT_BASE || 22000);
  const port = Number(process.env.E2E_VPN_CHECK_PORT || base + 60);
  const s = await startVpnCheck(port);
  console.log(`vpn-check on ${s.url}`);
}
