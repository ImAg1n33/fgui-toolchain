'use strict';
/**
 * src/cli/cmd-create-run.js —— v0.3-D CREATE 执行入口（干跑 / 确认执行）
 *
 * usage:
 *   fgui-rb create-run --exec <create_exec.json> --bridge-url <url>
 *                      [--project <path>] [--confirm] [--out <dir>] [--timeout-ms 30000]
 *
 * ★ 两条硬约束 ★
 *   1. **不带 `--confirm` 只做干跑**：只调 `ping` 做运行时自检，**不发任何写命令**，
 *      打印将要执行的步骤后退 0。想动工程必须显式 `--confirm`。
 *   2. **失败即停 ≠ 自动回滚**：本工具**没有事务回滚**。因此执行前必须**正向证明**
 *      目标组件不存在（用 `read_component` 查），已存在 → 拒绝执行（退 4）。
 *
 * ★ 不做的事 ★
 *   · **不实现 `publish` / 删除类入口**（Runner 自带白名单 `CREATE_ALLOWED_OPS` 已挡，
 *     本 CLI 也不提供任何旁路）。
 *   · **不加重试**：失败即停，与朋友 SKILL.md「编辑命令串行、上一条成功再发下一条」一致。
 *   · **不做多实例路由**：只接受显式 `--bridge-url`（官方 `instances.mjs` 缺失，
 *     路由优先级未确认 —— 猜了就是错）。
 *
 * ★ 可测缝 ★
 *   逻辑在 `runCreateRun(args, deps)`，`deps.transport` 可注入（契约同 Runner）；
 *   `run(ctx)` 只是薄封装。e2e（test/e2e/create-run.test.js）据此在**不连 Bridge**
 *   的前提下真跑整条命令逻辑。生产路径永远走默认 HTTP transport。
 *
 * 退出码：
 *   0  干跑成功 / 执行成功
 *   2  参数错误 / 文件不存在
 *   4  NEEDS_HUMAN：运行时自检不过、目标组件已存在、无法确认目标是否存在
 *   5  Runner 报告 status !== 'ok'（执行/校验失败）
 *
 * 日志走 stderr、数据走 stdout（与全仓约定一致）。
 */

const fs = require('fs');
const path = require('path');
const { readJson } = require('../core/fs-json');
const { flagStr, flagBool, flagNum } = require('./args');
const { AppError, CODES, EXIT } = require('../core/errors');
const { createHttpTransport } = require('../create/bridge-http');
const { runExecPlan, writeExecReport } = require('../create/exec-runner');

/**
 * 运行时自检：`ping`（字段依据 `docs/plugin_main.js.baseline:155-163`）。
 *
 * @param {Object} transport
 * @param {string|null} expectProject 期望的工程路径（--project）
 * @returns {Promise<{ok:boolean, reason?:string, ping?:Object}>}
 */
async function preflight(transport, expectProject) {
  const res = await transport.send('ping');
  if (!res.ok) {
    return {
      ok: false,
      reason: `Bridge 不可达或 ping 失败：${res.error || '(无 error)'}`
        + '（请确认 FairyGUI 编辑器已启动并加载了插件与工程）',
      ping: null,
    };
  }
  const d = res.data && typeof res.data === 'object' ? res.data : {};
  // ★ projectOpen 是源码确认的字段（plugin_main.js.baseline:161）★
  if (d.projectOpen !== true) {
    return { ok: false, reason: '编辑器里没有打开任何工程（ping.projectOpen !== true）', ping: d };
  }
  if (expectProject) {
    const got = d.projectPath === undefined || d.projectPath === null ? '' : String(d.projectPath);
    if (!got) {
      return { ok: false, reason: 'ping 未返回 projectPath，无法核对目标工程', ping: d };
    }
    if (!samePath(got, expectProject)) {
      return {
        ok: false,
        reason: `连到的是另一个工程：ping.projectPath='${got}'，--project='${expectProject}'`
          + '（请换 --bridge-url 指向目标实例，或去掉 --project）',
        ping: d,
      };
    }
  }
  return { ok: true, ping: d };
}

