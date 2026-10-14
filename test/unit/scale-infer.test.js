'use strict';
/**
 * test/unit/scale-infer.test.js —— E-02 倍率推断（回应 L6 / Q22）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 本文件的期望值全部为**手算**，不 import src/ 的参考实现 ★
 *   （P0 BUG#1 的教训：自己造数据自己验证会漏「实现与期望同错」）
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 覆盖：
 *   ① 1x / 2x / 3x 倍率推断正确（含边界）
 *   ② 非整数比（150 vs 96 = 1.5625）不硬凑倍率
 *   ③ 混合场景（同名 1x + 2x）-> AMBIGUOUS，全部返回，各标倍率，不静默选取
 *   ④ 回归保护：1x 场景下容差行为与改造前**完全一致**（±2px，不放松）
 *   ⑤ K5 兜底不弱化：矩形1 / 矩形11 仍只命中自己
 *   ⑥ 默认关闭（fgui.config.json 的 asset.scaleInfer.enabled === false）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { AssetStore } = require('../../src/assets/store');
const { channel1Name, CH1_STATUS } = require('../../src/assets/channel1-name');
const { searchAssets, CERTAINTY } = require('../../src/assets/search');
const { inferScale, DEFAULT_SCALE_INFER } = require('../../src/assets/scale-infer');
const { loadConfig } = require('../../src/core/config');

const ROOT = path.resolve(__dirname, '../..');
const { config } = loadConfig({ rootDir: ROOT });

/** 倍率推断配置（测试用：开启）。 */
const SCALE_ON = { enabled: true, maxScale: 4 };

/** 造一条最小可用的素材行（特征/九宫格不需要，Ch-1 只用 w/h/normName）。 */
function makeRow(overrides) {
  return {
    id: 'aaaaaaaaaaaaaaaa',
    relPath: 'a.png',
    baseName: 'a',
    normName: 'a',
    format: 'png',
    w: 10,
    h: 10,
    fileSize: 100,
    mtimeMs: 0,
    contentSha256: 'a',
    features: null,
    grid9: null,
    suggestedName: '',
    firstSeenRun: 'test',
    lastSeenRun: 'test',
    ...overrides,
  };
}

/** 建内存库并插入给定行。 */
function storeWith(rows) {
  const s = AssetStore.open({ dbPath: ':memory:', assetRoot: '' });
  for (const r of rows) s.upsert(r);
  return s;
}

// ======================================================================
// ① inferScale 纯函数（期望值手算）
// ======================================================================

test('inferScale: 1x 精确命中', () => {
  const r = inferScale({ w: 96, h: 96 }, { w: 96, h: 96 });
  assert.equal(r.matched, true);
  assert.equal(r.scale, 1);
  assert.equal(r.reason, 'OK');
});

test('inferScale: 1x 容差边界（±2 内过、±3 拒）', () => {
  // 98x97：偏差 1+1=2 <= 2 -> 1x
  assert.equal(inferScale({ w: 96, h: 96 }, { w: 98, h: 97 }).scale, 1);
  // 99x96：宽偏 3 > 2 -> 不匹配
  const r = inferScale({ w: 96, h: 96 }, { w: 99, h: 96 });
  assert.equal(r.matched, false);
  assert.equal(r.reason, 'NO_INTEGER_SCALE');
});

test('inferScale: 2x 命中且容差按倍率缩放（±4）', () => {
  // 192x192 = 96x96 × 2，偏差 0
  let r = inferScale({ w: 96, h: 96 }, { w: 192, h: 192 });
  assert.equal(r.matched, true);
  assert.equal(r.scale, 2);
  // 190x193：偏差 2+1=3 <= 2*2=4 -> 2x
  r = inferScale({ w: 96, h: 96 }, { w: 190, h: 193 });
  assert.equal(r.matched, true);
  assert.equal(r.scale, 2);
  // 187x192：宽偏 5 > 4 -> 不匹配（不硬凑）
  r = inferScale({ w: 96, h: 96 }, { w: 187, h: 192 });
  assert.equal(r.matched, false);
  assert.equal(r.reason, 'NO_INTEGER_SCALE');
});

test('inferScale: 3x 命中且容差 ±6', () => {
  // 288x288 = 96x96 × 3
  let r = inferScale({ w: 96, h: 96 }, { w: 288, h: 288 });
  assert.equal(r.matched, true);
  assert.equal(r.scale, 3);
  // 285x289：偏差 3+1=4 <= 6 -> 3x
  r = inferScale({ w: 96, h: 96 }, { w: 285, h: 289 });
  assert.equal(r.scale, 3);
  // 281x288：宽偏 7 > 6 -> 不匹配
  r = inferScale({ w: 96, h: 96 }, { w: 281, h: 288 });
  assert.equal(r.matched, false);
});

