'use strict';
/**
 * test/e2e/create-run.test.js —— create-run 端到端（干跑 / 确认执行）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 三种跑法，各管各的真实层 ★
 *   ① **真 CLI 子进程**（test/e2e/run-cli.js）：参数/文件错误类用例。
 *      它们在碰到 Bridge 之前就失败，不需要注入也能真跑、真拿进程退出码。
 *   ② **进程内 `runCreateRun(args, deps)`**（注入假 transport）：干跑/确认执行
 *      的逻辑主体。注入走 `cmd-create-run.js` 的 `deps.transport` 缝
 *      （契约同 exec-runner：`{send(op,args)}`），**不建任何套接字**；
 *      stdout/logger 也注入，绝不猴补全局（那会吞掉 node:test 的报告，
 *      见 run-cli.js 头注释）。AppError → 退出码的换算与 src/cli/index.js
 *      同口径（toAppError）。
 *   ③ **loopback 全栈**：真 CLI 子进程 + 真 `defaultPost` + 真 HTTP，
 *      打一个只听 127.0.0.1 临时端口的假 Bridge。数据不出本机
 *      （PRD K1 禁的是素材外发，不是本机回环）；这条用例专门证明
 *      「HTTP 500 但 body ok:true 也判成功」与干跑零写命令在**整条栈**上成立。
 *
 * fixture：`create_exec.json` 由**真链路**产出（buildCreatePlan → buildExecPlan），
 *   不手写结构 —— 与 test/unit/exec-runner.test.js 同源，保证 e2e 踩的是
 *   真实契约而不是测试自己臆想的形状。
 *
 * 退出码契约（cmd-create-run.js 头注释）：
 *   0 干跑成功 / 执行成功｜2 参数错误 / 文件不存在
 *   4 NEEDS_HUMAN（自检不过 / 目标已存在 / 目标存在性未知）｜5 Runner 报告非 ok
 * ════════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

const { runCli, CLI } = require('./run-cli');
const { runCreateRun, isAbsentEvidence } = require('../../src/cli/cmd-create-run');
const { toAppError } = require('../../src/core/errors');
const { buildCreatePlan } = require('../../src/create/plan-builder');
const { buildExecPlan } = require('../../src/create/exec-plan');

const ROOT = path.resolve(__dirname, '../..');
const TMP_BASE = path.join(ROOT, 'out', 'e2e-create-run');
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const ISO_TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/**
 * 异步版 runCli（loopback 全栈用例专用）。
 *
 * ★ 为什么不能直接用 run-cli.js 的 spawnSync ★
 *   spawnSync 会**阻塞测试进程的事件循环** —— 而假 Bridge 服务器就住在
 *   测试进程里。子进程 CLI 发请求过来时父进程正卡在 spawnSync，服务器
 *   永远没机会回包，客户端只能等 30s 超时。故全栈用例必须用异步 spawn，
 *   让事件环保持自由。
 *
 * @param {string[]} args
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function runCliAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--disable-warning=ExperimentalWarning', CLI, ...args,
    ], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code === null ? -1 : code, stdout, stderr }));
  });
}

/** 异步跑一次 CLI 并解析 stdout JSON。 */
async function runCliJsonAsync(args) {
  const r = await runCliAsync(args);
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch (err) {
    throw new Error(
      `CLI stdout 不是合法 JSON（${args.join(' ')}）：${err.message}\n`
      + `--- stdout 前 500 字 ---\n${r.stdout.slice(0, 500)}\n`
      + `--- stderr 前 500 字 ---\n${r.stderr.slice(0, 500)}`,
    );
  }
  return { code: r.code, json, stderr: r.stderr };
}

/** CREATE 白名单里的写命令（用于断言「干跑/拒绝时零写命令」）。 */
const WRITE_OPS = new Set([
  'create_component', 'insert_object', 'insert_text', 'insert_list', 'insert_loader',
  'set_image_scale9', 'save_all',
]);

// ════════════════════════════════════════════════════════════════════════════
// fixture：真链路产出的 create_exec.json（与 unit 测试同源）
// ════════════════════════════════════════════════════════════════════════════

const PKG_ID = 'mailpkg1';

/** 真实 plan（不手写结构）。 */
function realPlan() {
  const ir = {
    version: '1.0',
    source: { canvas: { w: 750, h: 1334 } },
    layers: [
      {
        id: 'L1', name: '背景', type: 'raster', bbox: { x: 0, y: 0, w: 750, h: 1334 }, visible: true, opacity: 1,
      },
      {
        id: 'L2',
        name: '标题',
        type: 'text',
        bbox: { x: 40, y: 100, w: 300, h: 40 },
        visible: true,
        opacity: 0.8,
        text: { value: '邮件详情', color: '#ffffff', fontSize: 24 },
      },
    ],
  };
  const projectIndex = {
    version: '1.0',
    project: { packages: [{ name: 'Mail', id: PKG_ID }] },
    resources: [{
      pkg: 'Mail', pkgId: PKG_ID, id: 'q0jse', name: '背景.png', type: 'image', exported: true, width: 750, height: 1334,
    }],
    components: [],
  };
  return buildCreatePlan({ ir, projectIndex, pageName: 'MailPagePopup' });
}

