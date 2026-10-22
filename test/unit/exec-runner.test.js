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

test('★ 5) opts.timing=true 才允许输出耗时（且因此报告不再逐字节一致）', async () => {
  const { report } = await runExecPlan(realExec(), fakeTransport(), { timing: true });
  for (const s of report.steps) assert.equal(typeof s.ms, 'number');
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