test('inferScale: 非整数倍（150 vs 96 = 1.5625）不硬凑', () => {
  const r = inferScale({ w: 96, h: 96 }, { w: 150, h: 150 });
  assert.equal(r.matched, false);
  assert.equal(r.reason, 'NO_INTEGER_SCALE');
  assert.equal(r.scale, null);
  // 比值仍如实返回，供 evidence 展示
  assert.equal(r.ratioW, 1.5625);
  assert.equal(r.ratioH, 1.5625);
});

test('inferScale: 非方形图按宽高分别推断（96x48 图层 -> 192x96 图 = 2x）', () => {
  const r = inferScale({ w: 96, h: 48 }, { w: 192, h: 96 });
  assert.equal(r.matched, true);
  assert.equal(r.scale, 2);
  // 192x100：高偏 4 > 2*2=4? 4 <= 4 边界内 -> 仍 2x
  assert.equal(inferScale({ w: 96, h: 48 }, { w: 192, h: 100 }).scale, 2);
  // 192x101：高偏 5 > 4 -> 不匹配
  assert.equal(inferScale({ w: 96, h: 48 }, { w: 192, h: 101 }).matched, false);
});

test('inferScale: maxScale 封顶（5x 超出 maxScale=4 不匹配，放开才匹配）', () => {
  assert.equal(inferScale({ w: 96, h: 96 }, { w: 480, h: 480 }, { maxScale: 4 }).matched, false);
  assert.equal(inferScale({ w: 96, h: 96 }, { w: 480, h: 480 }, { maxScale: 5 }).scale, 5);
});

test('inferScale: 非法入参返回 INVALID_INPUT（不静默当成不匹配）', () => {
  for (const [box, img] of [
    [null, { w: 10, h: 10 }],
    [{ w: 0, h: 10 }, { w: 10, h: 10 }],
    [{ w: 96, h: 96 }, { w: Number.NaN, h: 96 }],
    [{ w: 96, h: 96 }, { w: -192, h: -192 }],
  ]) {
    const r = inferScale(box, img);
    assert.equal(r.matched, false);
    assert.equal(r.reason, 'INVALID_INPUT');
    assert.equal(r.scale, null);
  }
});

test('inferScale: 多倍率同时落在容差内时取偏差最小（极小图退化场景）', () => {
  // bbox 2x2, tol 2：k=1 偏差 2+2=4（图 4x4 时 |4-2|=2<=2）；k=2 偏差 0
  // -> 取偏差最小的 2x
  assert.equal(inferScale({ w: 2, h: 2 }, { w: 4, h: 4 }).scale, 2);
  // 真正并列（图 3x3：k=1 偏差 2、k=2 偏差 2）-> 保守取小倍率 1x
  assert.equal(inferScale({ w: 2, h: 2 }, { w: 3, h: 3 }).scale, 1);
});

// ======================================================================
// ② Ch-1 集成：混合 1x/2x 场景
// ======================================================================

test('★ Ch-1 混合场景: 同名 1x + 2x 同时通过 -> AMBIGUOUS 全部返回且各标倍率', () => {
  const s = storeWith([
    makeRow({ id: 'a'.repeat(16), relPath: 'icon.png', baseName: 'icon', normName: 'icon', w: 96, h: 96 }),
    makeRow({ id: 'b'.repeat(16), relPath: 'icon@2x.png', baseName: 'icon@2x', normName: 'icon', w: 192, h: 192 }),
  ]);
  const r = channel1Name({
    index: s, queryName: 'icon', layerBox: { w: 96, h: 96 }, scaleInfer: SCALE_ON,
  });
  assert.equal(r.status, CH1_STATUS.AMBIGUOUS, '★ 1x/2x 同时通过必须判歧义');
  assert.equal(r.candidates.length, 2, '★ 必须全部返回，不能只给一个');
  assert.equal(r.ambiguous, true);
  // 两张候选都必须带正确倍率
  const byPath = new Map(r.candidates.map((c) => [c.relPath, c]));
  assert.equal(byPath.get('icon.png').scale, 1, '96x96 应标 1x');
  assert.equal(byPath.get('icon@2x.png').scale, 2, '192x192 应标 2x');
  // evidence 必须写明不静默选择 + 倍率信息
  assert.ok(r.evidence.includes('不做静默选择'));
  assert.ok(r.evidence.includes('1x/2x'), 'evidence 应说明可能含倍图混用');
  assert.ok(r.evidence.includes('2x'));
  s.close();
});

