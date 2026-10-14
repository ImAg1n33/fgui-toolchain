'use strict';
/**
 * test/unit/matcher.test.js —— L1→L4 四级匹配 + 七类差异分类
 *
 * ★ 验收：L1 / L2 / L3 / L4 四条路径各有单测；
 *   merged/suspected 启发式**不改变匹配路径**（UPSTREAM-FIX-4）：
 *   L1/L2 照常精确匹配且不封顶，仅 L3 弱证据命中疑似合并对象时封顶 0.5，
 *   未命中且疑似合并时进 INFERRED（classifier 侧，PRD K4）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { matchLayers, isUnderMerged, l3Similarity, sameSize, samePos, LEVEL } = require('../../src/diff/matcher');
const {
  classifyPair, classifyUnmatchedTarget, classifyUnmatchedBase,
  summarize, sameAspect, styleChanged, OP,
} = require('../../src/diff/classifier');
const { advise, findRepeatedClusters, collectOpenQuestions, ADVICE } = require('../../src/diff/structure-advisor');

const CFG = {
  sizeTolerancePx: 2, positionTolerancePx: 4, phashMaxDistance: 10,
  phashWeight: 0.5, sizeWeight: 0.3, positionWeight: 0.2,
  l3MinScore: 0.6, maxAreaRatio: 4, maxShapeRatioFactor: 1.6,
  mergedConfidenceCap: 0.5, l4Confidence: 0.15, restyleOpacityDelta: 0.02,
};

/**
 * 造一个 IR 层。
 * @param {Object} o
 * @returns {Object}
 */
function layer(o) {
  return {
    id: o.id || 'L001',
    name: o.name || 'L',
    normName: o.normName || o.name || 'l',
    parent: o.parent === undefined ? null : o.parent,
    type: o.type || 'raster',
    bbox: o.bbox || { x: 0, y: 0, w: 100, h: 100 },
    bboxSource: o.type === 'group' ? 'derived' : 'own',
    rotation: 0,
    opacity: o.opacity === undefined ? 1 : o.opacity,
    visible: o.visible === undefined ? true : o.visible,
    blend: 'normal',
    merged: !!o.merged,
    suspectedMerged: !!o.suspectedMerged,
    childCount: o.childCount || 0,
    sliceName: o.sliceName || null,
    phash: o.phash || null,
    text: o.text || null,
  };
}

// ======================================================================
// L1：slice 名一致
// ======================================================================
test('L1: slice 名一致 + 尺寸一致 -> HIT 且 confidence=1', () => {
  const base = [layer({ id: 'L001', name: '矩形11', sliceName: 'mail_bg', bbox: { x: 10, y: 10, w: 200, h: 100 } })];
  const target = [layer({ id: 'L001', name: '完全不同的名字', sliceName: 'mail_bg', bbox: { x: 10, y: 10, w: 200, h: 100 } })];
  const r = matchLayers({ baseLayers: base, targetLayers: target, config: CFG });
  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0].level, LEVEL.L1);
  assert.equal(r.pairs[0].confidence, 1);
  assert.ok(r.pairs[0].evidence.includes('mail_bg'));
  assert.ok(r.pairs[0].evidence.includes('最强证据'));
});

test('L1: slice 一致但尺寸变了 -> 置信度降为 0.9', () => {
  const base = [layer({ id: 'L001', name: 'a', sliceName: 'mail_bg', bbox: { x: 10, y: 10, w: 200, h: 100 } })];
  const target = [layer({ id: 'L001', name: 'a', sliceName: 'mail_bg', bbox: { x: 10, y: 10, w: 260, h: 130 } })];
  const r = matchLayers({ baseLayers: base, targetLayers: target, config: CFG });
  assert.equal(r.pairs[0].level, LEVEL.L1);
  assert.equal(r.pairs[0].confidence, 0.9);
  assert.ok(r.pairs[0].evidence.includes('尺寸有变化'));
});

// ======================================================================
// L2：归一化名全等（★ K5：只做全等）
// ======================================================================
test('L2: 归一化名全等 -> L2 匹配', () => {
  const base = [layer({ id: 'L001', name: '图层249(1)', normName: '图层249', bbox: { x: 0, y: 0, w: 64, h: 64 } })];
  const target = [layer({ id: 'L001', name: '图层249', normName: '图层249', bbox: { x: 0, y: 0, w: 64, h: 64 } })];
  const r = matchLayers({ baseLayers: base, targetLayers: target, config: CFG });
  assert.equal(r.pairs[0].level, LEVEL.L2);
  assert.ok(r.pairs[0].evidence.includes('全等匹配'));
  assert.ok(r.pairs[0].evidence.includes('未使用前缀'));
});

