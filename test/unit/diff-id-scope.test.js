'use strict';
/**
 * test/unit/diff-id-scope.test.js —— ★ UPSTREAM-FIX-3 跨 PSD 节点 ID 碰撞回归 ★
 *
 * 问题（外部审查第三轮核实，P0）：
 *   base 与 target 的图层 id 各自从 L001 独立编号，**必然碰撞**。
 *   matcher/planner 旧实现把两份图层放进同一张以局部 id 为键的 Map
 *   （target 覆盖 base），merged/suspected 的父链爬升会走**错侧**的父节点：
 *     · base 的 L002.parent=L001，但 Map.get('L001') 返回 target 侧的 L001；
 *     · 若 base 侧 L001 是 merged 组而 target 侧不是（或反之），
 *       merged 归属判定互相污染 → 误加/绕过保守联动。
 *
 * 修复：身份加作用域 —— 按侧建表（baseById/targetById），
 * under 与归属表的键为 `base:${id}` / `target:${id}`；change_plan 输出格式不变。
 *
 * 测试设计（判别力说明）：
 *   用「只有 base 侧 L001 是 merged 组、target 侧同 ID 不是」的场景，
 *   让 L3 匹配的封顶行为成为可观察信号：
 *     · 修复后：base 侧父链判定 under-merged → L3 封顶 0.5（保守 OR，两侧任一
 *       疑似合并都打折）；
 *     · 旧缺陷：合并 Map 里 L001 被 target 的（非 merged）覆盖 → 两侧都判
 *       「不在 merged 下」→ 不封顶 → 测试红。
 *   planner 级用 INFERRED/ADD 去向与 REMOVE 置信度做同样的判别。
 *
 * 注：reference-ir.js（E-05 对账基准）不参与跨侧匹配（它只对账单份 IR 的
 * 结构），故无需作用域语义；本文件即跨侧身份的独立回归位。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { matchLayers, LEVEL } = require('../../src/diff/matcher');
const { buildChangePlan } = require('../../src/diff/planner');

const CFG = {
  sizeTolerancePx: 2, positionTolerancePx: 4, phashMaxDistance: 10,
  phashWeight: 0.5, sizeWeight: 0.3, positionWeight: 0.2,
  l3MinScore: 0.6, maxAreaRatio: 4, maxShapeRatioFactor: 1.6,
  mergedConfidenceCap: 0.5, l4Confidence: 0.15, restyleOpacityDelta: 0.02,
};

/**
 * 造一个 IR 层（最小字段集；两侧允许 id 完全相同 —— 这正是被测场景）。
 * @param {Object} o
 * @returns {Object}
 */
function layer(o) {
  return {
    id: o.id,
    name: o.name || o.id,
    normName: o.normName || o.name || o.id,
    parent: o.parent === undefined ? null : o.parent,
    type: o.type || 'raster',
    bbox: o.bbox || { x: 0, y: 0, w: 10, h: 10 },
    bboxSource: o.type === 'group' ? 'derived' : 'own',
    rotation: 0,
    opacity: 1,
    visible: true,
    blend: 'normal',
    merged: !!o.merged,
    suspectedMerged: !!o.suspectedMerged,
    childCount: o.childCount || 0,
    sliceName: o.sliceName || null,
    phash: o.phash || null,
    text: null,
  };
}

// ============================================================
// matcher 级：父链爬升按侧判定
// ============================================================

