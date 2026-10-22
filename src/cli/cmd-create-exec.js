'use strict';
/**
 * src/cli/cmd-create-exec.js —— v0.3-D CREATE 执行清单（create_plan → create_exec）
 *
 * usage:
 *   fgui-rb create-exec --plan <create_plan.json> --index <project_index.json> --out <dir>
 *                       [--pkg <pkg>] [--strict]
 *
 * ★ 本命令**只产出执行清单，不做任何实际调度** ★
 *   本机没有 FairyGUI/Unity 环境，也连不上 Bridge。因此这里**绝不假装调用了 Bridge**：
 *   只把 `create_plan` 经 `buildExecPlan`（src/create/exec-plan.js）翻译成
 *   「Bridge 命令序列 + 校验期望 + 执行方自查项」，真正的调度由外部执行器负责。
 *
 * 产物（确定性，无时间戳）：
 *   create_exec.json  机器可读执行清单（steps / invalidSteps / unsupported / verify / preflight）
 *   create_exec.md    人可读：步骤表、不能构建的原因、校验期望、运行前自查
 *
 * 退出码：
 *   0  清单生成成功（**不代表可执行** —— 可执行性看 executable / preflight.ok）
 *   4  --strict 且 executable===false 或 preflight.ok===false（NEEDS_HUMAN）
 *   2  输入/参数错误（缺 --plan、文件不存在、plan 缺 page.pkg 等）
 *
 * 日志走 stderr、产物数据走 stdout（与全仓约定一致）。
 */

const fs = require('fs');
const path = require('path');
const { readJson, writeJson, ensureDir } = require('../core/fs-json');
const { flagStr } = require('./args');
const { AppError, CODES, EXIT } = require('../core/errors');
const { buildExecPlan } = require('../create/exec-plan');

/** 图片/文本节点里值得人眼核对的关键参数（md 步骤表用）。 */
const KEY_PARAMS = ['xy', 'size', 'url', 'fontSize', 'text', 'color', 'src', 'scale9grid', 'visible', 'align'];

/**
 * 从索引里按包名查 pkgId。
 *
 * ★ 查不到返回 null —— 绝不瞎编 ★
 *   `buildExecPlan` 在缺 pkgId 时会把图片插入记为 unsupported（而不是拼一个假 id），
 *   这正是我们要的行为；这里若编造 id，就会静默产出无效引用。
 *
 * @param {Object} projectIndex
 * @param {string|null} pkgName
 * @returns {string|null}
 */
function findPkgId(projectIndex, pkgName) {
  if (!pkgName) return null;
  const pkgs = (projectIndex && projectIndex.project && Array.isArray(projectIndex.project.packages))
    ? projectIndex.project.packages : [];
  const hit = pkgs.find((p) => p && p.name === pkgName);
  if (hit && hit.id !== undefined && hit.id !== null && String(hit.id).trim() !== '') {
    return String(hit.id);
  }
  return null;
}

/** 从 step.args 里挑出关键参数（确定性顺序）。 */
function keyParamsOf(args) {
  if (!args || typeof args !== 'object') return '';
  return KEY_PARAMS
    .filter((k) => args[k] !== undefined && args[k] !== null && args[k] !== '')
    .map((k) => `${k}=${args[k]}`)
    .join(' ');
}

/** 步骤/条目的目标描述：pkg/组件/节点名（缺项跳过）。 */
function targetOf(source, args, fallbackPkg) {
  const a = args && typeof args === 'object' ? args : {};
  const parts = [
    a.pkg || fallbackPkg,
    a.component || (a.parent && a.parent.name) || a.parent,
    a.name || a.nodeName,
  ].filter((x) => x !== undefined && x !== null && x !== '');
  return parts.length ? parts.join('/') : '—';
}

/** xy/size 可能是字符串也可能是 {x,y}/{w,h} — 统一成文本。 */
function vecText(v, keys) {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && keys.every((k) => v[k] !== undefined)) {
    return keys.map((k) => v[k]).join(',');
  }
  return String(v);
}

