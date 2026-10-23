'use strict';
/**
 * test/unit/exec-runner.test.js —— CREATE Runner（调度器）单测
 *
 * ★ 真实 Bridge 适配层未实现 → 用**假 transport** 注入 ★
 *   这样"调度逻辑 / 失败即停 / 回读比对"全都能在本地真测，
 *   而不是"只有朋友那台机器能跑、我们只能盲写"。
 *   测试里**没有任何** HTTP/WS 客户端，也不假装连过 Bridge。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { buildCreatePlan } = require('../../src/create/plan-builder');
const { buildExecPlan } = require('../../src/create/exec-plan');
const {
  runExecPlan, renderExecReportMarkdown, childrenFromComponentXml,
} = require('../../src/create/exec-runner');

const PKG_ID = 'mailpkg1';
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/** 真实 plan（不手写结构）。 */
function realPlan() {
  const ir = {
    version: '1.0',
    source: { canvas: { w: 750, h: 1334 } },
    layers: [
      {
        id: 'L1', name: '背景', type: 'raster', bbox: {
          x: 0, y: 0, w: 750, h: 1334,
        }, visible: true, opacity: 1,
      },
      {
        id: 'L2',
        name: '标题',
        type: 'text',
        bbox: {
          x: 40, y: 100, w: 300, h: 40,
        },
        visible: true, opacity: 0.8, text: { value: '邮件详情', color: '#ffffff', fontSize: 24 },
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

/** 少一个子节点 + 标题 xy 被改坏的 XML。 */
function brokenXml() {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<component size="750,1334" exported="true">',
    '  <displayList>',
    '    <image id="b00001" name="img_bg" src="ui://mailpkg1q0jse" xy="0,0" size="750,1334"/>',
    '    <text id="b00002" name="txt_标题" xy="41,100" size="300,40" text="邮件详情"/>',
    '  </displayList>',
    '</component>',
    '',
  ].join('\n');
}

/** 少一个子节点的 XML（childCount 少 1）。 */
function shortXml() {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<component size="750,1334" exported="true">',
    '  <displayList>',
    '    <image id="b00001" name="img_bg" src="ui://mailpkg1q0jse" xy="0,0" size="750,1334"/>',
    '  </displayList>',
    '</component>',
    '',
  ].join('\n');
}

/**
 * 假 transport。
 * @param {Object} [o]
 * @param {string} [o.readXml] read_component 返回的 XML
 * @param {number|null} [o.failAtCall] 第 N 次调用（1-based）返回失败
 * @param {string[]} [o.calls] 记录调用序列
 */
function fakeTransport(o = {}) {
  const calls = o.calls || [];
  let n = 0;
  return {
    calls,
    async send(op, args) {
      n += 1;
      calls.push(op);
      if (o.failAtCall && n === o.failAtCall) {
        return { ok: false, error: `模拟失败（第 ${n} 次调用：${op}）` };
      }
      switch (op) {
        case 'create_component':
          return { ok: true, data: { id: 'f6a7b8c9', name: args.name } };
        case 'insert_object':
          return { ok: true, data: { inserted: (args.props && args.props.name) || null } };
        case 'insert_text':
          return { ok: true, data: { name: args.child } };
        case 'insert_loader':
        case 'insert_list':
          return { ok: true, data: { name: args.child } };
        case 'save_all':
          return { ok: true, data: { saved: true } };
        case 'read_component':
          return {
            ok: true,
            data: { name: args.name, url: 'ui://mailpkg1f6a7b8c9', xml: o.readXml || okXml() },
          };
        case 'list_children':
          return {
            ok: true,
            data: {
              component: args.name,
              children: childrenFromComponentXml(o.readXml || okXml())
                .map((c, i) => ({ name: c.name, id: `b${i}`, objType: c.tag })),
            },
          };
        default:
          return { ok: false, error: `未建模的命令：${op}` };
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
test('★ 1) 全成功 → status:"ok"', async () => {
  const t = fakeTransport();
  const { report } = await runExecPlan(realExec(), t);
  assert.equal(report.status, 'ok');
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.skipped, 0);
  assert.equal(report.summary.verifyDiffs, 0);
  assert.ok(Array.isArray(report.verify) && report.verify.length === 1);
  assert.equal(report.verify[0].ok, true);
});

// ────────────────────────────────────────────────────────────────────────────
test('★ 2) 第 2 步失败 → failed，第 3 步 skipped，且失败后**不再**调 transport', async () => {
  const calls = [];
  const t = fakeTransport({ failAtCall: 2, calls });
  const { report } = await runExecPlan(realExec(), t);

  assert.equal(report.status, 'failed');
  assert.equal(report.failedAtStep, 2, '应在第 2 步停下');
  assert.equal(report.summary.ok, 1);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.skipped, 2, '后续步骤必须标 skipped（不做半截组件）');
  assert.deepEqual(report.steps.map((s) => s.skipped), [false, false, true, true]);
  // ★ 失败即停：调用次数 = 2，之后一次都没有
  assert.deepEqual(calls, ['create_component', 'insert_object']);
  assert.equal(report.verify, null, '失败时不该继续回读');
});

// ────────────────────────────────────────────────────────────────────────────
test('★ 3) verify 不一致（childCount 少 1）→ verify-failed，diff 点名 childCount', async () => {
  const t = fakeTransport({ readXml: shortXml() });
  const { report } = await runExecPlan(realExec(), t);
  assert.equal(report.status, 'verify-failed');
  const d = report.verify[0].diffs;
  assert.ok(d.some((x) => x.field === 'childCount'), `diff 应点名 childCount：${JSON.stringify(d)}`);
  const cc = d.find((x) => x.field === 'childCount');
  assert.deepEqual({ expected: cc.expected, actual: cc.actual }, { expected: 2, actual: 1 });
});

test('★ 3) verify 不一致（某个 xy 不对）→ diff 点名 children[i].xy', async () => {
  const t = fakeTransport({ readXml: brokenXml() });
  const { report } = await runExecPlan(realExec(), t);
  assert.equal(report.status, 'verify-failed');
  const d = report.verify[0].diffs;
  assert.equal(d.length, 1, `只应有一条 xy 差异：${JSON.stringify(d)}`);
  assert.equal(d[0].field, 'xy');
  assert.equal(d[0].index, 1, '应定位到 index=1 的那个子节点');
  assert.deepEqual({ expected: d[0].expected, actual: d[0].actual }, { expected: '40,100', actual: '41,100' });
});

// ────────────────────────────────────────────────────────────────────────────
test('★ 4) executable=false → refused 且 transport **零调用**', async () => {
  const calls = [];
  const bad = buildExecPlan(realPlan(), { pkgId: 'zzzz9999', packages: [{ name: 'Mail', id: PKG_ID }] }).execPlan;
  assert.equal(bad.executable, false, '前置：这份 execPlan 本身不可执行');
  const t = fakeTransport({ calls });
  const { report } = await runExecPlan(bad, t);
  assert.equal(report.status, 'refused');
  assert.ok(report.reason && report.reason.length > 10);
  assert.deepEqual(calls, [], 'refused 时一次都不许调 transport');
  assert.deepEqual(report.steps, []);
});

test('★ 4) 存在 required unsupported（图片缺 pkgId 的另一条路径）→ refused 且零调用', async () => {
  const calls = [];
  // 不传 pkgId → 图片进 unsupported(required:true)，同时 executable=false
  const noPkg = buildExecPlan(realPlan()).execPlan;
  assert.ok(noPkg.unsupported.some((u) => u.required), '前置：应有 required unsupported');
  const t = fakeTransport({ calls });
  const { report } = await runExecPlan(noPkg, t);
  assert.equal(report.status, 'refused');
  assert.deepEqual(calls, [], '有必需操作没落成 → 一次都不许调 transport');
});

// ────────────────────────────────────────────────────────────────────────────
test('★ 5) 确定性：同一假 transport 跑两遍，报告 md5 一致（默认不写时间戳/耗时）', async () => {
  const a = await runExecPlan(realExec(), fakeTransport());
  const b = await runExecPlan(realExec(), fakeTransport());
  const sa = JSON.stringify(a.report);
  const sb = JSON.stringify(b.report);
  assert.equal(md5(sa), md5(sb));
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(sa), '不得出现 ISO 时间戳');
  for (const s of a.report.steps) assert.equal(s.ms, undefined, '默认不得输出耗时');
});

test('★ 5) opts.timing + 注入假时钟 → 输出 ms，且耗时是**确定值**（不自带时钟）', async () => {
  let t = 0;
  const fakeClock = () => { t += 5; return t; };
  const { report } = await runExecPlan(realExec(), fakeTransport(), { timing: true, now: fakeClock });
  for (const s of report.steps) assert.equal(s.ms, 5, '耗时应由注入的时钟决定（确定值）');
  // 再跑一遍：假时钟行为相同 → ms 完全一致
  let t2 = 0;
  const again = await runExecPlan(realExec(), fakeTransport(), {
    timing: true, now: () => {
      t2 += 5;
      return t2;
    },
  });
  assert.deepEqual(again.report.steps.map((s) => s.ms), report.steps.map((s) => s.ms));
});

test('★ 5) 只开 timing 但**不注入**时钟 → 不计时（源码里不允许有任何自带时钟）', async () => {
  const { report } = await runExecPlan(realExec(), fakeTransport(), { timing: true });
  for (const s of report.steps) assert.equal(s.ms, undefined, '没有注入时钟就不该有 ms');
});

test('★ K1: src/create/exec-runner.js 里不得出现 Date.now 字面量（与 net-guard 同口径）', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../../src/create/exec-runner.js'), 'utf8',
  );
  assert.ok(!/Date\.now/.test(src), 'runner 不得自带时钟 —— 时钟必须注入');
});

// ────────────────────────────────────────────────────────────────────────────
test('★ 6) 步骤顺序：transport 收到的 op 序列 == steps 顺序（+ 末尾回读）', async () => {
  const calls = [];
  const ep = realExec();
  await runExecPlan(ep, fakeTransport({ calls }));
  const expected = [...ep.steps.map((s) => s.op), ...ep.verify.map((v) => v.op)];
  assert.deepEqual(calls, expected, `调用序列必须严格按 steps 顺序（无乱序/并行）：${JSON.stringify(calls)}`);
  assert.deepEqual(calls.slice(0, ep.steps.length), ep.steps.map((s) => s.op));
  assert.equal(calls[calls.length - 1], 'read_component', '回读在最后');
});

// ────────────────────────────────────────────────────────────────────────────
test('★ md 产物：含每步结果表 + verify diff（且无时间戳）', async () => {
  const { report } = await runExecPlan(realExec(), fakeTransport({ readXml: brokenXml() }));
  const md = renderExecReportMarkdown(report);
  assert.ok(/^# create exec 报告/m.test(md));
  assert.ok(/\| step \| op \| ok \|/.test(md), 'md 应含步骤表');
  assert.ok(/verify-failed/.test(md));
  assert.ok(/children\[1\]\.xy/.test(md), `md 应点名 diff 字段：${md}`);
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(md));
});

test('★ transport 抛异常 → 按失败处理（不崩、不继续）', async () => {
  const calls = [];
  const t = {
    calls,
    async send(op) {
      calls.push(op);
      throw new Error('transport boom');
    },
  };
  const { report } = await runExecPlan(realExec(), t);
  assert.equal(report.status, 'failed');
  assert.ok(/transport boom/.test(report.steps[0].error));
  assert.deepEqual(calls, ['create_component'], '异常后不得继续');
});

// ════════════════════════════════════════════════════════════════════════════
// P0-A：回读的引用比对必须**归一化**（同包短 ID / 拼接 / 斜杠 指的都是同一个资源）
// ════════════════════════════════════════════════════════════════════════════

/** 只含一张背景图的真实 execPlan（便于单独验证 url 归一化）。 */
function singleImageExec() {
  const ir = {
    version: '1.0',
    source: { canvas: { w: 750, h: 1334 } },
    layers: [{
      id: 'L1', name: '背景', type: 'raster', bbox: {
        x: 0, y: 0, w: 750, h: 1334,
      }, visible: true, opacity: 1,
    }],
  };
  const projectIndex = {
    version: '1.0',
    project: { packages: [{ name: 'Mail', id: PKG_ID }] },
    resources: [{
      pkg: 'Mail', pkgId: PKG_ID, id: 'q0jse', name: '背景.png', type: 'image', exported: true, width: 750, height: 1334,
    }],
    components: [],
  };
  return buildExecPlan(buildCreatePlan({ ir, projectIndex, pageName: 'MailPagePopup' }), {
    pkgId: PKG_ID, packages: projectIndex.project.packages, resources: projectIndex.resources,
  }).execPlan;
}

/** 回读 XML：只有一张背景图，src 由测试给定。 */
function xmlWithSrc(src) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<component size="750,1334">',
    '  <displayList>',
    `    <image id="b00001" name="img_bg" src="${src}" xy="0,0" size="750,1334"/>`,
    '  </displayList>',
    '</component>',
    '',
  ].join('\n');
}

