'use strict';

/**
 * 谁占着某条会话的写锁。
 *
 * Codex 用 `~/.codex/thread-writer-locks/<threadId>.lock` 做写者互斥，
 * 靠 **flock** 持有（0 字节文件，锁在打开的 fd 上）。要点：
 *
 *   - 文件存在 ≠ 被锁：用完的锁文件会留在原地，没有持有者
 *   - 删文件**不解锁**：flock 绑在 inode 上，删了对方照样持有；
 *     新建同名文件只会锁到新 inode，于是两个进程同时以为自己是唯一写入方，
 *     并发追加同一个 rollout → 会话历史写坏。**所以永远不要去动这些文件。**
 *
 * 本模块只做只读探测：一次 `lsof` 拿到全部持有者，供界面提前告诉用户
 * 「这条现在被电脑占着，发不出去」，而不是让人打完一长段字才吃 409。
 *
 * 为什么用 lsof 而不是自己试着加锁：试锁需要真的 flock 一下，
 * 那一瞬间会把 Desktop 挡在外面；而且 Node 没有内置 flock，
 * 引依赖又违背零依赖的约束。一次 lsof 覆盖全部线程，几十毫秒。
 */

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');

const LOCK_DIR = path.join(os.homedir(), '.codex', 'thread-writer-locks');
const TTL_MS = 5000;

let cache = { at: 0, map: new Map() };
let inflight = null;

/** @returns {Promise<Map<string, number>>} threadId -> 持有者 pid */
function scan() {
  if (Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.map);
  if (inflight) return inflight;

  inflight = new Promise(resolve => {
    // -F pn：机器可读，p<pid> 打头，随后若干 n<路径>
    execFile('lsof', ['-F', 'pn', '+D', LOCK_DIR], { timeout: 5000 }, (err, stdout) => {
      const map = new Map();
      // lsof 在"一个都没打开"时返回非 0，这不是错误
      for (const line of String(stdout || '').split('\n')) {
        if (line.startsWith('p')) { map._pid = Number(line.slice(1)); continue; }
        if (line.startsWith('n')) {
          const m = line.slice(1).match(/([0-9a-f-]{36})\.lock$/i);
          if (m && map._pid) map.set(m[1], map._pid);
        }
      }
      delete map._pid;
      cache = { at: Date.now(), map };
      inflight = null;
      resolve(map);
    });
  });
  return inflight;
}

/** 让下一次 scan 立刻重扫（自己刚拿/放锁时用，别让界面读到过期状态） */
function invalidate() { cache.at = 0; }

/**
 * @param {Map<string,number>} map  scan() 的结果
 * @param {number[]} ownPids        本 daemon 自己的 app-server 进程号
 * @returns {(threadId:string) => {locked:boolean, lockedBy?:'self'|'other'}}
 */
function classifier(map, ownPids = []) {
  const own = new Set(ownPids.filter(Boolean));
  return (threadId) => {
    const pid = map.get(threadId);
    if (!pid) return { locked: false };
    return { locked: true, lockedBy: own.has(pid) ? 'self' : 'other' };
  };
}

module.exports = { scan, invalidate, classifier, LOCK_DIR };
