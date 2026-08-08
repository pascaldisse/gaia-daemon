#!/usr/bin/env bun
// edge-proxy.mjs — token-authenticated reverse proxy in front of the
// loopback GAIA daemon (127.0.0.1:8787). Node stdlib only, no npm deps.
//
// Listens on 127.0.0.1:8789. Never binds 0.0.0.0 — the outward path is an
// outbound Cloudflare tunnel dialed at scripts/edge-proxy.mjs's downstream,
// not a port-forward.
//
// Auth model:
//   - Token lives in ~/.gaia/edge-token (chmod 600), generated on first run.
//   - GET /auth?token=<t>  -> constant-time compare; match sets an HttpOnly
//     cookie and redirects to /; mismatch returns bare 403.
//   - Every other request requires the cookie OR an `Authorization: Bearer
//     <token>` header; otherwise bare 403.
//   - SSE (/api/events) is streamed through untouched, flushed per chunk.
//   - WebSocket upgrades are validated against the same cookie/header check
//     before the raw duplex socket is piped to the daemon.

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = 8789;
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 8787;

const TOKEN_DIR = path.join(os.homedir(), '.gaia');
const TOKEN_PATH = path.join(TOKEN_DIR, 'edge-token');
const COOKIE_NAME = 'gaia_edge';

function loadOrCreateToken() {
  try {
    const existing = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // fall through to generate
  }
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_PATH, token + '\n', { mode: 0o600 });
  fs.chmodSync(TOKEN_PATH, 0o600);
  return token;
}

const TOKEN = loadOrCreateToken();
const TOKEN_BUF = Buffer.from(TOKEN, 'utf8');

function constantTimeEquals(candidate) {
  // Compare against the token at a fixed buffer length so a length
  // mismatch alone doesn't short-circuit before the timing-safe compare.
  const padded = Buffer.alloc(TOKEN_BUF.length);
  const candidateBuf = Buffer.from(candidate ?? '', 'utf8');
  candidateBuf.copy(padded, 0, 0, Math.min(candidateBuf.length, padded.length));
  const lengthOk = candidateBuf.length === TOKEN_BUF.length;
  const bytesOk = crypto.timingSafeEqual(padded, TOKEN_BUF);
  return lengthOk && bytesOk;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function isAuthorized(req) {
  const cookies = parseCookies(req.headers['cookie']);
  if (cookies[COOKIE_NAME] && constantTimeEquals(cookies[COOKIE_NAME])) {
    return true;
  }
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    const bearer = auth.slice('Bearer '.length).trim();
    if (constantTimeEquals(bearer)) return true;
  }
  return false;
}

function send403(res) {
  res.writeHead(403, { 'Content-Length': '0' });
  res.end();
}

// Per-request access log: timestamp, method, path, response status. Never
// logs the token — only the pathname (query strings are redacted).
function logRequest(req, pathname, statusCode) {
  const ts = new Date().toISOString();
  console.log(`[edge-proxy] ${ts} ${req.method} ${pathname} -> ${statusCode}`);
}

function handleAuthRoute(req, res, url) {
  const token = url.searchParams.get('token');
  if (token && constantTimeEquals(token)) {
    const cookie = [
      `${COOKIE_NAME}=${TOKEN}`,
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=31536000',
    ].join('; ');
    res.writeHead(302, {
      'Set-Cookie': cookie,
      Location: '/',
      'Content-Length': '0',
    });
    res.end();
    return;
  }
  send403(res);
}

function writeWsFrame(socket, opcode, payload = Buffer.alloc(0)) {
  if (socket.destroyed) return;
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  socket.write(Buffer.concat([header, body]));
}

function parseSseField(line) {
  const idx = line.indexOf(':');
  if (idx === -1) return [line, ''];
  const field = line.slice(0, idx);
  const value = line.slice(idx + 1).startsWith(' ')
    ? line.slice(idx + 2)
    : line.slice(idx + 1);
  return [field, value];
}