test('★ P0-A ① 同包短 ID（真实 FairyGUI 写法）→ 判一致，不得误报 verify-failed', async () => {
  const ep = singleImageExec();
  assert.equal(ep.verify[0].expect.children[0].url, `ui://${PKG_ID}q0jse`, '前置：expect 是拼接 ui://');
  const { report } = await runExecPlan(ep, fakeTransport({ readXml: xmlWithSrc('q0jse') }));
  assert.equal(report.status, 'ok', `同包短 ID 必须判一致：${JSON.stringify(report.verify[0].diffs)}`);
  assert.deepEqual(report.verify[0].diffs, []);
});

test('★ P0-A ② 拼接 ui:// → 判一致', async () => {
  const { report } = await runExecPlan(singleImageExec(), fakeTransport({ readXml: xmlWithSrc(`ui://${PKG_ID}q0jse`) }));
  assert.equal(report.status, 'ok');
});

test('★ P0-A ③ 斜杠 ui:// → 判一致', async () => {
  const { report } = await runExecPlan(singleImageExec(), fakeTransport({ readXml: xmlWithSrc(`ui://${PKG_ID}/q0jse`) }));
  assert.equal(report.status, 'ok');
});

test('★ P0-A ④ 确实是不同资源 → 判不一致，且 diff 用归一化后的值（不是原始字符串）', async () => {
  const { report } = await runExecPlan(singleImageExec(), fakeTransport({ readXml: xmlWithSrc('other') }));
  assert.equal(report.status, 'verify-failed');
  const d = report.verify[0].diffs[0];
  assert.equal(d.field, 'url');
  assert.equal(d.expected, `${PKG_ID}/q0jse`, 'diff 期望值应为归一化后的 pkgId/itemId');
  assert.equal(d.actual, `${PKG_ID}/other`);
});