test('★ Ch-1 混合场景: 零误匹配证明 —— 2x 候选不得冒充 1x，反之亦然', () => {
  const s = storeWith([
    makeRow({ id: 'a'.repeat(16), relPath: 'icon.png', normName: 'icon', w: 96, h: 96 }),
    makeRow({ id: 'b'.repeat(16), relPath: 'icon@2x.png', normName: 'icon', w: 192, h: 192 }),
    makeRow({ id: 'c'.repeat(16), relPath: 'other.png', normName: 'other', w: 192, h: 192 }),
  ]);
  // 查 icon：other（虽 192x192）不得出现（归一化名全等是第一道闸）
  const r = channel1Name({
    index: s, queryName: 'icon', layerBox: { w: 96, h: 96 }, scaleInfer: SCALE_ON,
  });
  for (const c of r.candidates) {
    assert.equal(c.normName, 'icon', `候选中混入了其它归一名：${c.relPath}`);
  }
  // 查 other（192x192 图层 bbox）：icon(96x96) 不得通过（96 不对应 192 的整数倍附近）
  const r2 = channel1Name({
    index: s, queryName: 'other', layerBox: { w: 192, h: 192 }, scaleInfer: SCALE_ON,
  });
  assert.equal(r2.status, CH1_STATUS.HIT);
  assert.equal(r2.candidates[0].relPath, 'other.png');
  assert.equal(r2.candidates[0].scale, 1);
  s.close();
});

test('★ 回归保护: 1x 场景下开启倍率推断与关闭时行为完全一致', () => {
  // 同一库、同一图层 bbox，scaleInfer 开/关两种判定必须逐字段一致（1x 路径）
  const rows = [
    makeRow({ id: 'a'.repeat(16), relPath: 'icon.png', normName: 'icon', w: 96, h: 96 }),
    makeRow({ id: 'b'.repeat(16), relPath: 'icon_dup.png', normName: 'icon', w: 98, h: 97 }),
  ];
  const box = { w: 96, h: 96 };
  const off = channel1Name({ index: storeWith(rows), queryName: 'icon', layerBox: box });
  const on = channel1Name({ index: storeWith(rows), queryName: 'icon', layerBox: box, scaleInfer: SCALE_ON });
  assert.equal(off.status, CH1_STATUS.AMBIGUOUS);
  assert.equal(on.status, off.status, '1x 路径状态必须一致');
  assert.equal(on.candidates.length, off.candidates.length);
  assert.equal(on.confidence, off.confidence);
  assert.equal(on.ch1, off.ch1);
  // 唯一允许的差异：开启时多一个 scale 字段（值为 1）
  assert.deepEqual(on.candidates.map((c) => c.scale), [1, 1]);
});

test('★ 回归保护: ±2px 边界不因倍率推断放松（103 vs 100 仍拒）', () => {
  const s = storeWith([
    makeRow({ id: 'a'.repeat(16), relPath: 'r1.png', normName: 'r1', w: 100, h: 50 }),
  ]);
  // 102x52 在 ±2 内 -> HIT（开关无关）
  for (const scaleInfer of [null, SCALE_ON]) {
    const ok = channel1Name({
      index: s, queryName: 'r1', layerBox: { w: 102, h: 52 }, scaleInfer,
    });
    assert.equal(ok.status, CH1_STATUS.HIT, `102x52 应命中（scaleInfer=${!!scaleInfer}）`);
    // 103x50 超 1px -> 必须 NO_SIZE_MATCH（★ 不放松 1x 精度）
    const far = channel1Name({
      index: s, queryName: 'r1', layerBox: { w: 103, h: 50 }, scaleInfer,
    });
    assert.equal(far.status, CH1_STATUS.NO_SIZE_MATCH,
      `★ 103 vs 100 必须拒（scaleInfer=${!!scaleInfer}）—— 倍率推断不得放松 1x 校验`);
  }
  s.close();
});

test('★ 回归保护: 默认关闭时 2x 图被判不匹配（改造前行为原样保留）', () => {
  const s = storeWith([
    makeRow({ id: 'a'.repeat(16), relPath: 'icon.png', normName: 'icon', w: 96, h: 96 }),
    makeRow({ id: 'b'.repeat(16), relPath: 'icon@2x.png', normName: 'icon', w: 192, h: 192 }),
  ]);
  // 关闭：192x192 通不过 ±2px -> 唯一命中 96x96（2x 被排除，这是 L6 记录的旧行为）
  const r = channel1Name({ index: s, queryName: 'icon', layerBox: { w: 96, h: 96 } });
  assert.equal(r.status, CH1_STATUS.HIT);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].relPath, 'icon.png');
  assert.equal(r.candidates[0].scale, undefined, '关闭时不得附加 scale 字段');
  // 只有 2x 图的库 + 1x 图层 bbox：关闭 -> NO_SIZE_MATCH（L6 旧行为）；
  // 开启 -> 命中且标 2x（E-02 的修复点）
  const s2 = storeWith([
    makeRow({ id: 'b'.repeat(16), relPath: 'icon@2x.png', normName: 'icon', w: 192, h: 192 }),
  ]);
  assert.equal(
    channel1Name({ index: s2, queryName: 'icon', layerBox: { w: 96, h: 96 } }).status,
    CH1_STATUS.NO_SIZE_MATCH,
    '★ 关闭时 2x 图必须匹配不到（改造前行为）',
  );
  const on = channel1Name({
    index: s2, queryName: 'icon', layerBox: { w: 96, h: 96 }, scaleInfer: SCALE_ON,
  });
  assert.equal(on.status, CH1_STATUS.HIT, '开启后 2x 图应能匹配');
  assert.equal(on.candidates[0].scale, 2);
  s.close();
  s2.close();
});