/**
 * 路径比较（Windows 大小写不敏感 + 分隔符归一 + 去末尾斜杠）。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function samePath(a, b) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * create-run 主体（**可注入 transport 的可测形态**）。
 *
 * ★ 为什么要有这个缝 ★
 *   e2e 要「真跑 CLI 逻辑、但绝不连 Bridge」：本机没有 FairyGUI，真连只会
 *    ECONNREFUSED。故把逻辑从 `run(ctx)` 里抽出来，允许注入 `deps.transport`
 *   （`{send(op,args)}` 契约与 `exec-runner.js:9` 一致）。`run(ctx)` 只是
 *   薄封装：flags → args、建真 transport。生产路径永远不注入。
 *
 * @param {Object} [args]
 * @param {string|null} [args.exec] create_exec.json 路径（相对 rootDir 或绝对）
 * @param {string|null} [args.bridgeUrl] 显式 Bridge URL（生产必填；注入 transport 时仅为占位）
 * @param {string|null} [args.project] 期望的工程路径（--project）
 * @param {boolean} [args.confirm=false] 是否真正执行（false = 只干跑）
 * @param {string|null} [args.out] 产物目录（相对 rootDir 或绝对；缺省 'out'）
 * @param {number} [args.timeoutMs=30000]
 * @param {string} [args.rootDir=process.cwd()]
 * @param {Object} [deps]
 * @param {{send:Function}} [deps.transport] 注入的 transport（测试用）；缺省建真 HTTP transport
 * @param {{info:Function,warn:Function,error:Function}|null} [deps.logger=null]
 * @param {{write:Function}} [deps.stdout=process.stdout]
 * @returns {Promise<number>} 退出码
 */
