'use strict';
/**
 * src/core/atomic.js —— 原子写 + .bak 备份（ARCHITECTURE §4.3）
 *
 * 序列：写 .tmp -> 复检 -> 备份 .bak.<ts> -> fs.rename 原子替换 -> 失败回滚。
 * 时间戳只出现在 .bak 文件名里（产物 JSON 内零时间戳）。`now` 由参数注入，
 * 便于 B9 逐字节一致性验证（ARCHITECTURE §5 决策 13）。
 */

const fs = require('fs');
const path = require('path');
const { AppError, CODES } = require('./errors');
// ★ 刻意**不**从 './fs-json' 取 ensureDir ★
//   fs-json 现在需要 atomicWrite（writeJsonAtomic），若这里再反向引入就成环：
//     atomic -> fs-json -> atomic  =>  ESM/CJS 下 require 返回半初始化模块，
//     表现为 `ensureDir is not a function` 这种极难定位的错。
//   ensureDir 只是一行 mkdirSync，直接用 node:fs 更省、也更符合分层。

/**
 * 确保父目录存在（本地实现，避免与 fs-json 形成循环依赖）。
 * @param {string} dir
 */
function ensureDir(dir) {
  if (!dir || fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 生成 .bak 文件名用的时间戳串（可注入 now）。
 * @param {Date|string|number} [now]
 * @returns {string} 形如 20260513T102030123Z
 */
function stampOf(now) {
  const d = now === undefined ? new Date() : (now instanceof Date ? now : new Date(now));
  if (Number.isNaN(d.getTime())) {
    throw new AppError(CODES.USAGE, `--now 不是合法时间: ${String(now)}`);
  }
  return d.toISOString().replace(/[-:.]/g, '');
}

/**
 * 原子写文件（可选备份）。
 *
 * @param {Object} args
 * @param {string} args.targetPath 目标文件
 * @param {string|Buffer} args.content 内容
 * @param {Date|string|number} [args.now] 注入时间戳（决定 .bak 文件名）
 * @param {boolean} [args.backup] 目标已存在时是否备份，默认 true
 * @param {Function} [args.verify] 复检函数：(tmpPath) => string|null，返回非 null 表示失败原因
 * @returns {{applied:boolean, backupPath:string|null, targetPath:string, bytes:number}}
 */
function atomicWrite(args) {
  const targetPath = args.targetPath;
  const content = args.content;
  const doBackup = args.backup !== false;
  const verify = typeof args.verify === 'function' ? args.verify : null;

  const dir = path.dirname(targetPath);
  ensureDir(dir);
  const tmpPath = `${targetPath}.tmp`;
  const existed = fs.existsSync(targetPath);
  let backupPath = null;

  try {
    // ③ 写 tmp
    fs.writeFileSync(tmpPath, content);

    // ④ 复检 tmp 内容（防写入截断/编码损坏）
    if (verify) {
      const problem = verify(tmpPath);
      if (problem) {
        safeUnlink(tmpPath);
        throw new AppError(CODES.LINT_BLOCKED, `原子写复检失败，未改动原文件: ${problem}`, { targetPath });
      }
    }

    // ⑤ 备份
    if (existed && doBackup) {
      backupPath = `${targetPath}.bak.${stampOf(args.now)}`;
      fs.copyFileSync(targetPath, backupPath);
    }

    // ⑥ 原子替换
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    safeUnlink(tmpPath);
    if (err instanceof AppError) throw err;
    throw new AppError(CODES.ROLLED_BACK, `原子写失败: ${targetPath}`, {
      cause: err.message,
      backupPath,
    });
  }

  return {
    applied: true,
    backupPath,
    targetPath,
    bytes: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content), 'utf8'),
  };
}

/**
 * 从 .bak 恢复原文件。
 * @param {string} backupPath
 * @param {string} targetPath
 * @returns {{restored:boolean, backupPath:string}}
 */
function rollbackFrom(backupPath, targetPath) {
  if (!backupPath || !fs.existsSync(backupPath)) {
    return { restored: false, backupPath: backupPath || '' };
  }
  try {
    fs.copyFileSync(backupPath, targetPath);
    return { restored: true, backupPath };
  } catch (err) {
    throw new AppError(CODES.ROLLED_BACK, `回滚失败: ${targetPath}`, { cause: err.message });
  }
}

/**
 * 尽力删除，不抛异常（清理路径不允许静默失败影响主流程，但也不该阻断）。
 * @param {string} p
 */
function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // 清理失败不阻断主流程；调用方已在日志里拿到主错误
  }
}

module.exports = { atomicWrite, rollbackFrom, stampOf };