test('★ L2 K5: 矩形1 与 矩形11 不得互相匹配', () => {
  const base = [layer({ id: 'L001', name: '矩形11', normName: '矩形11', bbox: { x: 0, y: 0, w: 180, h: 90 } })];
  const target = [layer({ id: 'L001', name: '矩形1', normName: '矩形1', bbox: { x: 0, y: 0, w: 100, h: 50 } })];
  const r = matchLayers({ baseLayers: base, targetLayers: target, config: CFG });
  assert.equal(r.pairs.length, 0, '★ 矩形11 与 矩形1 不得配对');
  assert.equal(r.unmatchedBase.length, 1);
  assert.equal(r.unmatchedTarget.length, 1);
});

test('★ L2 K5: 归一化后同名（矩形1 vs 矩形1(1)）应匹配而非歧义', () => {
  const base = [layer({ id: 'L001', name: '矩形1', normName: '矩形1', bbox: { x: 0, y: 0, w: 100, h: 50 } })];
  const target = [layer({ id: 'L001', name: '矩形1(1)', normName: '矩形1', bbox: { x: 0, y: 0, w: 100, h: 50 } })];
  const r = matchLayers({ baseLayers: base, targetLayers: target, config: CFG });
  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0].level, LEVEL.L2);
});

// ======================================================================
// L3：pHash + 尺寸 + 位置
// ======================================================================
test('L3: 名字完全不同但 pHash 相同 + 尺寸相近 -> L3 匹配', () => {
  const base = [layer({ id: 'L001', name: '旧名字', phash: '0000000074eef6fe', bbox: { x: 100, y: 100, w: 200, h: 150 } })];
  const target = [layer({ id: 'L001', name: '新名字', phash: '0000000074eef6fe', bbox: { x: 100, y: 100, w: 200, h: 150 } })];
  const r = matchLayers({ baseLayers: base, targetLayers: target, config: CFG });
  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0].level, LEVEL.L3);
  assert.ok(r.pairs[0].evidence.includes('汉明距离'));
});

test('★ L3: pHash 退化（纯色）时靠几何门槛兜住误配', () => {
  // 两个纯色方块 pHash 几乎一样，但尺寸差 5.76 倍 -> 不应匹配
  const base = [layer({ id: 'L001', name: '角标', phash: '0000000000000000', bbox: { x: 500, y: 300, w: 40, h: 40 } })];
  const target = [layer({ id: 'L001', name: '图标', phash: '0000000000000001', bbox: { x: 100, y: 200, w: 96, h: 96 } })];
  const r = matchLayers({ baseLayers: base, targetLayers: target, config: CFG });
  assert.equal(r.pairs.length, 0, '★ 面积差 5.76 倍不应被 L3 匹配');
});

test('★ L3: 同形态不同宽度仍能匹配（相对比较而非相减）', () => {
  // 480x8 与 560x8：形状比 60 vs 70，相减差 10 > 阈值会误杀，相对比值 1.17 应放行
  const base = [layer({ id: 'L001', name: '横条', phash: '0000000075eea5ff', bbox: { x: 100, y: 100, w: 480, h: 8 } })];
  const target = [layer({ id: 'L001', name: '改名横条', phash: '0000000075eea5ff', bbox: { x: 80, y: 80, w: 560, h: 8 } })];
  const r = matchLayers({ baseLayers: base, targetLayers: target, config: CFG });
  assert.equal(r.pairs.length, 1, '★ 同一根横条缩放应能 L3 匹配');
  assert.equal(r.pairs[0].level, LEVEL.L3);
});

test('l3Similarity: 无 pHash 返回 null', () => {
  assert.equal(l3Similarity(
    { phash: null, bbox: { x: 0, y: 0, w: 10, h: 10 } },
    { phash: '0000000000000000', bbox: { x: 0, y: 0, w: 10, h: 10 } },
    CFG,
  ), null);
});

