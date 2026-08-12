'use strict';

/**
 * daemon 侧的中继连接器 + 端到端加密。
 *
 * 中继只是条哑管道，所以密钥协商和加解密都在两端完成：
 *   - 配对时通过二维码把 daemon 的公钥和房间信息交给手机（X25519）
 *   - 双方 ECDH 出共享密钥，用 HKDF 派生出会话密钥
 *   - 业务载荷一律 AES-256-GCM 封装，中继看到的只有密文
 *
 * 会话内容就是你的源代码，这是不能对第三方妥协的部分。
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---------- 加密 ----------

/** 生成 X25519 密钥对 */
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKeyObj: privateKey,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  };
}

function importPrivate(b64) {
  return crypto.createPrivateKey({
    key: Buffer.from(b64, 'base64url'), format: 'der', type: 'pkcs8',
  });
}

function importPublic(b64) {
  return crypto.createPublicKey({
    key: Buffer.from(b64, 'base64url'), format: 'der', type: 'spki',
  });
}

/** ECDH + HKDF → 32 字节会话密钥。双方派生结果必须一致，所以 salt/info 固定。 */
function deriveKey(privateKeyObj, peerPublicB64, roomId) {
  const shared = crypto.diffieHellman({
    privateKey: privateKeyObj,
    publicKey: importPublic(peerPublicB64),
  });
  // hkdfSync 返回 ArrayBuffer，统一包成 Buffer，避免与 createCipheriv / 编码调用混用时出错
  return Buffer.from(
    crypto.hkdfSync('sha256', shared, Buffer.from(roomId), Buffer.from('apiagentcontrol-v1'), 32)
  );
}

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('base64url'), ct: ct.toString('base64url'), tag: c.getAuthTag().toString('base64url') };
}

function open(key, env) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64url'));
  d.setAuthTag(Buffer.from(env.tag, 'base64url'));
  const pt = Buffer.concat([d.update(Buffer.from(env.ct, 'base64url')), d.final()]);
  return JSON.parse(pt.toString('utf8'));
}

// ---------- 最小 WebSocket 客户端 ----------

class WsClient {
  constructor(urlStr, { onOpen, onMessage, onClose } = {}) {
    this.url = new URL(urlStr);
    this.onOpen = onOpen || (() => {});
    this.onMessage = onMessage || (() => {});
    this.onClose = onClose || (() => {});
    this.buf = Buffer.alloc(0);
    this.alive = false;
    this._connect();
  }

  _connect() {
    const isTls = this.url.protocol === 'wss:';
    const mod = isTls ? https : http;
    const key = crypto.randomBytes(16).toString('base64');
    const req = mod.request({
      hostname: this.url.hostname,
      port: this.url.port || (isTls ? 443 : 80),
      path: this.url.pathname + this.url.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    // 第三个参数 head 是随握手响应一起到达的、属于升级后协议的字节。
    // 服务端在 101 之后立刻发帧时（中继就是这样：客户端一接入就发 host_online），
    // 这一帧极可能与响应头合进同一个 TCP 段，从而落在 head 里。
    // 丢掉 head 就等于静默丢掉第一条消息 —— 表现为"连上了但状态永远不更新"。
    req.on('upgrade', (res, socket, head) => {
      const expect = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expect) { socket.destroy(); this._die(); return; }
      this.socket = socket;
      this.alive = true;
      socket.setNoDelay(true);
      socket.on('data', d => this._feed(d));
      socket.on('close', () => this._die());
      socket.on('error', () => this._die());
      this.onOpen();
      if (head && head.length) this._feed(head);   // 必须在 onOpen 之后喂，回调此时才就绪
    });
    req.on('error', () => this._die());
    req.on('response', () => this._die());   // 未升级成功
    req.end();
  }

  send(text) {
    if (!this.alive) return false;
    // 客户端发出的帧必须掩码（RFC 6455）
    const data = Buffer.from(text);
    const mask = crypto.randomBytes(4);
    const len = data.length;
    let header;
    if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
    else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[0] = 0x81;
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    try { this.socket.write(Buffer.concat([header, mask, masked])); return true; }
    catch { this._die(); return false; }
  }

  close() { this.alive = false; try { this.socket?.destroy(); } catch {} }

  _die() {
    if (this.alive === false && !this.socket) { this.onClose(); return; }
    this.alive = false;
    this.onClose();
  }

  _feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const ml = masked ? 4 : 0;
      if (this.buf.length < off + ml + len) return;
      const mask = masked ? this.buf.subarray(off, off + 4) : null;
      const payload = Buffer.from(this.buf.subarray(off + ml, off + ml + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buf = this.buf.subarray(off + ml + len);
      if (opcode === 0x8) { this.close(); this.onClose(); return; }
      if (opcode === 0x9) { this._pong(payload); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x2) this.onMessage(payload.toString('utf8'));
    }
  }

  _pong(payload) {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    const header = Buffer.alloc(2);
    header[0] = 0x8A; header[1] = 0x80 | masked.length;
    try { this.socket.write(Buffer.concat([header, mask, masked])); } catch {}
  }
}

// ---------- 中继连接器 ----------

class RelayConnector {
  /**
   * @param {object} o
   * @param {string} o.relayUrl   ws(s)://host:port
   * @param {string} o.roomId
   * @param {string} o.secret     中继准入密钥（可选）
   * @param {object} o.keys       { publicKey, privateKey }
   * @param {(req:object)=>Promise<object>} o.onRequest  处理手机发来的请求，返回响应体
   * @param {(m:string)=>void} o.log
   */
  constructor({ relayUrl, roomId, secret = '', keys, onRequest, log }) {
    this.relayUrl = relayUrl;
    this.roomId = roomId;
    this.secret = secret;
    this.keys = keys;
    this.privateKeyObj = importPrivate(keys.privateKey);
    this.onRequest = onRequest;
    this.log = log || (() => {});
    this.peers = new Map();          // peerPublicKey -> derivedKey
    this.ws = null;
    this.backoff = 1000;
    this.stopped = false;
    this.connected = false;
  }

