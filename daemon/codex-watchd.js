#!/usr/bin/env node
'use strict';

/**
 * codex-watchd — Codex 会话监听 + 控制 daemon
 *
 * 两条通道：
 *   [只读] 监听 $CODEX_HOME/sessions/**、archived_sessions/ 下的 rollout-*.jsonl 追加写入，
 *          归一化为统一事件流。零侵入覆盖所有来源（Desktop / CLI / VSCode 插件）。
 *   [控制] 托管 `codex app-server` 子进程（官方 JSON-RPC 协议），支持新建/续接线程、
 *          发送指令、打断、引导，以及远程审批。
 *
 * 输出：
 *   1. stdout（人类可读的彩色日志）
 *   2. HTTP: GET /events (SSE)、GET /sessions、GET / (调试页，含审批按钮)
 *      控制: GET|POST /threads、POST /threads/:id/{turns,interrupt,steer}
 *            GET /approvals、POST /approvals/:id
 *
 * 零依赖，Node >= 20。
 *
 * 用法：
 *   node codex-watchd.js [--home ~/.codex] [--port 8787] [--verbose] [--no-server] [--no-control]
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { AppServerClient } = require('./appserver');
const { Auth, SCOPES, AUTH_FILE } = require('./auth');
const { RelayConnector, generateKeyPair } = require('./relay-client');
const { DesktopState } = require('./desktop-state');
const { describeApproval } = require('./approvals');
const { PushSender, pushableEvent } = require('./push');

// ---------- CLI ----------

const args = process.argv.slice(2);
function flag(name) { return args.includes(name); }
function opt(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

const CODEX_HOME = path.resolve(
  (opt('--home', process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))).replace(/^~/, os.homedir())
);
const PORT = Number(opt('--port', 8787));
const VERBOSE = flag('--verbose');
const NO_SERVER = flag('--no-server');
const NO_CONTROL = flag('--no-control');
// 关掉 fs.watch，只靠轮询。用于验证轮询兜底本身是否可靠 ——
// fs.watch 在安静的小目录树里总是好用，会掩盖轮询侧的缺陷。
const NO_FSWATCH = flag('--no-fswatch');
const BIND = opt('--bind', '127.0.0.1');
const NO_AUTH = flag('--no-auth');
// 额外放行的主机名（如 Tailscale MagicDNS：--allow-host mac.tailnet.ts.net）
const ALLOW_HOSTS = (opt('--allow-host', '') || '').split(',').map(s => s.trim()).filter(Boolean);
// 设备管理子命令（不启动 daemon，执行完即退出）
const ADD_DEVICE = opt('--add-device', null);
const DEVICE_SCOPE = opt('--scope', 'read');
const REVOKE_DEVICE = opt('--revoke-device', null);
const LIST_DEVICES = flag('--list-devices');
// 中继
const RELAY_URL = opt('--relay', null);
const RELAY_SECRET = opt('--relay-secret', process.env.RELAY_SECRET || '');
const PAIR = flag('--pair');
// 默认与 --add-device 保持一致，都是最小权限 read。
// 曾把 --pair 默认设成 approve，等于每次配对都悄悄多发一档权限 —— 提权必须显式。
const PAIR_SCOPE = opt('--pair-scope', 'read');

const WATCH_DIRS = [
  path.join(CODEX_HOME, 'sessions'),
  path.join(CODEX_HOME, 'archived_sessions'),
];
const INDEX_FILE = path.join(CODEX_HOME, 'session_index.jsonl');

// ---------- 会话注册表 ----------

/** sessionId -> { id, title, updatedAt, cwd, originator, provider, source, file } */
const sessions = new Map();

function upsertSession(id, patch) {
  const cur = sessions.get(id) || { id, status: 'idle', unread: 0 };
  sessions.set(id, { ...cur, ...patch });
  return sessions.get(id);
}

/**
 * 从 cwd 推导"项目"。用户常用 git worktree 并行开多个任务，
 * 形如 ~/.codex/worktrees/<hash>/<repo>；这些应归到同一个项目下，
 * 否则 App 里会散成一堆看不出关系的条目。
 */
const desktop = new DesktopState(CODEX_HOME);

function projectOf(cwd) {
  const m = cwd ? cwd.match(/\/\.codex\/worktrees\/([^/]+)\/([^/]+)\/?$/) : null;
  const worktree = m ? m[1] : null;

  // 优先用 Desktop 侧栏里用户自己整理的项目归属；纯 CLI 环境下没有这份状态，
  // 退回按 cwd 末段推导（仓库同名或改名时会不准，但总比没有强）。
  const p = desktop.projectFor(cwd);
  if (p) return { project: p.name, projectId: p.id, worktree };

  if (!cwd) return { project: 'unknown', projectId: null, worktree: null };
  if (m) return { project: m[2], projectId: null, worktree };
  return { project: path.basename(cwd), projectId: null, worktree: null };
}

/** 事件 → 会话状态机。App 的"需要我关注吗"全靠这个。 */
function applyEventToSession(ev) {
  if (!ev.session_id) return;
  const s = upsertSession(ev.session_id, {});
  s.lastActivity = ev.ts || new Date().toISOString();
  s.lastKind = ev.kind;

  switch (ev.kind) {
    case 'session_meta': {
      const { project, worktree } = projectOf(ev.cwd);
      Object.assign(s, { cwd: ev.cwd, originator: ev.originator, provider: ev.provider, source: ev.source, project, worktree });
      if (ev.file) s.archived = isArchived(path.join(CODEX_HOME, ev.file));
      break;
    }
    case 'turn_context':
      if (ev.model) s.model = ev.model;
      if (ev.cwd && !s.cwd) Object.assign(s, { cwd: ev.cwd }, projectOf(ev.cwd));
      break;
    case 'user_message':
      s.status = 'running';
      s.waitingReason = null;          // 已经回过话了，从待办里移除
      s.lastUserMessage = clip(ev.text, 200);
      // 启动时的 deriveTitle 只覆盖已有内容的文件；daemon 运行期间新建的会话
      // 要在这里补上标题，否则它在列表里会一直是一串 UUID
      if (!s.title && ev.text && !isMachineMessage(ev.text)) {
        s.title = String(ev.text).replace(/\s+/g, ' ').slice(0, 60);
        s.titleDerived = true;
      }
      break;
    case 'turn_started':
      s.status = 'running';
      break;
    case 'approval_request':
      s.status = 'waiting_approval';
      s.pendingApproval = ev.approval_id;
      break;
    case 'approval_resolved':
      if (s.pendingApproval === ev.approval_id) { s.pendingApproval = null; s.status = 'running'; }
      break;
    case 'assistant_message':
      s.lastAssistantMessage = clip(ev.text, 200);
      s.unread = (s.unread || 0) + 1;
      break;
    case 'turn_complete': {
      s.pendingApproval = null;
      if (ev.last_message) s.lastAssistantMessage = clip(ev.last_message, 200);
      // 轮次结束时，若最后一句像是在问你，就标成「等你回复」并放进待办。
      // 这是推断（waitingReason='inferred'），与协议给出的确定信号区分开。
      const asking = looksLikeQuestion(ev.last_message ?? s.lastAssistantMessage);
      s.status = asking ? 'waiting_input' : 'idle';
      s.waitingReason = asking ? 'inferred' : null;
      break;
    }
    case 'turn_aborted':
      s.status = 'aborted';
      s.pendingApproval = null;
      break;
    case 'thread_status':
      // 「等你回文字」和「等你审批」是两种不同的待办，UI 上的动作也不同：
      // 前者需要一个输入框，后者需要允许/拒绝按钮。
      if (ev.waitingOnApproval) { s.status = 'waiting_approval'; s.waitingReason = 'signal'; }
      else if (ev.waitingOnUserInput) { s.status = 'waiting_input'; s.waitingReason = 'signal'; }
      else if (ev.status === 'active') { s.status = 'running'; s.waitingReason = null; }
      // status=idle 时不覆盖：turn_complete 那边可能已根据最后一句推断出「等你回复」
      break;
    case 'ctl_error':
      s.status = 'error';
      break;
  }
}

function sessionIdFromFilename(file) {
  const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return m ? m[1] : null;
}

// ---------- 事件归一化 ----------
//
// rollout 行格式: { timestamp, type, payload }
// 归一化输出: { ts, session_id, title, originator, kind, ...detail }

function clip(s, n) {
  if (typeof s !== 'string') s = JSON.stringify(s);
  if (s == null) return s;
  return s.length > n ? s.slice(0, n) + `… (+${s.length - n} chars)` : s;
}

