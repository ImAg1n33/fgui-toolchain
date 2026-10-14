'use strict';
/**
 * test/unit/search.test.js —— 三通道检索（A1/A2/A3）
 *
 * ★ 本文件承载 K5 的端到端防御：切图索引里同时存在 `矩形1` 与 `矩形11`，
 *   检索 `矩形11` **绝不能**返回 `矩形1`（PRD K5 / ARCHITECTURE T02 验收①）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AssetStore } = require('../../src/assets/store');
const { channel1Name, sizeWithinTol, CH1_STATUS } = require('../../src/assets/channel1-name');
const { searchAssets, channel1Coverage, CERTAINTY } = require('../../src/assets/search');
const { channel2Shape } = require('../../src/assets/channel2-shape');
const { channel3Phash } = require('../../src/assets/channel3-phash');
const { buildIndex } = require('../../src/assets/indexer');
const { loadConfig } = require('../../src/core/config');
const { nullLogger } = require('../../src/core/logger');

const ASSETS = path.resolve(__dirname, '../fixtures/golden/assets');
const { config } = loadConfig({ rootDir: path.resolve(__dirname, '../..') });

/** 内存库（免磁盘）。 */
let store = null;
let indexed = false;

async function ensureStore() {
  if (store) return store;
  store = AssetStore.open({ dbPath: ':memory:', assetRoot: ASSETS });
  const res = await buildIndex({
    store, assetRoot: ASSETS, config, logger: nullLogger(),
    runId: 'test', withFeatures: true, incremental: false,
  });
  indexed = true;
  return store;
}

test('索引: 25 张合成切图全部入库', async (t) => {
  if (!fs.existsSync(ASSETS)) {
    t.skip('合成切图未生成，先跑 `npm run fixtures`');
    return;
  }
  const s = await ensureStore();
  assert.ok(s.count() >= 20, `应索引至少 20 张，实得 ${s.count()}`);
  const rows = s.all();
  assert.ok(rows.length >= 20);
  // 全部应带特征
  for (const r of rows) {
    assert.ok(r.features && r.features.phash, `${r.relPath} 应有 pHash`);
    assert.ok(r.grid9, `${r.relPath} 应有九宫格判定`);
  }
});

// ======================================================================
// ★★★ K5：矩形1 vs 矩形11 ★★★
// ======================================================================
test('★ K5: byNormName 返回数组且 矩形1 / 矩形11 各自只命中自己', async (t) => {
  if (!fs.existsSync(ASSETS)) {
    t.skip('合成切图未生成');
    return;
  }
  const s = await ensureStore();
  const a = s.byNormName('矩形1');
  const b = s.byNormName('矩形11');
  assert.ok(Array.isArray(a), '★ byNormName 返回类型必须是数组（强制调用方处理歧义）');
  assert.ok(Array.isArray(b));
  assert.ok(a.length >= 1, '应有 矩形1');
  assert.ok(b.length >= 1, '应有 矩形11');
  for (const r of a) assert.equal(r.normName, '矩形1', '★ 矩形1 的候选里不得混入 矩形11');
  for (const r of b) assert.equal(r.normName, '矩形11', '★ 矩形11 的候选里不得混入 矩形1');
});

test('★ K5: 检索 矩形11 绝不返回 矩形1', async (t) => {
  if (!fs.existsSync(ASSETS)) {
    t.skip('合成切图未生成');
    return;
  }
  const s = await ensureStore();
  const b = s.byNormName('矩形11')[0];
  const res = searchAssets({
    index: s, queryName: '矩形11', layerBox: { w: b.w, h: b.h },
    topK: 10, config: config.search,
  });
  assert.ok(res.hits.length >= 1);
  assert.equal(res.hits[0].asset.normName, '矩形11');
  assert.equal(res.hits[0].certainty, CERTAINTY.EXACT_NAME);
  for (const h of res.hits) {
    assert.notEqual(h.asset.normName, '矩形1',
      `★ 检索 矩形11 的结果里出现了 矩形1（${h.asset.relPath}）—— K5 事故`);
  }
});