test('l3Similarity: 同图自比分数为 1', () => {
  const a = { phash: '0000000074eef6fe', bbox: { x: 100, y: 100, w: 200, h: 150 } };
  const s = l3Similarity(a, { ...a }, CFG);
  assert.ok(s);
  assert.equal(s.score, 1);
  assert.equal(s.parts.hamming, 0);
});

// ======================================================================
// ★ merged/suspected 启发式联动（UPSTREAM-FIX-4 成本不对称语义）
// ======================================================================

test('★ merged 组内节点照常走 L1/L2（原语义「禁用 L1/L2」已废除）', () => {
  // 原语义 → 新语义：原来 merged 组内禁用 L1/L2、强制落到未匹配；
  // 新语义下匹配成功（L1 slice 名一致）本身就证明没被合并 ——
  // 误判 merged 禁用精确匹配的代价高（无理放弃精确结果），而漏判的代价低
  // （真合并组没有独立子层，L1/L2 本来就会失败）。
  const base = [
    layer({ id: 'L001', name: '组合并组', type: 'group', merged: true, childCount: 2 }),
    layer({ id: 'L002', name: '矩形11', parent: 'L001', sliceName: 'mail_bg', normName: '矩形11',
      bbox: { x: 10, y: 10, w: 200, h: 100 } }),
  ];
  const target = [
    layer({ id: 'L001', name: '组合并组', type: 'group', merged: true, childCount: 2 }),
    layer({ id: 'L002', name: '矩形11', parent: 'L001', sliceName: 'mail_bg', normName: '矩形11',
      bbox: { x: 10, y: 10, w: 200, h: 100 } }),
  ];
  const r = matchLayers({ baseLayers: base, targetLayers: target, config: CFG });
  assert.equal(r.pairs.length, 1, '★ merged 组内子层应照常精确匹配');
  assert.equal(r.pairs[0].level, LEVEL.L1);
  assert.equal(r.pairs[0].confidence, 1, '★ L1 精确匹配不得被封顶');
});

test('★ merged/suspected 组内 L2 命中同样不封顶（匹配成功 = 未合并的证据）', () => {
  const base = [
    layer({ id: 'L001', name: '按钮组', type: 'group', suspectedMerged: true, childCount: 1 }),
    layer({ id: 'L002', name: '按钮背景', parent: 'L001', normName: '按钮背景',
      bbox: { x: 10, y: 10, w: 200, h: 100 } }),
  ];
  const target = [
    layer({ id: 'L001', name: '按钮组', type: 'group', suspectedMerged: true, childCount: 1 }),
    layer({ id: 'L002', name: '按钮背景', parent: 'L001', normName: '按钮背景',
      bbox: { x: 10, y: 10, w: 200, h: 100 } }),
  ];
  const r = matchLayers({ baseLayers: base, targetLayers: target, config: CFG });
  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0].level, LEVEL.L2);
  assert.equal(r.pairs[0].confidence, 0.95, '★ L2 全等匹配不受 suspected 影响');
});

test('★ merged 组内 L3 命中时 confidence 封顶 0.5（弱证据打折，保留）', () => {
  const base = [
    layer({ id: 'L001', name: '组合并组', type: 'group', merged: true, childCount: 1 }),
    layer({ id: 'L002', name: '完全不同的名字', parent: 'L001', phash: '0000000074eef6fe',
      bbox: { x: 100, y: 100, w: 200, h: 150 } }),
  ];
  const target = [
    layer({ id: 'L001', name: '组合并组', type: 'group', merged: true, childCount: 1 }),
    layer({ id: 'L002', name: '另一个名字', parent: 'L001', phash: '0000000074eef6fe',
      bbox: { x: 100, y: 100, w: 200, h: 150 } }),
  ];
  const r = matchLayers({ baseLayers: base, targetLayers: target, config: CFG });
  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0].level, LEVEL.L3);
  assert.ok(r.pairs[0].confidence <= 0.5, `★ 应封顶 0.5，实得 ${r.pairs[0].confidence}`);
  assert.ok(r.pairs[0].evidence.includes('封顶'));
  assert.equal(r.pairs[0].underMerged, true);
});

test('isUnderMerged: 沿父链向上查找', () => {
  const byId = new Map([
    ['L001', layer({ id: 'L001', type: 'group', merged: true, name: 'g' })],
    ['L002', layer({ id: 'L002', parent: 'L001', name: 'c' })],
    ['L003', layer({ id: 'L003', parent: 'L002', name: 'gc' })],
    ['L004', layer({ id: 'L004', name: 'root' })],
  ]);
  assert.equal(isUnderMerged(byId.get('L002'), byId), true);
  assert.equal(isUnderMerged(byId.get('L003'), byId), true, '深层子层也应识别');
  assert.equal(isUnderMerged(byId.get('L004'), byId), false);
});