/** 把 CLI 的 item_completed.item 归一化成与 Desktop 一致的事件形态 */
function normalizeItem(item, base) {
  if (!item) return null;
  const type = item.type || item.item_type;
  const textOf = parts => (parts || []).map(c => c?.text ?? '').join('').trim();

  switch (type) {
    case 'UserMessage':
      return { ...base, kind: 'user_message', text: textOf(item.content) };
    case 'AgentMessage':
      return { ...base, kind: 'assistant_message', text: textOf(item.content) };
    case 'Reasoning':
      return { ...base, kind: 'reasoning', text: clip(item.summary_text || '', 400) };
    case 'CommandExecution': {
      const cmd = Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '');
      return {
        ...base, kind: 'tool_call', name: 'exec', args: clip(cmd, 600),
        output: clip(item.aggregated_output ?? item.stdout ?? '', 600),
        exitCode: item.exit_code,
      };
    }
    case 'FileChange':
      return {
        ...base, kind: 'tool_call', name: 'apply_patch',
        args: clip((item.changes || []).map(c => c?.path ?? '').join(', '), 400),
      };
    default:
      return VERBOSE ? { ...base, kind: `item:${type}`, detail: clip(item, 400) } : null;
  }
}

function normalize(line, file) {
  let raw;
  try { raw = JSON.parse(line); } catch { return null; }
  const { timestamp, type, payload = {} } = raw;
  const sid = sessionIdFromFilename(file);
  const base = { ts: timestamp, session_id: sid, file: path.relative(CODEX_HOME, file) };

  switch (type) {
    case 'session_meta': {
      const meta = {
        cwd: payload.cwd,
        originator: payload.originator,
        provider: payload.model_provider,
        source: payload.source,
        cliVersion: payload.cli_version,
        file,
      };
      upsertSession(payload.id || sid, meta);
      const { file: _f, ...pub } = meta;
      return { ...base, kind: 'session_meta', ...pub };
    }

    case 'event_msg': {
      const p = payload;
      switch (p.type) {
        case 'user_message':
          return { ...base, kind: 'user_message', text: p.message ?? p.text ?? '' };
        case 'agent_message':
          return { ...base, kind: 'assistant_message', text: p.message ?? p.text ?? '' };
        case 'agent_reasoning':
          return { ...base, kind: 'reasoning', text: p.text ?? p.message ?? '' };
        case 'task_started':
          return { ...base, kind: 'turn_started' };
        case 'task_complete':
          return { ...base, kind: 'turn_complete', last_message: clip(p.last_agent_message ?? '', 2000) };
        case 'token_count':
          return VERBOSE ? { ...base, kind: 'usage', info: p.info ?? p } : null;
        case 'thread_settings_applied':
          return VERBOSE ? { ...base, kind: 'settings', detail: p } : null;
        case 'turn_aborted':
          return { ...base, kind: 'turn_aborted' };
        case 'item_completed':
          // CLI(codex-tui) 会话把全部内容包在 item_completed 里，与 Desktop 的
          // user_message / agent_message / response_item 是两套形态。
          // 不处理的话，CLI 会话在实时流里几乎什么都看不到。
          return normalizeItem(p.item, base);
        default:
          return VERBOSE ? { ...base, kind: `event:${p.type}`, detail: p } : null;
      }
    }

    case 'response_item': {
      const p = payload;
      switch (p.type) {
        case 'function_call':
          return { ...base, kind: 'tool_call', name: p.name, args: clip(p.arguments ?? '', 600) };
        case 'custom_tool_call':
          return { ...base, kind: 'tool_call', name: p.name, args: clip(p.input ?? '', 600) };
        case 'function_call_output':
        case 'custom_tool_call_output':
          return { ...base, kind: 'tool_result', output: clip(p.output ?? '', 600) };
        // message / reasoning 与 event_msg 中的 agent_message / agent_reasoning 重复，默认跳过
        case 'message':
        case 'reasoning':
          return null;
        default:
          return VERBOSE ? { ...base, kind: `item:${p.type}`, detail: clip(p, 600) } : null;
      }
    }

    case 'turn_context':
      return {
        ...base, kind: 'turn_context',
        model: payload.model, cwd: payload.cwd,
        approval_policy: payload.approval_policy, effort: payload.effort,
      };

    case 'compacted':
    case 'context_compacted':
      return { ...base, kind: 'compacted' };

    case 'turn_aborted':
      return { ...base, kind: 'turn_aborted' };

    case 'world_state':
      return null;

    default:
      return VERBOSE ? { ...base, kind: `raw:${type}`, detail: clip(payload, 400) } : null;
  }
}

