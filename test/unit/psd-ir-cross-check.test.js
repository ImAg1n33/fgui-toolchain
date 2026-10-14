'use strict';
/**
 * test/unit/psd-ir-cross-check.test.js —— E-05 交叉验证 fixture（打破自证循环）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 回应什么 ★（QA 两轮的核心批评）
 *   「所有 fixture 都是你自己造的、所有验证代码都是你自己写的，既造数据又写验证时
 *     『精确对账』会退化成自证循环。」BUG#1（组 bbox 不递归）正是这么漏过去的。
 *
 * ★ 本文件的三层结构 ★
 *   第一层（正向）：用 test/unit/helpers/reference-ir.js（零 src/ 依赖、
 *     递归+reduce 风格、深度上限 100 的独立实现）交叉对账 IrBuilder 的输出；
 *   第二层（反向-1）：参考实现的 BUG#1 模拟版（组 bbox 读自身坐标）必须与正确版
 *     **结果不同** —— 否则说明 fixture 仍掩盖 bug，对账无效（ir-builder.test.js:358
 *     同款做法，推广到整条 IR 链路）；
 *   第三层（反向-2）：**变异测试** —— 把正确 IR 的某个字段故意改坏，交叉对账
 *     必须报告不一致。这一层直接证明「对账器本身不是恒真」：如果改坏了都发现不了，
 *     那「一致」什么也不能证明。
 *
 * ★ 覆盖边界（诚实声明，见 reference-ir.js 头注释）★
 *   含切片的黄金样本跳过 MERGED_LAYER_GROUP 对账（切片归属是另一套算法）；
 *   pHash 数值不参与对账（L3 兜底，与结构无关）。
 * ════════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  referenceBuildIr, referenceBuildIrBuggy, irToComparable, crossCheck, REF_MAX_DEPTH,
} = require('./helpers/reference-ir');
const { installCanvasShim } = require('../../src/psd/canvas-shim');
const { readPsdFile, extractSlices } = require('../../src/psd/reader');
const { IrBuilder } = require('../../src/psd/ir-builder');
const { makePsds } = require('../fixtures/make-psd');

installCanvasShim({ force: true });

const ROOT = path.resolve(__dirname, '../..');
const GOLDEN = path.join(ROOT, 'test/fixtures/golden');

/** 确保黄金样本存在（与 e2e 同款策略：缺就现造）。 */
function ensureGolden() {
  if (!fs.existsSync(path.join(GOLDEN, 'state_A.psd'))) {
    makePsds({ outDir: GOLDEN });
  }
}

/**
 * 读黄金样本并构建 IR（走真实管线：含切片抽取 —— 黄金样本自带切片）。
 * @param {'A'|'B'} label
 * @returns {{ir:Object, psd:Object}}
 */
function goldenIr(label) {
  ensureGolden();
  const read = readPsdFile(path.join(GOLDEN, `state_${label}.psd`), { mode: 'structure' });
  const ir = new IrBuilder({ withPhash: false }).build({
    psd: read.psd,
    psdPath: `state_${label}.psd`,
    sha256: read.sha256,
    slices: extractSlices(read.psd),
  });
  return { ir, psd: read.psd };
}

/**
 * 内存里的无切片畸形树 → IR + psd（不走 writePsd 的树直接喂 IrBuilder，
 * 与 E-01 的「真实往返」互补：这里专注结构对账）。
 * @param {Object[]} children
 * @returns {{ir:Object, psd:Object}}
 */
function treeIr(children) {
  const psd = { width: 300, height: 200, children };
  const ir = new IrBuilder({ withPhash: false }).build({
    psd, psdPath: 'synthetic.psd', sha256: 'x', slices: [],
  });
  return { ir, psd };
}

