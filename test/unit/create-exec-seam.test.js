'use strict';
/**
 * test/unit/create-exec-seam.test.js —— **plan-builder ↔ exec-plan 接缝测试**
 *
 * ★ 为什么必须单独有这个文件（第八轮审查）★
 *   `test/unit/exec-plan.test.js` 的夹具是**手写**的 plan，里面写的是 `fontSize`；
 *   而真实 `buildCreatePlan()` 产出的是 **`fontsize`**（XML 习惯小写）→
 *   两个模块各自单测全绿，接起来 `insert_text.fontSize` 却是空的。
 *   这和之前 gen-plan↔gen-dryrun 的 REUSE P0 是同一类问题。
 *
 * **本文件一律用真实 `buildCreatePlan()` 产出**，禁止手写 plan 结构。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCreatePlan } = require('../../src/create/plan-builder');
const { buildExecPlan, BRIDGE_COMMANDS } = require('../../src/create/exec-plan');

const PKG_ID = 'mailpkg1';

/**
 * 真实 IR：背景图 + 标题文本 +（比固有尺寸大的）按钮底图。
 * 按钮底刻意摆得比资源固有尺寸大，触发 plan-builder 的九宫格分支 → 产出 `scale9grid` 属性。
 */
function makeIr() {
  return {
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
        visible: true,
        opacity: 0.8, // → alpha
        text: { value: '邮件详情', color: '#ffffff', fontSize: 24 },
      },
      {
        id: 'L3', name: '按钮底', type: 'raster', bbox: {
          x: 20, y: 600, w: 300, h: 120,
        }, visible: true, opacity: 1,
      },
    ],
  };
}

function makeIndex() {
  return {
    version: '1.0',
    project: { packages: [{ name: 'Mail', id: PKG_ID }] },
    resources: [
      {
        pkg: 'Mail', pkgId: PKG_ID, id: 'q0jse', name: '背景.png', type: 'image', exported: true, width: 750, height: 1334,
      },
      {
        pkg: 'Mail', pkgId: PKG_ID, id: 'btnbg1', name: '按钮底.png', type: 'image', exported: true, width: 200, height: 80, scale9grid: '10,10,180,60',
      },
    ],
    components: [],
  };
}

/** 真实 plan（**不手写**）。 */
function realPlan() {
  return buildCreatePlan({ ir: makeIr(), projectIndex: makeIndex(), pageName: 'MailPagePopup' });
}

/** 真实 plan → 真实 exec（带 pkgId / 包清单 / 资源登记表）。 */
function realExec(overrides = {}, planOverrides = null) {
  const plan = planOverrides || realPlan();
  return buildExecPlan(plan, {
    pkgId: PKG_ID, packages: makeIndex().project.packages, resources: makeIndex().resources, ...overrides,
  }).execPlan;
}

const stepOf = (ep, op) => ep.steps.find((s) => s.op === op);
const textStep = (ep) => stepOf(ep, 'insert_text');
const imageSteps = (ep) => ep.steps.filter((s) => s.op === 'insert_object');

// ────────────────────────────────────────────────────────────────────────────
// P0-A：fontsize → fontSize
// ────────────────────────────────────────────────────────────────────────────

test('★ P0-A 接缝：真实 plan 的 `fontsize` 必须变成 insert_text 顶层 `fontSize`', () => {
  const plan = realPlan();
  const node = plan.nodes.find((n) => n.tag === 'text');
  // 前置：先证明真实 plan 用的确实是**小写** fontsize（否则本测试就没意义）
  assert.equal(node.attrs.fontsize, 24, '真实 plan-builder 产出的是小写 fontsize');
  assert.equal(node.attrs.fontSize, undefined);

  const ep = realExec();
  const args = textStep(ep).args;
  assert.equal(args.fontSize, 24, `insert_text 必须拿到顶层 fontSize（实际 ${JSON.stringify(args)}）`);
  assert.equal(typeof args.fontSize, 'number');
  assert.ok(!args.props || args.props.fontsize === undefined,
    'props 里不得再残留小写 fontsize（否则等于没映射）');
});

