'use strict';

/**
 * 审批请求的归一化。
 *
 * 手机上批准一条命令，必须看得见**要执行什么、在哪个目录、为什么要权限**，
 * 否则就是盲批 —— 而盲批比不批更危险。协议里这些字段都有，只是散在
 * 新旧两套方法、三种审批类型的不同字段名下，需要在这里统一成一套。
 *
 * 单独成模块是为了能脱离控制通道做单元测试（自检默认 --no-control）。
 */

function clipText(s, n) {
  if (s == null) return s;
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > n ? str.slice(0, n) + `… (+${str.length - n} chars)` : str;
}

function describeApproval(method, p = {}) {
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    const files = Object.keys(p.fileChanges || {});
    return {
      approvalKind: 'file_change',
      title: '请求修改文件',
      cwd: p.grantRoot || p.cwd,
      reason: p.reason ?? null,
      files,
      summary: files.length ? files.join('\n') : '(未提供文件清单)',
    };
  }

  if (method === 'item/permissions/requestApproval') {
    return {
      approvalKind: 'permissions',
      title: '请求额外权限',
      cwd: p.cwd,
      reason: p.reason ?? null,
      summary: clipText(p.permissions ?? {}, 500),
    };
  }

  if (method === 'item/tool/requestUserInput') {
    return {
      approvalKind: 'user_input',
      title: '请求补充输入',
      reason: p.reason ?? null,
      summary: clipText(p.prompt ?? '', 500),
    };
  }

  // 命令执行。新旧协议的字段名不同：
  //   v2  → command / commandActions[].command
  //   旧版 → command / parsedCmd[].command
  const command = p.command
    ?? (Array.isArray(p.parsedCmd)
      ? p.parsedCmd.map(c => c?.command ?? '').filter(Boolean).join(' && ') : null)
    ?? (Array.isArray(p.commandActions)
      ? p.commandActions.map(a => a?.command ?? '').filter(Boolean).join(' && ') : null);

  const out = {
    approvalKind: 'exec',
    title: '请求执行命令',
    cwd: p.cwd,
    reason: p.reason ?? null,
    command: command || '(未提供命令内容)',
  };
  out.summary = out.command;
  // 联网是另一档风险，单独标出来让客户端能突出显示
  if (p.networkApprovalContext) out.network = clipText(p.networkApprovalContext, 300);
  return out;
}

module.exports = { describeApproval };