/** 真实 execPlan（clean → executable=true）。 */
function realExec() {
  return buildExecPlan(realPlan(), {
    pkgId: PKG_ID,
    packages: [{ name: 'Mail', id: PKG_ID }],
    resources: [{ id: 'q0jse' }],
  }).execPlan;
}

/** 与 expect 完全一致的组件 XML（两个子节点：背景图 + 标题文本）。 */
function okXml() {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<component size="750,1334" exported="true">',
    '  <displayList>',
    '    <image id="b00001" name="img_bg" src="ui://mailpkg1q0jse" xy="0,0" size="750,1334"/>',
    '    <text id="b00002" name="txt_标题" xy="40,100" size="300,40" text="邮件详情"/>',
    '  </displayList>',
    '</component>',
    '',
  ].join('\n');
}

/** 建临时目录 + create_exec.json；返回各处路径。 */
function setup(label, mutate) {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_BASE, `${label}-`));
  const execPath = path.join(dir, 'create_exec.json');
  const plan = realExec();
  if (typeof mutate === 'function') mutate(plan);
  fs.writeFileSync(execPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return { dir, execPath, out: path.join(dir, 'out') };
}

// ════════════════════════════════════════════════════════════════════════════
// 假 transport（进程内注入用）：按剧本回包，并记录每次调用
// ════════════════════════════════════════════════════════════════════════════

/** 常用剧本片段。 */
const PING_OK = {
  ok: true,
  data: {
    version: '1.0.0', editor: 'FairyGUI', port: 7531,
    projectPath: 'D:/proj/Mail.fairy', projectOpen: true, project: 'Mail',
  },
};
const READ_ABSENT = { ok: false, error: '组件不存在：Mail/MailPagePopup' };
const READ_PRESENT = { ok: true, data: { pkg: 'Mail', name: 'MailPagePopup', xml: okXml() } };
const WRITE_OK = { ok: true, data: { ok: true } };

/** 全绿剧本：ping 通 → 探测不存在 → 各写命令成功 → 回读符合期望。 */
function happyScript() {
  return {
    ping: PING_OK,
    // 第 1 次 read_component = 目标存在性探测（不存在）；第 2 次 = Runner 回读（存在且符合期望）
    read_component: [READ_ABSENT, READ_PRESENT],
    create_component: WRITE_OK,
    insert_object: WRITE_OK,
    insert_text: WRITE_OK,
    save_all: WRITE_OK,
  };
}

function makeFakeTransport(script = {}, calls = []) {
  const seen = new Map();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    // 这两个字段只为让干跑产物里的 bridge 信息可读（注入时不会被真正使用）
    bridgeUrl: 'http://127.0.0.1:7531/',
    timeoutMs: 30000,
    async send(op, args) {
      calls.push({ op, args: args || {} });
      const n = (seen.get(op) || 0) + 1;
      seen.set(op, n);
      // 剧本值可以是数组：按调用次序消费（耗尽后沿用最后一条）
      let r;
      if (Array.isArray(script[op])) {
        r = script[op][Math.min(n - 1, script[op].length - 1)];
      } else if (script[op] !== undefined) {
        r = script[op];
      } else if (script.default !== undefined) {
        r = script.default;
      } else {
        r = { ok: false, transportError: true, error: `假 Bridge 未编排 op '${op}'` };
      }
      return clone(r);
    },
  };
}

/**
 * 进程内跑一次 create-run（注入 transport / stdout / logger）。
 * AppError 按 src/cli/index.js 的口径换算成退出码。
 *
 * @param {Object} spec
 * @param {Object} spec.args runCreateRun 的 args
 * @param {Object} [spec.script] 假 transport 剧本
 * @returns {Promise<{code:number, err:Object|null, json:Object|null, calls:Object[], logs:Object[]}>}
 */