// ────────────────────────────────────────────────────────────────────────────
// P0-B：图片节点名
// ────────────────────────────────────────────────────────────────────────────

test('★ P0-B 接缝：图片节点名不虚构 —— props.name 尽力传递，verify 不按名断言', () => {
  const plan = realPlan();
  const imgNode = plan.nodes.find((n) => n.tag === 'image' && n.layer === 0);
  const ep = realExec();

  const bgStep = imageSteps(ep).find((s) => s.source.tempId === imgNode.tempId);
  assert.ok(bgStep, '背景图片应有对应步骤');
  assert.equal(bgStep.args.child, undefined, 'insert_object 没有 child 参数，不得伪造');
  assert.equal(bgStep.args.props.name, imgNode.name, '节点名只能经 props.name 尽力传递');
  assert.ok(bgStep.notes.some((n) => /props\.name/.test(n)), '必须在 notes 里说明名字不保证');

  // 回读：图片只按 index+url 比对，**绝不**出现计划名与实际名不符却按计划名断言
  const expectChild = ep.verify[0].expect.children.find((c) => c.index === 0);
  assert.equal(expectChild.name, undefined, '图片不得按名字断言（否则就是自欺）');
  assert.equal(expectChild.url, `ui://${PKG_ID}${imgNode.attrs.src}`);
  assert.ok(ep.advisories.some((a) => /名字无法保证/.test(a)), '必须显式告知"图片名不可断言"');

  // 文本有 child 参数 → 名字可保证，按名断言
  const txtNode = plan.nodes.find((n) => n.tag === 'text');
  assert.equal(textStep(ep).args.child, txtNode.name);
  const txtExpect = ep.verify[0].expect.children.find((c) => c.index === textStep(ep).args.index);
  assert.equal(txtExpect.name, txtNode.name);
});

// ────────────────────────────────────────────────────────────────────────────
// 其余属性映射（全部走真实 plan）
// ────────────────────────────────────────────────────────────────────────────

test('★ 接缝：text 的 color/xy/size 与 image 的 props.size 都对得上', () => {
  const plan = realPlan();
  const ep = realExec();
  const txtNode = plan.nodes.find((n) => n.tag === 'text');
  const args = textStep(ep).args;
  assert.equal(args.text, '邮件详情');
  assert.equal(args.color, '#ffffff');
  assert.equal(args.x, txtNode.source.bbox.x);
  assert.equal(args.y, txtNode.source.bbox.y);
  assert.equal(args.width, txtNode.source.bbox.w);
  assert.equal(args.height, txtNode.source.bbox.h);

  const imgNode = plan.nodes.find((n) => n.tag === 'image' && n.layer !== 0);
  const imgStep = imageSteps(ep).find((s) => s.source.tempId === imgNode.tempId);
  assert.equal(imgStep.args.props.size, imgNode.attrs.size, '图片尺寸走 props.size');
  assert.equal(imgStep.args.x, imgNode.source.bbox.x);
  assert.equal(imgStep.args.y, imgNode.source.bbox.y);
});

test('★ 接缝：alpha 与 scale9grid 不得丢（真实 plan 的 alpha / 九宫格属性）', () => {
  const plan = realPlan();
  const txtNode = plan.nodes.find((n) => n.tag === 'text');
  const btnNode = plan.nodes.find((n) => n.tag === 'image' && n.attrs.scale9grid);
  assert.ok(txtNode.attrs.alpha !== undefined, '真实 plan 应产出 alpha');
  assert.ok(btnNode, '真实 plan 应产出 scale9grid（按钮底摆得比固有尺寸大）');

  const ep = realExec();
  const args = textStep(ep).args;
  // insert_text 没有 alpha 参数 → 必须落进 props（不丢）
  assert.equal(args.alpha, undefined, 'insert_text 词表里没有 alpha 参数');
  assert.equal(args.props.alpha, txtNode.attrs.alpha, `alpha 必须保留在 props（实际 ${JSON.stringify(args.props)}）`);

  const btnStep = imageSteps(ep).find((s) => s.source.tempId === btnNode.tempId);
  assert.equal(btnStep.args.props.scale9grid, btnNode.attrs.scale9grid,
    'insert_object 没有 scale9grid 参数 → 必须保留在 props，不得静默丢弃');
});

