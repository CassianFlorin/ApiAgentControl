'use strict';

/**
 * AppServerClient — 托管 `codex app-server` 子进程的 JSON-RPC 客户端。
 *
 * 职责：
 *   - spawn 并保活 app-server（异常退出后指数退避重启）
 *   - rpc(method, params) 请求/响应配对
 *   - 服务端主动发起的请求（审批、用户输入）转交 onServerRequest，由外部答复
 *   - 服务端通知转交 onNotification
 *   - 跟踪本实例已 resume 的线程与每线程当前进行中的 turnId（turn/interrupt 需要）
 */

const { spawn } = require('child_process');

const RPC_TIMEOUT_MS = 120_000;

class AppServerClient {
  /**
   * @param {object} opts
   * @param {(method: string, params: any, respond: (result: any) => void, rpcId: any) => void} opts.onServerRequest
   * @param {(method: string, params: any) => void} [opts.onNotification]
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ onServerRequest, onNotification, log } = {}) {
    this.onServerRequest = onServerRequest || (() => {});
    this.onNotification = onNotification || (() => {});
    this.log = log || (() => {});
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();      // id -> {resolve, reject, timer}
    this.resumed = new Set();      // 本实例已加载的 threadId
    this.activeTurns = new Map();  // threadId -> turnId
    this.buf = '';
    this.ready = null;             // Promise，initialize 完成
    this.stopped = false;
    this.backoff = 1000;
  }

  start() {
    if (this.stopped) return;
    this.proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', d => this.log(`app-server stderr: ${String(d).trim()}`));
    this.proc.stdout.on('data', d => this._onData(d));
    this.proc.on('exit', (code) => {
      this.log(`app-server exited (code ${code})`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('app-server exited'));
      }
      this.pending.clear();
      this.resumed.clear();
      this.activeTurns.clear();
      this.ready = null;
      if (!this.stopped) {
        setTimeout(() => { this.backoff = Math.min(this.backoff * 2, 30_000); this.start(); }, this.backoff);
      }
    });

    this.ready = this.rpc('initialize', {
      clientInfo: { name: 'apiagentcontrol-daemon', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }).then(info => {
      this.backoff = 1000;
      this._notify('initialized', {});
      this.log(`app-server ready (codexHome=${info.codexHome})`);
      return info;
    });
    this.ready.catch(e => this.log(`initialize failed: ${e.message}`));
    return this.ready;
  }

  stop() {
    this.stopped = true;
    if (this.proc) this.proc.kill();
  }

  _write(obj) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error('app-server not running');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  _notify(method, params) { this._write({ jsonrpc: '2.0', method, params }); }

  respond(rpcId, result) { this._write({ jsonrpc: '2.0', id: rpcId, result }); }

  rpc(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try { this._write({ jsonrpc: '2.0', id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  _onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      this._onMessage(m);
    }
  }

  _onMessage(m) {
    // 我方请求的响应
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(Object.assign(new Error(m.error.message || 'rpc error'), { code: m.error.code, data: m.error.data }));
      else p.resolve(m.result);
      return;
    }
    // 服务端主动请求（审批等），需要答复
    if (m.id !== undefined && m.method) {
      this.onServerRequest(m.method, m.params, result => this.respond(m.id, result), m.id);
      return;
    }
    // 通知
    if (m.method) {
      this._trackTurns(m.method, m.params);
      this.onNotification(m.method, m.params);
    }
  }

  _trackTurns(method, params = {}) {
    if (method === 'turn/started' && params.threadId && params.turn?.id) {
      this.activeTurns.set(params.threadId, params.turn.id);
    }
    if ((method === 'turn/completed' || method === 'turn/failed' || method === 'turn/aborted') && params.threadId) {
      this.activeTurns.delete(params.threadId);
    }
  }

  // ---------- 高层操作 ----------

  async ensureResumed(threadId) {
    await this.ready;
    if (this.resumed.has(threadId)) return;
    await this.rpc('thread/resume', { threadId });
    this.resumed.add(threadId);
  }

  async listThreads(params = {}) {
    await this.ready;
    return this.rpc('thread/list', { limit: 25, sortKey: 'recency_at', ...params });
  }

  /**
   * 取出 Codex 认为"用户可见"的全部线程 id。
   *
   * thread/list 不带 sourceKinds 时的默认口径就是 Desktop 侧栏用的那套，
   * 比我们自己按 thread_source 判断可靠得多：实测它既包含 CLI 交互会话（codex-tui），
   * 也包含由某个会话派生、但用户能直接看到的 subagent 线程，
   * 同时排除掉压缩/审阅之类的内部线程。
   */
  async listVisibleThreadIds({ pageLimit = 200, maxPages = 20 } = {}) {
    await this.ready;
    const ids = new Set();
    let cursor = null;
    for (let i = 0; i < maxPages; i++) {
      const params = { limit: pageLimit, sortKey: 'recency_at' };
      if (cursor) params.cursor = cursor;
      const res = await this.rpc('thread/list', params);
      for (const t of res?.data || []) if (t?.id) ids.add(t.id);
      cursor = res?.nextCursor || null;
      if (!cursor) break;
    }
    return ids;
  }

  async startThread(params = {}) {
    await this.ready;
    const res = await this.rpc('thread/start', params);
    const id = res.thread?.id;
    if (id) this.resumed.add(id);
    return res;
  }

  async startTurn(threadId, text, extra = {}) {
    await this.ensureResumed(threadId);
    const res = await this.rpc('turn/start', {
      threadId,
      input: [{ type: 'text', text }],
      ...extra,
    });
    if (res.turn?.id) this.activeTurns.set(threadId, res.turn.id);
    return res;
  }

  /**
   * 打断当前 turn。
   *
   * turnId 只能从 turn/start 的响应或 turn/started 通知里拿到，daemon 重启后就丢了 ——
   * 此前这种情况直接返回 409，用户在手机上根本打断不了（而"任务跑飞了要停掉"
   * 恰恰是重启后最想做的事）。所以先查内存，查不到就向 app-server 要一次线程状态。
   */
  async interruptTurn(threadId) {
    await this.ready;
    let turnId = this.activeTurns.get(threadId);
    if (!turnId) turnId = await this._recoverTurnId(threadId);
    if (!turnId) throw Object.assign(new Error('该会话当前没有进行中的任务'), { status: 409 });
    return this.rpc('turn/interrupt', { threadId, turnId });
  }

  /** 从 thread/read 里找出仍在进行中的 turn */
  async _recoverTurnId(threadId) {
    try {
      await this.ensureResumed(threadId);
      const res = await this.rpc('thread/read', { threadId, includeTurns: true });
      const turns = res?.thread?.turns || res?.turns || [];
      const active = [...turns].reverse().find(t => t?.status === 'inProgress');
      if (active?.id) {
        this.activeTurns.set(threadId, active.id);
        return active.id;
      }
    } catch { /* 恢复失败就按无活跃任务处理 */ }
    return null;
  }

  async steerTurn(threadId, text) {
    await this.ready;
    const turnId = this.activeTurns.get(threadId);
    if (!turnId) throw Object.assign(new Error('no active turn for thread'), { status: 409 });
    return this.rpc('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text }] });
  }
}

module.exports = { AppServerClient };
