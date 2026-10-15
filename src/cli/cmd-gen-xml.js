'use strict';
/**
 * src/cli/cmd-gen-xml.js —— gen-xml 三阶段增量构建（M2 已实现）
 *
 * usage:
 *   fgui-rb gen-xml prepare --plan <change_plan.json> --project <root|.fairy> --index <project_index.json>
 *                           [--base-ir <design_ir.A.json>] [--target-ir <design_ir.B.json>]
 *                           [--skip-unconfirmed] [--out <dir>]
 *   fgui-rb gen-xml dryrun  --gen-plan <gen_plan.json> --project <root> --index <project_index.json> [--out <dir>]
 *   fgui-rb gen-xml apply   --gen-plan <gen_plan.json> --project <root> --index <project_index.json> [--out <dir>] --yes [--now <iso>]
 *
 * 三阶段（M2-SPEC §0 / §3）：
 *   prepare → gen_plan.json（人可读可改的编辑脚本，含 SHA-256 指纹）
 *   dryrun  → dryrun_report.{json,md}（内存打补丁 + lint + 逐行 diff；工程零写入）
 *   apply   → 事务写盘（漂移校验 + lint 门禁 + .bak + 原子替换 + 回滚）
 *
 * ★ 上游踩坑硬约束（实现时严格遵守，见 src/fgui/constants.js）★
 *   · 颜色只用 6 位 + alpha="0.x" 属性（8 位 #RRGGBBAA 运行时只取后 6 位 → 纯蓝）
 *   · `ui://` 包 id 必须 8 位（6 位会吃掉 itemId 首字符）
 *   · **不使用 OpenDocument**（静默返回 null / 被 unity 裁剪）
 *   · **不使用 screenshot**（truthy 但不可调用，必须 try/catch 实调）
 *   · 编辑器开着时**不手写 package.xml**（会被内存态覆盖）
 *   · 字段名拼写就是 `extention`（不是 extension）
 *
 * ★ M2 明确不做（M2-SPEC §9）★
 *   · 不写 package.xml、不导入素材、不关联 assets.db（只消费 project_index 的 resources）
 *   · 不推断 z-order（ADD 一律追加 displayList 末尾，`after` 锚点仅作提示，见 gen-dryrun notes）
 *   · 不生成文本内容、不猜控件类型（Button 提示仅进 note）
 *   · relation/gear 联动（用绝对坐标代替）
 *   · 多组件 plan（单 target：task.targetPkg + task.name）
 */

const fs = require('fs');
const path = require('path');

const { readJson, readText, writeJson, ensureDir } = require('../core/fs-json');
const { AppError, CODES, EXIT, toAppError } = require('../core/errors');
const { locateProject } = require('../fgui/project-reader');
const { buildGenPlan } = require('../fgui/gen-plan');
const { runDryrun, buildLintResources, sha256 } = require('../fgui/gen-dryrun');
const { writeComponentXml } = require('../fgui/transaction');
const { flagStr, flagBool } = require('./args');

/** 用法文本（走 stderr）。 */
const USAGE = [
  'gen-xml 三阶段增量构建（M2）：',
  '  fgui-rb gen-xml prepare --plan <change_plan.json> --project <root|.fairy> --index <project_index.json>',
  '                         [--base-ir <json>] [--target-ir <json>] [--skip-unconfirmed] [--out <dir>]',
  '  fgui-rb gen-xml dryrun  --gen-plan <gen_plan.json> --project <root> --index <project_index.json> [--out <dir>]',
  '  fgui-rb gen-xml apply   --gen-plan <gen_plan.json> --project <root> --index <project_index.json> [--out <dir>] --yes [--now <iso>]',
  '',
  '退出码：0 OK / 2 USAGE（参数错/漂移/目标找不到）/ 3 LINT_BLOCKED / 4 NEEDS_HUMAN（门禁/缺 --yes）/ 5 ROLLED_BACK',
].join('\n');

