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

/** 解析符号链接后的真实路径（失败则原样返回）。 */
function realpathSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** 大小写归一（Windows 大小写不敏感；两侧一致处理，不影响 POSIX 正确性）。 */
function normCase(p) {
  return process.platform === 'win32' ? String(p).toLowerCase() : String(p);
}

/**
 * child 是否位于 root 之内 —— **路径段比较**，绝不用字符串前缀
 * （前缀法会放过 `/proj-evil` 这类同前缀的越界路径）。
 * @param {string} root
 * @param {string} child
 * @returns {boolean}
 */
function isInside(root, child) {
  const rel = path.relative(root, child);
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${path.sep}`)) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * `project_index.components[].file` 里**登记过**的组件绝对路径集合（P0-A 校验 ③）。
 * @param {Object} projectIndex
 * @param {string} projectRoot
 * @param {string} rootDir
 * @returns {Set<string>} normCase(realpath) 集合
 */
function buildAllowedTargets(projectIndex, projectRoot, rootDir) {
  const set = new Set();
  const comps = (projectIndex && Array.isArray(projectIndex.components)) ? projectIndex.components : [];
  for (const c of comps) {
    if (!c || typeof c.file !== 'string' || !c.file || c.file.startsWith('outside-root/')) continue;
    for (const base of [projectRoot, rootDir]) {
      const a = path.resolve(base, c.file);
      if (fs.existsSync(a)) {
        set.add(normCase(realpathSafe(a)));
        break;
      }
    }
  }
  return set;
}

/**
 * 把 project_index 里的相对 `file` 解析成绝对路径，并做**路径边界校验**（P0-A）。
 *
 * ★ 契约（A3-0b 已与第 3 步工程师对齐）★
 *   `genPlan.target.file` 是 **FGUI 工程根相对** 路径（如 `assets/MailDetail/MailDetail.xml`），
 *   因此**主解析必须是** `path.resolve(projectRoot, relFile)` —— 正常路径下必须直接命中，
 *   **不触发兜底告警**。
 *
 * ★ 兜底只作最后手段 ★
 *   若索引是在别处生成的（file 相对的是生成索引时的 rootDir），工程根拼不出，才退化按本次
 *   CLI 的 `--root` 拼，且**命中时必须 stderr 告警**（绝不静默换基准）。兜底结果同样要过下面
 *   的全部边界校验（只有落在工程根内才可能通过）。
 *
 * ★ P0-A / P0-1 路径逃逸防护（`gen_plan.json` 的路径一律视为**不可信输入**）★
 *   只靠 SHA-256 防漂移挡不住「人自己改 target.file 并同步改哈希」。校验：
 *     ⓪ `target.file` 必须是**相对路径形态**（绝对路径 / 带盘符 / 以分隔符开头 → 直接拒绝）；
 *     ① 解析结果必须**位于工程根之内**（路径段比较）；
 *     ② `fs.realpathSync` 解析符号链接后的真实路径仍须在工程根内（防软链跳出）；
 *     ③ 目标必须是 `project_index.components[].file` 里**登记过**的组件 XML ——
 *        ★ 白名单为空时**默认拒绝**（P0-1：原实现写成「有名单才查」，空索引会短路跳过整条检查）★；
 *     ④ `outside-root/` 跨盘降级形态继续拒绝。
 *
 * @param {string} projectRoot
 * @param {string} rootDir
 * @param {string} relFile
 * @param {Object} logger
 * @param {Set<string>} [allowedTargets] 登记组件的 normCase(realpath) 集合
 * @returns {string} 绝对路径
 */
function resolveTargetPath(projectRoot, rootDir, relFile, logger, allowedTargets) {
  if (!relFile || typeof relFile !== 'string') {
    throw new AppError(CODES.USAGE, '目标组件缺少 file 字段：project_index.components 未提供 file');
  }
  // ⓪ 形态约束（与 README 声明一致，**显式拒绝**而非靠后置校验顺带挡住）：
  //    target.file 必须是**工程根内的相对路径**。绝对路径 / 带盘符 / 以分隔符开头
  //    一律直接拒绝 —— 这是「不可信输入」的第一道门。
  if (path.isAbsolute(relFile) || /^[A-Za-z]:[\\/]/.test(relFile)
      || relFile.startsWith('/') || relFile.startsWith('\\')) {
    throw new AppError(CODES.USAGE,
      `target.file 必须是工程根内的相对路径，但收到绝对路径形态：${JSON.stringify(relFile)}`
      + '（P0-A：gen_plan.json 的路径一律视为不可信输入）',
      { targetFile: relFile });
  }
  // ④ 跨盘降级形态：不含绝对路径信息，无法定位 → 拒绝
  if (relFile.startsWith('outside-root/')) {
    throw new AppError(CODES.USAGE,
      `目标组件 file 是跨盘降级形态（outside-root/…），无法定位绝对路径，拒绝猜测：${relFile}`);
  }

  // 主解析 → 兜底
  let abs = null;
  const candProject = path.resolve(projectRoot, relFile);
  if (fs.existsSync(candProject)) {
    abs = candProject;
  } else {
    const candRoot = path.resolve(rootDir, relFile);
    if (fs.existsSync(candRoot)) {
      if (logger) logger.warn('目标文件不在 --project 工程根下，已按 CLI rootDir 解析（仍会做包含性校验）', { file: relFile, rootDir });
      abs = candRoot;
    }
  }
  if (!abs) {
    throw new AppError(CODES.USAGE,
      `目标组件文件未找到：尝试了 <project>/${relFile} 与 <root>/${relFile} 均不存在`);
  }

  // ① 包含性校验（路径段比较）
  if (!isInside(projectRoot, abs)) {
    throw new AppError(CODES.USAGE,
      `目标文件逃出工程根，拒绝写入：${abs}（工程根 ${projectRoot}；target.file=${JSON.stringify(relFile)}）`
      + ' —— gen_plan.json 的 target.file 只能是工程根内的相对路径（P0-A 路径边界）',
      { targetFile: relFile, resolved: abs, projectRoot });
  }
  // ② 符号链接真实路径仍需在工程根内
  const realRoot = realpathSafe(projectRoot);
  const realAbs = realpathSafe(abs);
  if (!isInside(realRoot, realAbs)) {
    throw new AppError(CODES.USAGE,
      `目标文件经符号链接解析后逃出工程根，拒绝写入：${realAbs}（工程根 ${realRoot}）`,
      { targetFile: relFile, resolved: abs, realpath: realAbs, projectRoot: realRoot });
  }
  // ③ 必须是登记过的组件 XML —— ★ 白名单为空 = **默认拒绝**（P0-1）★
  //   原实现写成 `allowedTargets && allowedTargets.size && !has(...)` —— 这等于
  //   「有名单才查」，于是「索引里一个组件都没登记」时整条检查被**短路跳过**，
  //   而那恰恰是白名单最需要生效的时刻。守卫必须反过来：**没名单就拒绝**。
  if (!allowedTargets || allowedTargets.size === 0) {
    throw new AppError(CODES.USAGE,
      '工程索引里没有任何已登记组件（project_index.components 为空），拒绝写入'
      + ' —— 请先在**正确的工程根**上跑 `project-index` 生成索引后再重试（P0-1：白名单为空即默认拒绝）',
      { targetFile: relFile, resolved: abs, allowedCount: 0 });
  }
  if (!allowedTargets.has(normCase(realAbs))) {
    throw new AppError(CODES.USAGE,
      `目标文件不在 project_index.components[].file 登记范围内，拒绝写入：${abs}`
      + ' —— 只有工程里已登记的组件 XML 才允许被 gen-xml 改写（P0-A）',
      { targetFile: relFile, resolved: abs });
  }
  return abs;
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
    const abs = resolveTargetPath(projectRoot, rootDir, target.file, logger,
      buildAllowedTargets(projectIndex, projectRoot, rootDir));
    targetContents[target.file] = readTargetContent(abs);
  }

  const { genPlan, exitCode } = buildGenPlan({
    changePlan, projectIndex, baseIr, targetIr, targetContents,
    // ★ projectRoot / rootDir 必须显式传 ★
    //   gen-plan 据此把输出的 `target.file` 相对化成「**FGUI 工程根相对**」形态
    //   （M2-SPEC §4）。不传则退回 index 原样（相对 CLI rootDir，形如
    //   `out/<tmp>/project/assets/...`），§4 语义不会真正生效。
    //   `rootDir` 显式传 ctx.rootDir（而非让 gen-plan 缺省 process.cwd()），更稳。
    //   注意：targetContents 的键仍是 index 的**原始** file 值（gen-plan 只相对化输出字段）。
    options: { skipUnconfirmed, projectRoot, rootDir },
  });

  // ---- 三态状态（M2-SPEC §4.1①）：不完整即 partial，不默认为成功 ----
  const entries0 = Array.isArray(genPlan.entries) ? genPlan.entries : [];
  const blockedCount0 = entries0.filter((e) => e && e.status === 'blocked').length;
  const pending0 = entries0.filter((e) => e && e.status !== 'resolved');
  const status0 = (genPlan.gate && genPlan.gate.needsHuman) || pending0.length > 0 ? 'partial' : 'complete';
  genPlan.summary = { ...genPlan.summary, status: status0, blockedCount: blockedCount0 };
  if (status0 === 'partial') {
    emitPartialNotice(logger, 'prepare', blockedCount0, pending0, genPlan.gate);
  }

  const outPath = path.join(outDir, 'gen_plan.json');
  writeJson(outPath, genPlan); // 不做 root 相对化：file 已是相对路径，避免二次相对化

  const allowPartial0 = flagBool(flags['allow-partial'], false);
  let code0 = exitCode;
  if (code0 === EXIT.OK && status0 === 'partial' && !allowPartial0) code0 = EXIT.NEEDS_HUMAN;

  process.stdout.write(`${JSON.stringify({
    command: 'gen-xml',
    phase: 'prepare',
    // ok 语义与退出码解耦：partial（即便 --allow-partial 放行）仍为 false
    ok: status0 === 'complete',
    status: status0,
    outputs: { genPlan: relShow(outDir, outPath) },
    target: { file: genPlan.target.file, component: genPlan.target.component, pkg: genPlan.target.pkg },
    gate: genPlan.gate,
    summary: genPlan.summary,
    warningCount: (genPlan.warnings || []).length,
    warnings: genPlan.warnings || [],
  }, null, 2)}\n`);
  return code0;
}

/**
 * 部分构建的 stderr 告警（明确列出被阻塞/待处理的 op/slot 与原因，引导人去看 gen_plan.json）。
 * @param {Object} logger
 * @param {string} phase
 * @param {number} blockedCount
 * @param {Object[]} pending 非 resolved 条目
 * @param {Object} [gate]
 */
function emitPartialNotice(logger, phase, blockedCount, pending, gate) {
  const lines = [
    `[gen-xml ${phase}] 构建不完整（status=partial，blocked=${blockedCount}，待处理=${pending.length}）`
      + '—— 这些条目未落盘，请查看 gen_plan.json 的对应条目 note',
  ];
  for (const e of pending) {
    lines.push(`  · ${e.op || '?'} slot=${e.slot === undefined ? '?' : e.slot} status=${e.status || '?'}`
      + `${e.nodeId ? ` nodeId=${e.nodeId}` : ''}${e.note ? ` —— ${e.note}` : ''}`);
  }
  if (gate && gate.needsHuman) lines.push('  （门禁：含未确认 INFERRED / 歧义条目，需人工确认）');
  lines.push('  若「部分构建」可接受，请显式加 --allow-partial 放行退出码（ok 仍为 false）。');
  process.stderr.write(`${lines.join('\n')}\n`);
  if (logger) logger.warn(`gen-xml ${phase} 构建不完整（partial）`, { blockedCount, pending: pending.length });
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
    const abs = resolveTargetPath(projectRoot, rootDir, file, logger,
      buildAllowedTargets(projectIndex, projectRoot, rootDir));
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
  const lines = ['# gen-xml dryrun 报告', '', `- ok: ${report.ok}`, `- status: ${report.status || (report.summary && report.summary.status)}`, ''];
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
  const { flags, logger, config } = ctx;
  const {
    genPlan, projectIndex, targetContents,
  } = loadGenInputs(ctx);

  const allowPartial = flagBool(flags['allow-partial'], false);
  const { report, exitCode } = runDryrun({
    genPlan, projectIndex, targetContents, options: { config, allowPartial },
  });

  if (report.summary.status === 'partial') {
    emitPartialNotice(logger, 'dryrun', report.summary.blockedCount,
      (genPlan.entries || []).filter((e) => e && e.status !== 'resolved'), null);
  }

  const jsonPath = path.join(outDir, 'dryrun_report.json');
  const mdPath = path.join(outDir, 'dryrun_report.md');
  writeJson(jsonPath, report);
  ensureDir(outDir);
  fs.writeFileSync(mdPath, renderDryrunMarkdown(report), 'utf8');

  process.stdout.write(`${JSON.stringify({
    command: 'gen-xml',
    phase: 'dryrun',
    ok: report.ok,
    status: report.summary.status,
    exitCodeMeaning: exitMeaning(exitCode),
    outputs: { report: relShow(outDir, jsonPath), markdown: relShow(outDir, mdPath) },
    summary: report.summary,
    files: report.files.map((f) => ({ file: f.file, status: f.status, changed: f.changed })),
    errors: report.errors || [],
    warnings: report.warnings || [],
  }, null, 2)}\n`);
  return exitCode;
}

/**
 * apply 的三态状态：failed 优先于 partial。
 * @param {number} gateCode dryrun 门禁退出码
 * @param {number} failedCount 写盘失败文件数
 * @param {string} dryrunStatus dryrun 报告的三态
 * @returns {'complete'|'partial'|'failed'}
 */
function finalStatus(gateCode, failedCount, dryrunStatus) {
  if (failedCount > 0) return 'failed';
  if (gateCode === EXIT.USAGE || gateCode === EXIT.LINT_BLOCKED || gateCode === EXIT.ROLLED_BACK) return 'failed';
  if (dryrunStatus === 'partial' || gateCode === EXIT.NEEDS_HUMAN) return 'partial';
  return 'complete';
}

/** 退出码语义（供 stdout 字段）。 */
function exitMeaning(code) {  switch (code) {
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

  const allowPartial = flagBool(flags['allow-partial'], false);

  // 先跑同一套漂移校验 + 内存打补丁 + lint 门禁（不改盘）。
  // ★ 关键不变量（方案 A）★：apply 直接写 runDryrun 返回的 `contents[file]` ——
  //   即 dryrun 校验过的**同一份字节**。绝不自行重放补丁，从而杜绝
  //   「dryrun 报告 sha256After ≠ 实际落盘内容」这类可静默漂移的重复实现。
  const { report, exitCode: gateCode, contents: patched } = runDryrun({
    genPlan, projectIndex, targetContents, options: { config, allowPartial },
  });

  if (report.summary.status === 'partial') {
    emitPartialNotice(logger, 'apply', report.summary.blockedCount,
      (genPlan.entries || []).filter((e) => e && e.status !== 'resolved'), null);
  }

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
      const abs = resolveTargetPath(projectRoot, ctx.rootDir, f.file, logger,
        buildAllowedTargets(projectIndex, projectRoot, ctx.rootDir));
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
  // 三态：failed（回滚/写失败）优先于 partial；partial 时 ok=false（即便 --allow-partial 放行退出码）
  const status = finalStatus(gateCode, aggregate.failed, report.summary.status);
  const applyReport = {
    ok: status === 'complete',
    status,
    phase: 'apply',
    target: { file: genPlan.target ? genPlan.target.file : null },
    summary: { ...aggregate, status, blockedCount: report.summary.blockedCount || 0 },
    gate: {
      exitCode: gateCode,
      status: report.summary.status,
      filesChanged: report.summary.filesChanged,
      entriesApplied: report.summary.entriesApplied,
      entriesSkipped: report.summary.entriesSkipped,
      blockedCount: report.summary.blockedCount || 0,
    },
    files: results,
    errors: report.errors || [],
    warnings: report.warnings || [],
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
    status,
    exitCodeMeaning: exitMeaning(finalCode),
    outputs: { report: relShow(outDir, jsonPath), markdown: relShow(outDir, mdPath) },
    summary: applyReport.summary,
    files: results.map((r) => ({ file: r.file, applied: r.applied, backupPath: r.backupPath || null })),
    errors: applyReport.errors,
    warnings: applyReport.warnings,
  }, null, 2)}\n`);
  return finalCode;
}

/**
 * @param {Object} applyReport
 * @returns {string}
 */
function renderApplyMarkdown(applyReport) {
  const lines = ['# gen-xml apply 报告', '', `- ok: ${applyReport.ok}`, `- status: ${applyReport.status}`, ''];
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

module.exports = { run, resolveTargetPath, buildAllowedTargets };