// ---------- 输出：stdout + SSE ----------

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', magenta: '\x1b[35m', red: '\x1b[31m', bold: '\x1b[1m', reset: '\x1b[0m' }
  : new Proxy({}, { get: () => '' });

const KIND_STYLE = {
  user_message: [C.bold + C.green, '👤'],
  assistant_message: [C.cyan, '🤖'],
  reasoning: [C.dim, '💭'],
  tool_call: [C.yellow, '🔧'],
  tool_result: [C.dim, '↩︎ '],
  turn_started: [C.magenta, '▶️ '],
  turn_complete: [C.magenta, '✅'],
  turn_aborted: [C.red, '⛔'],
  session_meta: [C.bold, '🆕'],
  turn_context: [C.dim, '⚙️ '],
  compacted: [C.dim, '📦'],
  approval_request: [C.bold + C.red, '🔐'],
  approval_resolved: [C.green, '🔓'],
  ctl_error: [C.red, '⚠️ '],
};

function label(ev) {
  const s = sessions.get(ev.session_id);
  return (s && s.title) || (ev.session_id ? ev.session_id.slice(-8) : '????????');
}

function logEvent(ev) {
  const [color = '', icon = '·'] = KIND_STYLE[ev.kind] || [];
  const time = (ev.ts || '').slice(11, 19);
  const text = ev.text ?? ev.name ?? ev.output ?? ev.method ?? ev.model ?? ev.cwd ?? '';
  const extra = ev.kind === 'tool_call' ? ` ${C.dim}${clip(ev.args, 100)}${C.reset}` : '';
  console.log(
    `${C.dim}${time}${C.reset} ${C.bold}[${label(ev)}]${C.reset} ${color}${icon} ${ev.kind}${C.reset} ${clip(String(text).replace(/\s+/g, ' '), 160)}${extra}`
  );
}

// SSE
const sseClients = new Set();
const ring = [];          // 最近事件的回放缓冲
const RING_MAX = 500;

function broadcast(ev) {
  ring.push(ev);
  if (ring.length > RING_MAX) ring.shift();
  const frame = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of sseClients) {
    // 客户端可只订阅单个会话（App 进入某会话详情页时用），或按 kind 过滤
    if (res._session && ev.session_id !== res._session) continue;
    if (res._kinds && !res._kinds.has(ev.kind)) continue;
    res.write(frame);
  }
}

function emit(ev) {
  if (!ev) return;
  applyEventToSession(ev);
  logEvent(ev);
  broadcast(ev);
  if (relay) relay.pushEvent(ev);      // 加密后经中继推给已配对的手机（App 在前台时用）
  maybePush(ev);                       // App 在后台时，只能靠 APNs 叫醒
}

// ---------- 文件尾随 ----------

/** file -> { offset, remainder } */
const tails = new Map();

/**
 * 读取文件自上次偏移量以来的新内容，返回归一化事件数组（不直接发出）。
 * 由调用方汇总多个文件的结果、按时间戳排序后统一发出 —— 否则并行会话的
 * 事件会按"文件读取顺序"而非时间顺序涌出，时间戳来回跳。
 */
async function readAppended(file, fromStart = false) {
  let st;
  try { st = await fsp.stat(file); } catch { return []; }
  let t = tails.get(file);
  if (!t) { t = { offset: fromStart ? 0 : st.size, remainder: '' }; tails.set(file, t); if (!fromStart) return []; }
  if (st.size < t.offset) { t.offset = 0; t.remainder = ''; }       // 文件被截断/重写
  if (st.size === t.offset) return [];
  markHot(file);                                                     // 有新数据 → 进入快车道

  const out = [];
  const fh = await fsp.open(file, 'r');
  try {
    const len = st.size - t.offset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, t.offset);
    t.offset = st.size;
    const chunk = t.remainder + buf.toString('utf8');
    const lines = chunk.split('\n');
    t.remainder = lines.pop() ?? '';                                 // 尾部半行留到下次
    // 每条事件带上其在文件中的起始偏移量作为 seq：
    // 与历史回填用的是同一套游标，客户端据此去重、续拉，无需另建序号体系
    let lineStart = t.offset - Buffer.byteLength(chunk, 'utf8');
    for (const line of lines) {
      const at = lineStart;
      lineStart += Buffer.byteLength(line, 'utf8') + 1;
      if (!line.trim()) continue;
      const ev = normalize(line, file);
      if (ev) out.push({ ...ev, seq: at });
    }
  } finally {
    await fh.close();
  }
  return out;
}

/**
 * 从文件尾部反向读取历史事件。
 *
 * 会话文件最大实测 25MB / 7000 行，每次翻页都整份加载不可接受。
 * 这里以**字节偏移量**作游标：从 before 处向前分块读，凑够 limit 条归一化事件就停。
 * 偏移量天然单调有序，既是游标也是事件的稳定序号，不需要在别处维护状态。
 */
async function readHistoryBackward(file, before, limit) {
  const CHUNK = 256 * 1024;
  let fh;
  try { fh = await fsp.open(file, 'r'); } catch { return { events: [], nextBefore: null, hasMore: false }; }
  try {
    const st = await fh.stat();
    let end = before == null ? st.size : Math.min(before, st.size);
    const collected = [];
    let tail = '';                       // 跨块残留的行首片段

    while (end > 0 && collected.length < limit) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      await fh.read(buf, 0, buf.length, start);
      const text = buf.toString('utf8') + tail;
      const lines = text.split('\n');
      tail = start > 0 ? lines.shift() ?? '' : '';   // 首行可能被截断，留给下一块

      // 自后向前解析，并记录每行的起始偏移量
      let offset = start + (start > 0 ? Buffer.byteLength(tail, 'utf8') + 1 : 0);
      const withOffsets = [];
      for (const line of lines) {
        withOffsets.push([offset, line]);
        offset += Buffer.byteLength(line, 'utf8') + 1;
      }
      for (let i = withOffsets.length - 1; i >= 0 && collected.length < limit; i--) {
        const [off, line] = withOffsets[i];
        if (!line.trim()) continue;
        const ev = normalize(line, file);
        if (ev) collected.push({ ...ev, seq: off });
      }
      end = start;
    }

    collected.reverse();                              // 返回时按时间正序
    const nextBefore = collected.length ? collected[0].seq : null;
    return { events: collected, nextBefore, hasMore: nextBefore != null && nextBefore > 0 };
  } finally {
    await fh.close().catch(() => {});
  }
}

/** 读取一批文件，按时间戳排序后统一发出 */
async function flushFiles(entries) {
  const batches = await Promise.all(
    entries.map(([file, fromStart]) =>
      readAppended(file, fromStart).catch(e => {
        console.error(`${C.red}read error${C.reset} ${file}: ${e.message}`);
        return [];
      })
    )
  );
  const all = batches.flat();
  if (!all.length) return;
  all.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  for (const ev of all) emit(ev);
}

// 待读文件集合。多个会话并行时，fs.watch 会为每个文件分别触发；若各自立即读取，
// 排序只在单文件内生效，全局流仍然乱序（表现为时间戳来回跳）。
// 因此统一累积到 dirty，短暂延迟后合并成一批读取、跨文件排序再发出。
const dirty = new Map();          // file -> fromStart
let drainTimer = null;
const DRAIN_MS = 200;

function markDirty(file, fromStart = false) {
  dirty.set(file, dirty.get(file) || fromStart);
  if (!drainTimer) drainTimer = setTimeout(() => { drainTimer = null; drain(); }, DRAIN_MS);
}

async function drain() {
  if (!dirty.size) return;
  const entries = [...dirty.entries()];
  dirty.clear();
  await flushFiles(entries);
}

/**
 * 只读取文件头部，解析首行的 session_meta。
 * rollout 文件可达数十 MB，而 cwd / originator / provider 只在第一行；
 * 若不这样做，daemon 启动前就存在的会话（尤其是被续接的旧会话）在 App 里
 * 会缺失项目归属和来源信息。
 */
async function readHeadMeta(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    // 首行含完整 base_instructions（实测约 45KB），必须读到换行符为止才能解析
    const CHUNK = 65536, MAX = 4 * 1024 * 1024;
    let acc = '', pos = 0, nl = -1;
    while (nl < 0 && pos < MAX) {
      const buf = Buffer.alloc(CHUNK);
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      acc += buf.subarray(0, bytesRead).toString('utf8');
      nl = acc.indexOf('\n');
    }
    const firstLine = nl >= 0 ? acc.slice(0, nl) : acc;
    if (!firstLine) return null;
    const headBytes = Buffer.byteLength(firstLine, 'utf8') + 1;   // 供后续从首行之后继续扫描
    const rec = JSON.parse(firstLine);
    if (rec.type !== 'session_meta') return null;
    const p = rec.payload || {};
    return {
      id: p.id || p.session_id,
      cwd: p.cwd,
      originator: p.originator,
      provider: p.model_provider,
      source: p.source,
      threadSource: p.thread_source,
      cliVersion: p.cli_version,
      startedAt: p.timestamp || rec.timestamp,
      headBytes,
    };
  } catch { return null; }
  finally { if (fh) await fh.close().catch(() => {}); }
}

/**
 * 从会话开头找出第一条用户消息，用作标题回退。
 *
 * `session_index.jsonl` 只覆盖被命名过的线程，实测 68 个会话里 40 个没有标题，
 * 在 App 里只能显示一串 UUID，完全无法分辨。第一条用户消息通常就是任务描述，
 * 是最合适的替代。从 session_meta 之后开始限量扫描，避免读整个几十 MB 的文件。
 */
/**
 * 有些 "user_message" 并不是人写的：fork / 压缩会话时 Codex 会注入历史摘要前缀，
 * 自动化任务会注入 <heartbeat> 之类的标记。拿它们当标题会让列表里出现一排一模一样的条目。
 */
/**
 * 从一条 rollout 记录里取出用户消息文本。
 *
 * 两种承载形式并存，取决于会话来源：
 *   - Desktop：`event_msg` / `user_message`，文本在 payload.message
 *   - CLI(codex-tui)：`event_msg` / `item_completed`，文本在 item.content[].text，
 *     item.type == "UserMessage"
 * 只认前者的话，CLI 会话在列表里永远只显示一串 UUID。
 */
function firstUserText(rec) {
  const p = rec?.payload;
  if (!p) return null;
  if (rec.type === 'event_msg' && p.type === 'user_message') {
    return String(p.message ?? p.text ?? '').trim() || null;
  }
  if (p.type === 'item_completed' && (p.item?.type === 'UserMessage' || p.item?.item_type === 'UserMessage')) {
    const parts = p.item.content || [];
    const text = parts.map(c => c?.text ?? '').join('').trim();
    return text || null;
  }
  return null;
}

/**
 * 判断助手最后那句话是不是在等你回话。
 *
 * **这是启发式，不是协议保证。** 实测：模型用文字提问后，线程只是 active → idle，
 * `waitingOnUserInput` 并不置位 —— 协议层根本不区分「它问了你」和「任务干完了」。
 * 而「模型问一句然后停下」恰恰是实际使用中最常见的卡住场景，不识别就等于看不见。
 *
 * 因此宁可漏报也不要误报：误报会让「需要我处理」被完成态的会话淹没，直接失去意义。
 * 只看结尾问号和少量明确的征询用语，且只在结尾附近匹配。
 */
const QUESTION_TAIL = /[?？]\s*$/;
const ASKING_CUES = /(请确认|请选择|是否要|要不要|需要我|你希望|哪一个|哪个|确认一下|请告诉我|可以吗)/;

function looksLikeQuestion(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (QUESTION_TAIL.test(t)) return true;
  return ASKING_CUES.test(t.slice(-100));   // 只看结尾，正文里提到"请确认"不算
}

function isMachineMessage(text) {
  if (text.startsWith('<')) return true;                                  // <heartbeat>、<automation_id> 等
  if (text.startsWith('The following is the Codex agent history')) return true;  // fork/压缩注入的前缀
  return false;
}

async function deriveTitle(file, startOffset) {
  const MAX_SCAN = 512 * 1024;
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const st = await fh.stat();
    const len = Math.min(MAX_SCAN, Math.max(0, st.size - startOffset));
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, startOffset);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.startsWith('{')) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const text = firstUserText(rec);
      if (text && !isMachineMessage(text)) {
        return text.replace(/\s+/g, ' ').slice(0, 60);
      }
    }
    return null;
  } catch { return null; }
  finally { if (fh) await fh.close().catch(() => {}); }
}