test('★ K5 兜底不弱化: 矩形1 / 矩形11 开启倍率推断后仍只命中自己', () => {
  const s = storeWith([
    makeRow({ id: 'a'.repeat(16), relPath: '矩形1.png', baseName: '矩形1', normName: '矩形1', w: 100, h: 50 }),
    makeRow({ id: 'b'.repeat(16), relPath: '矩形11.png', baseName: '矩形11', normName: '矩形11', w: 180, h: 90 }),
  ]);
  for (const scaleInfer of [null, SCALE_ON]) {
    const r1 = channel1Name({ index: s, queryName: '矩形1', layerBox: { w: 100, h: 50 }, scaleInfer });
    assert.equal(r1.status, CH1_STATUS.HIT);
    assert.equal(r1.candidates[0].normName, '矩形1');
    const r11 = channel1Name({ index: s, queryName: '矩形11', layerBox: { w: 180, h: 90 }, scaleInfer });
    assert.equal(r11.status, CH1_STATUS.HIT);
    assert.equal(r11.candidates[0].normName, '矩形11');
  }
  s.close();
});

// ======================================================================
// ③ searchAssets 集成
// ======================================================================

test('★ searchAssets 混合场景: AMBIGUOUS 全部返回、各标倍率、必须人工确认', () => {
  const s = storeWith([
    makeRow({ id: 'a'.repeat(16), relPath: 'icon.png', normName: 'icon', w: 96, h: 96 }),
    makeRow({ id: 'b'.repeat(16), relPath: 'icon@2x.png', normName: 'icon', w: 192, h: 192 }),
  ]);
  const res = searchAssets({
    index: s, queryName: 'icon', layerBox: { w: 96, h: 96 },
    scaleInfer: SCALE_ON, config: config.search,
  });
  assert.equal(res.certainty, CERTAINTY.AMBIGUOUS);
  assert.equal(res.needsConfirm, true, '★ 歧义必须进人工确认队列');
  assert.equal(res.hits.length, 2, '★ 不得静默选取，必须两个都返回');
  const byPath = new Map(res.hits.map((h) => [h.asset.relPath, h]));
  assert.equal(byPath.get('icon.png').scale, 1);
  assert.equal(byPath.get('icon@2x.png').scale, 2);
  for (const h of res.hits) {
    assert.equal(h.certainty, CERTAINTY.AMBIGUOUS);
    assert.equal(h.needsConfirm, true);
    assert.equal(h.confirmed, false);
  }
  s.close();
});

test('searchAssets: 默认不传 scaleInfer 时 2x 候选被排除（改造前行为）', () => {
  const s = storeWith([
    makeRow({ id: 'a'.repeat(16), relPath: 'icon.png', normName: 'icon', w: 96, h: 96 }),
    makeRow({ id: 'b'.repeat(16), relPath: 'icon@2x.png', normName: 'icon', w: 192, h: 192 }),
  ]);
  const res = searchAssets({
    index: s, queryName: 'icon', layerBox: { w: 96, h: 96 }, config: config.search,
  });
  assert.equal(res.certainty, CERTAINTY.EXACT_NAME);
  assert.equal(res.hits.length, 1);
  assert.equal(res.hits[0].asset.relPath, 'icon.png');
  assert.equal(res.hits[0].scale, undefined, '默认关闭时 hit 不带 scale 字段（输出与改造前一致）');
  s.close();
});

// ======================================================================
// ④ 默认配置
// ======================================================================

test('默认配置: asset.scaleInfer.enabled === false（Q22 未答，默认不改变行为）', () => {
  assert.equal(config.asset.scaleInfer.enabled, false);
  assert.equal(config.asset.scaleInfer.maxScale, DEFAULT_SCALE_INFER.maxScale);
  // 仓库里的配置文件同样默认关闭（与内置默认一致）
  const fs = require('fs');
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'fgui.config.json'), 'utf8'));
  assert.equal(raw.asset.scaleInfer.enabled, false,
    '★ fgui.config.json 的 scaleInfer 必须默认关闭');
});
