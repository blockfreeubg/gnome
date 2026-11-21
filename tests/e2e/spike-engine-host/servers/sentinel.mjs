// Leak sentinel: the browsers are launched with this HTTP proxy for every non-loopback destination, so the
// only working route to the internet is Wisp (engine host -> /wisp/ gateway -> HolyWisp). Anything that
// reaches the sentinel is a request that bypassed the proxy engines (a leak) or browser background noise.
// It never forwards: plain requests get 403, CONNECT tunnels are refused.
import http from 'node:http';
import { PORTS, HOST } from '../lib/config.mjs';
import { report, listen } from './common.mjs';

const server = http.createServer((req, res) => {
  report('sentinel', { kind: 'http', method: req.method, url: String(req.url).slice(0, 400), ua: String(req.headers['user-agent'] || '').slice(0, 60) });
  res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
  res.end('GNOME e2e sentinel: direct egress blocked\n');
});
server.on('connect', (req, socket) => {
  report('sentinel', { kind: 'connect', target: String(req.url).slice(0, 300), ua: String(req.headers['user-agent'] || '').slice(0, 60) });
  socket.on('error', () => {});
  socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
});
server.on('upgrade', (req, socket) => {
  report('sentinel', { kind: 'upgrade', url: String(req.url).slice(0, 400) });
  socket.destroy();
});

await listen(server, PORTS.sentinel, HOST);
report('listening', { role: 'sentinel', port: PORTS.sentinel });
