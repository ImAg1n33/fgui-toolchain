'use strict';
/**
 * src/fgui/transaction.js —— 事务化写盘（P1-a-03 / ARCHITECTURE §4.3 路线 C）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 8 步写盘序列（ARCHITECTURE §4.3，P1 必须严格遵循）：
 *   ① 生成候选内容到内存（调用方负责，本模块收 content 字符串）
 *   ② lintComponentXml(候选内容)      ── 有 error ─→ 退出码 3，**不动磁盘**
 *   ③ 写 <target>.tmp
 *   ④ 复检 tmp 内容（防写入截断/编码损坏）── 有 error ─→ 删 tmp，退出码 3
 *   ⑤ 目标已存在 ─→ 复制 <target> → <target>.bak.<ts>
 *   ⑥ fs.rename(tmp, target)          ── 原子替换
 *   ⑦ 写后校验失败 ─→ 用 .bak 恢复原文件，返回 { applied:false }，退出码 5
 *   ⑧ 成功 ─→ 返回 { applied:true, backupPath } + reload_hint
 *
 * ③~⑥ 全部委托给 P0 的 src/core/atomic.js（原子写 + .bak + 回滚，now 可注入），
 * 不重造轮子；本模块只负责「lint 门禁 + 写后校验 + reload_hint + 回滚编排」。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ package.xml 硬约束（上游 STANDARDS 已核实）★★
 *   编辑器开着时**手写 package.xml 会被内存态覆盖**（用户在编辑器里的操作
 *   保存在内存里，保存时整份写回，手改内容丢失且无任何报错）。
 *   本模块的 API 设计直接体现这个约束：
 *     · 只提供 writeComponentXml（组件 XML 是编辑器关闭时才能安全写的文件，
 *       由调用方保证编辑器已关 —— reload_hint 会提示）；
 *     · writePackageXml **故意不实现**：一律抛 USAGE 错并说明原因，
 *       包的登记必须走编辑器 API（create_package / create_component）。
 *
 * ★ 确定性（B9）★
 *   `now` 必须可注入（--now <iso>）：它只进 `.bak.<ts>` 文件名，
 *   产物内容零时间戳。两次运行传同一 now → 结果对象逐字段一致（有单测）。
 * ════════════════════════════════════════════════════════════════════════════
 */

const path = require('path');
const { atomicWrite, rollbackFrom } = require('../core/atomic');
const { readText } = require('../core/fs-json');
const { AppError, CODES, EXIT } = require('../core/errors');
const { lintComponentXml } = require('./lint-rules');

/**
 * 写盘成功后返回的 reload_hint（PRD R4-F5 写盘序列的一部分）。
 * 文案同时覆盖「关编辑器再写」与「写后 refresh」两个动作。
 */
const RELOAD_HINT = '写盘完成。若编辑器此前处于打开状态，请重启编辑器（或执行 refresh）后'
  + '用 read_component 抽查 3 个对象确认生效；package.xml 严禁在编辑器开着时手写'
  + '（会被内存态覆盖），包的登记请走编辑器 API。';

/** 目标文件名黑名单：这些文件不是「组件 XML」，拒绝走本事务层。 */
const PROTECTED_BASENAMES = Object.freeze(['package.xml']);

/**
 * lint 门禁：有 error 级问题就抛 LINT_BLOCKED（退出码 3），调用方不应写盘。
 *
 * @param {string} content 候选 XML
 * @param {Object} opts 透传给 lintComponentXml
 * @returns {{errors:Object[], warnings:Object[]}} lint 结果（仅 error 时抛错）
 */
function assertLintClean(content, opts = {}) {
  const result = lintComponentXml(content, opts);
  if (!result.ok) {
    const lines = result.errors.map((e) => `  [${e.rule}] ${e.message}`);
    throw new AppError(CODES.LINT_BLOCKED,
      `组件 XML 未通过 lint（${result.errors.length} 个 error），已停止写盘、未改动磁盘：\n${lines.join('\n')}`,
      {
        errors: result.errors,
        warnings: result.warnings,
        exitCode: EXIT.LINT_BLOCKED,
      });
  }
  return result;
}

/**
 * 事务化写组件 XML（8 步序列）。
 *
 * @param {Object} args
 * @param {string} args.targetPath 目标文件路径
 * @param {string} args.content 候选 XML 内容
 * @param {Date|string|number} [args.now] 注入时间戳（决定 .bak 文件名，B9 用）
 * @param {Object} [args.config] 透传给 lint 的配置（完整配置或 fgui 段）
 * @param {Object|Map} [args.resources] 透传给 lint 的资源注入（R-05/R-10 用）
 * @param {Function} [args.verify] tmp 复检函数：(tmpPath) => string|null，返回非 null 即失败原因。
 *        默认复检内容 = 重新 lint 读回的文件（防写入截断/编码损坏）。
 * @param {Function} [args.postVerify] 写后校验函数：(targetPath) => string|null，返回非 null 即失败原因。
 *        默认校验 = 读回目标文件与候选内容逐字节一致。失败则用 .bak 回滚。
 * @param {boolean} [args.backup=true] 目标已存在时是否留 .bak 备份
 * @returns {{applied:boolean, targetPath:string, bytes:number, backupPath:string|null,
 *            reloadHint:string, lint:{errors:number, warnings:number}, now:string|null}}
 */