/**
 * 渲染 create_exec.md（人可读报告）。
 *
 * 结构（对应 lead 的 5 条要求）：
 *   ① 顶部一行：可执行 / 不可执行 + preflight 首条失败原因
 *   ② 步骤表：序号、op、目标、关键参数、来源 tempId
 *   ③ unsupported / invalidSteps 逐条原因
 *   ④ verify 期望：节点数 + 每节点 name/xy/size
 *   ⑤ 末尾一行：runtimeChecks
 *
 * @param {Object} exec execPlan
 * @param {Object} meta { planPath, pkgName, pkgId }
 * @returns {string}
 */
function renderExecMarkdown(exec, meta) {
  const e = exec || {};
  const lines = [];
  const push = (x) => lines.push(x);
  const preflight = e.preflight && typeof e.preflight === 'object' ? e.preflight : { ok: true, failures: [] };
  const failures = Array.isArray(preflight.failures) ? preflight.failures : [];
  const preflightOk = preflight.ok !== false;
  const executable = e.executable === true;
  const ok = executable && preflightOk;

  // ---- ① 顶部一行 ----
  const firstReason = failures.length
    ? `${failures[0].code || 'PREFLIGHT'}：${failures[0].detail || ''}`.replace(/：$/, '')
    : '';
  push(`# CREATE 执行清单：${ok ? '✅ 可执行' : `⛔ 不可执行${firstReason ? `（${firstReason}）` : ''}`}`);
  push('');
  push('> 本清单只描述**应执行的 Bridge 命令序列**；`create-exec` 本身不连接 Bridge、'
    + '不写任何 FGUI 文件。实际调度由外部执行器完成。');
  push('');
  if (meta) {
    push(`- 计划文件：\`${meta.planPath || '?'}\``);
    push(`- 目标包：\`${meta.pkgName || '(未指定)'}\`${meta.pkgId ? `（pkgId=${meta.pkgId}）` : '（**未解析到 pkgId**）'}`);
  }
  const target = e.target && typeof e.target === 'object' ? e.target : {};
  push(`- 页面：\`${target.page || '?'}\`　画布：${target.canvas ? `${target.canvas.w}×${target.canvas.h}` : '?'}`);
  push(`- executable：**${executable}**　preflight：**${preflightOk ? 'ok' : 'FAILED'}**`);
  push('');

  // ---- ② 步骤表 ----
  const steps = Array.isArray(e.steps) ? e.steps : [];
  push(`## 步骤（${steps.length}）`);
  push('');
  if (steps.length) {
    push('| # | op | 目标 | 关键参数 | 来源 |');
    push('|---|---|---|---|---|');
    for (const s of steps) {
      const src = s.source && s.source.tempId ? s.source.tempId : '';
      push(`| ${s.step !== undefined ? s.step : ''} | \`${s.op || '?'}\` | `
        + `${targetOf(s.source, s.args, meta && meta.pkgName)} | ${keyParamsOf(s.args) || '—'} | ${src || '—'} |`);
    }
  } else {
    push('-（无步骤）');
  }
  push('');

  // ---- ③ unsupported / invalidSteps ----
  const unsupported = Array.isArray(e.unsupported) ? e.unsupported : [];
  const invalid = Array.isArray(e.invalidSteps) ? e.invalidSteps : [];
  push('## 不能构建的部分');
  push('');
  if (!unsupported.length && !invalid.length) {
    push('-（无：计划里需要的操作都能翻译成 Bridge 命令）');
  } else {
    for (const u of unsupported) {
      const id = (u.source && u.source.tempId) || '?';
      push(`- **unsupported**${u.required === false ? '（非必需）' : ''}：\`${id}\` —— ${u.reason || '(无原因)'}`);
    }
    for (const v of invalid) {
      const id = (v.source && v.source.tempId) || v.op || '?';
      push(`- **invalidStep**：\`${id}\`（${v.op || '?'}）—— ${v.reason || '(无原因)'}`);
    }
  }
  push('');

  // ---- ④ verify 期望 ----
  const verify = Array.isArray(e.verify) ? e.verify : [];
  push('## 校验期望（执行后应满足）');
  push('');
  const readComp = verify.find((v) => v && v.op === 'read_component' && v.expect);
  if (readComp && readComp.expect) {
    const children = Array.isArray(readComp.expect.children) ? readComp.expect.children : [];
    push(`- 节点数：**${readComp.expect.childCount !== undefined ? readComp.expect.childCount : children.length}**`);
    if (children.length) {
      push('');
      push('| name | xy | size |');
      push('|---|---|---|');
      for (const c of children) {
        push(`| \`${c.name || '?'}\` | ${vecText(c.xy, ['x', 'y'])} | ${vecText(c.size, ['w', 'h'])} |`);
      }
    }
  } else {
    push('-（无 read_component 校验项）');
  }
  const others = verify.filter((v) => v !== readComp);
  if (others.length) {
    push('');
    push('其他校验：');
    for (const v of others) {
      push(`- \`${v.op || '?'}\`：compare=${JSON.stringify(v.compare || [])}`
        + `${v.expect ? ` expect=${JSON.stringify(v.expect)}` : ''}`);
    }
  }
  push('');

  // ---- ⑤ 末尾一行：runtimeChecks ----
  const checks = Array.isArray(e.runtimeChecks) ? e.runtimeChecks : [];
  push(`**执行方自查（本工具无法验证）**：${checks.length ? checks.join('；') : '（无）'}`);
  push('');
  return lines.join('\n');
}

