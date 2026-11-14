import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';

// A small WebSocket client (RFC 6455) for `cleanlist listen`. Node 20 has no
// global WebSocket, and the browser API can't send an Authorization header.
// Text frames, fragmentation, ping/pong and close; no extensions.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WsConnection {
  send(text: string): void;
  close(code?: number): void;
}

export interface WsHandlers {
  message(text: string): void;
  close(code: number, reason: string): void;
}

/** Open a WebSocket to an http(s) URL. Rejects on a refused upgrade with the HTTP status and body. */
export function connectWebSocket(url: URL, headers: Record<string, string>, on: WsHandlers): Promise<WsConnection> {
  const key = randomBytes(16).toString('base64');
  const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': key, 'sec-websocket-version': '13' },
  });
  return new Promise((resolve, reject) => {
    req.on('error', reject);
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode, body })));
    });
    req.on('upgrade', (res, socket: Socket, head: Buffer) => {
      const accept = createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== accept) {
        socket.destroy();
        return reject(new Error('The server did not accept the WebSocket handshake.'));
      }
      resolve(attach(socket, head, on));
    });
    req.end();
  });
}

/** A client frame: always masked. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const header = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (len < 126) header[1] = 0x80 | len;
  else if (len < 65536) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, body]);
}

/** Split complete frames off the front of `buf`. Returns the frames and what's left over. */
export function decodeFrames(buf: Buffer): { frames: { fin: boolean; opcode: number; payload: Buffer }[]; rest: Buffer } {
  const frames = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off];
    const b1 = buf[off + 1];
    let len = b1 & 0x7f;
    let pos = off + 2;
    if (len === 126) {
      if (buf.length < pos + 2) break;
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (buf.length < pos + 8) break;
      len = Number(buf.readBigUInt64BE(pos));
      pos += 8;
    }
    const masked = (b1 & 0x80) !== 0;
    const mask = masked ? buf.subarray(pos, pos + 4) : undefined;
    if (masked) pos += 4;
    if (buf.length < pos + len) break;
    const payload = Buffer.from(buf.subarray(pos, pos + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
    off = pos + len;
  }
  return { frames, rest: buf.subarray(off) };
}

function attach(socket: Socket, head: Buffer, on: WsHandlers): WsConnection {
  let buf: Buffer = Buffer.alloc(0);
  let parts: Buffer[] = [];
  let binary = false; // inside a binary message, which listen never gets: drop it
  let closed = false;
  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    // The server ends the TCP connection after the close handshake; don't wait on it.
    socket.end();
    socket.unref();
    on.close(code, reason);
  };
  const write = (opcode: number, payload: Buffer) => {
    if (!socket.destroyed) socket.write(encodeFrame(opcode, payload));
  };
  const onData = (chunk: Buffer) => {
    const { frames, rest } = decodeFrames(Buffer.concat([buf, chunk]));
    buf = rest;
    for (const f of frames) {
      if (f.opcode === 0x9) write(0xa, f.payload);
      else if (f.opcode === 0x8) {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
        write(0x8, f.payload.subarray(0, 2));
        finish(code, f.payload.subarray(2).toString('utf8'));
      } else if (f.opcode === 0x2 || (f.opcode === 0x0 && binary)) {
        binary = !f.fin;
      } else if (f.opcode === 0x1 || f.opcode === 0x0) {
        parts.push(f.payload);
        if (f.fin) {
          const text = Buffer.concat(parts).toString('utf8');
          parts = [];
          on.message(text);
        }
      }
    }
  };
  socket.on('data', onData);
  socket.on('close', () => finish(1006, 'connection lost'));
  socket.on('error', () => finish(1006, 'connection lost'));
  if (head.length) onData(head);
  return {
    send: (text) => write(0x1, Buffer.from(text, 'utf8')),
    close: (code = 1000) => {
      const p = Buffer.alloc(2);
      p.writeUInt16BE(code);
      write(0x8, p);
      finish(code, '');
    },
  };
}