/** raster 层工厂（与 E-01 同款最小构造）。 */
function r(name, x, y, w, h) {
  return { name, left: x, top: y, right: x + w, bottom: y + h, blendMode: 'normal' };
}
/** 文本层工厂。 */
function t(name, x, y, w, h, text, transform) {
  return {
    name, left: x, top: y, right: x + w, bottom: y + h, blendMode: 'normal',
    text: {
      text, transform: transform || [1, 0, 0, 1, 0, 0],
      style: { font: { name: 'A' }, fontSize: 20, fillColor: { r: 1, g: 2, b: 3 } },
      paragraphStyle: { justification: 'left' },
    },
  };
}
/** 组工厂。 */
function g(name, children) {
  return { name, children, blendMode: 'pass through' };
}

// ════════════════════════════════════════════════════════════════════════════
// 第一层：正向交叉对账
// ════════════════════════════════════════════════════════════════════════════

test('★ 黄金样本 A: 独立参考实现与 IrBuilder 完全一致（含切片树上跳过 MERGED）', () => {
  const { ir, psd } = goldenIr('A');
  const ref = referenceBuildIr(psd);
  const got = irToComparable(ir);
  const { mismatches } = crossCheck(ref, got, { skipLayerWarnCodes: ['MERGED_LAYER_GROUP'] });
  assert.equal(mismatches.length, 0,
    `★ 交叉对账不一致（这正是旧 bug 的藏身处）：\n${mismatches.join('\n')}`);
  // 规模 sanity：黄金样本 A 不是小树（否则「一致」说明不了什么）
  assert.ok(ir.layers.length >= 15, `黄金样本 A 应有足够层数，实际 ${ir.layers.length}`);
  assert.ok(ir.layers.filter((l) => l.type === 'group').length >= 3, '应含多层嵌套组');
});

test('★ 黄金样本 B: 同样完全一致', () => {
  const { ir, psd } = goldenIr('B');
  const ref = referenceBuildIr(psd);
  const got = irToComparable(ir);
  const { mismatches } = crossCheck(ref, got, { skipLayerWarnCodes: ['MERGED_LAYER_GROUP'] });
  assert.equal(mismatches.length, 0,
    `★ 交叉对账不一致：\n${mismatches.join('\n')}`);
});