async function runInProcess(spec) {
  const calls = [];
  const chunks = [];
  const logs = [];
  const stdout = { write: (s) => { chunks.push(String(s)); return true; } };
  const rec = (lv) => (m, o) => { logs.push({ level: lv, msg: m, obj: o || null }); };
  const logger = { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') };
  let code;
  let err = null;
  try {
    code = await runCreateRun(spec.args, {
      transport: makeFakeTransport(spec.script, calls), logger, stdout,
    });
  } catch (e) {
    err = toAppError(e);
    code = err.exitCode;
  }
  let json = null;
  try {
    json = chunks.join('') ? JSON.parse(chunks.join('')) : null;
  } catch (e) {
    json = { __parseError: String(e) };
  }
  return { code, err, json, calls, logs };
}

/** 进程内跑一次的标准 args（exec/out 用绝对路径，rootDir=仓库根）。 */
function stdArgs(f, extra = {}) {
  return {
    exec: f.execPath,
    bridgeUrl: 'http://127.0.0.1:7531/',
    project: null,
    confirm: false,
    out: f.out,
    timeoutMs: 30000,
    rootDir: ROOT,
    ...extra,
  };
}

const opsOf = (calls) => calls.map((c) => c.op);

// ════════════════════════════════════════════════════════════════════════════
// ① 参数 / 文件错误 → 退 2（真 CLI 子进程，真进程退出码）
// ════════════════════════════════════════════════════════════════════════════

test('① 缺 --exec / 缺 --bridge-url / 文件不存在 → 退 2（真 CLI）', () => {
  const f = setup('args');

  const noExec = runCli(['create-run', '--bridge-url', 'http://127.0.0.1:7531/']);
  assert.equal(noExec.code, 2, `缺 --exec 应退 2，实际 ${noExec.code}`);
  assert.match(noExec.stderr + noExec.stdout, /--exec/);

  const noUrl = runCli(['create-run', '--exec', f.execPath]);
  assert.equal(noUrl.code, 2, `缺 --bridge-url 应退 2，实际 ${noUrl.code}`);
  assert.match(noUrl.stderr + noUrl.stdout, /--bridge-url/);

  const missing = runCli([
    'create-run', '--exec', path.join(f.dir, 'nope.json'), '--bridge-url', 'http://127.0.0.1:7531/',
  ]);
  assert.equal(missing.code, 2, `文件不存在应退 2，实际 ${missing.code}`);
  assert.match(missing.stderr + missing.stdout, /不存在/);
  // 失败在前，产物目录都不该被建
  assert.equal(fs.existsSync(f.out), false, '★ 参数错误不许建产物目录');

  // 附：空 / 非对象的 create_exec.json → 干净的 AppError（退 1），绝不许裸 TypeError
  const brokenDir = path.join(f.dir, 'broken');
  fs.mkdirSync(brokenDir, { recursive: true });
  const emptyExec = path.join(brokenDir, 'create_exec.json');
  fs.writeFileSync(emptyExec, '', 'utf8');
  const broken = runCli(['create-run', '--exec', emptyExec, '--bridge-url', 'http://127.0.0.1:7531/']);
  assert.equal(broken.code, 1, `空清单应退 1（READ_FAILED），实际 ${broken.code}`);
  assert.match(broken.stderr + broken.stdout, /不是有效的执行清单/);
  assert.ok(!/TypeError/.test(broken.stderr), '★ 不许裸 TypeError 冲到 CLI 外层');
});

// ════════════════════════════════════════════════════════════════════════════
// ② 不带 --confirm → 只干跑：ping 被调用，写命令零调用，退 0
// ════════════════════════════════════════════════════════════════════════════

test('② 干跑：只调 ping，写命令零调用，退 0，且不落任何产物', async () => {
  const f = setup('dryrun');
  const r = await runInProcess({ args: stdArgs(f), script: happyScript() });

  assert.equal(r.code, 0, `干跑应退 0：${JSON.stringify(r.json).slice(0, 300)}`);
  assert.equal(r.json.dryRun, true);
  assert.equal(r.json.ok, true);
  assert.match(r.json.note, /干跑/);
  assert.deepEqual(opsOf(r.calls), ['ping'], '★ 干跑只许调 ping（自检）');
  assert.equal(r.calls.some((c) => WRITE_OPS.has(c.op)), false, '★ 任何写命令都不许出现');
  assert.equal(r.calls.some((c) => c.op === 'read_component'), false,
    '★ 干跑连目标存在性探测都不做（那是确认执行阶段的门禁）');
  // 计划步骤被完整打印出来（让人 review 将要发生什么）
  const plan = realExec();
  assert.equal(r.json.plannedSteps.length, plan.steps.length);
  assert.deepEqual(r.json.plannedSteps.map((s) => s.op), plan.steps.map((s) => s.op));
  // 干跑不落产物
  assert.equal(fs.existsSync(path.join(f.out, 'exec_report.json')), false);
  assert.equal(fs.existsSync(f.out), false, '★ 干跑连 out 目录都不该建');
});

// ════════════════════════════════════════════════════════════════════════════
// ③ ping 自检不过 → 退 4，原因写明
// ════════════════════════════════════════════════════════════════════════════

test('③ ping 报 projectOpen:false → 退 4，原因点名', async () => {
  const f = setup('no-project');
  const r = await runInProcess({
    args: stdArgs(f),
    script: { ping: { ok: true, data: { ...PING_OK.data, projectOpen: false } } },
  });
  assert.equal(r.code, 4, `应退 4，实际 ${r.code}`);
  assert.equal(r.json.exitCodeMeaning, 'NEEDS_HUMAN');
  assert.match(r.json.preflight.reason, /projectOpen/);
  assert.deepEqual(opsOf(r.calls), ['ping'], '自检失败就停，不做别的');
});

test('③-b ping 不可达（transportError）→ 退 4，原因说明要开编辑器', async () => {
  const f = setup('bridge-down');
  const r = await runInProcess({
    args: stdArgs(f),
    script: { ping: { ok: false, transportError: true, error: 'connect ECONNREFUSED 127.0.0.1:7531' } },
  });
  assert.equal(r.code, 4);
  assert.match(r.json.preflight.reason, /不可达|ping 失败/);
  assert.match(r.json.preflight.reason, /ECONNREFUSED/);
});

test('③-c --project 与 ping.projectPath 不一致 → 退 4（fail-closed）', async () => {
  const f = setup('wrong-project');
  const r = await runInProcess({
    args: stdArgs(f, { project: 'D:/other/Proj' }),
    script: { ping: PING_OK },
  });
  assert.equal(r.code, 4);
  assert.match(r.json.preflight.reason, /另一个工程/);
  assert.match(r.json.preflight.reason, /Mail\.fairy/);
});

// ════════════════════════════════════════════════════════════════════════════
// ④ 目标组件已存在 → 退 4，且不再执行任何步骤
// ════════════════════════════════════════════════════════════════════════════

test('④ 目标已存在（read_component 命中）→ 退 4，零步骤执行', async () => {
  const f = setup('exists');
  const r = await runInProcess({
    args: stdArgs(f, { confirm: true }),
    script: { ping: PING_OK, read_component: READ_PRESENT },
  });

  assert.equal(r.code, 4, `已存在应退 4，实际 ${r.code}`);
  assert.equal(r.json.reason, 'TARGET_ALREADY_EXISTS');
  assert.match(r.json.detail, /没有事务回滚/);
  // ★ 只做了 ping + 一次只读探测，没有任何步骤、没有任何写命令
  assert.deepEqual(opsOf(r.calls), ['ping', 'read_component']);
  assert.equal(r.calls.some((c) => WRITE_OPS.has(c.op)), false, '★ 已存在时一个写命令都不许发');
  // 探测形状：只读命令 read_component(pkg,name)，且在 CREATE 白名单里
  assert.deepEqual(r.calls[1].args, { pkg: 'Mail', name: 'MailPagePopup' });
  assert.equal(fs.existsSync(path.join(f.out, 'exec_report.json')), false, '拒绝执行不落报告');
});

test('④-b 探测本身失败（transportError）→ 退 4：无法证明不存在即拒绝（fail-closed）', async () => {
  const f = setup('probe-fail');
  const r = await runInProcess({
    args: stdArgs(f, { confirm: true }),
    script: {
      ping: PING_OK,
      read_component: { ok: false, transportError: true, error: '探测请求超时（30000ms）' },
    },
  });
  assert.equal(r.code, 4);
  assert.equal(r.json.reason, 'TARGET_EXISTENCE_UNKNOWN');
  assert.match(r.json.detail, /fail-closed|无法证明/);
  assert.deepEqual(opsOf(r.calls), ['ping', 'read_component']);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑤ --confirm 且全部通过 → 退 0，产物 exec_report.json/.md 落盘
// ════════════════════════════════════════════════════════════════════════════

test('⑤ 确认执行全绿 → 退 0，报告落盘，回读通过', async () => {
  const f = setup('happy');
  const r = await runInProcess({ args: stdArgs(f, { confirm: true }), script: happyScript() });

  assert.equal(r.code, 0, `应退 0：${JSON.stringify(r.json).slice(0, 400)}`);
  assert.equal(r.json.status, 'ok');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.dryRun, false);
  assert.equal(r.json.targetExistence.proven, 'absent');
  assert.equal(r.json.targetExistence.how, 'read_component');

  // 产物落盘
  const jsonPath = path.join(f.out, 'exec_report.json');
  const mdPath = path.join(f.out, 'exec_report.md');
  assert.ok(fs.existsSync(jsonPath), 'exec_report.json 必须落盘');
  assert.ok(fs.existsSync(mdPath), 'exec_report.md 必须落盘');
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(report.status, 'ok');
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.skipped, 0);
  assert.ok(report.verify.every((v) => v.ok), '回读必须全过');

  // 调用序列：ping → 存在性探测 → 全部步骤（顺序）→ 回读
  const plan = realExec();
  const expected = ['ping', 'read_component', ...plan.steps.map((s) => s.op), ...plan.verify.map((v) => v.op)];
  assert.deepEqual(opsOf(r.calls), expected);
  assert.equal(r.calls[r.calls.length - 1].op, 'read_component', '回读在最后');

  // stdout 的 outputs 指向真实产物
  assert.equal(r.json.outputs.json, path.relative(ROOT, jsonPath).replace(/\\/g, '/'));
  assert.equal(r.json.outputs.markdown, path.relative(ROOT, mdPath).replace(/\\/g, '/'));
});

// ════════════════════════════════════════════════════════════════════════════
// ⑥ Runner 报告 status !== 'ok' → 退 5
// ════════════════════════════════════════════════════════════════════════════

test('⑥ 步骤失败 → Runner status:failed → 退 5，失败即停（后续不调）', async () => {
  const f = setup('step-fail');
  const script = happyScript();
  script.insert_text = { ok: false, error: '模拟失败：文本插入被编辑器拒绝' };
  const r = await runInProcess({ args: stdArgs(f, { confirm: true }), script });

  const plan = realExec();
  const failStep = plan.steps.find((s) => s.op === 'insert_text').step;

  assert.equal(r.code, 5, `Runner 非 ok 应退 5，实际 ${r.code}`);
  assert.equal(r.json.status, 'failed');
  assert.equal(r.json.failedAtStep, failStep);
  // 失败即停：调用到失败步骤为止，回读不再发生
  const executed = plan.steps.filter((s) => s.step <= failStep).map((s) => s.op);
  assert.deepEqual(opsOf(r.calls), ['ping', 'read_component', ...executed]);
  assert.equal(r.calls.some((c) => c.op === 'read_component' && c !== r.calls[1]), false,
    '★ 失败后不许再做回读');
  // 报告仍落盘（供人看死在哪一步）
  const report = JSON.parse(fs.readFileSync(path.join(f.out, 'exec_report.json'), 'utf8'));
  assert.equal(report.status, 'failed');
  assert.equal(report.failedAtStep, failStep);
});

test('⑥-b 篡改清单 executable:false → Runner refused → 退 5，写命令零调用', async () => {
  const f = setup('tampered-exec', (plan) => { plan.executable = false; });
  const r = await runInProcess({ args: stdArgs(f, { confirm: true }), script: happyScript() });

  assert.equal(r.code, 5, `refused 应退 5，实际 ${r.code}`);
  assert.equal(r.json.status, 'refused');
  assert.match(r.json.reason, /executable/);
  assert.deepEqual(opsOf(r.calls), ['ping', 'read_component'],
    '★ 不可执行的清单：只做了自检与只读探测，一个写命令都不许发');
});

test('⑥-c 篡改步骤塞入白名单外命令（delete_item）→ 被 Runner 最终门禁拦下 → 退 5', async () => {
  const f = setup('tampered-op', (plan) => {
    plan.steps.push({ step: plan.steps.length + 1, op: 'delete_item', args: { pkg: 'Mail', name: 'x' } });
  });
  const r = await runInProcess({ args: stdArgs(f, { confirm: true }), script: happyScript() });

  assert.equal(r.code, 5);
  assert.equal(r.json.status, 'refused');
  assert.match(r.json.reason, /delete_item/);
  assert.match(r.json.reason, /CREATE 白名单/);
  assert.equal(r.calls.some((c) => WRITE_OPS.has(c.op)), false,
    '★ 词表内但白名单外的命令，一个都不许到达 Bridge');
});

// ════════════════════════════════════════════════════════════════════════════
// ★ 第十一轮审查 P0-1：目标绑定 —— 存在性检查查的是 target，写步骤必须只写给 target
//   篡改手法：target.page=NewPage（不存在，检查通过）而 insert_text.args.name=
//   ExistingPage（真实写入已有组件）。本工具无事务回滚 → 必须在探测之前拦下。
// ════════════════════════════════════════════════════════════════════════════

test('★ P0-1 ① 篡改 insert_text.args.name 指向已有组件 → 退 4，零调用（连探测都不做）', async () => {
  const f = setup('bind-name', (plan) => {
    plan.steps.find((s) => s.op === 'insert_text').args.name = 'ExistingPage';
  });
  const r = await runInProcess({ args: stdArgs(f, { confirm: true }), script: happyScript() });
  const stepNo = realExec().steps.find((s) => s.op === 'insert_text').step;

  assert.equal(r.code, 4, `绑定不符应退 4，实际 ${r.code}`);
  assert.equal(r.json.reason, 'TARGET_BINDING_VIOLATION');
  assert.ok(r.json.detail.includes(`step ${stepNo} 的 args.name='ExistingPage' ≠ target.page='MailPagePopup'`),
    `错误必须点名 step 与字段：${r.json.detail}`);
  // ★ 绑定闸门在探测之前：ping 之外零调用，写命令更不许出现
  assert.deepEqual(opsOf(r.calls), ['ping'], '★ 绑定不符时连 read_component 探测都不许发');
  assert.equal(r.calls.some((c) => WRITE_OPS.has(c.op)), false);
  assert.equal(fs.existsSync(path.join(f.out, 'exec_report.json')), false, '拒绝执行不落报告');
});

test('★ P0-1 ② 第一个写步骤不是 create_component → 退 4，零调用', async () => {
  const f = setup('bind-first', (plan) => {
    plan.steps = plan.steps.filter((s) => s.op !== 'create_component');
  });
  const r = await runInProcess({ args: stdArgs(f, { confirm: true }), script: happyScript() });

  assert.equal(r.code, 4);
  assert.equal(r.json.reason, 'TARGET_BINDING_VIOLATION');
  assert.match(r.json.detail, /第一个写步骤必须是 create_component/);
  assert.deepEqual(opsOf(r.calls), ['ping']);
});

test('★ P0-1 ③ verify 里塞 insert_text（写命令）→ 退 4，零调用', async () => {
  const f = setup('bind-verify', (plan) => {
    plan.verify.push({
      op: 'insert_text', args: { pkg: 'Mail', name: 'MailPagePopup', child: 'x', index: 9, text: 'x' },
    });
  });
  const r = await runInProcess({ args: stdArgs(f, { confirm: true }), script: happyScript() });

  assert.equal(r.code, 4);
  assert.equal(r.json.reason, 'TARGET_BINDING_VIOLATION');
  assert.match(r.json.detail, /verify 的 op 'insert_text' 不是只读回读命令/);
  assert.deepEqual(opsOf(r.calls), ['ping']);
});

test('★ P0-1 ④ verify 指向别的组件 → 退 4（回读也不许跑偏）', async () => {
  const f = setup('bind-verify-target', (plan) => {
    plan.verify[0].args.name = 'OtherPage';
  });
  const r = await runInProcess({ args: stdArgs(f, { confirm: true }), script: happyScript() });

  assert.equal(r.code, 4);
  assert.equal(r.json.reason, 'TARGET_BINDING_VIOLATION');
  assert.match(r.json.detail, /verify 的 args\.name='OtherPage' ≠ target\.page='MailPagePopup'/);
  assert.deepEqual(opsOf(r.calls), ['ping']);
});

test('★ P0-1 ⑤ 合法清单照常执行（回归：绑定闸门不误伤）', async () => {
  const f = setup('bind-ok');
  const r = await runInProcess({ args: stdArgs(f, { confirm: true }), script: happyScript() });
  assert.equal(r.code, 0, `合法清单不该被绑定闸门拦：${JSON.stringify(r.json).slice(0, 300)}`);
});

test('★ P0-1 ⑥ 清单里出现 set_image_scale9 → 被 Runner 白名单拦下，退 5', async () => {
  const f = setup('bind-scale9', (plan) => {
    plan.steps.push({
      step: plan.steps.length + 1, op: 'set_image_scale9',
      args: { pkg: 'Mail', name: '背景.png', scale9grid: '10,10,10,10' }, source: { tempId: 'X' },
    });
  });
  const r = await runInProcess({ args: stdArgs(f, { confirm: true }), script: happyScript() });

  assert.equal(r.code, 5, `不在白名单应退 5，实际 ${r.code}`);
  assert.equal(r.json.status, 'refused');
  assert.match(r.json.reason, /set_image_scale9/);
  assert.match(r.json.reason, /不在 CREATE 白名单内/);
  // 绑定闸门不管白名单外的 op（它们到不了 Bridge）；探测照常，Runner 拦在门前
  assert.deepEqual(opsOf(r.calls), ['ping', 'read_component']);
});

// ════════════════════════════════════════════════════════════════════════════
// ★ 第十一轮审查 P0-3：只有**明确**的「组件不存在」才算不存在证据
//   包不存在 / 读失败 / 插件内部异常 → 存在性未知 → 退 4（fail-closed）。
// ════════════════════════════════════════════════════════════════════════════

test('★ P0-3 ① probe 返回 "component not found" → 判不存在，照常执行退 0', async () => {
  const f = setup('absent-en');
  const script = happyScript();
  script.read_component = [{ ok: false, error: 'component not found: Mail/MailPagePopup' }, READ_PRESENT];
  const r = await runInProcess({ args: stdArgs(f, { confirm: true }), script });

  assert.equal(r.code, 0, `明确不存在应放行：${JSON.stringify(r.json).slice(0, 300)}`);
  assert.equal(r.json.status, 'ok');
  assert.match(r.json.targetExistence.note, /明确匹配「组件不存在」判据/);
  assert.ok(!/已确认不存在/.test(r.json.targetExistence.note),
    '★ 过度措辞「已确认不存在」不许再现（模式匹配≠铁证）');
});

test('★ P0-3 ② probe 返回 "package not found" → 存在性未知，退 4', async () => {
  const f = setup('absent-pkg');
  const script = happyScript();
  script.read_component = { ok: false, error: 'package not found: Mail' };
  const r = await runInProcess({ args: stdArgs(f, { confirm: true }), script });

  assert.equal(r.code, 4, `包不存在不是组件不存在，必须退 4，实际 ${r.code}`);
  assert.equal(r.json.reason, 'TARGET_EXISTENCE_UNVERIFIED');
  assert.match(r.json.detail, /无法确认/);
  assert.deepEqual(opsOf(r.calls), ['ping', 'read_component'], '★ 未知就停，不许进 Runner');
});

test('★ P0-3 ③ probe 返回 "读取失败" → 存在性未知，退 4', async () => {
  const f = setup('absent-readfail');
  const script = happyScript();
  script.read_component = { ok: false, error: '读取失败：组件文件损坏' };
  const r = await runInProcess({ args: stdArgs(f, { confirm: true }), script });

  assert.equal(r.code, 4);
  assert.equal(r.json.reason, 'TARGET_EXISTENCE_UNVERIFIED');
  assert.deepEqual(opsOf(r.calls), ['ping', 'read_component']);
});

test('★ P0-3 ④ isAbsentEvidence 判据表（纯函数直测，防模式表被改松）', () => {
  // 明确「组件不存在」→ true
  for (const e of [
    'component not found', 'Component "X" does not exist', "component doesn't exist",
    'no such component', '组件不存在', 'not found', '组件不存在：Mail/MailPagePopup',
  ]) {
    assert.equal(isAbsentEvidence(e), true, `应判不存在: ${e}`);
  }
  // 不是「组件不存在」→ false（含包/读取/异常字样，或压根不匹配）
  for (const e of [
    'package not found', 'the package does not exist', '包 Mail 不存在', '读取失败',
    '组件文件损坏', '插件内部异常', 'internal error occurred', 'timeout', '', null, undefined,
  ]) {
    assert.equal(isAbsentEvidence(e), false, `不得判不存在: ${JSON.stringify(e)}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ★ 第十一轮审查 P1：没有回读证据的成功 → ok-unverified（退 0 但 stdout 可区分）
// ════════════════════════════════════════════════════════════════════════════

test('★ P1 ① verify 为空的清单 → status:ok-unverified，退 0，stdout 明示未验证', async () => {
  const f = setup('unverified', (plan) => { plan.verify = []; });
  const r = await runInProcess({ args: stdArgs(f, { confirm: true }), script: happyScript() });

  assert.equal(r.code, 0, `未验证的成功也退 0，实际 ${r.code}`);
  assert.equal(r.json.status, 'ok-unverified');
  assert.equal(r.json.verified, false, '★ stdout 必须能区分「已验证/未验证」');
  assert.equal(r.json.ok, true);

  const report = JSON.parse(fs.readFileSync(path.join(f.out, 'exec_report.json'), 'utf8'));
  assert.equal(report.status, 'ok-unverified');
  assert.ok((report.advisories || []).some((a) => /未验证/.test(a)), '报告必须写未验证');
  const md = fs.readFileSync(path.join(f.out, 'exec_report.md'), 'utf8');
  assert.ok(/- status: ok-unverified/.test(md) && /未验证/.test(md), 'md 也要可见');
});

test('★ P1 ② 有回读且通过 → 仍是 ok、verified:true（回归）', async () => {
  const f = setup('verified');
  const r = await runInProcess({ args: stdArgs(f, { confirm: true }), script: happyScript() });
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'ok');
  assert.equal(r.json.verified, true);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑦ B9 确定性：同一输入跑两遍，exec_report.json/.md 的 md5 一致、无 ISO 时间戳
// ════════════════════════════════════════════════════════════════════════════

test('⑦ B9：同一输入两遍，报告逐字节一致且无时间戳', async () => {
  const f = setup('b9');
  const out1 = path.join(f.dir, 'o1');
  const out2 = path.join(f.dir, 'o2');
  const r1 = await runInProcess({ args: stdArgs(f, { confirm: true, out: out1 }), script: happyScript() });
  const r2 = await runInProcess({ args: stdArgs(f, { confirm: true, out: out2 }), script: happyScript() });
  assert.equal(r1.code, 0);
  assert.equal(r2.code, 0);

  for (const name of ['exec_report.json', 'exec_report.md']) {
    assert.equal(md5(path.join(out1, name)), md5(path.join(out2, name)),
      `★ ${name} 两次运行必须逐字节一致（B9）`);
    const text = fs.readFileSync(path.join(out1, name), 'utf8');
    assert.ok(!ISO_TS.test(text), `★ ${name} 不得含 ISO 时间戳（默认不计时）`);
  }
  const report = JSON.parse(fs.readFileSync(path.join(out1, 'exec_report.json'), 'utf8'));
  for (const s of report.steps) assert.equal(s.ms, undefined, '默认不得输出耗时');
});

// ════════════════════════════════════════════════════════════════════════════
// ⑧ 全栈 loopback：真 CLI 子进程 + 真 defaultPost + 真 HTTP
//    （证明「HTTP 500 + body ok 也判成功」与「干跑零写命令」在整条栈上成立）
// ════════════════════════════════════════════════════════════════════════════

/** 起一个只听 127.0.0.1 临时端口的假 Bridge（handler 见单元测试同款）。 */
function startFakeBridge(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    res.on('error', () => {});
    req.on('error', () => {});
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let msg = null;
      try { msg = JSON.parse(body); } catch (e) { msg = { __parseError: String(e) }; }
      received.push({ method: req.method, url: req.url, msg });
      let r = null;
      try {
        r = await handler(msg, received.length);
      } catch (e) {
        r = { ok: false, error: `fake bridge handler threw: ${e && e.message}` };
      }
      if (!r) r = { ok: true, data: null };
      try {
        res.statusCode = Number.isFinite(r.status) ? r.status : 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: r.ok, data: r.data === undefined ? null : r.data, error: r.error }));
      } catch (e) { /* 客户端已断开 */ }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        received,
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

/** 每阶段用全新 Bridge（调用计数互不污染）。 */
async function withBridge(handler, fn) {
  const bridge = await startFakeBridge(handler);
  try {
    await fn(bridge);
  } finally {
    await bridge.close();
  }
}

test('⑧ 全栈 loopback：HTTP 500+ok 也判成功；干跑只 ping；确认执行全序列落盘', async () => {
  const f = setup('loopback');
  // ping 故意回 HTTP 500 但 body 是 ok:true —— 整条栈都必须判成功。
  // read_component 第 1 次（存在性探测）回「不存在」，其后（Runner 回读）回符合期望的 XML。
  // ★ 每个阶段（干跑 / 确认执行）各建一个全新 handler：readSeen 按阶段归零，
  //   不能跨阶段共享（确认执行里「第 1 次」必须是它的探测，不是上一个阶段的）。★
  const makeHandler = () => {
    let readSeen = 0;
    return (msg) => {
      switch (msg.cmd) {
        case 'ping':
          return { status: 500, ok: true, data: PING_OK.data };
        case 'read_component':
          readSeen += 1;
          return readSeen === 1 ? READ_ABSENT : READ_PRESENT;
        default:
          return { ok: true, data: { ok: true } };
      }
    };
  };

  // ── 干跑：真 CLI 子进程（异步 spawn，事件环保持自由），只该看到一次 ping ──
  await withBridge(makeHandler(), async (bridge) => {
    const r = await runCliJsonAsync(['create-run', '--exec', f.execPath, '--bridge-url', bridge.url, '--out', f.out]);
    assert.equal(r.code, 0, `干跑应退 0：${r.stderr.slice(0, 300)}`);
    assert.equal(r.json.dryRun, true);
    assert.deepEqual(bridge.received.map((x) => x.msg.cmd), ['ping'],
      '★ 干跑：整条栈上只许发出 ping');
    assert.equal(bridge.received[0].method, 'POST');
    assert.equal(bridge.received[0].url, '/');
    assert.deepEqual(bridge.received[0].msg, { cmd: 'ping', args: {} });
  });

  // ── 确认执行：ping(500+ok) → 探测不存在 → 步骤序列 → 回读，退 0，报告落盘 ──
  await withBridge(makeHandler(), async (bridge) => {
    const r = await runCliJsonAsync([
      'create-run', '--exec', f.execPath, '--bridge-url', bridge.url, '--out', f.out, '--confirm',
    ]);
    assert.equal(r.code, 0, `确认执行应退 0：${r.stderr.slice(0, 300)}`);
    assert.equal(r.json.status, 'ok');

    const cmds = bridge.received.map((x) => x.msg.cmd);
    assert.equal(cmds[0], 'ping', '★ ping 回 500 也判成功 —— 证明不按状态码判成败');
    assert.equal(cmds[1], 'read_component', '第二步必须是只读存在性探测');
    const plan = realExec();
    assert.deepEqual(cmds, [
      'ping', 'read_component', ...plan.steps.map((s) => s.op), ...plan.verify.map((v) => v.op),
    ]);
    // 每个写命令的 body 形状都符合契约 {cmd,args}
    for (const x of bridge.received) {
      assert.ok(typeof x.msg.cmd === 'string' && x.msg.cmd.length > 0);
      assert.ok(x.msg.args && typeof x.msg.args === 'object');
    }
    assert.ok(fs.existsSync(path.join(f.out, 'exec_report.json')));
    assert.ok(fs.existsSync(path.join(f.out, 'exec_report.md')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.out, 'exec_report.json'), 'utf8')).status, 'ok');
  });
});