/**
 * @param {Object} ctx CLI 上下文
 * @returns {Promise<number>} 退出码
 */
async function run(ctx) {
  const { flags, config, logger, rootDir } = ctx;

  const planFlag = flagStr(flags.plan);
  if (!planFlag) {
    throw new AppError(CODES.USAGE,
      'create-exec 需要 --plan <create_plan.json>（先跑 create-plan 生成计划）');
  }
  const indexFlag = flagStr(flags.index);
  if (!indexFlag) {
    throw new AppError(CODES.USAGE,
      'create-exec 需要 --index <project_index.json>（用于解析 pkgId；可先跑 project-index）');
  }

  const planPath = path.resolve(rootDir, planFlag);
  const indexPath = path.resolve(rootDir, indexFlag);
  for (const [p, what] of [[planPath, 'create_plan.json'], [indexPath, 'project_index.json']]) {
    if (!fs.existsSync(p)) {
      // FILE_NOT_FOUND 已在 core/errors.js 显式映射为 2（USAGE 语义），
      // 故此处直接用语义正确的错误码，无需绕行。
      throw new AppError(CODES.FILE_NOT_FOUND, `${what} 不存在: ${p}`, { file: p });
    }
  }

  const plan = readJson(planPath);
  const projectIndex = readJson(indexPath);

  // ★ 目标包一致性门禁（第九轮审查 P0）★
  //   只改「查哪个包 id」而不改 plan.page.pkg，会产出**跨包错引用**：
  //   容器建在 plan 的包里、图片却引用 --pkg 那个包的 pkgId（实测过）。
  //   → 不一致直接拒绝，**不产出任何清单**。
  //   ★ 未来若真要迁移目标包，那是独立的「资源重映射流程」（需同时改写
  //     page.pkg 与所有 src/url），本轮不做 —— 不做半吊子的部分迁移。
  const planPkg = (plan && plan.page && plan.page.pkg) ? String(plan.page.pkg) : null;
  const cliPkgRaw = flagStr(flags.pkg);
  const cliPkg = (typeof cliPkgRaw === 'string' && cliPkgRaw.trim()) ? cliPkgRaw.trim() : null;
  if (cliPkg && planPkg && cliPkg !== planPkg) {
    throw new AppError(CODES.USAGE,
      `plan 的目标包是 '${planPkg}'，--pkg 指定为 '${cliPkg}' —— 目标包不一致，`
      + '请去掉 --pkg 或重新生成 CREATE Plan');
  }

  // ★ pkgId：--pkg 优先，其次 plan.page.pkg；都查不到就**不传** ★
  //   （交给 buildExecPlan 记 unsupported / PKGID_INVALID，绝不编 id）
  const pkgName = cliPkg || planPkg;
  const pkgId = findPkgId(projectIndex, pkgName);

  // ★ 交叉核验数据必须传进去（第九轮审查 P0）★
  //   buildExecPlan 能用索引里的「包清单」与「目标包资源登记表」做二次核对
  //   （plan 是人工可编辑的，可能被改坏）。只传 pkgId 会让这两项核对在
  //   正式入口被跳过 —— 这正是我们第三次踩到的同一类毛病（核心函数支持、
  //   CLI 没接上）。
  //   → 索引里有这些字段就**必须传**（即使为空：空也意味着「确实没登记」）；
  //     索引里没有该字段才不传（由 exec-plan 写 advisory 说明跳过了核对）。
  const opts = {};
  if (pkgId) opts.pkgId = pkgId;
  const idxPkgs = (projectIndex && projectIndex.project && Array.isArray(projectIndex.project.packages))
    ? projectIndex.project.packages : null;
  if (idxPkgs) opts.packages = idxPkgs;
  if (Array.isArray(projectIndex && projectIndex.resources)) {
    // 只传**目标包 + image**（buildExecPlan 用它比对图片短 ID 是否已登记）
    opts.resources = projectIndex.resources.filter((r) => r && r.pkg === planPkg && r.type === 'image');
  }

  // buildExecPlan 返回 { execPlan }
  const built = buildExecPlan(plan, opts);
  const exec = built && built.execPlan ? built.execPlan : built;

  const outDir = path.resolve(rootDir, flagStr(flags.out, config.paths.outDir || 'out'));
  ensureDir(outDir);
  const jsonPath = path.join(outDir, 'create_exec.json');
  const mdPath = path.join(outDir, 'create_exec.md');
  writeJson(jsonPath, exec); // 内容无绝对路径 / 无时间戳（B9）
  // ★ 计划文件路径若在 rootDir 之外（跨盘/跨根），相对化会得到绝对路径 →
  //   绝对路径进 md 会破坏 B9（不同机器 md5 不同）。此时只写文件名。★
  const relPlan = path.relative(rootDir, planPath).replace(/\\/g, '/');
  const planLabel = (!relPlan || path.isAbsolute(relPlan) || relPlan.startsWith('..'))
    ? path.basename(planPath) : relPlan;
  fs.writeFileSync(mdPath, renderExecMarkdown(exec, {
    planPath: planLabel,
    pkgName,
    pkgId,
  }), 'utf8');

  const preflightOk = !(exec && exec.preflight && exec.preflight.ok === false);
  const executable = !!(exec && exec.executable === true);
  const ready = executable && preflightOk;

  if (logger) {
    logger.info('create_exec 已生成（仅清单，未调用 Bridge）', {
      executable,
      preflightOk,
      steps: Array.isArray(exec.steps) ? exec.steps.length : 0,
      unsupported: Array.isArray(exec.unsupported) ? exec.unsupported.length : 0,
      pkgId: pkgId || '(none)',
    });
    if (!ready) {
      logger.warn('计划不可执行 —— 原因见 create_exec.md 的「不能构建的部分」与 preflight.failures', {
        failures: (exec && exec.preflight && exec.preflight.failures) || [],
      });
    }
  }

  process.stdout.write(`${JSON.stringify({
    command: 'create-exec',
    // ok 只表示「清单生成成功」；可执行性看 executable / preflight
    ok: true,
    outputs: {
      json: path.relative(rootDir, jsonPath).replace(/\\/g, '/'),
      markdown: path.relative(rootDir, mdPath).replace(/\\/g, '/'),
    },
    executable,
    preflight: (exec && exec.preflight) || null,
    summary: (exec && exec.summary) || {
      steps: Array.isArray(exec.steps) ? exec.steps.length : 0,
      invalidSteps: Array.isArray(exec.invalidSteps) ? exec.invalidSteps.length : 0,
      unsupported: Array.isArray(exec.unsupported) ? exec.unsupported.length : 0,
    },
  }, null, 2)}\n`);

  // ★ --strict：不可执行 → 4（NEEDS_HUMAN）。默认 0：清单确实生成了 ★
  const strict = ctx.bool(flags.strict, false);
  if (strict && !ready) {
    if (logger) {
      logger.warn(`--strict：executable=${executable} preflight.ok=${preflightOk}，`
        + `以退出码 ${EXIT.NEEDS_HUMAN} 结束`);
    }
    return EXIT.NEEDS_HUMAN;
  }
  return 0;
}

module.exports = { run, renderExecMarkdown, findPkgId, keyParamsOf, targetOf };
