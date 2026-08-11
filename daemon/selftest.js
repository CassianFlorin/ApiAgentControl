#!/usr/bin/env node
'use strict';

/**
 * codex-watchd 自检 —— 在隔离的临时 CODEX_HOME 上验证三个已修复的行为，
 * 全程不读写真实的 ~/.codex，可安全反复运行。
 *
 *   用法: node daemon/selftest.js
 *   退出码 0 = 全部通过
 *
 * 覆盖的回归点：
 *   1. 冷文件检测   —— 续接旧会话（写回旧日期目录里的原始文件）应在 ~2s 内被捕获
 *   2. 跨会话时序   —— 多会话并行时，全局事件流必须按时间戳有序
 *   3. 元数据解析   —— session_meta 首行可达数十 KB，必须完整读出才能得到项目归属
 *   4. 半行写入     —— 一行分两次落盘时不能丢事件或产生脏数据
 */

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');

// WATCHD 可指向另一份 daemon（用于验证自检本身能抓到回归）
const DAEMON = process.env.WATCHD || path.join(__dirname, 'codex-watchd.js');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const HOME = path.join(os.tmpdir(), `codex-watchd-selftest-${process.pid}`);

const uuid = (tag) => `019fa20d-${tag}-7000-8000-${tag.repeat(3)}`;
const results = [];
let proc;

function meta(id, cwd, originator, padKB = 0, threadSource = 'user') {
  // base_instructions 用于模拟真实的超大首行（实测约 45KB）
  return JSON.stringify({
    timestamp: '2026-08-11T12:00:00.000Z',
    type: 'session_meta',
    payload: {
      id, cwd, originator, model_provider: 'custom', source: 'vscode',
      thread_source: threadSource,
      cli_version: '0.147.0', timestamp: '2026-08-11T12:00:00.000Z',
      base_instructions: { text: 'x'.repeat(padKB * 1024) },
    },
  });
}

function evt(ts, type, payload) {
  return JSON.stringify({ timestamp: ts, type, payload });
}

async function setup() {
  await fsp.rm(HOME, { recursive: true, force: true });
  // 旧日期目录：模拟"数周前创建、今天被续接"的会话
  await fsp.mkdir(path.join(HOME, 'sessions/2026/07/27'), { recursive: true });
  await fsp.mkdir(path.join(HOME, 'sessions/2026/08/11'), { recursive: true });
  await fsp.mkdir(path.join(HOME, 'archived_sessions'), { recursive: true });

  const files = {
    // 冷文件 + 45KB 超大首行 + worktree 路径
    cold: path.join(HOME, `sessions/2026/07/27/rollout-2026-07-27T13-30-38-${uuid('aaaa')}.jsonl`),
    a: path.join(HOME, `sessions/2026/08/11/rollout-2026-08-11T10-00-00-${uuid('bbbb')}.jsonl`),
    b: path.join(HOME, `sessions/2026/08/11/rollout-2026-08-11T10-00-01-${uuid('cccc')}.jsonl`),
  };
  await fsp.writeFile(files.cold, meta(uuid('aaaa'), '/Users/x/.codex/worktrees/6d98/my-repo', 'Codex Desktop', 45) + '\n');
  await fsp.writeFile(files.a, meta(uuid('bbbb'), '/Users/x/.codex/worktrees/aa11/my-repo', 'Codex Desktop') + '\n');
  await fsp.writeFile(files.b, meta(uuid('cccc'), '/Users/x/projects/other-repo', 'Codex CLI') + '\n');
  // 子代理线程：Codex 内部派生，Desktop 侧栏不显示，默认应被过滤
  files.sub = path.join(HOME, `sessions/2026/08/11/rollout-2026-08-11T10-00-02-${uuid('dddd')}.jsonl`);
  await fsp.writeFile(files.sub,
    meta(uuid('dddd'), '/Users/x/.codex/worktrees/zz99/my-repo', 'Codex Desktop', 0, 'subagent') + '\n');
  // CLI(codex-tui) 会话：内容承载形式与 Desktop 不同
  files.cli = path.join(HOME, `sessions/2026/08/11/rollout-2026-08-11T10-00-03-${uuid('eeee')}.jsonl`);
  await fsp.writeFile(files.cli,
    meta(uuid('eeee'), '/Users/x/projects/other-repo', 'codex-tui') + '\n');
  await fsp.writeFile(path.join(HOME, 'session_index.jsonl'),
    `{"id":"${uuid('aaaa')}","thread_name":"续接的旧任务","updated_at":"2026-07-27T05:30:38Z"}\n`);
  return files;
}

