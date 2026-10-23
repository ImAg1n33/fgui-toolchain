'use strict';
/**
 * src/cli/cmd-create-run.js —— v0.3-D CREATE 执行入口（干跑 / 确认执行）
 *
 * usage:
 *   fgui-rb create-run --exec <create_exec.json> --bridge-url <url>
 *                      [--project <path>] [--confirm] [--out <dir>] [--timeout-ms 30000]
 *   （--project 在 --confirm 时必填：写操作必须绑定目标工程，见文首 P1）
 *
 * ★ 两条硬约束 ★
 *   1. **不带 `--confirm` 只做干跑**：只调 `ping` 做运行时自检，**不发任何写命令**，
 *      打印将要执行的步骤后退 0。想动工程必须显式 `--confirm`。
 *   2. **失败即停 ≠ 自动回滚**：本工具**没有事务回滚**。因此执行前必须**正向证明**
 *      目标组件不存在（用 `read_component` 查），已存在 → 拒绝执行（退 4）。
 *
 * ★ 第十一轮审查加固（三道闸门，按序）★
 *   3.1 **目标绑定**（P0-1，`checkTargetBinding`）：存在性检查只证明 target 不存在，
 *       但 Runner 执行的是 `steps[*].args` —— 篡改清单即可写成别的组件。故确认
 *       执行时先校验：第一个写步骤必须是 create_component 且 pkg/name == target；
 *       其余写步骤 pkg/name 必须绑定 target；verify 只许只读回读命令。不符 → 退 4
 *       且**零调用**（连探测都不发）。
 *   3.2 **存在性探测**（只读 read_component）：已存在 → 退 4；探测失败（没打通）→ 退 4。
 *   3.3 **严格不存在判据**（P0-3，`isAbsentEvidence(error, target)`）：插件回
 *       ok:false 也**不等于**「组件不存在」—— 可能是包不存在/读失败/内部异常。
 *       **结构化判定**（第十二轮修订，勿改回关键字黑名单）：真实格式
 *       `component not found in package '<pkg>': <name>` 必须包名+组件名都
 *       精确等于 target 才算不存在；无包名简写 `component not found` 算不存在；
 *       包级错误/读取失败/内部异常/名字对不上 → 一律未知，退 4 且错误带插件原文。
 *
 * ★ 写操作绑定实例（P1，第十二轮）★
 *   `--confirm` 必须显式带 `--project`：只验证"打开了某个工程"不够，多实例时
 *   可能连错编辑器、把组件写进别的工程（缺 → 退 2）。干跑是只读自检，可不带。
 *   `--project` 与 `ping.projectPath` 的比较走归一化（`\`→`/`、去尾斜杠、
 *   Windows 大小写不敏感；报错信息保留双方原值）。
 *
 * ★ 不做的事 ★
 *   · **不实现 `publish` / 删除类入口**（Runner 自带白名单 `CREATE_ALLOWED_OPS` 已挡，
 *     本 CLI 也不提供任何旁路）。
 *   · **不加重试**：失败即停，与朋友 SKILL.md「编辑命令串行、上一条成功再发下一条」一致。
 *   · **不做多实例路由**：只接受显式 `--bridge-url`（官方 `instances.mjs` 缺失，
 *     路由优先级未确认 —— 猜了就是错）。
 *   · **不外连**：`--bridge-url` 只允许本机回环（P0-2，见 bridge-http.js 的
 *     `assertLoopbackUrl`，构造时强校验，拒绝发生在联网之前）。
 *
 * ★ 可测缝 ★
 *   逻辑在 `runCreateRun(args, deps)`，`deps.transport` 可注入（契约同 Runner）；
 *   `run(ctx)` 只是薄封装。e2e（test/e2e/create-run.test.js）据此在**不连 Bridge**
 *   的前提下真跑整条命令逻辑。生产路径永远走默认 HTTP transport。
 *
 * 退出码：
 *   0  干跑成功 / 执行成功（report.status 为 `ok` 或 `ok-unverified`，stdout 用
 *      `status`/`verified` 区分「已验证的成功」与「未验证的成功」）
 *   2  参数错误 / 文件不存在 / `--confirm` 缺 `--project`
 *   4  NEEDS_HUMAN：运行时自检不过、目标绑定不符、目标组件已存在、
 *      探测失败或无法确认为「组件不存在」
 *   5  Runner 报告 status 为 failed / verify-failed / refused
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
 * 写命令集合（与 Runner `CREATE_ALLOWED_OPS` 的写侧对齐）。
 *
 * 只有这些命令真的会**写给某个组件**，所以才需要（也只需要）做目标绑定校验。
 * 白名单外的命令根本到不了 Bridge（Runner 最终门禁会 refused），
 * 在这里重复判断只会让错误信息指错地方。
 * @type {Set<string>}
 */