async function initialScan() {
  let count = 0;
  const files = [];
  for (const dir of WATCH_DIRS) {
    let entries;
    try { entries = await fsp.readdir(dir, { recursive: true }); } catch { continue; }
    for (const rel of entries) {
      if (!rel.endsWith('.jsonl')) continue;
      files.push(path.join(dir, rel));
    }
  }
  for (const file of files) {
    try {
      const st = await fsp.stat(file);
      tails.set(file, { offset: st.size, remainder: '' });           // 存量文件：从 EOF 开始尾随
      count++;
      const sid = sessionIdFromFilename(file);
      if (!sid) continue;
      const meta = await readHeadMeta(file);
      const existing = sessions.get(sid);
      upsertSession(sid, {
        file,
        archived: isArchived(file),          // 归档是用户主动做的动作，默认不该出现在首页
        updatedAt: st.mtime.toISOString(),
        ...(meta ? {
          cwd: meta.cwd, originator: meta.originator, provider: meta.provider,
          source: meta.source, threadSource: meta.threadSource,
          startedAt: meta.startedAt, ...projectOf(meta.cwd),
        } : {}),
      });
      // session_index 里没有标题时，用第一条用户消息兜底
      if (!existing?.title && meta) {
        const derived = await deriveTitle(file, meta.headBytes || 0);
        if (derived) upsertSession(sid, { title: derived, titleDerived: true });
      }
    } catch { /* 忽略消失的文件 */ }
  }
  return count;
}

// 轮询是主检测手段，fs.watch 只是加速器。
// 原因（实测）：续接旧会话时 Codex 会把新内容追加回**原始文件**，而该文件位于
// 按创建日期归档的旧目录（如 sessions/2026/07/27/）。这类文件在 daemon 启动时是"冷"的，
// 若只靠 fs.watch + 热文件轮询，首条事件要等到全量慢扫才出现，表现为"续接的会话监听不到"。
// 因此这里对**所有已跟踪文件**做 stat 轮询：141 个文件的 stat 开销在毫秒级，完全可接受。
// 每轮 stat 所有已跟踪文件。实测 67 个文件的全量 stat 仅 1ms，
// 不值得为此分级——之前按"是否近期活跃"降频到 10s，反而让续接旧会话的
// 检测延迟回升到 8s（fs.watch 掩盖了这一点，仅轮询模式下才暴露）。
const hot = new Map();                  // file -> lastActiveMs（仅用于观测/清理）
const HOT_TTL_MS = 60 * 60 * 1000;
const POLL_MS = 2000;

function markHot(file) { hot.set(file, Date.now()); }

/**
 * 归档/取消归档会把 rollout 文件在 sessions/ 与 archived_sessions/ 之间移动。
 * 偏移量按路径记录，移动后新路径会被当成新文件从头重放 —— 一个 20MB 的会话
 * 会瞬间灌出上万条"新"事件。因此发现新路径时，先看是否只是同一会话换了位置。
 */
function adoptMovedFile(file) {
  const sid = sessionIdFromFilename(file);
  if (!sid) return false;
  for (const [oldPath, t] of tails) {
    if (oldPath === file) continue;
    if (sessionIdFromFilename(oldPath) !== sid) continue;
    if (fs.existsSync(oldPath)) continue;          // 旧路径还在，说明不是移动
    tails.set(file, t);
    tails.delete(oldPath);
    hot.delete(oldPath);
    upsertSession(sid, { file, archived: isArchived(file) });
    return true;
  }
  return false;
}

function isArchived(file) {
  return file.startsWith(WATCH_DIRS[1]);
}

async function scanDirForJsonl(dir, into) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    if (tails.has(file)) continue;
    if (adoptMovedFile(file)) { into.push([file, false]); continue; }  // 沿用原偏移量
    into.push([file, true]);                                           // 真正的新文件才从头读
  }
}

function watchDirs() {
  if (NO_FSWATCH) return;
  for (const dir of WATCH_DIRS) {
    if (!fs.existsSync(dir)) continue;
    fs.watch(dir, { recursive: true }, (_evt, filename) => {
      if (!filename) return;
      const full = path.join(dir, filename);
      if (filename.endsWith('.jsonl')) {
        markHot(full);
        const isNew = !tails.has(full) && !adoptMovedFile(full);      // 归档移动不算新文件
        markDirty(full, isNew);
      } else {
        // 目录级合并事件：扫描该目录下的 jsonl
        fsp.stat(full).then(async st => {
          if (!st.isDirectory()) return;
          const found = [];
          await scanDirForJsonl(full, found);
          for (const [f, fromStart] of found) markDirty(f, fromStart);
        }).catch(() => {});
      }
    });
  }
}

let polling = false;
let pollTick = 0;

function startPolling() {
  setInterval(async () => {
    if (polling) return;                                // 上一轮未完成则跳过，避免堆积
    polling = true;
    try {
      const now = Date.now();
      pollTick++;
      const targets = [];

      // 1) 所有已跟踪文件，每轮都查（stat 极廉价，见上方说明）
      for (const file of tails.keys()) targets.push([file, false]);
      // 2) 发现新文件：今天的目录 + archived（平铺）
      const d = new Date();
      const today = path.join(
        WATCH_DIRS[0],
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
      );
      await scanDirForJsonl(today, targets);
      await scanDirForJsonl(WATCH_DIRS[1], targets);

      // 3) 每 5 分钟重扫全树，捕获跨天/被移动的文件
      if (pollTick % 150 === 0) {
        for (const dir of WATCH_DIRS) {
          let entries;
          try { entries = await fsp.readdir(dir, { recursive: true }); } catch { continue; }
          for (const rel of entries) {
            if (!rel.endsWith('.jsonl')) continue;
            const f = path.join(dir, rel);
            if (!tails.has(f)) targets.push([f, true]);
          }
        }
      }

      // 与 fs.watch 触发的待读文件合并，统一成一批（保证跨会话按时间排序）
      for (const [f, fromStart] of targets) markDirty(f, fromStart);
      if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
      await drain();
      for (const [file, ts] of hot) if (now - ts > HOT_TTL_MS) hot.delete(file);
    } finally {
      polling = false;
    }
  }, POLL_MS).unref();
}

// ---------- session_index.jsonl（会话标题）----------

let indexOffset = 0;

async function readIndex(fromStart) {
  let st;
  try { st = await fsp.stat(INDEX_FILE); } catch { return; }
  if (fromStart) indexOffset = 0;
  if (st.size < indexOffset) indexOffset = 0;
  if (st.size === indexOffset) return;
  const fh = await fsp.open(INDEX_FILE, 'r');
  try {
    const buf = Buffer.alloc(st.size - indexOffset);
    await fh.read(buf, 0, buf.length, indexOffset);
    indexOffset = st.size;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.id) upsertSession(rec.id, { title: rec.thread_name, updatedAt: rec.updated_at });
      } catch { /* 半行，忽略 */ }
    }
  } finally {
    await fh.close();
  }
}

function watchIndex() {
  const dir = path.dirname(INDEX_FILE);
  if (!fs.existsSync(dir)) return;
  fs.watch(dir, (_evt, filename) => {
    if (filename === path.basename(INDEX_FILE)) {
      readIndex(false).catch(() => {});
    }
  });
}

// ---------- 控制通道（托管 codex app-server 子进程）----------

/** approvalId -> { method, params, respond, ts } — 等待手机/客户端答复的审批 */
const approvals = new Map();
let ctl = null;

// Codex 判定的「用户可见线程」集合。由 app-server 的 thread/list 提供，
// 是决定某个会话该不该出现在列表里的权威依据（详见 visibilityAllows）。
let visibleThreads = null;
let visibleFetchedAt = 0;
const VISIBLE_TTL_MS = 60_000;

async function refreshVisibleThreads(force = false) {
  if (!ctl) return;
  if (!force && Date.now() - visibleFetchedAt < VISIBLE_TTL_MS) return;
  try {
    const ids = await ctl.listVisibleThreadIds();
    if (ids.size) { visibleThreads = ids; visibleFetchedAt = Date.now(); }
  } catch (e) {
    if (VERBOSE) console.log(`${C.dim}[ctl] 刷新可见线程失败: ${e.message}${C.reset}`);
  }
}

/**
 * 某个会话是否该出现在列表里。
 *
 * 优先用 Codex 自己的判定（app-server thread/list 的默认口径，与 Desktop 侧栏一致）——
 * 用户能在 Desktop 里直接看到的就应该出现，哪怕它是由另一个会话派生出来的。
 * 控制通道关闭或尚未就绪时，退回按 thread_source 粗判。
 */