test('★ ID 碰撞回归: 仅 base 侧 L001 是 merged 组时，L3 命中仍按 base 父链封顶', () => {
  // 两份 PSD 的 id 完全相同（L001 组 + L002 子层），名字不同（避开 L1/L2），
  // 只有 base 侧 L001 标 merged。
  // 旧缺陷：合并 Map 里 L001 -> target 侧（非 merged）→ 双侧都判「未合并」
  // → 不封顶。修复后：base 侧按自己的父链判 under-merged → L3 封顶 0.5。
  const base = [
    layer({ id: 'L001', name: '组合并组', type: 'group', merged: true, childCount: 1 }),
    layer({ id: 'L002', name: '基准侧名字甲', parent: 'L001', phash: '0000000074eef6fe',
      bbox: { x: 100, y: 100, w: 200, h: 150 } }),
  ];
  const target = [
    layer({ id: 'L001', name: '普通组', type: 'group', childCount: 1 }),
    layer({ id: 'L002', name: '目标侧名字乙', parent: 'L001', phash: '0000000074eef6fe',
      bbox: { x: 100, y: 100, w: 200, h: 150 } }),
  ];
  const r = matchLayers({ baseLayers: base, targetLayers: target, config: CFG });
  assert.equal(r.pairs.length, 1, 'L3 应照常命中（merged 不再禁用任何档位）');
  assert.equal(r.pairs[0].level, LEVEL.L3);
  assert.ok(r.pairs[0].confidence <= 0.5,
    `★ base 侧 merged 归属必须按 base 父链判定（L3 封顶 0.5），实得 ${r.pairs[0].confidence}`);
  assert.equal(r.pairs[0].underMerged, true);
});

test('★ ID 碰撞回归: 反向（仅 target 侧 merged）同样封顶，不因覆盖序漏判', () => {
  // target 侧 L001 是 merged 组。旧实现中 target 恰好覆盖 base —— 此场景
  // 旧实现「碰巧」也对；本用例锁定修复后的行为（保守 OR，双向都封顶），
  // 防止修复退化成「只按 base 判」的另一种不对称。
  const base = [
    layer({ id: 'L001', name: '普通组', type: 'group', childCount: 1 }),
    layer({ id: 'L002', name: '基准侧名字甲', parent: 'L001', phash: '0000000074eef6fe',
      bbox: { x: 100, y: 100, w: 200, h: 150 } }),
  ];
  const target = [
    layer({ id: 'L001', name: '组合并组', type: 'group', merged: true, childCount: 1 }),
    layer({ id: 'L002', name: '目标侧名字乙', parent: 'L001', phash: '0000000074eef6fe',
      bbox: { x: 100, y: 100, w: 200, h: 150 } }),
  ];
  const r = matchLayers({ baseLayers: base, targetLayers: target, config: CFG });
  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0].level, LEVEL.L3);
  assert.ok(r.pairs[0].confidence <= 0.5,
    `★ target 侧 merged 归属必须按 target 父链判定，实得 ${r.pairs[0].confidence}`);
});

test('★ ID 碰撞回归: 两侧同 ID 都不是 merged 时，L3 不被封顶（无误加封顶）', () => {
  const base = [
    layer({ id: 'L001', name: '普通组甲', type: 'group', childCount: 1 }),
    layer({ id: 'L002', name: '基准侧名字甲', parent: 'L001', phash: '0000000074eef6fe',
      bbox: { x: 100, y: 100, w: 200, h: 150 } }),
  ];
  const target = [
    layer({ id: 'L001', name: '普通组乙', type: 'group', childCount: 1 }),
    layer({ id: 'L002', name: '目标侧名字乙', parent: 'L001', phash: '0000000074eef6fe',
      bbox: { x: 100, y: 100, w: 200, h: 150 } }),
  ];
  const r = matchLayers({ baseLayers: base, targetLayers: target, config: CFG });
  assert.equal(r.pairs.length, 1);
  assert.ok(r.pairs[0].confidence > 0.5,
    `★ 双侧都未合并时 L3 不得误封顶，实得 ${r.pairs[0].confidence}`);
  assert.equal(r.pairs[0].underMerged, false);
});

// ============================================================
// planner 级：未命中去向按侧判定（INFERRED / REMOVE 联动互不污染）
// ============================================================

/**
 * 造一份最小 DesignIr（buildChangePlan 只需要 layers/source/task 形状）。
 * @param {Object[]} layers
 * @param {string} psdPath
 * @returns {Object}
 */
function miniIr(layers, psdPath) {
  return {
    version: '1.0',
    source: { psdPath, psdSha256: 'x'.repeat(64), canvas: { w: 720, h: 560 }, dpr: 1 },
    layers,
    warnings: [],
    slices: [],
    sliceNames: [],
  };
}