const BINDING_WRITE_OPS = Object.freeze(new Set([
  'create_component', 'insert_object', 'insert_text', 'insert_list', 'insert_loader', 'save_all',
]));

/** 只读回读命令（verify 只允许这些，且必须指向 target）。 @type {Set<string>} */
const READBACK_OPS = Object.freeze(new Set(['read_component', 'list_children', 'list_items']));

/**
 * ★ P0-1 目标绑定校验：存在性检查查的是 target，写步骤就必须**只**写给 target ★
 *
 * 背景（第十一轮审查）：原实现只查 `target.pkg + target.page` 是否存在，但 Runner
 * 执行的是 `steps[*].args` —— 篡改清单即可让 `target.page=NewPage`（不存在，检查通过）
 * 而 `insert_text.args.name=ExistingPage`（真实写入已有组件）。本工具**没有事务回滚**，
 * 这种写入会直接污染工程，必须在探测之前拦下。
 *
 * 四条规则：
 *   1. 第一个写步骤必须是 `create_component`，且 `args.pkg/name` 等于 target；
 *   2. 其余写步骤的 `args.pkg/name` 必须等于 target（`save_all` 不带视为绑定）；
 *   3. `verify` 只允许只读回读命令（read_component/list_children/list_items）且指向 target；
 *   4. 任一不符 → 调用方退 4 且**零调用**（连探测都不做）。
 *
 * @param {Object} execPlan create_exec.json 的内容
 * @returns {{ok:boolean, reason?:string}}
 */
function checkTargetBinding(execPlan) {
  const target = (execPlan && execPlan.target) || {};
  const pkg = target.pkg;
  const page = target.page;
  if (!pkg || !page) {
    return { ok: false, reason: 'create_exec.json 的 target 缺少 pkg/page，无法校验目标绑定' };
  }
  const steps = Array.isArray(execPlan.steps) ? execPlan.steps : [];
  const writeSteps = steps.filter((s) => s && BINDING_WRITE_OPS.has(s.op));

  // ① 第一个写步骤必须是 create_component 且指向 target
  const first = writeSteps[0];
  if (!first) {
    return {
      ok: false,
      reason: '清单里没有任何写步骤（create_component/insert_*/save_all 皆无）'
        + ' —— 无法证明本次执行只会创建 target',
    };
  }
  if (first.op !== 'create_component') {
    return {
      ok: false,
      reason: `第一个写步骤必须是 create_component（实际是 step ${first.step} 的 ${first.op}）`
        + ' —— 无法证明后续写入只作用于 target',
    };
  }
  const fa = first.args || {};
  if (fa.pkg !== pkg || fa.name !== page) {
    return {
      ok: false,
      reason: `step ${first.step} 的 args.pkg='${fa.pkg}'/args.name='${fa.name}'`
        + ` ≠ target.pkg='${pkg}'/target.page='${page}'`,
    };
  }

  // ② 其余写步骤的 pkg/name 必须绑定 target（字段缺省视为绑定，如 save_all 的 {}）
  for (const s of writeSteps) {
    const a = s.args || {};
    if (a.pkg !== undefined && a.pkg !== null && a.pkg !== pkg) {
      return { ok: false, reason: `step ${s.step} 的 args.pkg='${a.pkg}' ≠ target.pkg='${pkg}'` };
    }
    if (a.name !== undefined && a.name !== null && a.name !== page) {
      return { ok: false, reason: `step ${s.step} 的 args.name='${a.name}' ≠ target.page='${page}'` };
    }
  }

  // ③ verify 只允许只读回读命令，且指向 target
  for (const v of Array.isArray(execPlan.verify) ? execPlan.verify : []) {
    if (!v || !READBACK_OPS.has(v.op)) {
      return {
        ok: false,
        reason: `verify 的 op '${v && v.op ? v.op : '(缺失)'}' 不是只读回读命令`
          + `（${[...READBACK_OPS].join(' / ')}）—— 回读阶段不许出现写命令`,
      };
    }
    const a = v.args || {};
    if (a.pkg !== undefined && a.pkg !== null && a.pkg !== pkg) {
      return { ok: false, reason: `verify 的 args.pkg='${a.pkg}' ≠ target.pkg='${pkg}'` };
    }
    if (a.name !== undefined && a.name !== null && a.name !== page) {
      return { ok: false, reason: `verify 的 args.name='${a.name}' ≠ target.page='${page}'` };
    }
  }
  return { ok: true };
}