// ════════════════════════════════════════════════════════════════════════════
// P0-B：Runner 自己再过一道最终门禁（不信任 exec_plan 的自述）
// ════════════════════════════════════════════════════════════════════════════

test('★ P0-B ① 篡改自述（executable=true 但 preflight.ok=false）→ refused', async () => {
  const calls = [];
  const ep = realExec();
  ep.preflight = { ok: false, failures: [{ code: 'TAMPERED', detail: '人为改坏' }] };
  // executable 仍保持 true —— 正是"自述不可信"的场景
  assert.equal(ep.executable, true);
  const { report } = await runExecPlan(ep, fakeTransport({ calls }));
  assert.equal(report.status, 'refused');
  assert.ok(/preflight\.ok/.test(report.reason));
  assert.deepEqual(calls, []);
});

test('★ P0-B ② 手工塞一个词表外的 op → refused 且点名该命令', async () => {
  const calls = [];
  const ep = realExec();
  ep.steps.push({
    step: ep.steps.length + 1, op: 'nuke_everything', args: {}, source: { tempId: 'X' },
  });
  const { report } = await runExecPlan(ep, fakeTransport({ calls }));
  assert.equal(report.status, 'refused');
  assert.ok(/nuke_everything/.test(report.reason), '必须点名被拒的命令');
  assert.ok(/不在 BRIDGE_COMMANDS 词表内/.test(report.reason));
  assert.deepEqual(calls, []);
});