function visibilityAllows(s, pinnedSet) {
  if (pinnedSet && pinnedSet.has(s.id)) return true;      // 用户显式置顶的一律保留
  if (visibleThreads) return visibleThreads.has(s.id);
  return !s.threadSource || s.threadSource === 'user';
}

// 服务端可能发来的审批/输入请求 → 挂起并广播到 SSE，等待 POST /approvals/:id
const SERVER_REQUEST_KINDS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'execCommandApproval',
  'applyPatchApproval',
]);


function startControl() {
  ctl = new AppServerClient({
    log: m => VERBOSE && console.log(`${C.dim}[ctl] ${m}${C.reset}`),
    onServerRequest(method, params, respond) {
      if (!SERVER_REQUEST_KINDS.has(method)) {
        // 未知的服务端请求：记录并拒绝，避免永久挂起
        console.log(`${C.yellow}[ctl] 未处理的服务端请求 ${method}，已拒绝${C.reset}`);
        respond({ decision: LEGACY_METHODS.has(method) ? 'abort' : 'decline' });
        return;
      }
      const id = crypto.randomUUID().slice(0, 8);
      const info = describeApproval(method, params);
      approvals.set(id, { method, params, respond, ts: Date.now(), info });
      emit({
        ts: new Date().toISOString(),
        session_id: params?.threadId ?? null,
        kind: 'approval_request',
        approval_id: id,
        method,
        ...info,                 // title / command / cwd / reason / summary…
        detail: clip(params, 1200),
      });
    },
    onNotification(method, params) {
      // Codex 自己区分两种「在等你」，只处理其中一种是不够的：
      //   waitingOnApproval  —— 结构化审批（有 approval_request 事件）
      //   waitingOnUserInput —— 模型用文字问你，等一条文字回复
      // 后者在协议里没有任何请求，只是线程状态变了。不监听 thread/status/changed
      // 就完全看不到，而它恰恰是实际使用中最常见的「卡住等我」。
      if (method === 'thread/status/changed' && params?.threadId) {
        const flags = params.status?.activeFlags || [];
        emit({
          ts: new Date().toISOString(),
          session_id: params.threadId,
          kind: 'thread_status',
          status: params.status?.type,
          waitingOnUserInput: flags.includes('waitingOnUserInput'),
          waitingOnApproval: flags.includes('waitingOnApproval'),
        });
        return;
      }
      // 会话内容由 JSONL watcher 提供，这里只透传 turn 级状态与错误
      if (method === 'turn/failed' || method === 'error') {
        emit({ ts: new Date().toISOString(), session_id: params?.threadId ?? null, kind: 'ctl_error', method, detail: clip(params, 600) });
      }
    },
  });
  ctl.start();
  // 可见线程集合由 Codex 自身判定，启动后尽早拉一次，之后按 TTL 惰性刷新
  ctl.ready?.then(() => refreshVisibleThreads(true)).then(() => {
    if (visibleThreads) {
      console.log(`${C.dim}用户可见线程: ${visibleThreads.size} 条（由 Codex thread/list 判定）${C.reset}`);
    }
  }).catch(() => {});
}

// 不同审批方法的决策枚举不同：v2 的 item/* 用 accept/decline，
// 旧版 execCommandApproval / applyPatchApproval 用 approved/denied。
// 对外统一暴露 allow / allow_always / deny / abort，在此映射到各自的协议值。
const DECISION_MAP = {
  v2: { allow: 'accept', allow_always: 'acceptForSession', deny: 'decline', abort: 'cancel' },
  legacy: { allow: 'approved', allow_always: 'approved_for_session', deny: { denied: { rejection: 'denied from mobile' } }, abort: 'abort' },
};
const LEGACY_METHODS = new Set(['execCommandApproval', 'applyPatchApproval']);

function mapDecision(method, decision) {
  const table = LEGACY_METHODS.has(method) ? DECISION_MAP.legacy : DECISION_MAP.v2;
  if (decision in table) return table[decision];
  return decision;  // 已是协议原生值（如 acceptForSession）则直接透传
}

function resolveApproval(id, decision) {
  const a = approvals.get(id);
  if (!a) return null;
  approvals.delete(id);
  const mapped = mapDecision(a.method, decision);
  a.respond({ decision: mapped });
  emit({ ts: new Date().toISOString(), session_id: a.params?.threadId ?? null, kind: 'approval_resolved', approval_id: id, decision, mapped });
  return { ...a, mapped };
}

// ---------- HTTP: SSE + 会话目录 + 控制接口 + 调试页 ----------

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// 不再使用通配 CORS：控制接口能执行任意命令，任何页面都不该有资格调用它。
// 调试页与 daemon 同源，不需要 CORS 头；真正的客户端（手机 App / 中继）不是浏览器，也不受 CORS 约束。
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj, null, 2));
}

async function handleControl(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // e.g. ['threads', ':id', 'turns']
  // 只接管控制类路径，其余交回主路由（否则 --no-control 会把只读接口也吞掉）
  if (seg[0] !== 'threads' && seg[0] !== 'approvals') return false;
  if (!ctl) return sendJson(res, 503, { error: 'control channel disabled (--no-control)' });
  try {
    // GET /threads — app-server 视角的线程列表（比 session_index 更丰富）
    if (req.method === 'GET' && url.pathname === '/threads') {
      const params = {};
      if (url.searchParams.get('limit')) params.limit = Number(url.searchParams.get('limit'));
      if (url.searchParams.get('cursor')) params.cursor = url.searchParams.get('cursor');
      if (url.searchParams.get('search')) params.searchTerm = url.searchParams.get('search');
      return sendJson(res, 200, await ctl.listThreads(params));
    }
    // POST /threads {cwd, approvalPolicy?, model?} — 新建线程
    if (req.method === 'POST' && url.pathname === '/threads') {
      const body = await readBody(req);
      if (!body.cwd) return sendJson(res, 400, { error: 'cwd is required' });
      return sendJson(res, 200, await ctl.startThread(body));
    }
    // POST /threads/:id/turns {text, ...} — 发送指令
    if (req.method === 'POST' && seg[0] === 'threads' && seg[2] === 'turns') {
      const body = await readBody(req);
      if (!body.text) return sendJson(res, 400, { error: 'text is required' });
      const { text, ...extra } = body;
      const result = await ctl.startTurn(seg[1], text, extra);
      remoteTurns.add(seg[1]);   // 记下发起来源，完成时据此决定要不要推送
      return sendJson(res, 200, result);
    }
    // POST /threads/:id/interrupt — 打断当前 turn
    if (req.method === 'POST' && seg[0] === 'threads' && seg[2] === 'interrupt') {
      return sendJson(res, 200, await ctl.interruptTurn(seg[1]));
    }
    // POST /threads/:id/steer {text} — 追加引导当前 turn
    if (req.method === 'POST' && seg[0] === 'threads' && seg[2] === 'steer') {
      const body = await readBody(req);
      if (!body.text) return sendJson(res, 400, { error: 'text is required' });
      return sendJson(res, 200, await ctl.steerTurn(seg[1], body.text));
    }
    // GET /approvals — 待审批列表
    if (req.method === 'GET' && url.pathname === '/approvals') {
      return sendJson(res, 200, [...approvals.entries()].map(([id, a]) => ({
        id, method: a.method, ts: a.ts,
        session_id: a.params?.threadId ?? null,
        ...a.info,                        // 客户端据此渲染，无需再解析原始 params
        detail: clip(a.params, 1200),
      })));
    }
    // POST /approvals/:id {decision} — 答复审批
    if (req.method === 'POST' && seg[0] === 'approvals' && seg[1]) {
      const body = await readBody(req);
      if (!body.decision) return sendJson(res, 400, { error: 'decision is required: allow | allow_always | deny | abort' });
      const a = resolveApproval(seg[1], body.decision);
      if (!a) return sendJson(res, 404, { error: 'approval not found (already resolved?)' });
      return sendJson(res, 200, { ok: true, approval_id: seg[1], decision: body.decision, sent: a.mapped });
    }
    return false; // 未匹配，交回主路由
  } catch (e) {
    return sendJson(res, e.status || 500, { error: e.message, code: e.code, data: e.data });
  }
}