/**
 * ★ P0-3「组件不存在」的严格判据（第十二轮：改为**结构化判定**）★
 *
 * 背景：Bridge 基线的真实报错是
 *   `component not found in package 'Mail': NewPage`
 * （见 docs/plugin_main.js.baseline）—— **同时含 `not found` 和 `package`**。
 * 上一轮用「关键字黑名单」（含 package/包 就否）把这个合法报错也否了 →
 * 正常新建在存在性检查阶段被误拦（exit 4）。关键字路线根本走不通：
 * 删掉 /package/i 会放过 `package not found`，留着又会误杀真实格式。
 *
 * 故改为**解析真实格式 + 精确匹配目标**：
 *   模式 A（Bridge 完整格式）`component not found in package '<pkg>': <name>`
 *     → 捕获 pkg/name，**必须同时等于 target.pkg/target.page** 才算
 *       「目标组件不存在」；包名或组件名对不上 → 判**未知**
 *       （那是别的包/别的组件的错误，证明不了我们的目标不存在）。
 *   模式 B（无包名简写）`component not found`
 *     → 组件级错误、无名字可核 → 算不存在。
 *   其余一律未知：包级错误（package not found / package 'X' not found）、
 *   读取失败、插件内部异常……fail-closed，退 4。
 *
 * 插件真实措辞未经源码完全确认 → 判据从保守方向设计：宁可多拦（人来看），
 * 不可把业务错误读成"不存在"（下一步就是往已存在组件上写，无回滚）。
 *
 * @param {*} error 插件返回的 error 字段
 * @param {{pkg:string, page:string}|null|null} [target] 目标组件（用于核对模式 A 的名字）
 * @returns {boolean} true = 明确是「**目标**组件不存在」
 */