test('★ P0-B ③ 词表内但不在 CREATE 白名单（publish / 删除类）→ refused', async () => {
  const calls = [];
  const ep = realExec();
  ep.steps.push({
    step: ep.steps.length + 1, op: 'publish', args: { pkg: 'Mail' }, source: { tempId: 'X' },
  });
  const { report } = await runExecPlan(ep, fakeTransport({ calls }));
  assert.equal(report.status, 'refused');
  assert.ok(/不在 CREATE 白名单内/.test(report.reason), `应因白名单被拒：${report.reason}`);

  const calls2 = [];
  const ep2 = realExec();
  ep2.steps.push({
    step: ep2.steps.length + 1, op: 'delete_item', args: { pkg: 'Mail', name: 'x' }, source: { tempId: 'X' },
  });
  const r2 = await runExecPlan(ep2, fakeTransport({ calls: calls2 }));
  assert.equal(r2.report.status, 'refused', '删除类命令一律拒绝');
  assert.deepEqual(calls2, []);
});

test('★ P0-B ④ 参数被改坏 → 进 invalidSteps 并 refused', async () => {
  const calls = [];
  const ep = realExec();
  const txt = ep.steps.find((s) => s.op === 'insert_text');
  txt.args.child = 123; // 改坏：child 必须是字符串
  const { report } = await runExecPlan(ep, fakeTransport({ calls }));
  assert.equal(report.status, 'refused');
  assert.ok(Array.isArray(report.invalidSteps) && report.invalidSteps.length === 1);
  assert.ok(/child/.test(report.invalidSteps[0].reason));
  assert.deepEqual(calls, []);
});