function startDaemon(extraArgs = []) {
  return new Promise((resolve, reject) => {
    proc = spawn('node', [DAEMON, '--home', HOME, '--port', String(PORT), '--no-control', ...extraArgs],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', d => {
      out += d;
      if (out.includes('HTTP listening')) resolve();
    });
    proc.stderr.on('data', d => process.stderr.write(`[daemon] ${d}`));
    proc.on('exit', c => reject(new Error(`daemon exited early (${c})`)));
    setTimeout(() => reject(new Error('daemon start timeout')), 15000);
  });
}

let TOKEN = '';
const withTok = p => TOKEN ? p + (p.includes('?') ? '&' : '?') + 'token=' + TOKEN : p;

/** 订阅 SSE，每条事件回调 */
function subscribe(onEvent) {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: withTok('/events') }, res => {
    let buf = '';
    res.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = frame.split('\n').find(l => l.startsWith('data: '));
        if (line) { try { onEvent(JSON.parse(line.slice(6))); } catch {} }
      }
    });
  });
  return () => req.destroy();
}

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: withTok(p) }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/** 只取状态码，可自定义头部 */
function statusOf(p, headers = {}, method = 'GET') {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '\x1b[32m✓ PASS\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

async function main() {
  // 默认关掉 fs.watch：轮询才是生产环境真正依赖的检测手段。
  // fs.watch 在这种安静的小目录树里永远好用，会掩盖轮询侧的回归
  // ——用户遇到的"续接的会话监听不到"当初就是这样躲过测试的。
  // 加 --with-fswatch 可测两者叠加的实际路径。
  const withFsWatch = process.argv.includes('--with-fswatch');
  console.log(`模式: ${withFsWatch ? 'fs.watch + 轮询' : '仅轮询（默认，更严格）'}\n`);

  const files = await setup();
  await startDaemon(withFsWatch ? [] : ['--no-fswatch']);
  await sleep(1500);   // 让 initialScan 完成

  // 自检使用真实鉴权路径：从 daemon 的配置文件里取本机 token
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(os.homedir(), '.codex-watchd/auth.json'), 'utf8'));
    TOKEN = raw.devices.find(d => d.id === 'local')?.token || '';
  } catch {}

  // ---- 安全属性 ----
  check('鉴权：无 token 的请求必须被拒绝',
    await statusOf('/sessions') === 401, `实际 ${await statusOf('/sessions')}`);
  check('鉴权：错误 token 必须被拒绝',
    await statusOf('/sessions?token=wrong-token') === 401);
  check('鉴权：正确 token 放行',
    await statusOf(withTok('/sessions')) === 200);
  check('CSRF：带外部 Origin 的请求必须被拒绝（即使 token 正确）',
    await statusOf(withTok('/sessions'), { Origin: 'https://evil.example' }) === 403);
  check('DNS rebinding：伪造 Host 必须被拒绝',
    await statusOf(withTok('/sessions'), { Host: 'evil.example' }) === 403);

  const seen = [];
  const stop = subscribe(ev => seen.push({ ...ev, _at: Date.now() }));
  await sleep(300);

  // ---- 测试 3: 元数据解析（45KB 首行）----
  const sessions = await getJson('/sessions?limit=10');
  const cold = sessions.find(s => s.id === uuid('aaaa'));
  check('元数据解析：45KB 超大首行能提取出项目/worktree',
    !!cold && cold.project === 'my-repo' && cold.worktree === '6d98',
    cold ? `project=${cold.project} worktree=${cold.worktree} title=${cold.title}` : '会话未出现在 /sessions');

  // ---- 测试 1: 冷文件（续接旧会话）检测延迟 ----
  const t0 = Date.now();
  await fsp.appendFile(files.cold,
    evt('2026-08-11T12:30:00.000Z', 'event_msg', { type: 'user_message', message: '续接旧会话的第一条消息' }) + '\n');
  let latency = null;
  for (let i = 0; i < 100; i++) {
    const hit = seen.find(e => e.text === '续接旧会话的第一条消息');
    if (hit) { latency = hit._at - t0; break; }
    await sleep(100);
  }
  check('冷文件检测：旧日期目录里的会话被续接后应 ≤3s 捕获',
    latency !== null && latency <= 3000,
    latency === null ? '10s 内未捕获（回归！）' : `实测延迟 ${latency}ms`);

  // ---- 测试 2: 跨会话时序 ----
  seen.length = 0;
  for (const t of ['01', '03', '05']) {
    await fsp.appendFile(files.a, evt(`2026-08-11T12:40:${t}.000Z`, 'event_msg', { type: 'user_message', message: `A-${t}` }) + '\n');
  }
  for (const t of ['02', '04', '06']) {
    await fsp.appendFile(files.b, evt(`2026-08-11T12:40:${t}.000Z`, 'event_msg', { type: 'user_message', message: `B-${t}` }) + '\n');
  }
  await sleep(3000);
  const order = seen.filter(e => /^[AB]-\d\d$/.test(e.text || '')).map(e => e.text);
  const expected = ['A-01', 'B-02', 'A-03', 'B-04', 'A-05', 'B-06'];
  check('跨会话时序：并行会话的事件必须按时间戳全局有序',
    JSON.stringify(order) === JSON.stringify(expected),
    `实际: ${order.join(' ')}`);

  // ---- 测试 4: 半行写入 ----
  seen.length = 0;
  const line = evt('2026-08-11T12:50:00.000Z', 'event_msg', { type: 'agent_message', message: '被拆成两半写入的消息' });
  await fsp.appendFile(files.a, line.slice(0, 40));
  await sleep(600);
  await fsp.appendFile(files.a, line.slice(40) + '\n');
  await sleep(2500);
  const halves = seen.filter(e => e.text === '被拆成两半写入的消息');
  check('半行写入：一行分两次落盘应完整还原且不重复',
    halves.length === 1, `捕获 ${halves.length} 条（应为 1）`);

  // ---- 测试 5: 项目分组 ----
  const projects = await getJson('/projects?days=0');
  const myRepo = projects.find(p => p.project === 'my-repo');
  check('项目分组：同仓库的多个 worktree 应折叠到一个项目下',
    !!myRepo && myRepo.sessions.length === 2,
    projects.map(p => `${p.project}(${p.sessions.length})`).join(' '));

  // ---- 推送触发规则 ----
  // 只推「需要你动手」的时刻。进行中的每条都推，一轮对话能炸出几十条通知，
  // 用户会直接关掉推送权限 —— 那比不做还糟。
  {
    const { pushableEvent } = require('./push');
    check('推送：审批请求会推',
      pushableEvent({ kind: 'approval_request', command: 'rm -rf x', approval_id: 'a1' }, {})?.reason === 'approval');
    check('推送：等你回复会推',
      pushableEvent({ kind: 'turn_complete', last_message: '选哪个？' },
                    { status: 'waiting_input' })?.reason === 'waiting_input');
    check('推送：单纯任务完成不推（否则一轮对话炸出几十条）',
      pushableEvent({ kind: 'turn_complete', last_message: '已完成。' }, { status: 'idle' }) === null);
    check('推送：进行中的事件不推',
      pushableEvent({ kind: 'assistant_message', text: 'x' }, { status: 'running' }) === null &&
      pushableEvent({ kind: 'tool_call', name: 'exec' }, { status: 'running' }) === null);
  }

  // ---- 未读清零 ----
  {
    const before = (await getJson('/sessions?limit=50')).find(s => s.id === uuid('cccc'));
    await new Promise(r => {
      const req = http.request({ host: '127.0.0.1', port: PORT,
        path: withTok(`/sessions/${uuid('cccc')}/read`), method: 'POST' }, res => { res.resume(); res.on('end', r); });
      req.on('error', r); req.end();
    });
    const after = (await getJson('/sessions?limit=50')).find(s => s.id === uuid('cccc'));
    check('未读可清零（此前只增不减，看过也一直挂红点）',
      (after?.unread ?? 0) === 0, `之前=${before?.unread} 之后=${after?.unread}`);
  }

  // ---- 「等你回复」的识别 ----
  // 实测：模型用文字提问后线程只是 active → idle，waitingOnUserInput **不置位** ——
  // 协议层不区分「它问了你」和「任务干完了」。而这恰恰是最常见的卡住场景，
  // 只能靠启发式。宁可漏报不可误报，否则待办会被完成态会话淹没。
  {
    seen.length = 0;
    const done = (msg) => evt('2026-08-11T13:10:00.000Z', 'event_msg',
      { type: 'task_complete', last_agent_message: msg });
    await fsp.appendFile(files.b, done('配置文件你希望使用 JSON 还是 YAML？') + '\n');
    await sleep(3000);
    let s = (await getJson('/sessions?limit=50')).find(x => x.id === uuid('cccc'));
    check('轮次以问句结束 → 标记为等你回复',
      s?.status === 'waiting_input' && s?.waitingReason === 'inferred',
      `status=${s?.status} reason=${s?.waitingReason}`);

    await fsp.appendFile(files.b, done('已完成：三个文件均已更新并通过测试。') + '\n');
    await sleep(3000);
    s = (await getJson('/sessions?limit=50')).find(x => x.id === uuid('cccc'));
    check('轮次以陈述结束 → 不应误报为等你回复',
      s?.status === 'idle', `status=${s?.status}`);

    // 回了话就该从待办里消失
    await fsp.appendFile(files.b, done('要不要我顺便更新文档？') + '\n');
    await sleep(2500);
    await fsp.appendFile(files.b,
      evt('2026-08-11T13:11:00.000Z', 'event_msg', { type: 'user_message', message: '要' }) + '\n');
    await sleep(2500);
    s = (await getJson('/sessions?limit=50')).find(x => x.id === uuid('cccc'));
    check('回复之后不再是待办',
      s?.status !== 'waiting_input' && !s?.waitingReason, `status=${s?.status}`);
  }

  // ---- /me：客户端据此获知当前档位 ----
  // 配对串里的档位只是快照。凭证被吊销或调降后，客户端若一直信任本地快照，
  // 就会显示自己其实没有的权限，还渲染出点了必然失败的按钮。
  {
    const me = await getJson(withTok('/me'));
    check('/me 返回当前设备与权限档位',
      typeof me.deviceId === 'string' && ['read', 'approve', 'control'].includes(me.scope),
      `deviceId=${me.deviceId} scope=${me.scope}`);
    check('/me 无 token 时拒绝', await statusOf('/me') === 401);
  }

  // ---- 审批详情 ----
  // 手机上必须看得见批的是什么。协议里字段散在新旧两套方法下，归一化不能漏。
  {
    const { describeApproval } = require('./approvals');
    const v2 = describeApproval('item/commandExecution/requestApproval', {
      command: "/bin/zsh -lc 'rm -rf build'", cwd: '/repo', reason: '需要清理构建产物',
    });
    check('审批详情：v2 命令执行带出命令/目录/原因',
      v2.command === "/bin/zsh -lc 'rm -rf build'" && v2.cwd === '/repo' && !!v2.reason,
      `command=${v2.command}`);

    const legacy = describeApproval('execCommandApproval', {
      parsedCmd: [{ command: 'git status' }, { command: 'git push' }], cwd: '/repo',
    });
    check('审批详情：旧版 parsedCmd 也能还原命令',
      legacy.command === 'git status && git push', `command=${legacy.command}`);

    const file = describeApproval('applyPatchApproval', {
      fileChanges: { 'src/a.ts': {}, 'src/b.ts': {} }, grantRoot: '/repo',
    });
    check('审批详情：文件修改列出受影响文件',
      file.approvalKind === 'file_change' && file.files.length === 2 && file.summary.includes('src/a.ts'));

    const net = describeApproval('item/commandExecution/requestApproval', {
      command: 'curl https://x', networkApprovalContext: { host: 'x' },
    });
    check('审批详情：联网请求被单独标记', !!net.network);

    const empty = describeApproval('item/commandExecution/requestApproval', {});
    check('审批详情：命令缺失时给出明确占位而非空白',
      empty.command === '(未提供命令内容)', `command=${empty.command}`);
  }

  // ---- 历史回填 ----
  // 手机上点进会话要能往上翻。会话文件实测可达 25MB / 7000 行，
  // 必须以字节偏移量为游标从尾部反向分页，不能整份加载。
  const h1 = await getJson(`/sessions/${uuid('bbbb')}/history?limit=3`);
  check('历史回填：返回最新一页且按时间正序',
    h1.events?.length === 3 &&
    h1.events[0].seq < h1.events[2].seq,
    `条数=${h1.events?.length} seq=${(h1.events || []).map(e => e.seq).join(',')}`);

  const h2 = await getJson(`/sessions/${uuid('bbbb')}/history?limit=3&before=${h1.nextBefore}`);
  const overlap = new Set(h1.events.map(e => e.seq));
  check('历史回填：翻页无重复且游标递减',
    h2.events.length > 0 && h2.events.every(e => !overlap.has(e.seq)) && h2.nextBefore < h1.nextBefore,
    `第二页 seq=${h2.events.map(e => e.seq).join(',')}`);

  // 一路翻到会话开头必须能终止
  let cur = h1.nextBefore, guard = 0, total = h1.events.length;
  while (guard++ < 200) {
    const p = await getJson(`/sessions/${uuid('bbbb')}/history?limit=50&before=${cur}`);
    total += p.events.length;
    if (!p.events.length || !p.hasMore) break;
    cur = p.nextBefore;
  }
  check('历史回填：能翻到会话开头并终止', guard < 200, `翻了 ${guard} 页，累计 ${total} 条`);

  check('历史事件带 seq，与实时流共用游标',
    h1.events.every(e => typeof e.seq === 'number'));

  // ---- CLI(codex-tui) 会话格式 ----
  // CLI 把内容包在 item_completed 里，与 Desktop 的 user_message/agent_message 是两套形态。
  // 不支持的话，CLI 会话在列表里只有 UUID、实时流里几乎什么都看不到。
  seen.length = 0;
  const cliItem = (type, extra) => evt('2026-08-11T13:00:00.000Z', 'event_msg',
    { type: 'item_completed', item: { type, id: 'x', ...extra } });
  await fsp.appendFile(files.cli,
    cliItem('UserMessage', { content: [{ type: 'text', text: 'CLI 发来的指令' }] }) + '\n' +
    cliItem('AgentMessage', { content: [{ type: 'text', text: 'CLI 的回复' }] }) + '\n' +
    cliItem('CommandExecution', { command: ['/bin/zsh', '-lc', 'ls -la'], aggregated_output: 'total 0' }) + '\n');
  await sleep(3000);
  check('CLI 会话：item_completed 能解析出用户消息',
    seen.some(e => e.kind === 'user_message' && e.text === 'CLI 发来的指令'));
  check('CLI 会话：item_completed 能解析出助手消息与命令执行',
    seen.some(e => e.kind === 'assistant_message' && e.text === 'CLI 的回复') &&
    seen.some(e => e.kind === 'tool_call' && (e.args || '').includes('ls -la')));

  const cliSession = (await getJson('/sessions?limit=50')).find(s => s.id === uuid('eeee'));
  check('CLI 会话：标题能从 item_completed 推导',
    cliSession?.title === 'CLI 发来的指令', `title=${cliSession?.title}`);

  // ---- 子代理线程过滤 ----
  // Codex 内部派生的子代理线程没有可读标题（实测 60 个文件里有 27 个），
  // 混进列表会淹没真正的会话。
  const listNoSub = await getJson('/sessions?limit=50');
  check('默认列表排除子代理线程',
    !listNoSub.some(s => s.id === uuid('dddd')));
  const listWithSub = await getJson('/sessions?limit=50&subagent=1');
  check('subagent=1 时可取回子代理线程',
    listWithSub.some(s => s.id === uuid('dddd')));

  // ---- 测试 6: 归档（放最后，因为会把会话 A 移出默认视图）----
  // 归档把文件从 sessions/ 移到 archived_sessions/。偏移量按路径记录，
  // 若不识别这是同一会话换了位置，新路径会被当成新文件从头重放整个历史
  // ——一个 20MB 的会话能瞬间灌出上万条"新"事件。
  seen.length = 0;
  const archivedPath = path.join(HOME, 'archived_sessions', path.basename(files.a));
  await fsp.rename(files.a, archivedPath);
  await sleep(4000);
  const replayed = seen.filter(e => /^A-\d\d$/.test(e.text || '')).length;
  check('归档移动文件后不得重放历史事件', replayed === 0, `重放了 ${replayed} 条`);

  const afterArchive = await getJson('/sessions?limit=50&archived=1');
  const movedSession = afterArchive.find(s => s.id === uuid('bbbb'));
  check('归档后的会话被标记 archived', movedSession?.archived === true,
        `archived=${movedSession?.archived}`);

  check('默认列表排除归档会话',
        !(await getJson('/sessions?limit=50')).some(s => s.id === uuid('bbbb')));
  check('默认项目分组排除归档会话',
        !(await getJson('/projects?days=0')).some(g => g.sessions.some(s => s.id === uuid('bbbb'))));

  stop();
}

main()
  .then(async () => {
    if (proc) proc.kill();
    await fsp.rm(HOME, { recursive: true, force: true });
    const failed = results.filter(r => !r.pass).length;
    console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${results.length - failed}/${results.length} 通过\x1b[0m`);
    process.exit(failed ? 1 : 0);
  })
  .catch(async e => {
    console.error('\x1b[31m自检异常:\x1b[0m', e.message);
    if (proc) proc.kill();
    await fsp.rm(HOME, { recursive: true, force: true }).catch(() => {});
    process.exit(1);
  });