function writeComponentXml(args) {
  const targetPath = args.targetPath;
  const content = args.content;
  if (!targetPath || typeof targetPath !== 'string') {
    throw new AppError(CODES.BAD_ARGUMENT, 'writeComponentXml 需要 targetPath（字符串）');
  }
  if (typeof content !== 'string') {
    throw new AppError(CODES.BAD_ARGUMENT, 'writeComponentXml 需要 content（XML 字符串）');
  }

  // ---- 约束：拒绝写 package.xml（上游 STANDARDS：编辑器开着时手写会被内存态覆盖）----
  // ★ BUG-B 修复（QA 第三轮）：basename 必须先 trim 再比对 ★
  //   原实现直接比 `path.basename(targetPath).toLowerCase()`，`'package.xml '`
  //   （尾随空格）不被拦 —— Windows 上 OS 会剥掉尾随空格，文件落成真
  //   package.xml（QA 已实测落盘）。trim 后前导/尾随空格变体全部拦截。
  const base = path.basename(String(targetPath)).trim().toLowerCase();
  if (PROTECTED_BASENAMES.includes(base)) {
    throw new AppError(CODES.USAGE,
      `拒绝通过事务层写 ${base}：上游 STANDARDS 明确——编辑器开着时手写 package.xml `
      + '会被内存态覆盖（静默丢失、无报错）。包的登记必须走编辑器 API'
        + '（create_package / create_component）。组件 XML（*.xml）不受此限，'
        + '但同样应在编辑器关闭时写（Q5 待确认）。',
      { targetPath });
  }

  // ---- ② lint 门禁（内存态，不动磁盘）----
  const lintOpts = { config: args.config, resources: args.resources, fileName: base };
  const lint = assertLintClean(content, lintOpts);

  // ---- ③~⑥ 原子写（atomic.js：写 tmp → 复检 → .bak → rename）----
  const verify = typeof args.verify === 'function'
    ? args.verify
    : (tmpPath) => {
      // 复检 tmp：读回来重新 lint —— 防写入截断/编码损坏导致「盘上的是坏的但内存是好的」
      const back = readText(tmpPath);
      const r = lintComponentXml(back, lintOpts);
      return r.ok ? null : `tmp 复检未通过 lint：${r.errors.map((e) => e.message).join('；')}`;
    };

  const written = atomicWrite({
    targetPath,
    content,
    now: args.now,
    backup: args.backup !== false,
    verify,
  });

  // ---- ⑦ 写后校验（默认逐字节对账；失败用 .bak 回滚，退出码 5）----
  const postVerify = typeof args.postVerify === 'function'
    ? args.postVerify
    : (target) => {
      const back = readText(target);
      return back === content ? null : '写后校验失败：读回内容与候选内容不一致';
    };

  const problem = postVerify(targetPath);
  if (problem) {
    const restored = rollbackFrom(written.backupPath, targetPath);
    throw new AppError(CODES.ROLLED_BACK,
      `写盘事务失败，已回滚：${problem}`,
      {
        targetPath,
        backupPath: written.backupPath,
        restored: restored.restored,
        exitCode: EXIT.ROLLED_BACK,
      });
  }

  // ---- ⑧ 成功 ----
  return {
    applied: true,
    targetPath,
    bytes: written.bytes,
    backupPath: written.backupPath,
    reloadHint: RELOAD_HINT,
    lint: { errors: 0, warnings: lint.warnings.length },
    now: args.now === undefined || args.now === null ? null : String(args.now),
  };
}

/**
 * 从 .bak 恢复（暴露回滚能力，供调用方/CLI 在事务外手工恢复）。
 * @param {string} backupPath
 * @param {string} targetPath
 * @returns {{restored:boolean, backupPath:string}}
 */
function rollback(backupPath, targetPath) {
  return rollbackFrom(backupPath, targetPath);
}

/**
 * 显式拒绝写 package.xml（单独导出，让调用方在编译期/检索时就能发现这个约束）。
 * @param {string} targetPath
 * @throws {AppError} 永远抛出（这是设计意图，不是未实现）
 */
function writePackageXml(targetPath) {
  throw new AppError(CODES.USAGE,
    'writePackageXml 未被实现且**不应**被实现：上游 STANDARDS 明确——编辑器开着时手写 '
      + 'package.xml 会被内存态覆盖。包的登记必须走编辑器 API（create_package / create_component）。'
      + '本函数存在是为了让这个约束在 API 表面可见（检索 writePackageXml 即看到原因）。',
    { targetPath });
}

module.exports = {
  writeComponentXml,
  writePackageXml,
  rollback,
  assertLintClean,
  RELOAD_HINT,
  PROTECTED_BASENAMES,
};