async function runCreateRun(args = {}, deps = {}) {
  const {
    exec = null,
    bridgeUrl = null,
    project = null,
    confirm = false,
    out = null,
    timeoutMs = 30000,
    rootDir = process.cwd(),
  } = args || {};
  const transport = (deps && deps.transport) || createHttpTransport({ bridgeUrl, timeoutMs });
  const logger = (deps && deps.logger) || null;
  const stdout = (deps && deps.stdout) || process.stdout;
  /** 产物 JSON 一律走 stdout（日志走 stderr，见文件头约定）。 */
  const emit = (obj) => { stdout.write(`${JSON.stringify(obj, null, 2)}\n`); };

  if (!exec) {
    throw new AppError(CODES.USAGE,
      'create-run 需要 --exec <create_exec.json>（先跑 create-exec 生成执行清单）');
  }
  if (!bridgeUrl) {
    throw new AppError(CODES.USAGE,
      'create-run 需要 --bridge-url <url>（如 http://127.0.0.1:7531/；'
      + '多实例路由语义未确认，故不支持按工程自动选择实例）');
  }

  const execPath = path.resolve(rootDir, exec);
  if (!fs.existsSync(execPath)) {
    throw new AppError(CODES.FILE_NOT_FOUND, `create_exec.json 不存在: ${execPath}`, { file: execPath });
  }
  const execPlan = readJson(execPath);
  // 空文件 / 字面 null / 非对象：给干净错误，别让裸 TypeError 冲到 CLI 外层
  // （Runner 自己也容错 execPlan 缺失，但那是执行期；这里连步骤都读不出来）
  if (!execPlan || typeof execPlan !== 'object' || Array.isArray(execPlan)) {
    throw new AppError(CODES.READ_FAILED,
      `create_exec.json 不是有效的执行清单（空文件或非 JSON 对象）: ${execPath}`, { file: execPath });
  }

  const outDir = path.resolve(rootDir, out || 'out');
  const steps = Array.isArray(execPlan.steps) ? execPlan.steps : [];
  const target = execPlan.target && typeof execPlan.target === 'object' ? execPlan.target : {};

  // ── ① 运行时自检（干跑与执行都要做）──
  const check = await preflight(transport, project || null);
  if (!check.ok) {
    if (logger) logger.error(`运行时自检未通过：${check.reason}`);
    emit({
      command: 'create-run',
      ok: false,
      dryRun: !confirm,
      exitCodeMeaning: 'NEEDS_HUMAN',
      preflight: { ok: false, reason: check.reason, ping: check.ping },
      nextAction: '修正后重跑：确认编辑器已打开目标工程，或换 --bridge-url / --project',
    });
    return EXIT.NEEDS_HUMAN;
  }

  // ── ② 干跑：只打印，不发写命令 ──
  if (!confirm) {
    if (logger) {
      logger.info('干跑模式（未带 --confirm）：只做自检，**不会发送任何写命令**', {
        steps: steps.length, bridge: transport.bridgeUrl,
      });
      for (const s of steps) {
        logger.info(`将执行 ${s.step !== undefined ? s.step : '-'}: ${s.op}`, {
          args: s.args || {}, source: (s.source && s.source.tempId) || null,
        });
      }
    }
    emit({
      command: 'create-run',
      ok: true,
      dryRun: true,
      note: '干跑：已通过运行时自检；未发送任何写命令。加 --confirm 才会真正执行。',
      bridge: { url: transport.bridgeUrl, timeoutMs: transport.timeoutMs },
      target,
      preflight: { ok: true, ping: check.ping },
      plannedSteps: steps.map((s) => ({
        step: s.step, op: s.op, args: s.args || {}, source: (s.source && s.source.tempId) || null,
      })),
    });
    return 0;
  }

  // ── ③ 确认执行：先正向证明目标组件不存在（无事务回滚，必须先挡）──
  const componentName = target.page;
  if (!componentName || !target.pkg) {
    throw new AppError(CODES.BAD_ARGUMENT,
      'create_exec.json 的 target 缺少 pkg/page，无法校验目标组件是否已存在');
  }
  const probe = await transport.send('read_component', { pkg: target.pkg, name: componentName });
  if (probe.ok) {
    // 读到了 → 组件已存在
    if (logger) logger.error('目标组件已存在，拒绝执行（本工具无事务回滚）', {
      pkg: target.pkg, component: componentName,
    });
    emit({
      command: 'create-run',
      ok: false,
      dryRun: false,
      exitCodeMeaning: 'NEEDS_HUMAN',
      reason: 'TARGET_ALREADY_EXISTS',
      detail: `目标组件 '${componentName}'（包 '${target.pkg}'）已存在 —— `
        + '拒绝执行。本工具**没有事务回滚**，覆盖既有组件会直接破坏工程。'
        + '请换组件名，或在测试副本工程中执行。',
    });
    return EXIT.NEEDS_HUMAN;
  }
  if (probe.transportError) {
    // 不是插件说「不存在」，而是我们没打通 → 不能当作不存在
    if (logger) logger.error('无法确认目标组件是否存在（Bridge 侧探测失败），拒绝执行', {
      error: probe.error,
    });
    emit({
      command: 'create-run',
      ok: false,
      dryRun: false,
      exitCodeMeaning: 'NEEDS_HUMAN',
      reason: 'TARGET_EXISTENCE_UNKNOWN',
      detail: `探测目标组件失败：${probe.error}。无法证明它不存在，`
        + '故按 fail-closed 拒绝执行（无事务回滚）。',
    });
    return EXIT.NEEDS_HUMAN;
  }
  // 到这里：Bridge 通、插件明确回 ok:false（即查不到该组件）→ 可以建
  const existenceNote = `已用 read_component 确认目标组件 '${componentName}' 不存在`
    + `（插件返回 error：${probe.error || '(无)'}）`;

  // ── ④ 交给 Runner（它有自己的最终门禁：白名单 / unsupported / invalidSteps）──
  const { report } = await runExecPlan(execPlan, transport, { timing: false });
  const outputs = writeExecReport(outDir, report);

  if (logger) {
    logger.info('执行完成（失败即停，无重试、无回滚）', {
      status: report.status,
      executed: report.summary ? report.summary.executed : 0,
      failed: report.summary ? report.summary.failed : 0,
    });
  }

  emit({
    command: 'create-run',
    ok: report.status === 'ok',
    dryRun: false,
    status: report.status,
    preflight: { ok: true, ping: check.ping },
    targetExistence: { proven: 'absent', how: 'read_component', note: existenceNote },
    outputs: {
      json: path.relative(rootDir, outputs.json).replace(/\\/g, '/'),
      markdown: path.relative(rootDir, outputs.md).replace(/\\/g, '/'),
    },
    summary: report.summary || null,
    failedAtStep: report.failedAtStep === undefined ? null : report.failedAtStep,
    reason: report.reason || null,
  });

  return report.status === 'ok' ? 0 : EXIT.ROLLED_BACK;
}

/**
 * CLI 薄封装：ctx（flags/config/logger/rootDir）→ runCreateRun(args, deps)。
 *
 * @param {Object} ctx CLI 上下文（src/cli/index.js）
 * @param {Object} [deps] 透传给 runCreateRun（仅测试用；生产不传）
 * @returns {Promise<number>} 退出码
 */
async function run(ctx, deps = {}) {
  const { flags, config, logger, rootDir } = ctx;
  return runCreateRun({
    exec: flagStr(flags.exec),
    bridgeUrl: flagStr(flags['bridge-url']),
    project: flagStr(flags.project) || null,
    confirm: flagBool(flags.confirm, false),
    out: flagStr(flags.out, (config && config.paths && config.paths.outDir) || 'out'),
    timeoutMs: flagNum(flags['timeout-ms'], 30000),
    rootDir,
  }, { ...deps, logger });
}

module.exports = { run, runCreateRun, preflight, samePath };