test('★ K5: 检索 矩形1 也不得返回 矩形11', async (t) => {
  if (!fs.existsSync(ASSETS)) {
    t.skip('合成切图未生成');
    return;
  }
  const s = await ensureStore();
  const a = s.byNormName('矩形1')[0];
  const res = searchAssets({
    index: s, queryName: '矩形1', layerBox: { w: a.w, h: a.h }, topK: 10, config: config.search,
  });
  assert.ok(res.hits.length >= 1);
  for (const h of res.hits) {
    assert.notEqual(h.asset.normName, '矩形11', '★ 反向也不得误配');
  }
});

// ======================================================================
// Ch-1 语义
// ======================================================================
test('Ch-1: 归一化全等 + 尺寸吻合 -> HIT 且 confidence=1', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const s = await ensureStore();
  const target = s.byNormName('图层249')[0];
  const r = channel1Name({ index: s, queryName: '图层249(1)', layerBox: { w: target.w, h: target.h } });
  assert.equal(r.status, CH1_STATUS.HIT);
  assert.equal(r.ch1, 1);
  assert.equal(r.confidence, 1);
  assert.ok(r.evidence.includes('尺寸校验通过'));
});

test('Ch-1: 归一化全等 + 尺寸不符 -> NO_SIZE_MATCH（落 Ch-2）', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const s = await ensureStore();
  const target = s.byNormName('图层249')[0];
  const r = channel1Name({
    index: s, queryName: '图层249(1)', layerBox: { w: target.w + 50, h: target.h + 50 },
  });
  assert.equal(r.status, CH1_STATUS.NO_SIZE_MATCH);
  assert.equal(r.candidates.length, 0);
  assert.ok(r.evidence.includes('尺寸校验失败'));
});

test('Ch-1: 归一名不存在 -> NO_NAME_MATCH', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const s = await ensureStore();
  const r = channel1Name({ index: s, queryName: '根本不存在的名字', layerBox: { w: 100, h: 100 } });
  assert.equal(r.status, CH1_STATUS.NO_NAME_MATCH);
  assert.ok(r.evidence.includes('未命中'));
});

test('★ Ch-1 歧义: 归一化后同名多图且尺寸都符 -> AMBIGUOUS 并全部返回', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const s = await ensureStore();
  // 人工构造歧义：插入一条与 `矩形1` 同尺寸、归一名也相同的行
  const orig = s.byNormName('矩形1')[0];
  s.upsert({
    ...orig,
    id: 'ffffffffffffffff',
    relPath: '矩形1_dup.png',
    contentSha256: 'dup',
  });
  const r = channel1Name({ index: s, queryName: '矩形1', layerBox: { w: orig.w, h: orig.h } });
  assert.equal(r.status, CH1_STATUS.AMBIGUOUS, '★ 同名同尺寸应判 AMBIGUOUS');
  assert.ok(r.candidates.length >= 2, '★ 必须全部返回，不能只给一个');
  assert.equal(r.ambiguous, true);
  assert.ok(r.confidence <= 0.6, '歧义时置信度应被压低');
  assert.ok(r.evidence.includes('AMBIGUOUS'));
  assert.ok(r.evidence.includes('不做静默选择'), 'evidence 必须写明不会静默取第一个');
  // 清理
  s.db.prepare('DELETE FROM asset WHERE id=?').run('ffffffffffffffff');
});

test('Ch-1: 无图层尺寸可校验时同名即视为歧义（不能盲选）', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const s = await ensureStore();
  const r = channel1Name({ index: s, queryName: '矩形1', layerBox: null });
  assert.equal(r.status, CH1_STATUS.AMBIGUOUS);
  assert.ok(r.evidence.includes('无法做'));
});

test('sizeWithinTol: ±2px', () => {
  assert.equal(sizeWithinTol({ w: 100, h: 50 }, { w: 100, h: 50 }, 2), true);
  assert.equal(sizeWithinTol({ w: 100, h: 50 }, { w: 102, h: 52 }, 2), true);
  assert.equal(sizeWithinTol({ w: 100, h: 50 }, { w: 103, h: 50 }, 2), false);
});

