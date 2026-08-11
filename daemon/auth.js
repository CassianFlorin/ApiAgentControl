'use strict';

/**
 * daemon 鉴权层。
 *
 * 三个独立的防线，缺一不可：
 *   1. Token + 权限档位 —— 谁能做什么
 *   2. Origin 校验      —— 挡住浏览器发起的跨站请求（CSRF）
 *   3. Host 校验        —— 挡住 DNS rebinding
 *
 * 为什么本地回环也要鉴权：控制接口能在本机执行任意命令，而 `Content-Type: text/plain`
 * 的跨站 POST 属于 CORS "简单请求"、不触发预检。也就是说你浏览任意网页时，
 * 那个网页就能向 127.0.0.1 的控制接口投递指令。响应它读不到，但动作已经执行了。
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.codex-watchd');
const AUTH_FILE = path.join(CONFIG_DIR, 'auth.json');

// 权限档位。风险差一个数量级，因此分开：
//   read    —— 看会话内容
//   approve —— 批准/拒绝 Codex 已经提出的具体命令（动作空间被模型限死，风险低）
//   control —— 发送任意指令（等同远程 shell，手机丢失即机器失守）
const SCOPES = ['read', 'approve', 'control'];
const RANK = { read: 0, approve: 1, control: 2 };

function newToken() { return crypto.randomBytes(32).toString('base64url'); }

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // 长度不同也要走一次比较，避免用耗时泄漏长度
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

class Auth {
  constructor({ enabled = true, allowedOrigins = [], bindHosts = [], allowLocalIPs = false } = {}) {
    this.enabled = enabled;
    this.allowedOrigins = new Set(allowedOrigins);
    this.bindHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1', ...bindHosts]);
    // 绑定到非回环地址时，本机各网卡的 IP 都是合法的 Host。
    // 放行 IP 字面量不削弱 DNS rebinding 防护——那种攻击依赖的是主机名，
    // 攻击者可以把 evil.com 解析到本机 IP，但浏览器发出的 Host 仍是 evil.com。
    if (allowLocalIPs) {
      for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs || []) this.bindHosts.add(a.address.replace(/%.*$/, ''));
      }
    }
    this.raw = {};
    this.devices = [];   // { id, name, scope, token, created, lastSeen }
  }

  async load() {
    if (!this.enabled) return this;
    try {
      // 保留整个配置对象：文件里还有 relay 身份（房间 ID + 密钥）等字段，
      // 保存时只写 devices 会把它们抹掉，导致配对后房间对不上。
      this.raw = JSON.parse(await fsp.readFile(AUTH_FILE, 'utf8'));
      this.devices = this.raw.devices || [];
    } catch { this.raw = {}; this.devices = []; }

    if (!this.devices.some(d => d.id === 'local')) {
      // 首次运行：生成本机主 token（供调试页与本地脚本使用）
      this.devices.unshift({
        id: 'local', name: 'local', scope: 'control',
        token: newToken(), created: new Date().toISOString(),
      });
      await this.save();
    }
    return this;
  }

  async save() {
    await fsp.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    // 重新读一次盘上的内容再合并，避免覆盖其他进程（或本进程其他路径）写入的字段
    let onDisk = {};
    try { onDisk = JSON.parse(await fsp.readFile(AUTH_FILE, 'utf8')); } catch {}
    const merged = { ...onDisk, ...this.raw, devices: this.devices };
    const tmp = `${AUTH_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, AUTH_FILE);
    try { fs.chmodSync(AUTH_FILE, 0o600); } catch {}
  }

  get localToken() { return this.devices.find(d => d.id === 'local')?.token; }

  /** 配置文件有变更则重新加载设备列表。返回是否真的重载过。 */
  _reloadIfChanged() {
    try {
      const mtime = fs.statSync(AUTH_FILE).mtimeMs;
      if (mtime === this._mtime) return false;
      this._mtime = mtime;
      const raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      this.raw = raw;
      this.devices = raw.devices || [];
      return true;
    } catch { return false; }
  }

  async addDevice(name, scope = 'read') {
    if (!SCOPES.includes(scope)) throw new Error(`invalid scope: ${scope}`);
    const d = {
      id: crypto.randomBytes(6).toString('hex'), name, scope,
      token: newToken(), created: new Date().toISOString(),
    };
    this.devices.push(d);
    await this.save();
    return d;
  }

  async revokeDevice(id) {
    const before = this.devices.length;
    this.devices = this.devices.filter(d => d.id !== id);
    if (this.devices.length !== before) { await this.save(); return true; }
    return false;
  }

  /** 从请求中取出 token：优先 Authorization 头；SSE 只能走 query（EventSource 不支持自定义头） */
  static extractToken(req, url) {
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (m) return m[1].trim();
    return url.searchParams.get('token');
  }

  /**
   * 校验请求。返回 { ok: true, device } 或 { ok: false, status, error }。
   * @param need 该端点要求的最低权限档位
   */
  check(req, url, need = 'read') {
    // --- Host 校验：防 DNS rebinding ---
    const host = String(req.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '');
    if (host && !this.bindHosts.has(host) && !this.bindHosts.has(`[${host}]`)) {
      return { ok: false, status: 403, error: `host not allowed: ${host}` };
    }

    // --- Origin 校验：浏览器跨站请求一律拒绝 ---
    // 同源的 fetch 不带 Origin（或带本站 origin）；非浏览器客户端不带 Origin。
    const origin = req.headers.origin;
    if (origin && !this.allowedOrigins.has(origin)) {
      const selfOrigins = [...this.bindHosts].flatMap(h => [`http://${h}:${this.port}`, `https://${h}:${this.port}`]);
      if (!selfOrigins.includes(origin)) {
        return { ok: false, status: 403, error: 'cross-origin request rejected' };
      }
    }

    if (!this.enabled) return { ok: true, device: { id: 'anonymous', scope: 'control' } };

    // --- Token 与权限档位 ---
    const tok = Auth.extractToken(req, url);
    if (!tok) return { ok: false, status: 401, error: 'missing token (Authorization: Bearer <token> 或 ?token=)' };
    let device = this.devices.find(d => timingSafeEqual(d.token, tok));
    if (!device && this._reloadIfChanged()) {
      // 配对是由另一个进程（--pair）写入文件的，运行中的 daemon 需要重新加载才能认出新设备
      device = this.devices.find(d => timingSafeEqual(d.token, tok));
    }
    if (!device) return { ok: false, status: 401, error: 'invalid token' };
    if (RANK[device.scope] < RANK[need]) {
      return { ok: false, status: 403, error: `insufficient scope: 需要 ${need}，该设备为 ${device.scope}` };
    }
    device.lastSeen = new Date().toISOString();
    return { ok: true, device };
  }
}

module.exports = { Auth, SCOPES, AUTH_FILE, CONFIG_DIR };