/** 相对路径展示（POSIX 分隔符）。 */
function relShow(from, to) {
  return path.relative(from, to).replace(/\\/g, '/');
}

/**
 * 打印用法并输出最小 JSON（stdout 必须始终是纯 JSON，供 `> report.json`）。
 * @param {string} message
 * @param {Object} [extra]
 * @returns {number} EXIT.USAGE
 */
function usageError(message, extra) {
  process.stderr.write(`${USAGE}\n\n`);
  if (message) process.stderr.write(`${message}\n`);
  process.stdout.write(`${JSON.stringify({
    command: 'gen-xml', ok: false, error: message || '用法错误', ...(extra || {}),
  }, null, 2)}\n`);
  return EXIT.USAGE;
}

/**
 * 读一个必需的 JSON 文件（不存在/解析失败 → USAGE）。
 * @param {string} filePath
 * @param {string} label
 * @returns {Object}
 */
function readJsonRequired(filePath, label) {
  const val = readJson(filePath);
  if (val === null) {
    throw new AppError(CODES.USAGE, `${label} 读取失败或为空：${filePath}`);
  }
  return val;
}

/**
 * 解析工程根（--project 宽容：接受工程根目录或 .fairy 文件）。
 * @param {Object} ctx
 * @returns {string}
 */
function requireProjectRoot(ctx) {
  const projectInput = flagStr(ctx.flags.project);
  if (!projectInput) {
    throw new AppError(CODES.USAGE, '需要 --project <工程根目录 或 .fairy 文件>');
  }
  return locateProject(projectInput).root;
}

/**
 * 把 project_index 里的相对 `file` 解析成绝对路径。
 *
 * ★ read-researcher 缺口 1 ★：project_index 的 `file` 是相对「生成索引时的
 *   CLI rootDir」的相对路径。正常流程里 project-index 以工程根为 root 生成，
 *   故优先按 `--project` 工程根拼；若不存在则退化按本次 CLI 的 rootDir 拼
 *   （索引可能是在别处生成的）—— 两种都找不到 → USAGE（不猜）。
 *   `outside-root/` 降级形态直接拒绝（B9：不含绝对路径信息，无法定位）。
 *
 * @param {string} projectRoot
 * @param {string} rootDir
 * @param {string} relFile
 * @param {Object} logger
 * @returns {string} 绝对路径
 */
function resolveTargetPath(projectRoot, rootDir, relFile, logger) {
  if (!relFile || typeof relFile !== 'string') {
    throw new AppError(CODES.USAGE, '目标组件缺少 file 字段：project_index.components 未提供 file');
  }
  if (relFile.startsWith('outside-root/')) {
    throw new AppError(CODES.USAGE,
      `目标组件 file 是跨盘降级形态（outside-root/…），无法定位绝对路径，拒绝猜测：${relFile}`);
  }
  const absProject = path.resolve(projectRoot, relFile);
  if (fs.existsSync(absProject)) return absProject;
  const absRoot = path.resolve(rootDir, relFile);
  if (fs.existsSync(absRoot)) {
    if (logger) logger.warn('目标文件不在 --project 工程根下，已按 CLI rootDir 解析', { file: relFile, rootDir });
    return absRoot;
  }
  throw new AppError(CODES.USAGE,
    `目标组件文件未找到：尝试了 <project>/${relFile} 与 <root>/${relFile} 均不存在`);
}

/** 读目标 XML 内容（缺失 → USAGE）。 */
function readTargetContent(absPath) {
  if (!fs.existsSync(absPath)) {
    throw new AppError(CODES.USAGE, `目标组件文件不存在：${absPath}`);
  }
  return readText(absPath);
}

// ════════════════════════════════════════════════════════════════════════════
// 阶段 1：prepare
// ════════════════════════════════════════════════════════════════════════════

/**
 * @param {Object} ctx
 * @param {string} outDir
 * @returns {number} 退出码
 */