test('★ 接缝：所有 step 的 op 都在 BRIDGE_COMMANDS 内（词表封闭在真实链路上也成立）', () => {
  const ep = realExec();
  const vocab = new Set(Object.keys(BRIDGE_COMMANDS));
  for (const s of ep.steps) assert.ok(vocab.has(s.op), `词表外命令：${s.op}`);
  assert.equal(ep.executable, true, `干净的真实 plan 应 executable（preflight：${JSON.stringify(ep.preflight.failures)}）`);
});

// ────────────────────────────────────────────────────────────────────────────
// P1：不盲信 plan 的自述
// ────────────────────────────────────────────────────────────────────────────

test('★ P1: pkgId 位数错误 / 不在包清单 → preflight 失败', () => {
  const badLen = realExec({ pkgId: 'abc' });
  assert.ok(badLen.preflight.failures.some((f) => f.code === 'PKGID_INVALID'), 'pkgId 位数错必须失败');
  assert.equal(badLen.executable, false);

  const unknown = realExec({ pkgId: 'zzzz9999' });
  assert.ok(unknown.preflight.failures.some((f) => f.code === 'PKGID_UNKNOWN'), 'pkgId 不在包清单必须失败');
  assert.equal(unknown.executable, false);
});

test('★ P1: plan 被人改过（图片短 ID 不在登记表）→ RESOURCE_NOT_REGISTERED', () => {
  const plan = realPlan();
  const img = plan.nodes.find((n) => n.tag === 'image');
  img.attrs.src = 'not_registered'; // 模拟人工编辑
  const ep = realExec({}, plan);
  const f = ep.preflight.failures.find((x) => x.code === 'RESOURCE_NOT_REGISTERED');
  assert.ok(f, '短 ID 必须与登记表交叉核对');
  assert.ok(/not_registered/.test(f.detail));
  assert.equal(ep.executable, false);
});

test('★ P1: readiness 不盲信 —— 自称 ready 但本地复算失败 → 以本地为准', () => {
  const plan = realPlan();
  assert.equal(plan.readiness.status, 'ready');
  plan.assets.toImport = [{ suggestedName: 'missing.png' }]; // 人为制造本地阻塞
  const ep = realExec({}, plan);
  assert.equal(ep.executable, false, 'plan 自称 ready 也不能绕过本地复算');
  assert.ok(ep.preflight.failures.some((f) => f.code === 'RESOURCE_MISSING'));
  assert.ok(ep.advisories.some((a) => /以本地复算为准/.test(a)), '必须记录"不盲信 readiness"的说明');
});

test('★ P1: 自称非 ready 但本地通过 → fail-closed 拦下并记 note', () => {
  const plan = realPlan();
  plan.readiness = { status: 'needs-human', blockers: [] };
  const ep = realExec({}, plan);
  assert.equal(ep.executable, false, 'readiness 非 ready 时 fail-closed');
  assert.ok(ep.preflight.failures.some((f) => f.code === 'READINESS_NOT_READY'));
  assert.ok(ep.advisories.some((a) => /fail-closed/.test(a)), '必须说明是保守拦截');
});

test('★ P1: 未提供 packages / resources → 显式记录"已跳过交叉核对"（不假装验过）', () => {
  const plan = realPlan();
  const ep = buildExecPlan(plan, { pkgId: PKG_ID }).execPlan; // 不给 packages/resources
  assert.ok(ep.advisories.some((a) => /跳过.*pkgId/.test(a)), '未提供包清单必须声明跳过');
  assert.ok(ep.advisories.some((a) => /跳过.*图片短 ID/.test(a)), '未提供登记表必须声明跳过');
  assert.equal(ep.executable, true, '跳过交叉核对本身不该让计划不可执行（但要可见）');
});
