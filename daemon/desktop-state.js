'use strict';

/**
 * 读取 Codex Desktop 的侧栏组织结构。
 *
 * Desktop 侧栏有三段：置顶 / 项目 / 最近。这套结构是用户自己整理出来的，
 * 比从 cwd 反推准确得多 —— 之前按 cwd 末段分组，只是碰巧和项目名对上，
 * 一旦仓库改名、或多个仓库同名就会错乱，而且完全拿不到「置顶」和用户排序。
 *
 * 数据来自 `~/.codex/.codex-global-state.json`（Desktop 的 Electron 持久化状态）：
 *   - `local-projects`                              项目定义（id / name / rootPaths）
 *   - `electron-persisted-atom-state`
 *       · `unified-sidebar-pinned-order-v1`         置顶线程，数组顺序即显示顺序
 *       · `flat-project-sidebar-preferences-v1`     排序模式
 *   - `projectless-thread-ids`                      不属于任何项目 → 归入「最近」
 *
 * 这是 Desktop 独有的状态；纯 CLI 用户没有这个文件，此时全部降级为空，
 * 由调用方回退到按 cwd 推导。
 */

const fs = require('fs');
const path = require('path');

const PIN_PREFIX = 'codex:thread:local:';

class DesktopState {
  constructor(codexHome) {
    this.file = path.join(codexHome, '.codex-global-state.json');
    this.projects = [];        // { id, name, rootPaths[] }
    this.pinnedOrder = [];     // threadId[]，顺序即用户排的顺序
    this.projectless = new Set();
    this.sortMode = null;
    this.mtimeMs = 0;
    this.available = false;
  }

  /** 有变更才重新解析；文件约 157KB，不宜每次请求都读 */
  reload() {
    let st;
    try { st = fs.statSync(this.file); } catch { this.available = false; return false; }
    if (st.mtimeMs === this.mtimeMs) return false;
    this.mtimeMs = st.mtimeMs;

    let raw;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { return false; }

    const atoms = raw['electron-persisted-atom-state'] || {};

    this.projects = Object.values(raw['local-projects'] || {})
      .filter(p => p && p.id && p.name)
      .map(p => ({ id: p.id, name: p.name, rootPaths: p.rootPaths || [] }));

    // 置顶用 `pinned-thread-ids`：它的成员与顺序都已解析好，与 Desktop 侧栏逐条一致。
    //
    // 不要用 `unified-sidebar-pinned-order-v1`（看名字更像"顺序"的那个）——它含过期条目：
    // 实测里有一条已归档的会话和一条早已取消置顶的会话仍留在其中，还会把 UI 新建的会话
    // 记成临时 id（client-new-thread:*）。照它渲染会多出 Desktop 里根本不显示的条目。
    if (Array.isArray(raw['pinned-thread-ids'])) {
      this.pinnedOrder = raw['pinned-thread-ids'].filter(id => typeof id === 'string');
    } else {
      // 老版本 Desktop 没有该字段时，退回顺序数组，并用 thread-client-id-v1 还原临时 id
      const clientToThread = new Map();
      for (const [k, v] of Object.entries(atoms)) {
        const m = /^thread-client-id-v1:local%3A(.+)$/.exec(k);
        if (m && typeof v === 'string') clientToThread.set(v, m[1]);
      }
      this.pinnedOrder = (atoms['unified-sidebar-pinned-order-v1'] || [])
        .filter(s => typeof s === 'string' && s.startsWith(PIN_PREFIX))
        .map(s => s.slice(PIN_PREFIX.length))
        .map(id => id.startsWith('client-new-thread:')
          ? clientToThread.get(id.slice('client-new-thread:'.length))
          : id)
        .filter(Boolean);
    }

    this.projectless = new Set(raw['projectless-thread-ids'] || []);
    this.sortMode = atoms['flat-project-sidebar-preferences-v1'] || null;
    this.available = this.projects.length > 0 || this.pinnedOrder.length > 0;
    return true;
  }

  pinnedIndex(threadId) {
    const i = this.pinnedOrder.indexOf(threadId);
    return i < 0 ? null : i;
  }

  /**
   * 把会话归到某个项目。
   * 直接命中 rootPath 之外，还要覆盖 worktree —— 实测并行任务几乎都跑在
   * `~/.codex/worktrees/<hash>/<repo>` 里，仓库名与项目 rootPath 的末段一致。
   */
  projectFor(cwd) {
    if (!cwd) return null;
    for (const p of this.projects) {
      for (const root of p.rootPaths) {
        if (cwd === root || cwd.startsWith(root.endsWith('/') ? root : root + '/')) return p;
      }
    }
    const wt = cwd.match(/\/\.codex\/worktrees\/[^/]+\/([^/]+)\/?$/);
    if (wt) {
      const repo = wt[1];
      const hit = this.projects.find(p => p.rootPaths.some(r => path.basename(r) === repo));
      if (hit) return hit;
    }
    return null;
  }
}

module.exports = { DesktopState };