function runPrepare(ctx, outDir) {
  const { flags, logger, rootDir } = ctx;

  const planFlag = flagStr(flags.plan);
  if (!planFlag) return usageError('prepare 缺 --plan <change_plan.json>');
  const indexFlag = flagStr(flags.index);
  if (!indexFlag) return usageError('prepare 缺 --index <project_index.json>');

  const changePlan = readJsonRequired(path.resolve(rootDir, planFlag), 'change_plan.json');
  const projectIndex = readJsonRequired(path.resolve(rootDir, indexFlag), 'project_index.json');
  const baseIr = flags['base-ir'] ? readJsonRequired(path.resolve(rootDir, flagStr(flags['base-ir'])), 'base-ir') : null;
  const targetIr = flags['target-ir'] ? readJsonRequired(path.resolve(rootDir, flagStr(flags['target-ir'])), 'target-ir') : null;

  const projectRoot = requireProjectRoot(ctx);
  const skipUnconfirmed = flagBool(flags['skip-unconfirmed'], false);

  // 目标组件（task.targetPkg + task.name）→ project_index.components[].file
  const task = changePlan.task || {};
  const components = Array.isArray(projectIndex.components) ? projectIndex.components : [];
  const target = components.find((c) => c && c.pkg === task.targetPkg && c.name === task.name) || null;

  /** @type {Object<string,string>} */
  const targetContents = {};
  if (target && target.file && !String(target.file).startsWith('outside-root/')) {
    const abs = resolveTargetPath(projectRoot, rootDir, target.file, logger);
    targetContents[target.file] = readTargetContent(abs);
  }

  const { genPlan, exitCode } = buildGenPlan({
    changePlan, projectIndex, baseIr, targetIr, targetContents,
    options: { skipUnconfirmed },
  });

  const outPath = path.join(outDir, 'gen_plan.json');
  writeJson(outPath, genPlan); // 不做 root 相对化：file 已是相对路径，避免二次相对化

  process.stdout.write(`${JSON.stringify({
    command: 'gen-xml',
    phase: 'prepare',
    ok: exitCode === EXIT.OK,
    outputs: { genPlan: relShow(outDir, outPath) },
    target: { file: genPlan.target.file, component: genPlan.target.component, pkg: genPlan.target.pkg },
    gate: genPlan.gate,
    summary: genPlan.summary,
    warningCount: (genPlan.warnings || []).length,
    warnings: genPlan.warnings || [],
  }, null, 2)}\n`);
  return exitCode;
}

// ════════════════════════════════════════════════════════════════════════════
// 阶段 2：dryrun
// ════════════════════════════════════════════════════════════════════════════

/**
 * 读 gen_plan + project_index，解析目标内容。
 * dryrun 与 apply 共用。
 * @param {Object} ctx
 * @returns {{genPlan:Object, projectIndex:Object, targetContents:Object, projectRoot:string}}
 */
function loadGenInputs(ctx) {
  const { flags, logger, rootDir } = ctx;
  const genPlanFlag = flagStr(flags['gen-plan']);
  if (!genPlanFlag) {
    throw new AppError(CODES.USAGE, '缺 --gen-plan <gen_plan.json>');
  }
  const indexFlag = flagStr(flags.index);
  if (!indexFlag) {
    throw new AppError(CODES.USAGE, '缺 --index <project_index.json>');
  }
  const genPlan = readJsonRequired(path.resolve(rootDir, genPlanFlag), 'gen_plan.json');
  const projectIndex = readJsonRequired(path.resolve(rootDir, indexFlag), 'project_index.json');
  const projectRoot = requireProjectRoot(ctx);

  /** @type {Object<string,string>} */
  const targetContents = {};
  const file = genPlan.target && genPlan.target.file;
  if (file) {
    const abs = resolveTargetPath(projectRoot, rootDir, file, logger);
    targetContents[file] = readTargetContent(abs);
  }
  return {
    genPlan, projectIndex, targetContents, projectRoot,
  };
}

