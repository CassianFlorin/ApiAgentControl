'use strict';

/**
 * 日志自轮转 —— 保证 ~/.codex-watchd 不会越长越大。
 *
 * daemon 由 launchd 拉起时，stdout/stderr 是 launchd 打开的 **O_APPEND** fd。
 * 这决定了轮转方式只能是 copytruncate，不能是 rename：
 *   - rename 之后 launchd 手里的 fd 还指向被改名的那个 inode，新日志会继续
 *     写进 daemon.log.1，而 daemon.log 永远是空的 —— 看起来"轮转成功"，实则失联。
 *   - ftruncate 不换 inode，O_APPEND 的下一次写入自动回到偏移 0，fd 依旧有效。
 *
 * 代价：截断和补回尾巴之间若恰好有一行写入，顺序会错乱一次。调试日志可以接受，
 * 换成 rename 的"正确顺序"才是真的丢日志。
 *
 * 同一目录下的 relay.log / tunnel.log 由别的进程以 >> 写入，同样是 O_APPEND，
 * 一起管掉 —— 没有别的长驻进程会替它们收尾。
 */

const fs = require('fs/promises');
const path = require('path');

const CAP = 2 * 1024 * 1024;    // 超过就轮转
const KEEP = 256 * 1024;        // 留下的尾巴，够定位最近一次异常
const EVERY_MS = 10 * 60 * 1000;

/** 单个文件：超限则原地截断，保留末尾 KEEP 字节。返回是否轮转过。 */
async function rotateFile(file, { cap = CAP, keep = KEEP } = {}) {
  let st;
  try { st = await fs.stat(file); } catch { return false; }
  if (!st.isFile() || st.size <= cap) return false;

  const fh = await fs.open(file, 'r');
  let tail;
  try {
    const buf = Buffer.alloc(keep);
    const { bytesRead } = await fh.read(buf, 0, keep, st.size - keep);
    tail = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  // 从第一个换行之后开始，别让残缺的半行做开头
  const nl = tail.indexOf(0x0a);
  if (nl >= 0) tail = tail.subarray(nl + 1);

  await fs.truncate(file, 0);
  await fs.appendFile(file,
    `--- 日志已轮转（原 ${(st.size / 1048576).toFixed(1)}MB，保留末尾 ${(tail.length / 1024) | 0}KB）---\n`);
  await fs.appendFile(file, tail);
  return true;
}

/** 目录下所有 *.log 扫一遍。 */
async function rotateDir(dir, opts) {
  let names;
  try { names = await fs.readdir(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    try { if (await rotateFile(path.join(dir, name), opts)) n++; } catch { /* 轮转失败不该影响主流程 */ }
  }
  return n;
}

/** 启动时先查一次，之后定期查。定时器 unref，不阻止进程退出。 */
function startLogRotation(dir, { onRotate = () => {}, ...opts } = {}) {
  const tick = () => rotateDir(dir, opts).then(n => { if (n) onRotate(n); }).catch(() => {});
  tick();
  setInterval(tick, EVERY_MS).unref();
}

module.exports = { rotateFile, rotateDir, startLogRotation, CAP, KEEP };
