#!/usr/bin/env node
'use strict';

/**
 * 中继服务器 —— 一个「哑」转发器。
 *
 * 它做的事只有：把同一个房间里的 daemon 和手机配对起来，转发字节。
 * 它做不到的事：读懂转发的内容。业务载荷在两端做端到端加密，
 * 中继只看得见信封（房间 ID、时间、大小）。
 *
 * 为什么 daemon 要主动外连中继，而不是自己监听公网端口：
 *   - 穿透 NAT，不需要端口转发、不需要在路由器开洞
 *   - 不把一个能执行任意命令的接口暴露给互联网扫描
 *   - 换 Wi-Fi / 4G 都不受影响
 *
 * 零依赖，自己实现了 RFC 6455 的服务端握手与帧解析（只用到文本帧 + ping/pong/close）。
 *
 *   用法: node relay/server.js [--port 8090] [--secret <准入密钥>]
 */

const http = require('http');
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = Number(opt('--port', 8090));
const SECRET = opt('--secret', process.env.RELAY_SECRET || '');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** roomId -> { host: Conn|null, clients: Set<Conn>, createdAt } */
const rooms = new Map();

function log(...a) { console.log(new Date().toISOString(), ...a); }

// ---------- 最小 WebSocket 实现 ----------

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.from(payload);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

class Conn {
  constructor(socket, role, room) {
    this.socket = socket;
    this.role = role;          // 'host' (daemon) | 'client' (手机)
    this.room = room;
    this.buf = Buffer.alloc(0);
    this.alive = true;
    this.onMessage = () => {};
    this.onClose = () => {};

    socket.on('data', d => this._feed(d));
    socket.on('close', () => this._die());
    socket.on('error', () => this._die());
    this.pinger = setInterval(() => {
      if (this.alive) try { socket.write(encodeFrame('', 0x9)); } catch { this._die(); }
    }, 30000);
  }

  send(text) {
    if (!this.alive) return false;
    try { this.socket.write(encodeFrame(text, 0x1)); return true; }
    catch { this._die(); return false; }
  }

  close() { this._die(); }

  _die() {
    if (!this.alive) return;
    this.alive = false;
    clearInterval(this.pinger);
    try { this.socket.destroy(); } catch {}
    this.onClose();
  }

  _feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      const mask = masked ? this.buf.subarray(off, off + 4) : null;
      const payload = Buffer.from(this.buf.subarray(off + maskLen, off + maskLen + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buf = this.buf.subarray(off + maskLen + len);

      if (opcode === 0x8) { this._die(); return; }              // close
      if (opcode === 0x9) { try { this.socket.write(encodeFrame(payload, 0xA)); } catch {} continue; }  // ping
      if (opcode === 0xA) continue;                              // pong
      if (opcode === 0x1 || opcode === 0x2) this.onMessage(payload.toString('utf8'));
    }
  }
}

// ---------- 房间与转发 ----------

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { host: null, clients: new Set(), createdAt: Date.now() });
  return rooms.get(id);
}

function attach(conn, roomId) {
  const room = getRoom(roomId);

  if (conn.role === 'host') {
    if (room.host && room.host.alive) {
      // 同一房间只允许一个 daemon；新连接顶掉旧的（daemon 重启后重连的常见情形）
      room.host.send(JSON.stringify({ type: 'replaced' }));
      room.host.close();
    }
    room.host = conn;
    log(`host 已连接 room=${roomId} (在线客户端 ${room.clients.size})`);
    for (const c of room.clients) c.send(JSON.stringify({ type: 'host_online' }));
  } else {
    room.clients.add(conn);
    log(`client 已连接 room=${roomId} (共 ${room.clients.size})`);
    conn.send(JSON.stringify({ type: room.host?.alive ? 'host_online' : 'host_offline' }));
    if (room.host?.alive) room.host.send(JSON.stringify({ type: 'client_online' }));
  }

  conn.onMessage = (text) => {
    // 中继不解析业务载荷，只按方向转发。收到的应当是密文信封。
    if (conn.role === 'host') {
      for (const c of room.clients) c.send(text);
    } else {
      if (room.host?.alive) room.host.send(text);
      else conn.send(JSON.stringify({ type: 'host_offline' }));
    }
  };

  conn.onClose = () => {
    if (conn.role === 'host') {
      if (room.host === conn) {
        room.host = null;
        log(`host 断开 room=${roomId}`);
        for (const c of room.clients) c.send(JSON.stringify({ type: 'host_offline' }));
      }
    } else {
      room.clients.delete(conn);
      log(`client 断开 room=${roomId} (剩 ${room.clients.size})`);
      if (room.host?.alive) room.host.send(JSON.stringify({ type: 'client_offline' }));
    }
    if (!room.host && room.clients.size === 0) rooms.delete(roomId);
  };
}

// ---------- HTTP / 升级 ----------

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      // 只暴露聚合数字，不泄漏房间 ID
      connections: [...rooms.values()].reduce((n, r) => n + (r.host ? 1 : 0) + r.clients.size, 0),
    }));
    return;
  }
  res.writeHead(404); res.end('relay');
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://relay');
  const key = req.headers['sec-websocket-key'];
  const roomId = url.searchParams.get('room');
  const role = url.searchParams.get('role');
  const secret = url.searchParams.get('secret') || '';

  const bad = (code, msg) => {
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  if (!key) return bad(400, 'Bad Request');
  if (!roomId || !/^[A-Za-z0-9_-]{8,64}$/.test(roomId)) return bad(400, 'Bad Room');
  if (role !== 'host' && role !== 'client') return bad(400, 'Bad Role');
  if (SECRET) {
    const a = Buffer.from(secret), b = Buffer.from(SECRET);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return bad(401, 'Unauthorized');
  }

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  attach(new Conn(socket, role, roomId), roomId);
});

server.listen(PORT, () => {
  log(`relay listening on :${PORT}${SECRET ? ' (已启用准入密钥)' : ' (无准入密钥)'}`);
});