// ======================================================================
// Ch-2 / Ch-3
// ======================================================================
test('Ch-2: 尺寸硬过滤 + IoU 打分', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const s = await ensureStore();
  const target = s.byNormName('矩形11')[0];
  const r = channel2Shape({ index: s, layerBox: { w: target.w, h: target.h }, tol: 2 });
  assert.ok(r.candidates.length >= 1);
  assert.ok(r.ch2ById.size >= 1);
  for (const c of r.candidates) {
    assert.ok(c.ch2 >= 0 && c.ch2 <= 1);
  }
  // 确定性排序
  for (let i = 1; i < r.candidates.length; i++) {
    assert.ok(r.candidates[i - 1].ch2 >= r.candidates[i].ch2, '应按分值降序');
  }
});

test('Ch-2: 无尺寸可查时返回空并说明原因', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const s = await ensureStore();
  const r = channel2Shape({ index: s, layerBox: null });
  assert.equal(r.candidates.length, 0);
  assert.ok(r.evidence.includes('跳过'));
});

test('Ch-3: 无 pHash 时跳过并说明', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const s = await ensureStore();
  const r = channel3Phash({ index: s, phash: null });
  assert.equal(r.candidates.length, 0);
  assert.ok(r.evidence.includes('跳过'));
});

test('Ch-3: 同图自匹配汉明距离为 0（分值接近满分）', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const s = await ensureStore();
  const target = s.byNormName('矩形11')[0];
  const f = target.features;
  const r = channel3Phash({
    index: s,
    phash: f.phash,
    dominant: { r: f.dominantR, g: f.dominantG, b: f.dominantB },
    aspectRatio: f.aspectRatio,
    maxDistance: 12,
    aspectTolerance: 0.05,
  });
  assert.ok(r.candidates.length >= 1);
  const self = r.candidates.find((c) => c.asset.id === target.id);
  assert.ok(self, '自己应能被检索到');
  assert.equal(self.hamming, 0);
  assert.ok(self.ch3 > 0.9, `自匹配分应很高，实得 ${self.ch3}`);
});

// ======================================================================
// 综合检索：确定性标注是硬要求（PRD 检索三通道）
// ======================================================================
test('综合: Ch-1 命中短路置顶，不执行 Ch-2/Ch-3', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const s = await ensureStore();
  const target = s.byNormName('图层249')[0];
  const res = searchAssets({
    index: s, queryName: '图层249(1)', layerBox: { w: target.w, h: target.h },
    phash: target.features.phash, topK: 5, config: config.search,
  });
  assert.equal(res.hits.length, 1, '★ Ch-1 命中应只返回 1 条（短路）');
  assert.equal(res.hits[0].score, 1);
  assert.equal(res.hits[0].level, 'L1');
  assert.equal(res.certainty, CERTAINTY.EXACT_NAME);
  assert.equal(res.needsConfirm, false, '同名确定不需要人工确认');
  assert.equal(res.channels.ch2, null, '短路时 Ch-2 不应被执行');
  assert.ok(res.hits[0].evidence.includes('短路'));
});

test('综合: Ch-1 未命中时标为 guess 并要求人工确认', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const s = await ensureStore();
  const target = s.byNormName('矩形11')[0];
  const res = searchAssets({
    index: s,
    queryName: '一个不存在的图层名',
    layerBox: { w: target.w, h: target.h },
    phash: target.features.phash,
    topK: 5,
    config: config.search,
  });
  assert.equal(res.needsConfirm, true, '★ 猜的必须进人工确认队列');
  if (res.hits.length) {
    assert.equal(res.hits[0].certainty, CERTAINTY.GUESS);
    assert.equal(res.hits[0].needsConfirm, true);
    assert.ok(res.hits[0].evidence.includes('推测结果'));
  }
});

