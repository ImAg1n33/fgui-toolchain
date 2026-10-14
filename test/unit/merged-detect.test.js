'use strict';
/**
 * test/unit/merged-detect.test.js —— ★ UPSTREAM-FIX-1 merged 两档语义单测 ★
 *
 * 背景（外部审查核实的问题一，P0）：
 *   旧规则把「组内叶子全栅格 + 无切片」直接当合并证据。反例：
 *     按钮组（按钮背景/高光/装饰边框三个独立栅格层）——
 *     真实 PSD 很可能整份都没有切片，「无切片」是常态不是异常信号。
 *     误判 merged -> planner 里限 L3、置信度封顶 0.5、未命中进 INFERRED
 *     -> 大量人工确认，恰好抵消提效目标。
 *
 * 修复后的两档语义：
 *   【强证据】docHasSlices=true（文档确实在用切片）+ 纯栅格无切片子树
 *     -> merged=true（触发 L3 封顶 / INFERRED 联动）
 *   【弱信号】docHasSlices=false + 同样形态
 *     -> merged=false + suspected=true（只发 info 级 SUSPECTED_MERGED_GROUP，
 *        不触发任何联动）
 *
 * 本文件同时锁定：
 *   · 文本层 / 智能对象 / 组内切片三种豁免在两档下行为不变（回归）；
 *   · suspected 不触发 matcher 置信度封顶与 classifier INFERRED 联动；
 *   · 两条告警构造器的契约（MERGED vs SUSPECTED 的 lost_info 差异）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectMerged, buildMergedWarning, buildSuspectedMergedWarning,
} = require('../../src/psd/merged-detect');
const { matchLayers } = require('../../src/diff/matcher');
const { classifyUnmatchedTarget, OP } = require('../../src/diff/classifier');

// ---------------------------------------------------------------- 工厂

/**
 * 造一个伪 ag-psd 栅格叶子（merged-detect 只看 text/smartObject/__irIndex）。
 * @param {number} irIndex 图层序号（与 ir-builder 的分配一致）
 * @returns {Object}
 */
function rasterLeaf(irIndex) {
  return { name: `图层${irIndex}`, __irIndex: irIndex };
}

/**
 * 造一个组（children 结构与 ag-psd 一致）。
 * @param {Object[]} children
 * @returns {Object}
 */
function grp(children) {
  return { name: '测试组', children };
}

/** matcher/classifier 用的 IR 层工厂（最小字段集）。 */
function irLayer(o) {
  return {
    id: o.id,
    name: o.name || o.id,
    normName: o.normName || o.name || o.id,
    parent: o.parent || null,
    type: o.type || 'raster',
    bbox: o.bbox || { x: 0, y: 0, w: 10, h: 10 },
    merged: !!o.merged,
    childCount: o.childCount || 0,
    sliceName: o.sliceName || null,
    phash: o.phash || null,
    text: o.text || null,
  };
}

// ---------------------------------------------------------------- 强证据档

test('★ 强证据: 文档有切片时，「兄弟层有切片、本组整棵子树无切片」判 merged=true', () => {
  // 合作方要求的正对照：文档存在切片（index=99 的兄弟层携带），
  // 本组 3 个纯栅格叶子均无切片 —— 异常信号成立
  const group = grp([rasterLeaf(1), rasterLeaf(2), rasterLeaf(3)]);
  const info = detectMerged(group, {
    docHasSlices: true,
    sliceByLayerIndex: new Map([[99, true]]), // 切片在别处（兄弟/其他组）
  });
  assert.equal(info.merged, true, '强证据成立必须判 merged');
  assert.equal(info.suspected, false);
  assert.equal(info.reason, 'all_raster_subtree_without_slice');
  assert.equal(info.evidenceStrength, 'strong');
});

test('★ 强证据: 判 merged=true 时产出的是 MERGED 告警（人工确认 + 封顶契约）', () => {
  const info = detectMerged(grp([rasterLeaf(1)]), { docHasSlices: true });
  assert.equal(info.merged, true);
  const w = buildMergedWarning({ id: 'L010', name: '按钮组' }, info);
  assert.equal(w.code, 'MERGED_LAYER_GROUP');
  assert.equal(w.lost_info.requiresHumanConfirm, true);
  assert.equal(w.lost_info.allowedMatchLevel, 'L3');
  assert.equal(w.lost_info.confidenceCap, 0.5);
  assert.equal(w.lost_info.defaultIfUnconfirmed, 'skip');
});

// ---------------------------------------------------------------- 弱信号档

test('★ 核心回归: 无切片文档中的普通栅格组不再判 merged（合作方按钮组反例）', () => {
  // 按钮组：三个独立可编辑的栅格层，整份 PSD 没有切片 —— 这是常态不是合并
  const buttonGroup = grp([
    rasterLeaf(1), // 按钮背景
    rasterLeaf(2), // 高光
    rasterLeaf(3), // 装饰边框
  ]);
  const info = detectMerged(buttonGroup, { docHasSlices: false });
  assert.equal(info.merged, false, '★ 无切片文档绝不能把常态当合并证据');
  assert.equal(info.suspected, true, '应降级为疑似档');
  assert.equal(info.reason, 'all_raster_subtree_without_slice', 'reason 保留原始形态描述');
  assert.equal(info.evidenceStrength, 'weak');
});