test('★ 无切片畸形树: 全量对账（含 MERGED 预测）', () => {
  const c = Math.cos(Math.PI / 6);
  const s = Math.sin(Math.PI / 6);
  const children = [
    g('空壳组', []),
    g('全 raster 组', [r('纯色块1', 0, 0, 10, 10), r('纯色块2', 20, 0, 10, 10)]),
    g('含文本组', [t('标题', 0, 0, 50, 20, 'hi'), r('底板', 0, 30, 80, 40)]),
    g('变形组', [t('旋转文本', 10, 10, 40, 20, 'rot', [c, s, -s, c, 5, 5])]),
    g('全跳过组', [{ name: '零尺寸', left: 5, top: 5, right: 5, bottom: 5, blendMode: 'normal' }]),
    t('普通文本', 0, 100, 60, 20, 'plain'),
    r('越界层', -30, -20, 40, 40),
  ];
  const { ir, psd } = treeIr(children);
  const ref = referenceBuildIr(psd);
  const got = irToComparable(ir);
  const { mismatches } = crossCheck(ref, got);
  assert.equal(mismatches.length, 0,
    `★ 交叉对账不一致：\n${mismatches.join('\n')}`);

  // 对账覆盖的告警码都应真实出现（否则本测试是空转）
  const codes = new Set(ir.warnings.map((w) => w.code));
  for (const expected of ['EMPTY_GROUP', 'EMPTY_LAYER', 'GROUP_BBOX_UNRESOLVED', 'TRANSFORMED_LAYER', 'MERGED_LAYER_GROUP', 'NO_SLICE']) {
    assert.ok(codes.has(expected), `fixture 应触发 ${expected}（否则对账是空转）`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 第二层：反向断言 1 —— 参考实现的 buggy 版必须与正确版不同
// ════════════════════════════════════════════════════════════════════════════

test('★ 反向-1: BUG#1 模拟版（组 bbox 读自身坐标）与正确版结果必须不同', () => {
  const { ir, psd } = goldenIr('A');
  const correct = referenceBuildIr(psd);
  const buggy = referenceBuildIrBuggy(psd);

  // 至少一个组的 bbox 两者不同 —— 相同则说明 fixture 仍掩盖 bug，对账无效
  const diffs = [];
  for (const layer of correct.layers) {
    const b = buggy.byKey.get(layer.key);
    if (!b) continue;
    if (JSON.stringify(layer.bbox) !== JSON.stringify(b.bbox)) diffs.push(layer.key);
  }
  assert.ok(diffs.length > 0,
    '★ 若递归与不递归结果相同，说明 fixture 仍掩盖 BUG#1，本交叉验证无效');
  assert.ok(diffs.some((k) => k.includes('最外层容器') || k.includes('弹窗框架')),
    '差异应落在嵌套组上（BUG#1 的暴露形状）');

  // 且 buggy 版与真实 IR 对账必须报不一致（证明对账器抓得到这个错）
  const { mismatches } = crossCheck(buggy, irToComparable(ir),
    { skipLayerWarnCodes: ['MERGED_LAYER_GROUP'] });
  assert.ok(mismatches.length > 0, '★ 对账器必须能抓到 BUG#1 类错误，否则它是恒真的');
  assert.ok(mismatches.some((m) => m.includes('bbox')), '不一致应体现在 bbox 上');
});

// ════════════════════════════════════════════════════════════════════════════
// 第三层：反向断言 2 —— 变异测试（证明对账器不是恒真）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 深拷贝 IR 并施加一处变异。
 * @param {Object} ir
 * @param {string} kind bbox|parent|type|childCount|dropWarning|dropLayer
 * @returns {Object} 变异后的 IR
 */
function mutateIr(ir, kind) {
  const clone = JSON.parse(JSON.stringify(ir));
  const group = clone.layers.find((l) => l.type === 'group' && l.childCount > 0);
  const leaf = clone.layers.find((l) => l.type !== 'group');
  switch (kind) {
    case 'bbox':
      // 改一个组的 bbox.x（模拟 BUG#1 方向的错：bbox 偏小）
      group.bbox.x += 7;
      break;
    case 'bboxLeaf':
      leaf.bbox.w += 3;
      break;
    case 'parent':
      leaf.parent = group.id;
      break;
    case 'type':
      group.type = 'raster';
      break;
    case 'childCount':
      group.childCount += 1;
      break;
    case 'dropWarning':
      clone.warnings.shift();
      break;
    case 'dropLayer':
      clone.layers = clone.layers.filter((l) => l.id !== leaf.id);
      break;
    default:
      throw new Error(`unknown mutation: ${kind}`);
  }
  return clone;
}

test('★ 反向-2: 变异测试 —— 改坏任何一处，交叉对账必须抓到', () => {
  const { ir, psd } = goldenIr('A');
  const ref = referenceBuildIr(psd);
  const opts = { skipLayerWarnCodes: ['MERGED_LAYER_GROUP'] };

  // 先确认未变异的 IR 对账干净（否则下面的「抓到」没有说服力）
  assert.equal(crossCheck(ref, irToComparable(ir), opts).mismatches.length, 0,
    '未变异时对账必须干净');

  // 黄金样本 A 上跑结构性变异（这些维度与 skip 的 MERGED 无关，必然可被抓）
  for (const kind of ['bbox', 'bboxLeaf', 'parent', 'type', 'childCount', 'dropLayer']) {
    const mutated = mutateIr(ir, kind);
    const { mismatches } = crossCheck(ref, irToComparable(mutated), opts);
    assert.ok(mismatches.length > 0,
      `★ 变异 ${kind} 未被抓到 —— 对账器对该维度是恒真的，交叉验证形同虚设`);
  }
});

test('★ 反向-2c: dropWarning 变异在无切片树上必须被抓（skip 不影响）', () => {
  // 无切片树：无 skip，告警集合全量对账 —— 丢任何一条告警都应被抓
  const { ir, psd } = treeIr([
    g('空壳组', []),
    g('全 raster 组', [r('块1', 0, 0, 10, 10)]),
    t('文本', 0, 50, 40, 20, 'hi'),
  ]);
  const ref = referenceBuildIr(psd);
  assert.equal(crossCheck(ref, irToComparable(ir)).mismatches.length, 0, '未变异应干净');

  const mutated = mutateIr(ir, 'dropWarning');
  const { mismatches } = crossCheck(ref, irToComparable(mutated));
  assert.ok(mismatches.length > 0,
    '★ 丢掉一条告警未被抓到 —— 告警维度对账是恒真的');
  assert.ok(mismatches.some((m) => m.includes('告警码')), '不一致应体现在告警码上');
});

test('★ 反向-2b: 变异后恢复原值，对账重新干净（证明差异来自变异而非漂移）', () => {
  const { ir, psd } = goldenIr('A');
  const ref = referenceBuildIr(psd);
  const opts = { skipLayerWarnCodes: ['MERGED_LAYER_GROUP'] };
  const mutated = mutateIr(ir, 'bbox');
  assert.ok(crossCheck(ref, irToComparable(mutated), opts).mismatches.length > 0);
  // 把改动改回去
  const g = mutated.layers.find((l) => l.type === 'group' && l.childCount > 0);
  g.bbox.x -= 7;
  assert.equal(crossCheck(ref, irToComparable(mutated), opts).mismatches.length, 0,
    '恢复后应重新干净（证明对账结果只取决于数据，无隐藏状态）');
});

// ════════════════════════════════════════════════════════════════════════════
// 参考实现自身的健全性（它也必须被验证，不能当成免检金牌）
// ════════════════════════════════════════════════════════════════════════════

test('参考实现自检: 空组/全跳过组/嵌套穿透的手算期望值', () => {
  const psd = {
    width: 100, height: 100,
    children: [
      g('空组', []),
      g('嵌套', [g('内层', [r('叶子', 10, 20, 30, 40)])]),
    ],
  };
  const ref = referenceBuildIr(psd);
  const byName = new Map(ref.layers.map((l) => [l.name, l]));
  assert.equal(byName.get('空组').bbox.w, 0);
  assert.equal(byName.get('空组').childCount, 0);
  // 三层穿透：嵌套(0) -> 内层(1) -> 叶子(2)，bbox 递归到最底层
  assert.deepEqual(byName.get('嵌套').bbox, { x: 10, y: 20, w: 30, h: 40 });
  assert.equal(byName.get('叶子').depth, 2);
  assert.equal(byName.get('内层').parentKey, '/嵌套#0');
  assert.equal(byName.get('叶子').parentKey, '/嵌套#0/内层#0');
  // 告警预测：空组 → EMPTY_GROUP；两个组子树全 raster → MERGED×2；无切片 → 文档级 NO_SLICE
  const codes = ref.warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ['EMPTY_GROUP', 'MERGED_LAYER_GROUP', 'MERGED_LAYER_GROUP']);
  assert.deepEqual(ref.docWarnings, ['NO_SLICE']);
});

test('参考实现自检: 深度上限 100 独立生效（与被测 256 不同）', () => {
  // 造 150 层：参考实现上限 100 → 最深组 bbox 应为 0（截断），不栈溢出
  let node = r('最深叶子', 1, 1, 5, 5);
  for (let i = 0; i < 150; i++) node = g(`g${i}`, [node]);
  const ref = referenceBuildIr({ width: 50, height: 50, children: [node] });
  const top = ref.layers.find((l) => l.name === 'g149');
  assert.deepEqual(top.bbox, { x: 0, y: 0, w: 0, h: 0 }, '超过参考上限应截断为 0');
  assert.equal(REF_MAX_DEPTH, 100);
});