// ======================================================================
// L4 / 七类差异分类
// ======================================================================
test('七类差异: REUSE（几何与样式均无变化）', () => {
  const base = layer({ id: 'L001', name: 'btn_close', normName: 'btn_close', sliceName: 'btn_close',
    bbox: { x: 552, y: 92, w: 32, h: 32 } });
  const target = layer({ id: 'L001', name: '完全改名了', normName: '改名了', sliceName: 'btn_close',
    bbox: { x: 552, y: 92, w: 32, h: 32 } });
  const d = classifyPair({ level: LEVEL.L1, confidence: 1 }, base, target, { cfg: CFG });
  assert.equal(d.op, OP.REUSE);
  assert.equal(d.fguiStrategy.type, 'reuse');
  assert.ok(d.evidence.includes('零新增节点'));
});

test('七类差异: MOVE（尺寸不变位置变）', () => {
  const base = layer({ id: 'L001', name: 'a', bbox: { x: 552, y: 92, w: 32, h: 32 } });
  const target = layer({ id: 'L001', name: 'a', bbox: { x: 592, y: 72, w: 32, h: 32 } });
  const d = classifyPair({ level: LEVEL.L1, confidence: 1 }, base, target, {
    cfg: CFG,
    relationOf: () => ({ usable: true, sidePair: 'left-left', describe: '水平右移 40px' }),
  });
  assert.equal(d.op, OP.MOVE);
  assert.equal(d.fguiStrategy.type, 'relation');
  assert.ok(d.evidence.includes('位移'));
});

test('七类差异: MOVE 无相对关系时退用 gearXY', () => {
  const base = layer({ id: 'L001', name: 'a', bbox: { x: 0, y: 0, w: 32, h: 32 } });
  const target = layer({ id: 'L001', name: 'a', bbox: { x: 100, y: 100, w: 32, h: 32 } });
  const d = classifyPair({ level: LEVEL.L2, confidence: 0.9 }, base, target, {
    cfg: CFG, relationOf: () => null,
  });
  assert.equal(d.op, OP.MOVE);
  assert.equal(d.fguiStrategy.type, 'gearXY');
});

test('七类差异: RESIZE + CAN_9GRID -> scale9grid', () => {
  const base = layer({ id: 'L001', name: 'a', bbox: { x: 100, y: 80, w: 480, h: 320 } });
  const target = layer({ id: 'L001', name: 'a', bbox: { x: 80, y: 60, w: 560, h: 360 } });
  const d = classifyPair({ level: LEVEL.L1, confidence: 0.9 }, base, target, {
    cfg: CFG,
    grid9Of: () => ({ verdict: 'CAN_9GRID', confidence: 0.75, evidence: ['四角实心'], suggestedGrid: null }),
  });
  assert.equal(d.op, OP.RESIZE);
  assert.equal(d.fguiStrategy.type, 'scale9grid');
  assert.ok(d.evidence.includes('CAN_9GRID'));
});

test('七类差异: RESIZE + SINGLE_AXIS_ONLY -> 单轴 scale9grid 并警示', () => {
  const base = layer({ id: 'L001', name: 'btn', bbox: { x: 100, y: 100, w: 200, h: 40 } });
  const target = layer({ id: 'L001', name: 'btn', bbox: { x: 100, y: 100, w: 260, h: 40 } });
  const d = classifyPair({ level: LEVEL.L1, confidence: 0.9 }, base, target, {
    cfg: CFG,
    grid9Of: () => ({ verdict: 'SINGLE_AXIS_ONLY', confidence: 0.8, evidence: ['胶囊'], suggestedGrid: '20,0,220,40' }),
  });
  assert.equal(d.op, OP.RESIZE);
  assert.equal(d.fguiStrategy.detail.singleAxisOnly, true);
  assert.equal(d.fguiStrategy.detail.scale9grid, '20,0,220,40');
  assert.ok(d.evidence.includes('圆头会被拉成椭圆'), '★ 应写明误判的事故后果');
});