function handleEventsWebSocketUpgrade(req, socket) {
  if (!isAuthorized(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key || Array.isArray(key)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));

  let closed = false;
  let clientBuffer = Buffer.alloc(0);
  let sseBuffer = '';
  let eventName = '';
  /** @type {string[]} */
  let dataLines = [];
  /** @type {http.ClientRequest | undefined} */
  let sseReq;

  const closeBoth = (sendClose = false) => {
    if (closed) return;
    closed = true;
    clearInterval(pingTimer);
    if (sendClose && !socket.destroyed) writeWsFrame(socket, 0x8);
    if (sseReq) sseReq.destroy();
    if (!socket.destroyed) socket.end();
  };

  const dispatchSse = () => {
    if (dataLines.length === 0) {
      eventName = '';
      return;
    }
    writeWsFrame(socket, 0x1, JSON.stringify({
      event: eventName || 'message',
      data: dataLines.join('\n'),
    }));
    eventName = '';
    dataLines = [];
  };

  const processSseLine = (rawLine) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      dispatchSse();
      return;
    }
    if (line.startsWith(':')) return;
    const [field, value] = parseSseField(line);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  };

  const processClientFrames = () => {
    while (clientBuffer.length >= 2) {
      const first = clientBuffer[0];
      const second = clientBuffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (clientBuffer.length < offset + 2) return;
        length = clientBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (clientBuffer.length < offset + 8) return;
        const bigLength = clientBuffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          closeBoth(true);
          return;
        }
        length = Number(bigLength);
        offset += 8;
      }
      if (masked) {
        if (clientBuffer.length < offset + 4) return;
      }
      const maskOffset = offset;
      offset += masked ? 4 : 0;
      if (clientBuffer.length < offset + length) return;
      const mask = masked ? clientBuffer.subarray(maskOffset, maskOffset + 4) : undefined;
      const payload = Buffer.from(clientBuffer.subarray(offset, offset + length));
      clientBuffer = clientBuffer.subarray(offset + length);
      if (mask) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      if (opcode === 0x8) {
        writeWsFrame(socket, 0x8, payload);
        closeBoth(false);
        return;
      }
      if (opcode === 0x9) writeWsFrame(socket, 0xA, payload);
    }
  };

  const pingTimer = setInterval(() => writeWsFrame(socket, 0x9), 20_000);

  sseReq = http.get(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: req.url,
      headers: { Accept: 'text/event-stream' },
    },
    (sseRes) => {
      sseRes.setEncoding('utf8');
      sseRes.on('data', (chunk) => {
        sseBuffer += chunk;
        for (;;) {
          const idx = sseBuffer.indexOf('\n');
          if (idx === -1) break;
          const line = sseBuffer.slice(0, idx);
          sseBuffer = sseBuffer.slice(idx + 1);
          processSseLine(line);
        }
      });
      sseRes.on('close', () => closeBoth(true));
      sseRes.on('error', () => closeBoth(true));
    },
  );

  sseReq.on('error', () => closeBoth(true));
  socket.on('data', (chunk) => {
    clientBuffer = Buffer.concat([clientBuffer, chunk]);
    processClientFrames();
  });
  socket.on('close', () => closeBoth(false));
  socket.on('error', () => closeBoth(false));
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    res.writeHead(400, { 'Content-Length': '0' });
    res.end();
    return;
  }

  res.on('finish', () => logRequest(req, url.pathname, res.statusCode));

  if (url.pathname === '/auth') {
    handleAuthRoute(req, res, url);
    return;
  }

  if (!isAuthorized(req)) {
    send403(res);
    return;
  }

  const isSSE = url.pathname.startsWith('/api/events');

  const upstreamReq = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      if (isSSE || upstreamRes.headers['content-type']?.includes('text/event-stream')) {
        // Stream chunk-by-chunk, no buffering, flush immediately.
        upstreamRes.on('data', (chunk) => {
          res.write(chunk);
          if (typeof res.flush === 'function') res.flush();
        });
        upstreamRes.on('end', () => res.end());
        upstreamRes.on('error', () => res.end());
      } else {
        upstreamRes.pipe(res);
      }
    },
  );

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Length': '0' });
    }
    res.end();
    console.error('[edge-proxy] upstream error:', err.message);
  });

  req.pipe(upstreamReq);
});

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  if (url.pathname.startsWith('/api/events')) {
    handleEventsWebSocketUpgrade(req, socket);
    return;
  }

  if (!isAuthorized(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }

  const upstreamSocket = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    const headerLines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      const value = key.toLowerCase() === 'host'
        ? `${UPSTREAM_HOST}:${UPSTREAM_PORT}`
        : req.rawHeaders[i + 1];
      headerLines.push(`${key}: ${value}`);
    }
    headerLines.push('', '');
    upstreamSocket.write(headerLines.join('\r\n'));
    if (head && head.length) upstreamSocket.write(head);

    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });

  upstreamSocket.on('error', (err) => {
    console.error('[edge-proxy] upstream ws error:', err.message);
    socket.destroy();
  });
  socket.on('error', () => {
    upstreamSocket.destroy();
  });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[edge-proxy] listening on http://${LISTEN_HOST}:${LISTEN_PORT} -> http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  console.log(`[edge-proxy] token file: ${TOKEN_PATH}`);
});
