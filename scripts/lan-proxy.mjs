#!/usr/bin/env node
// Non-destructive LAN bridge: forwards <bind>:<listen> → 127.0.0.1:<target>.
// Raw TCP (protocol-agnostic: HTTP, SSE, and WebSocket all pass through), so a
// phone on the LAN can reach a loopback-only GAIA daemon without restarting it.
//   node scripts/lan-proxy.mjs [listenPort=8788] [targetPort=8787] [bind=0.0.0.0]
import net from 'node:net';

const listenPort = Number(process.argv[2] || 8788);
const targetPort = Number(process.argv[3] || 8787);
const bind = process.argv[4] || '0.0.0.0';

const server = net.createServer((client) => {
  const upstream = net.connect(targetPort, '127.0.0.1');
  const bail = () => { client.destroy(); upstream.destroy(); };
  client.on('error', bail);
  upstream.on('error', bail);
  client.pipe(upstream);
  upstream.pipe(client);
});

server.on('error', (e) => { console.error(`[lan-proxy] ${e.message}`); process.exit(1); });
server.listen(listenPort, bind, () => {
  console.log(`[lan-proxy] ${bind}:${listenPort} -> 127.0.0.1:${targetPort}`);
});