test('七类差异: RESIZE + NEVER -> gearSize（不切九宫格）', () => {
  const base = layer({ id: 'L001', name: 'icon', bbox: { x: 0, y: 0, w: 64, h: 64 } });
  const target = layer({ id: 'L001', name: 'icon', bbox: { x: 0, y: 0, w: 96, h: 96 } });
  const d = classifyPair({ level: LEVEL.L1, confidence: 0.9 }, base, target, {
    cfg: CFG,
    grid9Of: () => ({ verdict: 'NEVER', confidence: 0.85, evidence: ['圆形'], suggestedGrid: null }),
  });
  assert.equal(d.op, OP.RESIZE);
  assert.equal(d.fguiStrategy.type, 'gearSize');
  assert.ok(d.evidence.includes('禁止切九宫格') || d.evidence.includes('不建议切九宫格'));
});

test('七类差异: RESTYLE（同位置同尺寸但颜色变）', () => {
  const base = layer({ id: 'L001', name: 'body', bbox: { x: 10, y: 10, w: 200, h: 20 },
    text: { value: '发件人', color: '#e2e8f4', fontSize: 20, align: 'left', font: 'x' } });
  const target = layer({ id: 'L001', name: 'body', bbox: { x: 10, y: 10, w: 200, h: 20 },
    text: { value: '发件人', color: '#ffd678', fontSize: 20, align: 'left', font: 'x' } });
  const d = classifyPair({ level: LEVEL.L2, confidence: 0.95 }, base, target, { cfg: CFG });
  assert.equal(d.op, OP.RESTYLE);
  assert.equal(d.fguiStrategy.type, 'color');
  assert.equal(d.fguiStrategy.detail.color, '#ffd678');
  assert.ok(d.evidence.includes('不生成新图'));
  assert.ok(d.evidence.includes('8 位'), '★ 应提示 8 位色会渲染成纯蓝的上游坑');
});

test('七类差异: RESTYLE 透明度变化', () => {
  const base = layer({ id: 'L001', name: 'x', bbox: { x: 0, y: 0, w: 10, h: 10 }, opacity: 1 });
  const target = layer({ id: 'L001', name: 'x', bbox: { x: 0, y: 0, w: 10, h: 10 }, opacity: 0.5 });
  const d = classifyPair({ level: LEVEL.L2, confidence: 0.9 }, base, target, { cfg: CFG });
  assert.equal(d.op, OP.RESTYLE);
  assert.equal(d.fguiStrategy.detail.alpha, 0.5);
});

test('七类差异: ADD（无任何候选 -> 确定新增）', () => {
  const target = layer({ id: 'L001', name: 'btn_claim', bbox: { x: 260, y: 380, w: 200, h: 56 } });
  const d = classifyUnmatchedTarget(target, { cfg: CFG, underMerged: false, candidates: [] });
  assert.equal(d.op, OP.ADD);
  assert.equal(d.confidence, 0.9);
  assert.ok(d.evidence.includes('确定的新增'));
  assert.ok(d.evidence.includes('package.xml'), '★ 应提醒不允许自动改 package.xml');
});

test('★ 七类差异: INFERRED（merged 组内 -> 默认 skip 而非猜测）', () => {
  const target = layer({ id: 'L002', name: '图层249', parent: 'L001', bbox: { x: 100, y: 100, w: 96, h: 96 } });
  const d = classifyUnmatchedTarget(target, {
    cfg: CFG, underMerged: true, groupName: '组1200拷贝', candidates: ['矩形11.png'],
  });
  assert.equal(d.op, OP.INFERRED);
  assert.equal(d.matchLevel, LEVEL.L4);
  assert.equal(d.defaultIfUnconfirmed, 'skip', '★ PRD K4：低置信度一律 skip');
  assert.ok(d.confidence <= 0.5, 'merged 组内置信度应 <= 0.5');
  assert.ok(d.evidence.includes('merged=true'));
  assert.ok(d.evidence.includes('skip 而非猜测'));
  assert.deepEqual(d.candidates, ['矩形11.png']);
  assert.equal(d.fguiStrategy, null, 'INFERRED 不给确定策略');
});

test('★ 七类差异: REMOVE（默认不删，stash 或 visible=false）', () => {
  const base = layer({ id: 'L001', name: '旧附件角标', bbox: { x: 500, y: 300, w: 40, h: 40 } });
  const d = classifyUnmatchedBase(base, { cfg: CFG });
  assert.equal(d.op, OP.REMOVE);
  assert.equal(d.fguiStrategy.type, 'stash');
  assert.equal(d.fguiStrategy.detail.action, 'visible_false');
  assert.ok(d.evidence.includes('不直接删除'));
});