test('★ P0-B ⑤ 干净清单 → 照常执行（门禁不误伤）', async () => {
  const { report } = await runExecPlan(realExec(), fakeTransport());
  assert.equal(report.status, 'ok');
  assert.equal(report.summary.executed, report.summary.steps);
  assert.deepEqual(report.invalidSteps, undefined);
});

test('★ P0-B ⑥ 所有 refused 场景 transport 零调用（回归汇总）', async () => {
  const cases = [];
  // a) executable=false
  cases.push(buildExecPlan(realPlan(), { pkgId: 'zzzz9999', packages: [{ name: 'Mail', id: PKG_ID }] }).execPlan);
  // b) required unsupported
  cases.push(buildExecPlan(realPlan()).execPlan);
  // c) preflight 被改坏
  const c = realExec();
  c.preflight = { ok: false, failures: [] };
  cases.push(c);
  // d) 词表外 op
  const d = realExec();
  d.steps.push({ step: 99, op: 'bogus', args: {} });
  cases.push(d);
  // e) 白名单外 op
  const e = realExec();
  e.steps.push({ step: 99, op: 'screenshot', args: { path: 'C:/x.png' } });
  cases.push(e);

  for (const ep of cases) {
    const calls = [];
    const { report } = await runExecPlan(ep, fakeTransport({ calls }));
    assert.equal(report.status, 'refused', `该场景必须 refused：${report.reason}`);
    assert.deepEqual(calls, [], 'refused 时一次都不许调 transport');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ★ 第十一轮审查 P0-1：set_image_scale9 移出 CREATE 白名单
//   它改的是**包内共享图片资源**（别的组件可能引用同一张图），且 exec-plan.js
//   从不产出该 op（grep 确认只在词表里）→ 移除不影响合法计划，只拦人为篡入。
// ════════════════════════════════════════════════════════════════════════════

test('★ P0-1: set_image_scale9 不在 CREATE 白名单 → refused 且零调用', async () => {
  const calls = [];
  const ep = realExec();
  ep.steps.push({
    step: ep.steps.length + 1, op: 'set_image_scale9',
    args: { pkg: 'Mail', name: '背景.png', scale9grid: '10,10,10,10' }, source: { tempId: 'X' },
  });
  const { report } = await runExecPlan(ep, fakeTransport({ calls }));
  assert.equal(report.status, 'refused');
  assert.match(report.reason, /set_image_scale9/);
  assert.match(report.reason, /不在 CREATE 白名单内/);
  assert.deepEqual(calls, [], 'refused 时一次都不许调 transport');
});

// ════════════════════════════════════════════════════════════════════════════
// ★ 第十一轮审查 P1：没有回读证据的"成功"叫 ok-unverified，不叫 ok
//   （步骤都成功 ≠ 结果对；没有证据就必须让人看见"未验证"）
// ════════════════════════════════════════════════════════════════════════════

test('★ P1 ① verify 为空 → status:ok-unverified，advisory 明说未验证', async () => {
  const ep = realExec();
  ep.verify = [];
  const { report } = await runExecPlan(ep, fakeTransport());
  assert.equal(report.status, 'ok-unverified', '没有回读证据不许叫 ok');
  assert.ok(Array.isArray(report.advisories));
  assert.ok(report.advisories.some((a) => /未验证/.test(a)),
    `advisory 必须显式写「未验证」：${JSON.stringify(report.advisories)}`);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.executed, report.summary.steps);
});

test('★ P1 ② 计划声明「无法回读验证」→ 即便 verify 通过也是 ok-unverified', async () => {
  const ep = realExec();
  ep.unsupported.push({
    source: { tempId: null }, required: false,
    reason: '词表里没有任何可用的回读命令 —— 无法回读验证，需人工核对',
  });
  const { report } = await runExecPlan(ep, fakeTransport());
  assert.equal(report.status, 'ok-unverified');
  assert.ok(report.advisories.some((a) => /未验证/.test(a)));
});

test('★ P1 ③ 回读通过 + 无能力缺失声明 → 仍是 ok（回归，别误伤）', async () => {
  const { report } = await runExecPlan(realExec(), fakeTransport());
  assert.equal(report.status, 'ok');
  assert.equal(report.advisories, undefined, '正常路径不该有 advisory');
});

test('★ P1 ④ md 渲染：ok-unverified 的状态与「未验证」都要可见', async () => {
  const ep = realExec();
  ep.verify = [];
  const { report } = await runExecPlan(ep, fakeTransport());
  const md = renderExecReportMarkdown(report);
  assert.ok(/- status: ok-unverified/.test(md), 'md 必须显示 ok-unverified');
  assert.ok(/未验证/.test(md), 'md 必须显式说明未验证');
});