function isAbsentEvidence(error, target) {
  const msg = String(error || '').trim();
  if (!msg) return false;
  const t = target || {};

  // 模式 A：Bridge 完整格式。不加 ^ 锚 —— 允许 `read_component: ` 之类前缀。
  const PATTERN_A = /component\s+not\s+found\s+in\s+package\s+['"]?([^'":]+?)['"]?\s*:\s*(.+)$/i;
  const ma = PATTERN_A.exec(msg);
  if (ma) {
    const pkg = ma[1].trim().replace(/^['"]+|['"]+$/g, '');
    const name = ma[2].trim().replace(/^['"]+|['"]+$/g, '');
    // 名字对不上 → 未知（不是我们目标的错误，不能拿来当证据）
    return pkg === t.pkg && name === t.page;
  }

  // 模式 B：无包名的简写（组件级错误，无名字可核）
  if (/component\s+not\s+found/i.test(msg)) return true;

  // 其余：包级错误 / 读取失败 / 内部异常…… 一律未知
  return false;
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
 * @param {string|null} [args.bridgeUrl] 显式 Bridge URL（生产必填；注入 transport 时仅为占位；
 *   只允许本机回环，见 P0-2 `assertLoopbackUrl`）
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
  // ★ P1：确认执行（写操作）必须显式 --project ★
  //   只验证"编辑器打开了某个工程"不够 —— 多实例时可能连错编辑器，
  //   把组件写进别的工程。干跑是只读自检，仍可不带。
  if (confirm && !project) {
    throw new AppError(CODES.USAGE,
      '确认执行必须显式指定 --project（避免连到错误的编辑器实例）；干跑可不带');
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

  // ── ③ 确认执行：三道闸门，顺序即优先级 ──
  //
  //   3.1 目标绑定（P0-1）：写步骤必须只写给 target。放在探测**之前** ——
  //       绑定不符时连 read_component 都不发（fail-closed，零调用）。
  const binding = checkTargetBinding(execPlan);
  if (!binding.ok) {
    if (logger) logger.error('目标绑定校验未通过，拒绝执行', { reason: binding.reason });
    emit({
      command: 'create-run',
      ok: false,
      dryRun: false,
      exitCodeMeaning: 'NEEDS_HUMAN',
      reason: 'TARGET_BINDING_VIOLATION',
      detail: `${binding.reason}。存在性检查只能证明 target 不存在；若写步骤指向别的组件，`
        + '就会在**没有事务回滚**的情况下污染已有组件 —— 故拒绝执行。',
      nextAction: '修正 create_exec.json：写步骤的 pkg/name 必须与 target 一致，'
        + '第一个写步骤必须是 create_component，verify 只许只读回读命令。',
    });
    return EXIT.NEEDS_HUMAN;
  }

  //   3.2 目标存在性探测（只读 read_component，不写任何东西）
  const componentName = target.page;
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
  //   P0-3：插件回了 ok:false，但错误**无法确认**是「目标组件不存在」
  //   （可能是包不存在 / 读失败 / 插件内部异常 / 别的包或组件的错误）→ 按未知处理
  if (!isAbsentEvidence(probe.error, { pkg: target.pkg, page: target.page })) {
    if (logger) logger.error('探测返回 ok:false 但无法确认为「组件不存在」，按未知拒绝执行', {
      error: probe.error,
    });
    emit({
      command: 'create-run',
      ok: false,
      dryRun: false,
      exitCodeMeaning: 'NEEDS_HUMAN',
      reason: 'TARGET_EXISTENCE_UNVERIFIED',
      detail: `探测返回 ok:false 但无法确认为「组件不存在」（插件原始报错：${probe.error}）`
        + ' —— 可能是包不存在/读取失败/插件内部异常，或是**别的包/别的组件**的错误。'
        + '按未知处理，拒绝执行（无事务回滚）。',
      nextAction: '人工确认该组件确实不存在后再执行；若判据需要扩充，'
        + '改 cmd-create-run.js 的 isAbsentEvidence 并同步其单测。',
    });
    return EXIT.NEEDS_HUMAN;
  }
  //  3.3 到这里：Bridge 通、写步骤绑定 target、插件**明确**回「组件不存在」→ 可以建
  const existenceNote = `read_component 返回 ok:false 且错误明确匹配「组件不存在」判据`
    + `（${probe.error}）—— 目标不存在，允许创建`;

  // ── ④ 交给 Runner（它有自己的最终门禁：白名单 / unsupported / invalidSteps）──
  const { report } = await runExecPlan(execPlan, transport, { timing: false });
  const outputs = writeExecReport(outDir, report);

  // ★ P1：ok-unverified（步骤全成但结果未验证）同样退 0，但 stdout 必须能区分 ★
  const succeeded = report.status === 'ok' || report.status === 'ok-unverified';
  const verified = report.status === 'ok';

  if (logger) {
    logger.info(succeeded ? '执行完成（失败即停，无重试、无回滚）' : '执行未完成（见报告）', {
      status: report.status,
      verified,
      executed: report.summary ? report.summary.executed : 0,
      failed: report.summary ? report.summary.failed : 0,
    });
  }

  emit({
    command: 'create-run',
    ok: succeeded,
    dryRun: false,
    status: report.status,
    verified,
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

  return succeeded ? 0 : EXIT.ROLLED_BACK;
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

module.exports = {
  run, runCreateRun, preflight, samePath, checkTargetBinding, isAbsentEvidence,
};
