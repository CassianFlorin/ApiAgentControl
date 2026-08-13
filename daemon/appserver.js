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
  constructor({ onServerRequest, onNotification, onTurnDone, log, autoRestart = true } = {}) {
    this.onServerRequest = onServerRequest || (() => {});
    this.onNotification = onNotification || (() => {});
    this.onTurnDone = onTurnDone || (() => {});
    this.log = log || (() => {});
    this.autoRestart = autoRestart;   // 一次性实例退出后不该被拉起来
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
    // spawn 失败（如 launchd 环境 PATH 里没有 codex）走 error 事件而非 exit。
    // 不接住它就是 uncaught exception，整个 daemon 直接崩 —— 而这只该是
    // 控制通道不可用，监听/中继/推送都不依赖它。
    this.proc.on('error', (e) => {
      console.error(`[ctl] 无法启动 codex app-server: ${e.message}（PATH 里找得到 codex 吗？）`);
      this.proc = null;
      if (!this.stopped) {
        setTimeout(() => { this.backoff = Math.min(this.backoff * 2, 30_000); this.start(); }, this.backoff);
      }
    });
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
      if (!this.stopped && this.autoRestart) {
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
    if (method === 'turn/completed' && params.threadId) {
      this.activeTurns.delete(params.threadId);
      this.onTurnDone(params.threadId);
    }
  }

  /** 本实例当前是否还持有任何线程（决定能不能安全退出） */
  get holdsAnyThread() { return this.resumed.size > 0; }

  // ---------- 高层操作 ----------

  async ensureResumed(threadId) {
    await this.ready;
    if (this.resumed.has(threadId)) return;
    try {
      await this.rpc('thread/resume', { threadId });
    } catch (e) {
      // Codex 的硬约束：同一线程同时只允许一个写入方。
      // 原始报错是英文内部术语（thread-store conflict: already has an active
      // writer），直接透给手机等于没提示。
      if (/active writer|thread-store conflict/i.test(e.message || '')) {
        throw Object.assign(
          new Error('该会话已被另一处打开（多半是电脑上的 Codex Desktop）。同一会话同时只能有一方操作：请直接在电脑上继续，或在 Desktop 里离开该会话后重试。'),
          { status: 409 }
        );
      }
      throw e;
    }
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

/**
 * 控制通道。
 *
 * ## 为什么要分成"一个常驻 + 每线程一次性"
 *
 * `thread/resume` 会让本进程成为该线程的 **active writer**，而 Codex 同一线程
 * 只允许一个写入方。实测（探针见 git 历史）：
 *
 * | 操作 | 结果 |
 * |---|---|
 * | A resume → B resume | B 报 already has an active writer |
 * | A `thread/unsubscribe` | 返回 `unsubscribed`，但线程**仍在 `thread/loaded/list` 里** |
 * | A unsubscribe 后 B resume | **仍然冲突** —— 退订只停事件推送，不放锁 |
 * | 杀掉 A 进程后 B resume | 成功 |
 *
 * 协议里没有任何 close / unload 方法，**进程退出是唯一的释放手段**。
 *
 * 所以：
 *   - **常驻实例**只做无锁操作（thread/list），永远不 resume；
 *   - 手机每次发指令，为该线程起一个**一次性实例**，turn 跑完就杀掉进程。
 *
 * 此前误以为 unsubscribe 能放锁，导致：手机发过一次指令后该线程就被 daemon
 * 永久占住，Desktop 打不开（报"正在其他位置运行"）；而手机自己再发一次也会
 * 失败 —— resume 撞上的是**我们自己**上一次留下的锁，错误信息却在甩锅 Desktop。
 */
class ControlChannel {
  constructor({ onServerRequest, onNotification, log } = {}) {
    this.handlers = { onServerRequest, onNotification, log };
    this.log = log || (() => {});
    /** threadId -> { client, killTimer } —— 正在跑 turn 的一次性实例 */
    this.turns = new Map();
    this.main = new AppServerClient({ onServerRequest, onNotification, log });
  }

  /** turn 跑完到杀进程之间留的余量：turn/completed 之后紧跟的
   *  thread/status/changed（waitingOnUserInput 在里面）还得收到 */
  static GRACE_MS = 3000;

  start() { return this.main.start(); }
  get ready() { return this.main.ready; }
  get proc() { return this.main.proc; }

  stop() {
    this.main.stop();
    for (const { client, killTimer } of this.turns.values()) {
      clearTimeout(killTimer);
      client.stop();
    }
    this.turns.clear();
  }

  // --- 无锁操作走常驻实例 ---
  listThreads(params) { return this.main.listThreads(params); }
  listVisibleThreadIds(opts) { return this.main.listVisibleThreadIds(opts); }

  /** 当前持有写锁的线程数（/status 用，便于判断有没有占着 Desktop） */
  get heldThreads() { return this.turns.size; }

  /**
   * 取得某线程的一次性实例；没有就现起一个。
   * 起一个 app-server 约几百毫秒，只在手机主动发指令时发生，可以接受。
   */
  async _clientFor(threadId) {
    const existing = this.turns.get(threadId);
    if (existing) {
      clearTimeout(existing.killTimer);      // 有新动作，取消待执行的回收
      existing.killTimer = null;
      return existing.client;
    }
    const entry = { client: null, killTimer: null };
    entry.client = new AppServerClient({
      ...this.handlers,
      autoRestart: false,                    // 一次性实例退出就是退出，别拉起来
      onTurnDone: (tid) => this._scheduleKill(tid),
    });
    this.turns.set(threadId, entry);
    entry.client.start();
    await entry.client.ready;
    return entry.client;
  }

  /** turn 结束 → 延迟杀进程，把线程还给 Desktop */
  _scheduleKill(threadId) {
    const entry = this.turns.get(threadId);
    if (!entry || entry.killTimer) return;
    entry.killTimer = setTimeout(() => {
      // 期间又起了新 turn 就不动它
      if (entry.client.activeTurns.size > 0) { entry.killTimer = null; return; }
      entry.client.stop();
      this.turns.delete(threadId);
      this.log(`已释放线程 ${threadId}（一次性 app-server 退出）`);
    }, ControlChannel.GRACE_MS);
  }

  async startThread(params) {
    // 新建线程同样要独占，交给一次性实例；先建再登记
    const client = new AppServerClient({ ...this.handlers, autoRestart: false,
      onTurnDone: (tid) => this._scheduleKill(tid) });
    client.start();
    await client.ready;
    const res = await client.startThread(params);
    const id = res?.thread?.id;
    if (id) this.turns.set(id, { client, killTimer: null });
    else client.stop();
    return res;
  }

  async startTurn(threadId, text, extra) {
    const client = await this._clientFor(threadId);
    try {
      return await client.startTurn(threadId, text, extra);
    } catch (e) {
      // resume 失败（多半是 Desktop 占着）时别把空实例留在表里
      if (!client.holdsAnyThread) {
        client.stop();
        this.turns.delete(threadId);
      }
      throw e;
    }
  }

  async interruptTurn(threadId) {
    // 只有我们自己发起的 turn 才可能被打断：turn 跑在我们的一次性实例里。
    // 没有这个实例，就说明当前没有由本 daemon 发起的任务。
    const entry = this.turns.get(threadId);
    if (!entry) throw Object.assign(new Error('该会话当前没有由手机发起的进行中任务'), { status: 409 });
    return entry.client.interruptTurn(threadId);
  }

  async steerTurn(threadId, text) {
    const entry = this.turns.get(threadId);
    if (!entry) throw Object.assign(new Error('该会话当前没有由手机发起的进行中任务'), { status: 409 });
    return entry.client.steerTurn(threadId, text);
  }
}

module.exports = { AppServerClient, ControlChannel };