const DEBUG_PAGE = `<!doctype html><meta charset="utf-8"><title>codex-watchd</title>
<style>
body{font:13px/1.5 ui-monospace,monospace;background:#111;color:#ddd;margin:0;padding:1rem;
  display:grid;grid-template-columns:320px 1fr;gap:1rem;height:100vh;box-sizing:border-box}
h1{font-size:1rem;margin:0 0 .5rem}h2{font-size:.8rem;color:#888;margin:.8rem 0 .3rem}
aside,main{overflow:auto}
.k{color:#7dd3fc}.user{color:#86efac;font-weight:bold}.tool{color:#fde047}.appr{color:#f87171;font-weight:bold}
.dim{color:#666}#log div{border-bottom:1px solid #222;padding:2px 0;white-space:pre-wrap;word-break:break-all}
#approvals div{background:#2a1a1a;border:1px solid #f87171;padding:.5rem;margin:.3rem 0;border-radius:4px}
button{font:inherit;margin-right:.4rem;padding:.2rem .6rem;cursor:pointer}
.s{padding:.35rem .5rem;border-radius:4px;cursor:pointer;border:1px solid #222;margin:.2rem 0}
.s:hover{background:#1a1a1a}.s.sel{border-color:#7dd3fc;background:#12222b}
.badge{float:right;font-size:.7rem;padding:0 .3rem;border-radius:3px}
.running{background:#1e40af}.waiting_approval{background:#b91c1c}.idle{background:#333}
.aborted{background:#78350f}.error{background:#7f1d1d}
.proj{color:#a78bfa;font-weight:bold;margin-top:.6rem}
</style>
<aside>
  <h1>codex-watchd</h1>
  <div><button onclick="sel(null)">全部会话</button></div>
  <div id="approvals"></div>
  <h2>项目 / 会话</h2>
  <div id="tree"></div>
</aside>
<main><h2 id="ctx">实时事件流（全部）</h2><div id="log"></div></main>
<script>
const TOKEN='__TOKEN__';
const q=s=>s+(s.includes('?')?'&':'?')+'token='+encodeURIComponent(TOKEN);
const api=(p,o={})=>fetch(q(p),{...o,headers:{...(o.headers||{}),'Authorization':'Bearer '+TOKEN}});
const log=document.getElementById('log'), appr=document.getElementById('approvals'),
      tree=document.getElementById('tree'), ctx=document.getElementById('ctx');
let cur=null, es=null;
function decide(id,d){api('/approvals/'+id,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({decision:d})}); const el=document.getElementById('ap-'+id); if(el)el.remove();}
function sel(id){cur=id; log.innerHTML=''; ctx.textContent='实时事件流（'+(id?id.slice(-8):'全部')+'）';
  document.querySelectorAll('.s').forEach(e=>e.classList.toggle('sel',e.dataset.id===id)); connect();}
function connect(){ if(es)es.close();
  es=new EventSource(q('/events?replay=80'+(cur?'&session='+cur:''))); es.onmessage=onEvent; }
function onEvent(e){
  const ev=JSON.parse(e.data);
  if(ev.kind==='approval_request'){
    const box=document.createElement('div'); box.id='ap-'+ev.approval_id;
    box.innerHTML='<b>🔐 需要审批</b><br><span class="dim">'+(ev.method||'')+'</span><br>';
    for(const [d,l] of [['allow','允许'],['allow_always','始终允许'],['deny','拒绝'],['abort','中止']]){
      const b=document.createElement('button'); b.textContent=l; b.onclick=()=>decide(ev.approval_id,d); box.appendChild(b);
    }
    appr.prepend(box); refresh();
  }
  if(ev.kind==='approval_resolved'){const el=document.getElementById('ap-'+ev.approval_id); if(el)el.remove();}
  if(['turn_started','turn_complete','turn_aborted','session_meta'].includes(ev.kind)) refresh();
  const d=document.createElement('div');
  const cls=ev.kind==='user_message'?'user':ev.kind==='tool_call'?'tool':ev.kind.startsWith('approval')?'appr':'k';
  d.innerHTML='<span class="dim">'+(ev.ts||'').slice(11,19)+'</span> <b>['+(ev.session_id||'').slice(-8)+']</b> <span class="'+cls+'">'+ev.kind+'</span> '+
    ((ev.text??ev.name??ev.output??ev.method??ev.model??'')+(ev.args?' '+ev.args:'')).slice(0,500).replace(/</g,'&lt;');
  log.prepend(d);
}
let timer=null;
function refresh(){ clearTimeout(timer); timer=setTimeout(load,300); }
async function load(){
  const gs=await (await api('/projects?days=3')).json();
  tree.innerHTML='';
  for(const g of gs){
    const h=document.createElement('div'); h.className='proj';
    h.textContent=g.project+' ('+g.sessions.length+')'+(g.attention?' 🔐'+g.attention:'')+(g.running?' ▶'+g.running:'');
    tree.appendChild(h);
    for(const s of g.sessions){
      const d=document.createElement('div'); d.className='s'+(s.id===cur?' sel':''); d.dataset.id=s.id;
      d.innerHTML='<span class="badge '+(s.status||'idle')+'">'+(s.status||'idle')+'</span>'+
        (s.title||s.id.slice(-8)).replace(/</g,'&lt;')+
        (s.worktree?'<br><span class="dim">wt:'+s.worktree+'</span>':'');
      d.onclick=()=>sel(s.id); tree.appendChild(d);
    }
  }
}
load(); connect(); setInterval(load,5000);
</script>`;

const LOGIN_PAGE = `<!doctype html><meta charset="utf-8"><title>codex-watchd</title>
<style>body{font:14px/1.6 ui-monospace,monospace;background:#111;color:#ddd;padding:2rem;max-width:640px}
code{background:#222;padding:.15rem .4rem;border-radius:3px}a{color:#7dd3fc}</style>
<h2>需要访问令牌</h2>
<p>本页面与所有接口都需要 token。启动 daemon 时终端会打印带 token 的完整地址，直接打开那个链接即可。</p>
<p>令牌保存在 <code>~/.codex-watchd/auth.json</code>（权限 0600）。查看：</p>
<p><code>node daemon/codex-watchd.js --list-devices</code></p>`;

function sendLoginPage(res) {
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(LOGIN_PAGE);
}

let auth;
let relay = null;
let push = null;

// 由手机（中继）发起、尚未结束的 turn 所在线程。发起人必然不在电脑前，
// 这些 turn 完成时要推送（电脑本地发起的按「不打扰」逻辑）。
const remoteTurns = new Set();

/**
 * 推送：只在「需要你动手」时发，且内容加密。
 *
 * 推送体经过 APNs 服务器，Apple 能看到明文部分，所以真实内容
 * （命令、会话标题）加密放进自定义字段，由客户端扩展本地解密后再渲染；
 * 明文部分只写无信息量的占位。
 */
function maybePush(ev) {
  if (!push || !relay) return;
  const session = sessions.get(ev.session_id);
  const remoteInitiated = (ev.kind === 'turn_complete' || ev.kind === 'turn_aborted')
    && remoteTurns.delete(ev.session_id);   // 一次性消费
  const info = pushableEvent(ev, session, { remoteInitiated });
  if (!info) return;

  for (const dev of auth.devices) {
    if (!dev.pushToken) continue;
    // 与该设备协商过的密钥用于加密推送内容；没协商过就只发占位
    const key = relay.peers.get(dev.peerKey);
    const sealed = key ? relay.sealFor(dev.peerKey, {
      title: info.title, body: info.body, subtitle: info.subtitle,
      sessionId: ev.session_id, reason: info.reason,
    }) : null;

    push.send(dev.pushToken, {
      // 明文占位：APNs 看得到，所以不能带真实内容
      title: sealed ? '有一条需要处理' : info.title,
      body: sealed ? '打开查看' : info.body,
      ciphertext: sealed,
      threadId: ev.session_id,
      collapseId: info.collapseId,
    }).then(r => {
      if (r.gone) {                      // 410：token 已失效
        delete dev.pushToken;
        auth.save().catch(() => {});
        console.log(`${C.dim}[push] 设备 ${dev.id} 的 token 已失效，已移除${C.reset}`);
      } else if (!r.ok && VERBOSE) {
        console.log(`${C.dim}[push] 发送失败: ${r.error}${C.reset}`);
      }
    });
  }
}

async function startPush() {
  const cfg = auth.raw?.apns;
  if (!cfg?.keyId || !cfg?.teamId || !cfg?.bundleId || !(cfg.p8Path || cfg.p8)) {
    console.log(`${C.dim}推送: 未配置（需在 ~/.codex-watchd/auth.json 填写 apns 段）${C.reset}`);
    return;
  }
  try {
    push = new PushSender(cfg, m => console.log(`${C.dim}[push] ${m}${C.reset}`));
    console.log(`${C.green}推送${C.reset} APNs ${cfg.production ? '生产' : '沙盒'}环境, bundle=${cfg.bundleId}`);
  } catch (e) {
    console.error(`${C.red}推送初始化失败: ${e.message}${C.reset}`);
  }
}