test('综合: 排序确定性（分数降序 -> assetId 升序）', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const s = await ensureStore();
  const target = s.byNormName('矩形11')[0];
  const args = {
    index: s, queryName: '不存在的名字XYZ',
    layerBox: { w: target.w, h: target.h },
    phash: target.features.phash, topK: 10, config: config.search,
  };
  const r1 = searchAssets(args);
  const r2 = searchAssets(args);
  assert.deepEqual(r1.hits.map((h) => h.asset.id), r2.hits.map((h) => h.asset.id),
    '★ 同输入两次结果集必须一致');
  for (let i = 1; i < r1.hits.length; i++) {
    const prev = r1.hits[i - 1];
    const cur = r1.hits[i];
    assert.ok(prev.score > cur.score
      || (prev.score === cur.score && prev.asset.id <= cur.asset.id),
    '排序规则应为 分数降序 -> id 升序');
  }
});

test('综合: 加权公式 score = 0.5·Ch1 + 0.3·Ch2 + 0.2·Ch3', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const s = await ensureStore();
  const target = s.byNormName('矩形11')[0];
  const res = searchAssets({
    index: s, queryName: '不存在的名字XYZ',
    layerBox: { w: target.w, h: target.h },
    phash: target.features.phash, topK: 10, config: config.search,
  });
  const w = config.search.weights;
  for (const h of res.hits) {
    const expected = Number((w.ch1 * h.ch1 + w.ch2 * h.ch2 + w.ch3 * h.ch3).toFixed(6));
    assert.equal(h.score, expected, `${h.asset.relPath} 的加权分不符`);
  }
});

test('merged 组内的检索置信度被封顶 0.5', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const s = await ensureStore();
  const target = s.byNormName('图层249')[0];
  const res = searchAssets({
    index: s, queryName: '图层249(1)', layerBox: { w: target.w, h: target.h },
    topK: 5, config: config.search, layerMerged: true, mergedConfidenceCap: 0.5,
  });
  assert.equal(res.hits.length, 1);
  assert.ok(res.hits[0].confidence <= 0.5,
    `★ merged 组内置信度应 <= 0.5，实得 ${res.hits[0].confidence}`);
  assert.ok(res.hits[0].evidence.includes('封顶'));
});

test('channel1Coverage: 统计 Ch-1 覆盖率（A2 指标）', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const s = await ensureStore();
  const results = [];
  for (const name of ['图层249', '矩形1', '矩形11', '完全不存在的名字']) {
    const rows = s.byNormName(name);
    const box = rows.length ? { w: rows[0].w, h: rows[0].h } : { w: 100, h: 100 };
    results.push(searchAssets({
      index: s, queryName: name, layerBox: box, topK: 5, config: config.search,
    }));
  }
  const cov = channel1Coverage(results);
  assert.equal(cov.total, 4);
  assert.equal(cov.exactName, 3);
  assert.equal(cov.coverage, 0.75);
});

test('A3 粗测: Top-10 查询延迟（本机 25 张，应远低于 200ms）', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const s = await ensureStore();
  const target = s.byNormName('矩形11')[0];
  const args = {
    index: s, queryName: '不存在的名字XYZ',
    layerBox: { w: target.w, h: target.h },
    phash: target.features.phash, topK: 10, config: config.search,
  };
  searchAssets(args); // 预热
  const t0 = process.hrtime.bigint();
  const N = 20;
  for (let i = 0; i < N; i++) searchAssets(args);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  assert.ok(ms < 200, `单次查询 ${ms.toFixed(2)}ms 应 < 200ms`);
});

test('Store: byNormName 空串返回空数组（不查库）', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const s = await ensureStore();
  assert.deepEqual(s.byNormName(''), []);
  assert.deepEqual(s.byNormName(null), []);
});

test('Store: upsert 同 id 幂等（不产生重复行）', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const s = await ensureStore();
  const before = s.count();
  const row = s.byNormName('矩形11')[0];
  s.upsert(row);
  s.upsert(row);
  assert.equal(s.count(), before, '重复 upsert 不应增加行数');
});