test('styleChanged / sameAspect: 辅助函数', () => {
  assert.equal(sameAspect({ w: 100, h: 100 }, { w: 200, h: 200 }, 0.02), true, '等比缩放');
  assert.equal(sameAspect({ w: 100, h: 100 }, { w: 200, h: 50 }, 0.02), false, '非等比');
  const sc = styleChanged(
    { opacity: 1, visible: true, text: null },
    { opacity: 0.5, visible: true, text: null },
    0.02,
  );
  assert.equal(sc.changed, true);
  assert.ok(sc.parts[0].includes('透明度'));
});

test('summarize: 统计七类与总数', () => {
  const s = summarize([
    { op: OP.REUSE }, { op: OP.REUSE }, { op: OP.ADD }, { op: OP.INFERRED },
  ]);
  assert.equal(s.REUSE, 2);
  assert.equal(s.ADD, 1);
  assert.equal(s.INFERRED, 1);
  assert.equal(s.MOVE, 0);
  assert.equal(s.total, 4);
});

// ======================================================================
// 结构建议
// ======================================================================
test('结构建议: 3 个等距同尺寸兄弟 -> GList + Cell', () => {
  const targets = [
    layer({ id: 'L001', name: '奖励组', type: 'group', parent: null, childCount: 3, bbox: { x: 108, y: 240, w: 312, h: 96 } }),
    layer({ id: 'L002', name: '图层249', parent: 'L001', bbox: { x: 108, y: 240, w: 96, h: 96 } }),
    layer({ id: 'L003', name: '图层249', parent: 'L001', bbox: { x: 216, y: 240, w: 96, h: 96 } }),
    layer({ id: 'L004', name: '图层249', parent: 'L001', bbox: { x: 324, y: 240, w: 96, h: 96 } }),
  ];
  const diffs = [
    { op: OP.ADD, slot: '图层249', node: 'L002', matchLevel: 'L4', confidence: 0.9, evidence: '', candidates: [], defaultIfUnconfirmed: 'skip' },
    { op: OP.ADD, slot: '图层249', node: 'L003', matchLevel: 'L4', confidence: 0.9, evidence: '', candidates: [], defaultIfUnconfirmed: 'skip' },
    { op: OP.ADD, slot: '图层249', node: 'L004', matchLevel: 'L4', confidence: 0.9, evidence: '', candidates: [], defaultIfUnconfirmed: 'skip' },
  ];
  const a = advise({ targetLayers: targets, diffs, config: CFG });
  const list = a.find((x) => x.type === ADVICE.LIST);
  assert.ok(list, '★ 应给出 GList 建议');
  assert.equal(list.suggestion.extention, 'List', '★ 拼写就是 extention（上游拼写）');
  assert.equal(list.suggestion.layout, 'flow_hz');
  assert.equal(list.suggestion.itemCount, 3);
  assert.equal(list.suggestion.itemSize[0], 96);
  assert.equal(list.suggestion.gap, 12);
  assert.ok(list.reason.includes('等距'));
});

test('结构建议: 间距不一致则不给 GList 建议', () => {
  const targets = [
    layer({ id: 'L001', name: 'g', type: 'group', childCount: 3, bbox: { x: 0, y: 0, w: 300, h: 96 } }),
    layer({ id: 'L002', name: 'a', parent: 'L001', bbox: { x: 0, y: 0, w: 96, h: 96 } }),
    layer({ id: 'L003', name: 'b', parent: 'L001', bbox: { x: 106, y: 0, w: 96, h: 96 } }),
    layer({ id: 'L004', name: 'c', parent: 'L001', bbox: { x: 400, y: 0, w: 96, h: 96 } }),
  ];
  const diffs = targets.slice(1).map((t, i) => ({
    op: OP.ADD, slot: t.name, node: t.id, matchLevel: 'L4', confidence: 0.9,
    evidence: '', candidates: [], defaultIfUnconfirmed: 'skip',
  }));
  const a = advise({ targetLayers: targets, diffs, config: CFG });
  assert.equal(a.find((x) => x.type === ADVICE.LIST), undefined, '间距不一致不应判为重复结构');
});