  start() {
    if (this.stopped) return;
    const u = new URL(this.relayUrl);
    u.searchParams.set('room', this.roomId);
    u.searchParams.set('role', 'host');
    if (this.secret) u.searchParams.set('secret', this.secret);

    this.ws = new WsClient(u.toString(), {
      onOpen: () => {
        this.connected = true;
        this.backoff = 1000;
        this.log(`已连接中继 ${this.relayUrl} room=${this.roomId}`);
      },
      onMessage: (text) => this._onMessage(text),
      onClose: () => {
        // 断开一定要记日志。此前只在"从未连上"时才记，
        // 于是连上后再断开是完全静默的 —— 手机显示"电脑离线"却无处查原因。
        const wasConnected = this.connected;
        this.connected = false;
        if (this.stopped) return;
        this.log(wasConnected
          ? `中继连接断开，${this.backoff}ms 后重连`
          : `中继连接失败，${this.backoff}ms 后重试`);
        setTimeout(() => { this.backoff = Math.min(this.backoff * 2, 30000); this.start(); }, this.backoff);
      },
    });
  }

  stop() { this.stopped = true; this.ws?.close(); }

  /** 用与某台设备协商好的密钥加密一段内容（供 APNs 推送体使用） */
  sealFor(peerPublicKey, obj) {
    const key = this.peers.get(peerPublicKey);
    if (!key) return null;
    try { return seal(key, obj); } catch { return null; }
  }

  /** 主动推送事件给所有已配对的手机（加密） */
  pushEvent(ev) {
    if (!this.connected) return;
    for (const [peer, key] of this.peers) {
      this.ws.send(JSON.stringify({ to: peer, env: seal(key, { type: 'event', event: ev }) }));
    }
  }

  async _onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    // 中继自身的状态通知
    if (msg.type && !msg.env) {
      this.log(`中继状态: ${msg.type}`);
      return;
    }
    if (!msg.from || !msg.env) return;

    // 首次见到该手机公钥 → 派生共享密钥
    if (!this.peers.has(msg.from)) {
      try {
        this.peers.set(msg.from, deriveKey(this.privateKeyObj, msg.from, this.roomId));
        this.log(`已与设备协商密钥 ${msg.from.slice(0, 12)}…`);
      } catch (e) { this.log(`密钥协商失败: ${e.message}`); return; }
    }
    const key = this.peers.get(msg.from);

    let req;
    try { req = open(key, msg.env); }
    catch { this.log('解密失败（密钥不匹配或载荷被篡改），已丢弃'); this.peers.delete(msg.from); return; }

    let body;
    try { body = await this.onRequest(req); }
    catch (e) { body = { status: 500, body: { error: e.message } }; }

    this.ws.send(JSON.stringify({ to: msg.from, env: seal(key, { type: 'response', id: req.id, ...body }) }));
  }
}

module.exports = { RelayConnector, generateKeyPair, deriveKey, seal, open, importPrivate, importPublic, WsClient };