/**
 * 把手机经中继发来的请求，转成一次本机回环 HTTP 调用。
 *
 * 这样做是刻意的：鉴权、权限档位、CSRF/Host 校验全部复用同一套代码路径。
 * 如果给中继单开一条分支，两边的规则迟早会漂移，而漂移的那一侧就是漏洞。
 * 回环这一跳的开销可以忽略。
 */
function proxyToSelf({ method = 'GET', path: p = '/', body, token }) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        let parsed = b;
        try { parsed = JSON.parse(b); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', e => resolve({ status: 502, body: { error: e.message } }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function startRelay() {
  if (!RELAY_URL) return;
  if (!auth.enabled) {
    console.error(`${C.red}拒绝启动中继：--no-auth 下不能接入中继。${C.reset}`);
    process.exit(1);
  }
  const id = await ensureRelayIdentity();
  relay = new RelayConnector({
    relayUrl: RELAY_URL,
    roomId: id.roomId,
    secret: RELAY_SECRET,
    keys: { publicKey: id.publicKey, privateKey: id.privateKey },
    log: m => console.log(`${C.dim}[relay] ${m}${C.reset}`),
    onRequest: (req) => proxyToSelf(req),
  });
  relay.start();

  console.log(`${C.green}中继${C.reset} ${RELAY_URL}  room=${id.roomId}`);
  console.log(`${C.dim}  配对新设备: --pair --pair-scope read|approve|control${C.reset}`);
}

async function ensureRelayIdentity() {
  const a = await new Auth({ enabled: true }).load();
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch {}
  if (!raw.relay) {
    const kp = generateKeyPair();
    raw.relay = {
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      roomId: crypto.randomBytes(16).toString('base64url'),
    };
    raw.devices = raw.devices || a.devices;
    fs.writeFileSync(`${AUTH_FILE}.tmp`, JSON.stringify(raw, null, 2), { mode: 0o600 });
    fs.renameSync(`${AUTH_FILE}.tmp`, AUTH_FILE);
  }
  return raw.relay;
}

async function runPairing() {
  if (!RELAY_URL) {
    console.error(`${C.red}--pair 需要同时指定 --relay <ws://...>${C.reset}`);
    process.exitCode = 1; return;
  }
  const id = await ensureRelayIdentity();
  const a = await new Auth({ enabled: true }).load();
  const dev = await a.addDevice(`paired-${new Date().toISOString().slice(0, 16)}`, PAIR_SCOPE);
  const payload = Buffer.from(JSON.stringify({
    v: 1, relay: RELAY_URL, room: id.roomId, hostKey: id.publicKey,
    token: dev.token, scope: dev.scope,
    ...(RELAY_SECRET ? { secret: RELAY_SECRET } : {}),
  })).toString('base64url');

  console.log(`${C.bold}配对信息${C.reset}（有效期内一次性使用，勿转发给他人）`);
  console.log(`  设备 id: ${dev.id}   权限: ${C.bold}${dev.scope}${C.reset}`);
  console.log(`\napiagentcontrol://pair?d=${payload}\n`);
  console.log(`${C.dim}装了 qrencode 可直接生成二维码：${C.reset}`);
  console.log(`${C.dim}  qrencode -t ANSIUTF8 "apiagentcontrol://pair?d=${payload.slice(0, 24)}..."${C.reset}`);
  if (PAIR_SCOPE === 'control') {
    console.log(`${C.yellow}注意：control 档位等同远程 shell，仅授予你完全信任的设备。${C.reset}`);
  }
}

