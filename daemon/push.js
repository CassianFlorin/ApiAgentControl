'use strict';

/**
 * APNs 推送客户端。零依赖：Node 内置 http2 + ES256 签名。
 *
 * 为什么由 daemon 直连 APNs，而不是经中继：
 *   - 中继是哑管道，让它参与推送就得让它知道"什么时候该推"，等于泄漏会话动态
 *   - daemon 本来就有外网（它要连中继），直连 APNs 不增加任何暴露面
 *   - 少一跳就少一处可失败、可窥探的地方
 *
 * 推送内容一律是**密文**：APNs 服务器能看到推送体，所以真实内容
 * （命令、会话标题）必须加密后放进自定义字段，由客户端的
 * Notification Service Extension 本地解密后再渲染。
 * 明文部分只写"有一条需要处理"这种无信息量的占位。
 */

const crypto = require('crypto');
const fs = require('fs');
const http2 = require('http2');

const HOST_PROD = 'https://api.push.apple.com';
const HOST_DEV = 'https://api.sandbox.push.apple.com';

/** APNs 要求 ES256 签名的 JWT，且同一个 token 最多复用 1 小时 */
class ApnsAuth {
  constructor({ keyId, teamId, p8Path, p8 }) {
    this.keyId = keyId;
    this.teamId = teamId;
    this.key = p8 || fs.readFileSync(p8Path, 'utf8');
    this.token = null;
    this.issuedAt = 0;
  }

  jwt() {
    const now = Math.floor(Date.now() / 1000);
    // 提前 5 分钟续签；APNs 拒绝超过 1 小时的 token
    if (this.token && now - this.issuedAt < 3300) return this.token;
    const header = { alg: 'ES256', kid: this.keyId };
    const payload = { iss: this.teamId, iat: now };
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const signingInput = `${b64(header)}.${b64(payload)}`;
    const sig = crypto.createSign('SHA256')
      .update(signingInput)
      .sign({ key: this.key, dsaEncoding: 'ieee-p1363' })
      .toString('base64url');
    this.token = `${signingInput}.${sig}`;
    this.issuedAt = now;
    return this.token;
  }
}

class PushSender {
  /**
   * @param {object} cfg { keyId, teamId, bundleId, p8Path, production }
   * @param {(m:string)=>void} log
   */
  constructor(cfg, log = () => {}) {
    this.cfg = cfg;
    this.log = log;
    this.auth = new ApnsAuth(cfg);
    this.host = cfg.production ? HOST_PROD : HOST_DEV;
    this.session = null;
  }

  _connect() {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    this.session = http2.connect(this.host);
    this.session.on('error', e => { this.log(`APNs 连接错误: ${e.message}`); this.session = null; });
    this.session.on('close', () => { this.session = null; });
    return this.session;
  }

  /**
   * 发送一条推送。
   * @param {string} deviceToken 十六进制的 APNs device token
   * @param {object} o { title, body, ciphertext, threadId, badge, collapseId }
   */
  send(deviceToken, { title, body, ciphertext, threadId, badge, collapseId }) {
    return new Promise((resolve) => {
      let session;
      try { session = this._connect(); } catch (e) { return resolve({ ok: false, error: e.message }); }

      const payload = JSON.stringify({
        aps: {
          alert: { title, body },
          sound: 'default',
          // 让客户端的 Notification Service Extension 有机会改写内容
          'mutable-content': 1,
          ...(badge != null ? { badge } : {}),
          ...(threadId ? { 'thread-id': threadId } : {}),
        },
        // 真正的内容在这里，密文。APNs 看不懂。
        ...(ciphertext ? { e2e: ciphertext } : {}),
      });

      const headers = {
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${this.auth.jwt()}`,
        'apns-topic': this.cfg.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        ...(collapseId ? { 'apns-collapse-id': collapseId.slice(0, 64) } : {}),
      };

      const req = session.request(headers);
      let status = 0, data = '';
      req.on('response', h => { status = h[':status']; });
      req.on('data', d => { data += d; });
      req.on('end', () => {
        if (status === 200) return resolve({ ok: true });
        this.log(`APNs ${status}: ${data}`);
        // 410 = token 已失效，调用方应删除该 token
        resolve({ ok: false, status, error: data, gone: status === 410 });
      });
      req.on('error', e => resolve({ ok: false, error: e.message }));
      req.setTimeout(10000, () => { req.close(); resolve({ ok: false, error: 'timeout' }); });
      req.end(payload);
    });
  }

  close() { try { this.session?.close(); } catch {} }
}

/**
 * 决定某个事件要不要推送，以及推什么。
 *
 * 只推「需要你动手」的时刻。进行中的每一条都推，一轮对话能炸出几十条通知，
 * 用户会直接关掉推送权限 —— 那比不做还糟。
 */
function pushableEvent(ev, session) {
  const title = session?.title || '会话';
  switch (ev.kind) {
    case 'approval_request':
      return {
        reason: 'approval',
        title: '需要审批',
        body: ev.command ? String(ev.command).slice(0, 120) : (ev.title || '请求执行命令'),
        subtitle: title,
        collapseId: `approval-${ev.approval_id}`,
      };
    case 'turn_complete':
      // 只有「停下来在问你」才推；单纯干完活不打扰
      if (session?.status !== 'waiting_input') return null;
      return {
        reason: 'waiting_input',
        title: '等你回复',
        body: String(ev.last_message || session?.lastAssistantMessage || '').slice(0, 120),
        subtitle: title,
        collapseId: `reply-${ev.session_id}`,
      };
    case 'turn_aborted':
      return { reason: 'aborted', title: '任务已中止', body: title, subtitle: title,
               collapseId: `abort-${ev.session_id}` };
    default:
      return null;
  }
}

module.exports = { PushSender, ApnsAuth, pushableEvent };