test('★ 弱信号: suspected 产出的是 SUSPECTED_MERGED_GROUP（info 级、不要求人工确认）', () => {
  const info = detectMerged(grp([rasterLeaf(1), rasterLeaf(2)]), { docHasSlices: false });
  assert.equal(info.merged, false);
  const w = buildSuspectedMergedWarning({ id: 'L010', name: '按钮组' }, info);
  assert.equal(w.code, 'SUSPECTED_MERGED_GROUP');
  assert.equal(w.lost_info.severity, 'info');
  assert.equal(w.lost_info.suspected, true);
  assert.equal(w.lost_info.requiresHumanConfirm, false, '疑似档不得进人工确认队列');
  assert.ok(w.msg.includes('不判定为合并组'), '文案必须明说「只是疑似」');
});

test('★ 联动隔离: 无切片文档 + 疑似组不触发 matcher 置信度封顶（L2 照常 0.95）', () => {
  // IR 形态：组未标 merged（suspected 档在 IR 里就是 merged=false）
  const base = [
    irLayer({ id: 'L001', type: 'group', name: '按钮组', childCount: 1, merged: false }),
    irLayer({ id: 'L002', name: '按钮背景', parent: 'L001', normName: '按钮背景',
      bbox: { x: 10, y: 10, w: 200, h: 100 } }),
  ];
  const target = [
    irLayer({ id: 'L001', type: 'group', name: '按钮组', childCount: 1, merged: false }),
    irLayer({ id: 'L002', name: '按钮背景', parent: 'L001', normName: '按钮背景',
      bbox: { x: 10, y: 10, w: 200, h: 100 } }),
  ];
  const r = matchLayers({ baseLayers: base, targetLayers: target, config: {} });
  assert.equal(r.pairs.length, 1, '疑似组内的子层应正常配对');
  assert.equal(r.pairs[0].level, 'L2');
  assert.ok(r.pairs[0].confidence > 0.5,
    `★ suspected 不触发封顶：confidence 应 > 0.5，实得 ${r.pairs[0].confidence}`);
  assert.equal(r.pairs[0].underMerged, false);
  assert.equal(r.stats.mergedCapped, 0, '封顶统计必须为 0');
});

test('★ 联动隔离: 无切片文档 + 疑似组的未匹配子层判 ADD 而非 INFERRED', () => {
  // 对照：underMerged=true 时 classifyUnmatchedTarget 判 INFERRED（matcher.test.js 已锁）；
  // 这里锁 suspected 档（underMerged=false）不受牵连 —— 确定的新增照常判 ADD
  const target = irLayer({ id: 'L002', name: '新图标', bbox: { x: 100, y: 100, w: 96, h: 96 } });
  const d = classifyUnmatchedTarget(target, {
    cfg: {}, underMerged: false, candidates: [],
  });
  assert.equal(d.op, OP.ADD, '★ suspected 不得把确定新增拖进 INFERRED');
  assert.ok(d.confidence >= 0.9);
});

// ---------------------------------------------------------------- 豁免回归（两档一致）

test('豁免回归: 文本层豁免在两档下行为不变（has_text_layer）', () => {
  const group = { name: 'g', children: [{ name: 't', __irIndex: 1, text: { text: 'hi' } }] };
  for (const docHasSlices of [true, false]) {
    const info = detectMerged(group, { docHasSlices });
    assert.equal(info.merged, false, `docHasSlices=${docHasSlices}`);
    assert.equal(info.suspected, false, `docHasSlices=${docHasSlices}`);
    assert.equal(info.reason, 'has_text_layer');
  }
});

test('豁免回归: 智能对象豁免在两档下行为不变（has_smart_object）', () => {
  const group = { name: 'g', children: [{ name: 's', __irIndex: 1, smartObject: true }] };
  for (const docHasSlices of [true, false]) {
    const info = detectMerged(group, { docHasSlices });
    assert.equal(info.merged, false, `docHasSlices=${docHasSlices}`);
    assert.equal(info.suspected, false, `docHasSlices=${docHasSlices}`);
    assert.equal(info.reason, 'has_smart_object');
  }
});

test('豁免回归: 组内携带切片时明确未合并（has_slice），与文档级切片无关', () => {
  const group = grp([rasterLeaf(7)]);
  for (const docHasSlices of [true, false]) {
    const info = detectMerged(group, {
      docHasSlices,
      sliceByLayerIndex: new Map([[7, true]]),
    });
    assert.equal(info.merged, false, `docHasSlices=${docHasSlices}`);
    assert.equal(info.suspected, false, `docHasSlices=${docHasSlices}`);
    assert.equal(info.reason, 'has_slice');
    assert.equal(info.sliceCount, 1);
  }
});

test('空组两种文档下都不判合并、不进疑似（empty_group）', () => {
  for (const docHasSlices of [true, false]) {
    const info = detectMerged(grp([]), { docHasSlices });
    assert.equal(info.merged, false);
    assert.equal(info.suspected, false);
    assert.equal(info.reason, 'empty_group');
  }
});

// ---------------------------------------------------------------- ctx 兼容

test('ctx 兼容: 不传 docHasSlices 时按弱信号处理（保守默认，绝不误判 merged）', () => {
  // 老调用方（只传 sliceByLayerIndex 或什么都不传）必须拿到新语义下的安全默认：
  // 无切片信息 = 无判别力 = 只疑似
  const info1 = detectMerged(grp([rasterLeaf(1)]), {});
  assert.equal(info1.merged, false);
  assert.equal(info1.suspected, true);
  const info2 = detectMerged(grp([rasterLeaf(1)]));
  assert.equal(info2.merged, false);
  assert.equal(info2.suspected, true);
});
