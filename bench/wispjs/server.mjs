#!/usr/bin/env node
// Benchmark-only: the pinned @mercuryworkshop/wisp-js server (LGPL-3.0-or-later, version in package.json) on
// 127.0.0.1 only, with loopback targets allowed (the echo target is on loopback) and its limits off.
// `--workers N` runs it under node:cluster (wispjs4 meets HolyWisp's 4 workers on equal terms).
//   node bench/wispjs/server.mjs --port P [--workers N]
import cluster from 'node:cluster';
import http from 'node:http';
import { parseArgs } from 'node:util';
import { server as wisp, logging } from '@mercuryworkshop/wisp-js/server';

const { values: o } = parseArgs({ options: { port: { type: 'string' }, workers: { type: 'string', default: '1' } } });
const port = Number(o.port);
const workers = Number(o.workers);
if (!port) throw new Error('--port is required');

if (cluster.isPrimary && workers > 1) {
  for (let i = 0; i < workers; i++) cluster.fork();
  cluster.on('exit', () => process.exit(1));
  process.on('SIGTERM', () => {
    for (const w of Object.values(cluster.workers)) w.kill('SIGTERM');
    process.exit(0);
  });
} else {
  logging.set_level(logging.WARN);
  Object.assign(wisp.options, {
    allow_loopback_ips: true,
    allow_private_ips: false,
    allow_udp_streams: false,
    stream_limit_per_host: -1,
    stream_limit_total: -1,
    parse_real_ip: false,
  });
  const server = http.createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' }).end('websocket required\n');
  });
  server.on('upgrade', (req, socket, head) => wisp.routeRequest(req, socket, head));
  server.listen(port, '127.0.0.1', () => console.error(`wisp-js listening on 127.0.0.1:${port} (pid ${process.pid})`));
}