test('结构建议: 无语义槽位名应被提醒（PRD §8.3 硬约束）', () => {
  const diffs = [
    { op: OP.ADD, slot: '图层249', node: 'L002', matchLevel: 'L4', confidence: 0.9, evidence: '', candidates: [], defaultIfUnconfirmed: 'skip' },
    { op: OP.ADD, slot: 'n0', node: 'L003', matchLevel: 'L4', confidence: 0.9, evidence: '', candidates: [], defaultIfUnconfirmed: 'skip' },
  ];
  const a = advise({ targetLayers: [], diffs, config: CFG });
  const u = a.find((x) => x.type === ADVICE.UNNAMED_SLOT);
  assert.ok(u, '★ 应提醒无语义槽位名');
  assert.equal(u.suggestion.affected.length, 2);
  assert.deepEqual(u.suggestion.affected, ['n0', '图层249'], 'affected 应排序且确定性');
  assert.ok(u.suggestion.note.includes('语义化'));
});

test('结构建议: 框架类复用件 >= 3 -> 建议抽 PanelFrame', () => {
  const diffs = ['popup_bg', 'panel_frame', 'dialog_bg'].map((n, i) => ({
    op: OP.REUSE, slot: n, node: `L00${i}`, matchLevel: 'L1', confidence: 1,
    evidence: '', fguiStrategy: { type: 'reuse', detail: { refName: n } },
    candidates: [], defaultIfUnconfirmed: 'skip',
  }));
  const a = advise({ targetLayers: [], diffs, config: CFG });
  const r = a.find((x) => x.type === ADVICE.REUSE_COMPONENT);
  assert.ok(r);
  assert.equal(r.suggestion.component, 'PanelFrame');
  assert.equal(r.suggestion.package, 'Common');
});

test('findRepeatedClusters: 只找同父级下 >= minCount 个同尺寸等距节点', () => {
  const layers = [
    layer({ id: 'L1', parent: 'G', bbox: { x: 0, y: 0, w: 50, h: 50 } }),
    layer({ id: 'L2', parent: 'G', bbox: { x: 60, y: 0, w: 50, h: 50 } }),
    layer({ id: 'L3', parent: 'H', bbox: { x: 0, y: 0, w: 50, h: 50 } }),
  ];
  const clusters = findRepeatedClusters(layers, layers, { minRepeatCount: 3, sizeTolerancePx: 2 });
  assert.equal(clusters.length, 0, '只有 2 个同父级节点，不足 minCount=3');
});

test('openQuestions: INFERRED 必须被逐条问出来', () => {
  const diffs = [
    { op: OP.INFERRED, slot: 'icon_3', node: 'L048', matchLevel: 'L4', confidence: 0.15,
      evidence: '', candidates: ['a.png'], defaultIfUnconfirmed: 'skip' },
  ];
  const qs = collectOpenQuestions({ diffs, advice: [], baseIr: { sliceNames: ['x'], warnings: [] }, targetIr: { sliceNames: ['x'], warnings: [] } });
  assert.ok(qs.length >= 1);
  assert.ok(qs.some((q) => q.includes('INFERRED')));
});

test('openQuestions: 无切片时要问 Q7', () => {
  const qs = collectOpenQuestions({
    diffs: [], advice: [],
    baseIr: { sliceNames: [], warnings: [] },
    targetIr: { sliceNames: [], warnings: [] },
  });
  assert.ok(qs.some((q) => q.includes('切片')), '应就切片缺失提问（PRD Q7）');
});

test('openQuestions: 合并组要单独提醒', () => {
  const qs = collectOpenQuestions({
    diffs: [],
    advice: [],
    baseIr: { sliceNames: ['a'], warnings: [{ code: 'MERGED_LAYER_GROUP', layer: 'L003', msg: 'x' }] },
    targetIr: { sliceNames: ['a'], warnings: [] },
  });
  assert.ok(qs.some((q) => q.includes('被合并的组')));
});

test('sameSize / samePos: 容差判定', () => {
  assert.equal(sameSize({ w: 100, h: 50 }, { w: 102, h: 48 }, 2), true);
  assert.equal(sameSize({ w: 100, h: 50 }, { w: 103, h: 50 }, 2), false);
  assert.equal(samePos({ x: 10, y: 10 }, { x: 12, y: 8 }, 4), true);
  assert.equal(samePos({ x: 10, y: 10 }, { x: 20, y: 10 }, 4), false);
});