test('★ ID 碰撞回归(planner): 未命中去向按侧判定 —— base 侧 REMOVE 压置信度、target 侧判 ADD', () => {
  // 场景：两份 IR 的组 id 完全相同（L001），只有 base 侧 L001 是 merged 组。
  //   base 侧 L002（merged 组内子层，target 态无对应物）→ REMOVE 且置信度压 0.5；
  //   target 侧 L003（非 merged 组下的独立新增）→ ADD 0.9，不得被拖进 INFERRED。
  // 旧缺陷：合并 Map 把 L001 解析成 target 侧（非 merged）→ base 侧 REMOVE
  // 拿 0.9 全置信、mergedNote 丢失（绕过保守联动）。
  const baseLayers = [
    layer({ id: 'L001', name: '组合并组', type: 'group', merged: true, childCount: 1,
      bbox: { x: 10, y: 10, w: 200, h: 100 } }),
    layer({ id: 'L002', name: '基准子层', parent: 'L001', normName: '基准子层',
      bbox: { x: 10, y: 10, w: 200, h: 100 } }),
  ];
  const targetLayers = [
    layer({ id: 'L001', name: '普通组', type: 'group', childCount: 1,
      bbox: { x: 10, y: 10, w: 200, h: 100 } }),
    layer({ id: 'L003', name: '全新节点', parent: 'L001', normName: '全新节点',
      bbox: { x: 300, y: 300, w: 80, h: 80 } }),
  ];
  const plan = buildChangePlan({
    baseIr: miniIr(baseLayers, 'base.psd'),
    targetIr: miniIr(targetLayers, 'target.psd'),
    task: { name: 'ID 碰撞回归', basePkg: 'Common', targetPkg: 'Common' },
    config: { diff: CFG },
  });

  const remove = plan.diffs.find((d) => d.op === 'REMOVE');
  assert.ok(remove, 'base 侧 merged 组内子层未命中应产出 REMOVE');
  assert.ok(remove.confidence <= 0.5,
    `★ REMOVE 的置信度必须按 base 侧父链压到 0.5，实得 ${remove.confidence}`);
  assert.ok(remove.evidence.includes('被合并的组'),
    '★ evidence 必须写明 merged 归属（来自 base 侧父链）');

  const add = plan.diffs.find((d) => d.op === 'ADD');
  assert.ok(add, 'target 侧独立新增应判 ADD');
  assert.ok(add.confidence >= 0.9,
    `★ target 侧不在 merged 组内（按 target 父链判定），应判确定新增，实得 ${add.confidence}`);
  assert.ok(!plan.diffs.some((d) => d.op === 'INFERRED'),
    '★ 本场景不应有任何 INFERRED（两侧去向互不污染的强断言）');
});

test('★ ID 碰撞回归(planner): 反向场景 —— 仅 target 侧 merged 时未命中进 INFERRED', () => {
  const baseLayers = [
    layer({ id: 'L001', name: '普通组', type: 'group', childCount: 1,
      bbox: { x: 10, y: 10, w: 200, h: 100 } }),
  ];
  const targetLayers = [
    layer({ id: 'L001', name: '组合并组', type: 'group', merged: true, childCount: 1,
      bbox: { x: 10, y: 10, w: 200, h: 100 } }),
    layer({ id: 'L002', name: '目标子层', parent: 'L001', normName: '目标子层',
      bbox: { x: 10, y: 10, w: 200, h: 100 } }),
  ];
  const plan = buildChangePlan({
    baseIr: miniIr(baseLayers, 'base.psd'),
    targetIr: miniIr(targetLayers, 'target.psd'),
    task: { name: 'ID 碰撞回归-反向', basePkg: 'Common', targetPkg: 'Common' },
    config: { diff: CFG },
  });
  const inferred = plan.diffs.find((d) => d.op === 'INFERRED');
  assert.ok(inferred, '★ target 侧 merged 组内未命中的子层必须进 INFERRED');
  assert.ok(inferred.evidence.includes('merged=true'));
});