/**
 * 生成 dryrun 报告的 Markdown。
 * @param {Object} report
 * @returns {string}
 */
function renderDryrunMarkdown(report) {
  const lines = ['# gen-xml dryrun 报告', '', `- ok: ${report.ok}`, ''];
  lines.push(`- 变更文件数: ${report.summary.filesChanged}`);
  lines.push(`- 应用条目数: ${report.summary.entriesApplied}`);
  lines.push(`- 跳过条目数: ${report.summary.entriesSkipped}`);
  lines.push(`- lint 错误数: ${report.summary.lintErrors}`);
  lines.push('');
  if (report.errors && report.errors.length) {
    lines.push('## 错误', '');
    for (const e of report.errors) lines.push(`- ${e}`);
    lines.push('');
  }
  if (report.warnings && report.warnings.length) {
    lines.push('## 告警', '');
    for (const w of report.warnings) lines.push(`- [${w.code}] ${w.message}`);
    lines.push('');
  }
  for (const f of report.files) {
    lines.push(`## ${f.file}`, '');
    lines.push(`- status: ${f.status}  changed: ${f.changed}`);
    lines.push(`- sha256(before): ${f.sha256Before}`);
    lines.push(`- sha256(after):  ${f.sha256After}`);
    if (f.lint && f.lint.errors.length) {
      lines.push('- lint errors:');
      for (const e of f.lint.errors) lines.push(`  - [${e.rule}] ${e.message} (line ${e.line})`);
    }
    if (f.lint && f.lint.warnings && f.lint.warnings.length) {
      lines.push('- lint warnings:');
      for (const w of f.lint.warnings) lines.push(`  - [${w.rule}] ${w.message}`);
    }
    if (f.notes && f.notes.length) {
      lines.push('- notes:');
      for (const n of f.notes) lines.push(`  - ${n}`);
    }
    if (f.skippedEntries && f.skippedEntries.length) {
      lines.push('- skipped:');
      for (const s of f.skippedEntries) lines.push(`  - [${s.status}] ${s.op || ''} ${s.slot || ''}: ${s.reason}`);
    }
    if (f.diff) {
      lines.push('', '```diff', f.diff, '```');
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {Object} ctx
 * @param {string} outDir
 * @returns {number} 退出码
 */
function runDryrunPhase(ctx, outDir) {
  const { config } = ctx;
  const {
    genPlan, projectIndex, targetContents,
  } = loadGenInputs(ctx);

  const { report, exitCode } = runDryrun({
    genPlan, projectIndex, targetContents, options: { config },
  });

  const jsonPath = path.join(outDir, 'dryrun_report.json');
  const mdPath = path.join(outDir, 'dryrun_report.md');
  writeJson(jsonPath, report);
  ensureDir(outDir);
  fs.writeFileSync(mdPath, renderDryrunMarkdown(report), 'utf8');

  process.stdout.write(`${JSON.stringify({
    command: 'gen-xml',
    phase: 'dryrun',
    ok: exitCode === EXIT.OK,
    exitCodeMeaning: exitMeaning(exitCode),
    outputs: { report: relShow(outDir, jsonPath), markdown: relShow(outDir, mdPath) },
    summary: report.summary,
    files: report.files.map((f) => ({ file: f.file, status: f.status, changed: f.changed })),
    errors: report.errors || [],
    warnings: report.warnings || [],
  }, null, 2)}\n`);
  return exitCode;
}

/** 退出码语义（供 stdout 字段）。 */
function exitMeaning(code) {
  switch (code) {
    case EXIT.OK: return 'OK';
    case EXIT.USAGE: return 'USAGE（参数错/漂移/目标找不到）';
    case EXIT.LINT_BLOCKED: return 'LINT_BLOCKED';
    case EXIT.NEEDS_HUMAN: return 'NEEDS_HUMAN';
    case EXIT.ROLLED_BACK: return 'ROLLED_BACK';
    default: return `UNKNOWN(${code})`;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 阶段 3：apply
// ════════════════════════════════════════════════════════════════════════════

/**
 * @param {Object} ctx
 * @param {string} outDir
 * @returns {number} 退出码
 */
function runApplyPhase(ctx, outDir) {
  const { flags, logger, config, now } = ctx;

  // 缺 --yes → NEEDS_HUMAN（先让人看 dryrun 报告）
  if (!flagBool(flags.yes, false)) {
    process.stderr.write('apply 需要显式 --yes：请先 review dryrun 报告，确认后加 --yes 重跑\n');
    process.stdout.write(`${JSON.stringify({
      command: 'gen-xml', phase: 'apply', ok: false, error: '缺 --yes（请先 review dryrun 报告）',
    }, null, 2)}\n`);
    return EXIT.NEEDS_HUMAN;
  }

  const {
    genPlan, projectIndex, targetContents, projectRoot,
  } = loadGenInputs(ctx);

  // 先跑同一套漂移校验 + 内存打补丁 + lint 门禁（不改盘）。
  // ★ 关键不变量（方案 A）★：apply 直接写 runDryrun 返回的 `contents[file]` ——
  //   即 dryrun 校验过的**同一份字节**。绝不自行重放补丁，从而杜绝
  //   「dryrun 报告 sha256After ≠ 实际落盘内容」这类可静默漂移的重复实现。
  const { report, exitCode: gateCode, contents: patched } = runDryrun({
    genPlan, projectIndex, targetContents, options: { config },
  });

  const resources = buildLintResources(projectIndex);
  /** @type {Object[]} */
  const results = [];
  let firstFailure = null;

  if (gateCode === EXIT.OK) {
    for (const f of report.files) {
      const content = patched && typeof patched[f.file] === 'string' ? patched[f.file] : null;
      // 兜底：dryrun 与 apply 同一进程内调用，contents 必须存在且与报告 sha256After 一致
      if (content === null) {
        firstFailure = { exitCode: EXIT.USAGE };
        results.push({ applied: false, file: f.file, error: 'dryrun 未产出该文件的补丁内容（内部不一致，拒绝写盘）', code: 'INTERNAL' });
        continue;
      }
      if (sha256(content) !== f.sha256After) {
        firstFailure = { exitCode: EXIT.USAGE };
        results.push({ applied: false, file: f.file, error: 'dryrun 校验字节与待写内容不一致（内部不一致，拒绝写盘）', code: 'INTERNAL' });
        continue;
      }
      const abs = resolveTargetPath(projectRoot, ctx.rootDir, f.file, logger);
      try {
        const r = writeComponentXml({
          targetPath: abs, content, now, config, resources, backup: true,
        });
        results.push({
          applied: true,
          file: f.file,
          targetPath: relShow(ctx.rootDir, abs),
          bytes: r.bytes,
          backupPath: r.backupPath ? relShow(ctx.rootDir, r.backupPath) : null,
          lint: r.lint,
          reloadHint: r.reloadHint,
        });
      } catch (err) {
        const appErr = toAppError(err);
        firstFailure = appErr;
        results.push({
          applied: false,
          file: f.file,
          targetPath: relShow(ctx.rootDir, abs),
          error: appErr.message,
          code: appErr.code,
        });
        // 事务层回滚会附 exitCode（§8.1：ROLLED_BACK）
        if (typeof err.exitCode === 'number') firstFailure = { exitCode: err.exitCode };
      }
    }
  }

  const aggregate = {
    applied: results.filter((r) => r.applied).length,
    failed: results.filter((r) => !r.applied).length,
  };
  const applyReport = {
    ok: gateCode === EXIT.OK && aggregate.failed === 0,
    phase: 'apply',
    target: { file: genPlan.target ? genPlan.target.file : null },
    summary: aggregate,
    gate: { exitCode: gateCode, filesChanged: report.summary.filesChanged, entriesApplied: report.summary.entriesApplied, entriesSkipped: report.summary.entriesSkipped },
    files: results,
    errors: report.errors || [],
  };

  const jsonPath = path.join(outDir, 'apply_report.json');
  writeJson(jsonPath, applyReport);
  const mdPath = path.join(outDir, 'apply_report.md');
  ensureDir(outDir);
  fs.writeFileSync(mdPath, renderApplyMarkdown(applyReport), 'utf8');

  let finalCode = gateCode;
  if (finalCode === EXIT.OK && firstFailure) finalCode = firstFailure.exitCode || EXIT.INTERNAL;

  process.stdout.write(`${JSON.stringify({
    command: 'gen-xml',
    phase: 'apply',
    ok: applyReport.ok,
    exitCodeMeaning: exitMeaning(finalCode),
    outputs: { report: relShow(outDir, jsonPath), markdown: relShow(outDir, mdPath) },
    summary: aggregate,
    files: results.map((r) => ({ file: r.file, applied: r.applied, backupPath: r.backupPath || null })),
    errors: applyReport.errors,
  }, null, 2)}\n`);
  return finalCode;
}

/**
 * @param {Object} applyReport
 * @returns {string}
 */
function renderApplyMarkdown(applyReport) {
  const lines = ['# gen-xml apply 报告', '', `- ok: ${applyReport.ok}`, ''];
  lines.push(`- 已应用: ${applyReport.summary.applied}`);
  lines.push(`- 失败: ${applyReport.summary.failed}`);
  lines.push('');
  for (const f of applyReport.files) {
    lines.push(`## ${f.file}`, '');
    if (f.applied) {
      lines.push(`- applied: true  bytes: ${f.bytes}`);
      lines.push(`- backup: ${f.backupPath || '(无)'}`);
      lines.push(`- lint: errors=${f.lint.errors} warnings=${f.lint.warnings}`);
      lines.push(`- reloadHint: ${f.reloadHint}`);
    } else {
      lines.push(`- applied: false  code: ${f.code}`);
      lines.push(`- error: ${f.error}`);
    }
    lines.push('');
  }
  if (applyReport.errors && applyReport.errors.length) {
    lines.push('## 错误', '');
    for (const e of applyReport.errors) lines.push(`- ${e}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

// ════════════════════════════════════════════════════════════════════════════
// 入口
// ════════════════════════════════════════════════════════════════════════════

/**
 * gen-xml 入口：按 `ctx.positional[0]` 分发到 prepare / dryrun / apply。
 * @param {Object} ctx
 * @returns {number} 退出码
 */
function run(ctx) {
  const { flags, positional, logger, rootDir } = ctx;
  const phase = Array.isArray(positional) ? positional[0] : undefined;
  const outDir = path.resolve(rootDir, flagStr(flags.out, 'out'));

  if (phase !== 'prepare' && phase !== 'dryrun' && phase !== 'apply') {
    return usageError(phase ? `未知阶段：${phase}` : '缺少阶段参数（prepare | dryrun | apply）');
  }

  try {
    if (phase === 'prepare') return runPrepare(ctx, outDir);
    if (phase === 'dryrun') return runDryrunPhase(ctx, outDir);
    return runApplyPhase(ctx, outDir);
  } catch (err) {
    const appErr = toAppError(err);
    logger.error(`gen-xml ${phase} 失败`, { code: appErr.code, msg: appErr.message });
    // 参数/漂移类问题：stdout 仍给结构化 JSON（保持管道可用）
    process.stdout.write(`${JSON.stringify({
      command: 'gen-xml', phase, ok: false, error: appErr.message, code: appErr.code,
    }, null, 2)}\n`);
    return appErr.exitCode;
  }
}

module.exports = { run };