async function runDeviceCommands() {
  const a = await new Auth({ enabled: true }).load();
  if (LIST_DEVICES) {
    console.log(`${C.bold}已授权设备${C.reset}  (${AUTH_FILE})`);
    for (const d of a.devices) {
      console.log(`  ${C.cyan}${d.id}${C.reset}  ${d.name}  [${d.scope}]  最后使用: ${d.lastSeen || '从未'}`);
      console.log(`      token: ${d.token}`);
    }
    return true;
  }
  if (ADD_DEVICE) {
    if (!SCOPES.includes(DEVICE_SCOPE)) {
      console.error(`${C.red}无效的 --scope: ${DEVICE_SCOPE}${C.reset}（可选 ${SCOPES.join(' / ')}）`);
      process.exitCode = 1; return true;
    }
    const d = await a.addDevice(ADD_DEVICE, DEVICE_SCOPE);
    console.log(`${C.green}已添加设备${C.reset} ${d.name}  id=${d.id}  scope=${d.scope}`);
    console.log(`token: ${C.bold}${d.token}${C.reset}`);
    if (DEVICE_SCOPE === 'control') {
      console.log(`${C.yellow}注意：control 档位等同远程 shell，仅授予你完全信任的设备。${C.reset}`);
    }
    return true;
  }
  if (REVOKE_DEVICE) {
    if (REVOKE_DEVICE === 'local') { console.error('不能吊销本机主 token'); process.exitCode = 1; return true; }
    console.log(await a.revokeDevice(REVOKE_DEVICE) ? `${C.green}已吊销 ${REVOKE_DEVICE}${C.reset}` : `未找到设备 ${REVOKE_DEVICE}`);
    return true;
  }
  return false;
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // 每个端点声明自己需要的权限档位；鉴权在路由之前统一执行
    const need =
      url.pathname === '/' ? 'read'
      : url.pathname.startsWith('/approvals') ? (req.method === 'POST' ? 'approve' : 'read')
      : url.pathname.startsWith('/threads') ? (req.method === 'POST' ? 'control' : 'read')
      : url.pathname.startsWith('/devices') ? 'read'
      : 'read';
    const verdict = auth.check(req, url, need);
    if (!verdict.ok) {
      // 调试页允许无 token 打开（只回一个引导页，不含任何会话数据）
      if (url.pathname === '/' && verdict.status === 401) return sendLoginPage(res);
      return sendJson(res, verdict.status, { error: verdict.error });
    }

    if (await handleControl(req, res, url) !== false) return;

    // 手机注册它的 APNs device token。同时记下它的中继公钥，
    // 推送内容要用这台设备的会话密钥加密 —— 不同设备密钥不同。
    if (url.pathname === '/devices/push-token' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.token) return sendJson(res, 400, { error: 'token is required' });
      const dev = auth.devices.find(d => d.id === verdict.device.id);
      if (!dev) return sendJson(res, 404, { error: 'device not found' });
      dev.pushToken = String(body.token).replace(/[^0-9a-fA-F]/g, '');
      if (body.peerKey) dev.peerKey = String(body.peerKey);
      await auth.save();
      console.log(`${C.dim}[push] 设备 ${dev.id}（${dev.name}）已注册推送 token${C.reset}`);
      return sendJson(res, 200, { ok: true, pushEnabled: !!push });
    }

    // 标记会话已读。未读数此前只增不减，进过会话也一直挂着红点。
    if (url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/read') && req.method === 'POST') {
      const sid = url.pathname.split('/')[2];
      const s = sessions.get(sid);
      if (!s) return sendJson(res, 404, { error: 'session not found' });
      s.unread = 0;
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/me') {
      // 客户端据此获知**当前**权限档位。配对时的档位只是快照，
      // 之后可能被吊销或调整；客户端若一直信任本地快照，就会显示自己其实没有的权限。
      const d = verdict.device;
      return sendJson(res, 200, { deviceId: d.id, name: d.name ?? d.id, scope: d.scope });
    }

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res._session = url.searchParams.get('session') || null;
      const kinds = url.searchParams.get('kinds');
      res._kinds = kinds ? new Set(kinds.split(',')) : null;
      const replay = Math.min(Number(url.searchParams.get('replay') || 0), RING_MAX);
      for (const ev of ring.slice(-replay)) {
        if (res._session && ev.session_id !== res._session) continue;
        if (res._kinds && !res._kinds.has(ev.kind)) continue;
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
    } else if (url.pathname === '/sessions') {
      const active = url.searchParams.get('active') === '1';
      const withArchived = url.searchParams.get('archived') === '1';
      const withSubagent = url.searchParams.get('subagent') === '1';
      const ATTENTION = new Set(['waiting_approval', 'waiting_input']);
      await refreshVisibleThreads();
      const pinned = new Set(desktop.pinnedOrder);
      let list = [...sessions.values()];
      if (!withArchived) list = list.filter(s => !s.archived);
      if (!withSubagent) list = list.filter(s => visibilityAllows(s, pinned));
      if (active) list = list.filter(s => s.status === 'running' || ATTENTION.has(s.status));
      list = list
        .sort((a, b) => String(b.lastActivity || b.updatedAt || '').localeCompare(String(a.lastActivity || a.updatedAt || '')))
        .slice(0, Number(url.searchParams.get('limit') || 100));
      sendJson(res, 200, list);
    } else if (url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/history')) {
      // 会话历史回填：手机上点进会话要能往上翻，而不是只看得到订阅之后的新事件。
      // before 为字节偏移游标（省略则取最新一页），返回按时间正序。
      const sid = url.pathname.split('/')[2];
      const s = sessions.get(sid);
      if (!s?.file) return sendJson(res, 404, { error: 'session not found' });
      const before = url.searchParams.get('before');
      const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
      const kinds = url.searchParams.get('kinds');
      const filter = kinds ? new Set(kinds.split(',')) : null;
      const page = await readHistoryBackward(s.file, before ? Number(before) : null, limit);
      if (filter) page.events = page.events.filter(e => filter.has(e.kind));
      sendJson(res, 200, page);
    } else if (url.pathname === '/projects') {
      // App 首页视图。对齐 Codex Desktop 侧栏的三段结构：置顶 / 项目 / 最近，
      // 因为那是用户自己整理出来的组织方式，比任何自动推导都准。
      const days = Number(url.searchParams.get('days') ?? 7);
      const withArchived = url.searchParams.get('archived') === '1';
      const cutoff = days > 0 ? Date.now() - days * 864e5 : 0;
      const recencyOf = s => s.lastActivity || s.updatedAt || '';
      desktop.reload();

      const withSub = url.searchParams.get('subagent') === '1';
      const pinnedSet = new Set(desktop.pinnedOrder);
      await refreshVisibleThreads();
      const visible = [];
      for (const s of sessions.values()) {
        if (s.archived && !withArchived) continue;   // 归档的不进首页
        if (!withSub && !visibilityAllows(s, pinnedSet)) continue;
        const r = recencyOf(s);
        if (cutoff && (!r || Date.parse(r) < cutoff)) continue;
        visible.push(s);
      }

      const tally = list => ({
        // 「需要我处理」= 等审批 + 等回文字，两者都是卡住在等人
        attention: list.filter(s => s.status === 'waiting_approval' || s.status === 'waiting_input').length,
        running: list.filter(s => s.status === 'running').length,
        lastActivity: list.reduce((m, s) => recencyOf(s) > m ? recencyOf(s) : m, ''),
      });
      const byRecency = (a, b) => recencyOf(b).localeCompare(recencyOf(a));

      const out = [];
      const claimed = new Set();

      // 1) 置顶 —— 顺序完全按用户在 Desktop 里排的来，不按时间重排
      const pinned = [];
      for (const id of desktop.pinnedOrder) {
        const s = visible.find(v => v.id === id);
        if (s) { pinned.push(s); claimed.add(s.id); }
      }
      if (pinned.length) out.push({ project: '置顶', kind: 'pinned', sessions: pinned, ...tally(pinned) });

      // 2) 项目 —— 用 Desktop 的项目实体，而非从 cwd 猜
      for (const p of desktop.projects) {
        const list = visible.filter(s => !claimed.has(s.id) && s.projectId === p.id);
        if (!list.length) continue;
        list.forEach(s => claimed.add(s.id));
        list.sort(byRecency);
        out.push({ project: p.name, kind: 'project', projectId: p.id, sessions: list, ...tally(list) });
      }

      // 3) 最近 —— 未归入项目的会话。Desktop 里这段是平铺的，不再细分：
      // 这些会话的 cwd 多是一次性目录（o / qu / hi-2 …），按名字分组只会得到一堆碎片。
      const rest = visible.filter(s => !claimed.has(s.id)).sort(byRecency);
      if (rest.length) out.push({ project: '最近', kind: 'recent', sessions: rest, ...tally(rest) });

      // 纯 CLI 环境（没有 Desktop 状态）下，退回按推导出的项目名分组，否则会变成一个大杂烩
      if (!desktop.available) {
        const groups = new Map();
        for (const s of visible) {
          const key = s.project || 'unknown';
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(s);
        }
        return sendJson(res, 200, [...groups.entries()].map(([name, list]) => ({
          project: name, kind: 'project', sessions: list.sort(byRecency), ...tally(list),
        })).sort((a, b) =>
          (b.attention - a.attention) || (b.running - a.running) || b.lastActivity.localeCompare(a.lastActivity)
        ));
      }

      sendJson(res, 200, out);
    } else if (url.pathname === '/') {
      // 把本次请求用的 token 注入页面，供页面内的 fetch / EventSource 使用
      const tok = Auth.extractToken(req, url) || '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DEBUG_PAGE.replace('__TOKEN__', tok.replace(/[<>"'&]/g, '')));
    } else {
      // 统一返回 JSON：客户端按 JSON 解析响应体，纯文本会让它拿到标量顶层类型
      sendJson(res, 404, { error: `no such endpoint: ${url.pathname}` });
    }
  });
  server.listen(PORT, BIND, () => {
    const shown = BIND === '0.0.0.0' ? '127.0.0.1' : BIND;
    const t = auth.enabled ? `?token=${auth.localToken}` : '';
    console.log(`${C.green}HTTP${C.reset} listening on http://${shown}:${PORT}  (bind ${BIND})`);
    console.log(`${C.bold}  调试页: http://${shown}:${PORT}/${t}${C.reset}`);
    console.log(`${C.dim}  只读: /events SSE, /sessions, /projects${C.reset}`);
    if (!NO_CONTROL) console.log(`${C.dim}  控制: GET|POST /threads, POST /threads/:id/{turns,interrupt,steer}, GET /approvals, POST /approvals/:id${C.reset}`);
    if (auth.enabled) {
      console.log(`${C.dim}  鉴权: 已启用（token 见 ~/.codex-watchd/auth.json）。添加设备: --add-device <名字> --scope read|approve|control${C.reset}`);
    } else {
      console.log(`${C.red}  鉴权: 已关闭（--no-auth）——仅限本机可信环境${C.reset}`);
    }
  });
  setInterval(() => { for (const res of sseClients) res.write(': ping\n\n'); }, 15000).unref();
}

// ---------- main ----------

(async () => {
  if (await runDeviceCommands()) return;
  if (PAIR) { await runPairing(); return; }

  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(BIND);
  // 失败要失败在安全的一侧：非回环地址上关闭鉴权，等于把一个能执行任意命令的
  // 接口暴露到网络上，这种组合一律拒绝启动。
  if (!isLoopback && NO_AUTH) {
    console.error(`${C.red}拒绝启动：--bind ${BIND} 是非回环地址，不能与 --no-auth 同时使用。${C.reset}`);
    console.error(`${C.dim}控制接口可在本机执行任意命令，暴露到网络时必须开启鉴权。${C.reset}`);
    process.exit(1);
  }
  auth = await new Auth({
    enabled: !NO_AUTH,
    bindHosts: isLoopback ? [] : [BIND],
    allowLocalIPs: !isLoopback,
    // Tailscale MagicDNS 之类的主机名需要显式放行
    allowedOrigins: ALLOW_HOSTS.flatMap(h => [`http://${h}:${PORT}`, `https://${h}:${PORT}`]),
  }).load();
  for (const h of ALLOW_HOSTS) auth.bindHosts.add(h);
  auth.port = PORT;

  console.log(`${C.bold}codex-watchd${C.reset} watching ${CODEX_HOME}`);
  desktop.reload();
  if (desktop.available) {
    console.log(`${C.dim}Desktop 侧栏: ${desktop.projects.length} 个项目, ${desktop.pinnedOrder.length} 条置顶${C.reset}`);
  }
  await readIndex(true);
  const n = await initialScan();
  console.log(`${C.dim}tracked ${n} existing jsonl files, ${sessions.size} sessions in registry; tailing from EOF${C.reset}`);
  watchDirs();
  watchIndex();
  startPolling();
  if (!NO_CONTROL) {
    startControl();
    console.log(`${C.dim}control channel: managed codex app-server child process${C.reset}`);
  }
  if (!NO_SERVER) startServer();
  if (RELAY_URL) await startRelay();
  await startPush();
})();

process.on('SIGINT', () => { if (ctl) ctl.stop(); process.exit(0); });
process.on('SIGTERM', () => { if (ctl) ctl.stop(); process.exit(0); });
