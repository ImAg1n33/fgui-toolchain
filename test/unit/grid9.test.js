'use strict';
/**
 * test/unit/grid9.test.js —— 九宫格适用性三档判定（R1-F3）
 *
 * ★ 验收标准：20 张合成切图（矩形/胶囊/圆形/放射各 5 张）的判定与人工预期一致 ★
 * ★ 取值哲学：不确定返 NEVER —— 误判 CAN_9GRID 的后果是线上事故 ★
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { computeGrid9, capsuleGrid, hasRequiredFeatures, VERDICT, DEFAULT_THRESHOLDS } = require('../../src/imaging/grid9');
const { createDecoder } = require('../../src/imaging/decoder');
const { extractFeatures } = require('../../src/imaging/features');
const { loadConfig } = require('../../src/core/config');

const ASSETS = path.resolve(__dirname, '../fixtures/golden/assets');
const { config } = loadConfig({ rootDir: path.resolve(__dirname, '../..') });

/** 形态 -> 期望判定。 */
const EXPECT = {
  panel: VERDICT.CAN_9GRID,
  capsule: VERDICT.SINGLE_AXIS_ONLY,
  circle: VERDICT.NEVER,
  radial: VERDICT.NEVER,
};

// ---------------------------------------------------------------------
// 纯函数层面：不依赖 fixture 的判据测试
// ---------------------------------------------------------------------
test('特征缺失 -> UNKNOWN -> NEVER（宁可少建议，不可给错建议）', () => {
  const r = computeGrid9({});
  assert.equal(r.verdict, VERDICT.NEVER);
  assert.ok(r.confidence <= 0.4, `置信度应 <= 0.4，实得 ${r.confidence}`);
  assert.ok(r.evidence.length >= 2);
  assert.ok(r.evidence.some((e) => e.includes('不确定')), 'evidence 应说明「不确定」');
  assert.equal(r.suggestedGrid, null);
});

test('NaN 特征也归 NEVER（不静默产出错误建议）', () => {
  const r = computeGrid9({
    w: 100, h: 50, aspectRatio: NaN, cornerFill: 0.9,
    radialSymmetry: 0.1, midRowVariance: 0.01, midColVariance: 0.01,
  });
  assert.equal(r.verdict, VERDICT.NEVER);
});

test('hasRequiredFeatures: 判别关键字段', () => {
  const ok = {
    w: 10, h: 10, aspectRatio: 1, radialSymmetry: 0.1, cornerFill: 0.9,
  };
  assert.equal(hasRequiredFeatures(ok), true);
  assert.equal(hasRequiredFeatures({ ...ok, cornerFill: undefined }), false);
  assert.equal(hasRequiredFeatures({ ...ok, w: 0 }), false);
});

test('放射纹理 -> NEVER', () => {
  const r = computeGrid9({
    w: 128, h: 128, aspectRatio: 1, cornerFill: 0.2,
    radialSymmetry: 0.95, midRowVariance: 0.9, midColVariance: 0.9,
  }, DEFAULT_THRESHOLDS);
  assert.equal(r.verdict, VERDICT.NEVER);
  assert.ok(r.evidence.join(' ').includes('放射'));
});

test('圆形 -> NEVER', () => {
  const r = computeGrid9({
    w: 64, h: 64, aspectRatio: 1, cornerFill: 0.15,
    radialSymmetry: 0.1, midRowVariance: 0.28, midColVariance: 0.28,
  }, DEFAULT_THRESHOLDS);
  assert.equal(r.verdict, VERDICT.NEVER);
  assert.ok(r.evidence.join(' ').includes('圆'));
});

test('胶囊 -> SINGLE_AXIS_ONLY 且给出 scale9grid 建议', () => {
  const r = computeGrid9({
    w: 200, h: 40, aspectRatio: 5, cornerFill: 0.22,
    radialSymmetry: 0.1, midRowVariance: 0.01, midColVariance: 0.17,
  }, DEFAULT_THRESHOLDS);
  assert.equal(r.verdict, VERDICT.SINGLE_AXIS_ONLY);
  // 上/下不留角：r,0,w-2r,h
  assert.equal(r.suggestedGrid, '20,0,160,40');
  assert.ok(r.evidence.join(' ').includes('单轴'));
});

test('常规面板 -> CAN_9GRID', () => {
  const r = computeGrid9({
    w: 480, h: 320, aspectRatio: 1.5, cornerFill: 0.95,
    radialSymmetry: 0.02, midRowVariance: 0.001, midColVariance: 0.002,
  }, DEFAULT_THRESHOLDS);
  assert.equal(r.verdict, VERDICT.CAN_9GRID);
  assert.equal(r.suggestedGrid, null, 'CAN_9GRID 不给建议值（用默认四角留角）');
  assert.ok(r.evidence.length >= 2);
});

test('落在阈值间空白区 -> NEVER（不猜）', () => {
  // cornerFill 处于 round 与 panel 之间，且不是长条 -> 空白区
  const r = computeGrid9({
    w: 100, h: 100, aspectRatio: 1, cornerFill: 0.5,
    radialSymmetry: 0.1, midRowVariance: 0.9, midColVariance: 0.9,
  }, DEFAULT_THRESHOLDS);
  assert.equal(r.verdict, VERDICT.NEVER);
  assert.ok(r.confidence <= 0.4);
  assert.ok(r.evidence.join(' ').includes('空白区'));
});

test('capsuleGrid: 建议值格式为 r,0,w-2r,h', () => {
  assert.equal(capsuleGrid(200, 40), '20,0,160,40');
  assert.equal(capsuleGrid(120, 36), '18,0,84,36');
  assert.equal(capsuleGrid(100, 100), '50,0,0,100');
});

test('阈值可外置覆盖（fgui.config.json grid9 段）', () => {
  const feats = {
    w: 200, h: 40, aspectRatio: 5, cornerFill: 0.22,
    radialSymmetry: 0.1, midRowVariance: 0.01, midColVariance: 0.17,
  };
  // 把长条门槛调到 99 -> 不再是长条 -> 落到空白区 -> NEVER
  assert.equal(
    computeGrid9(feats, { ...DEFAULT_THRESHOLDS, capsuleAspectMin: 99 }).verdict,
    VERDICT.NEVER,
  );
  // 收紧圆档门槛（cornerFillRoundMax 降到 0.1）-> 胶囊不再被当成圆形，
  // 但仍因长条命中胶囊档；反过来把长条门槛调高则会落空白区 -> NEVER。
  // 这两条合起来证明阈值是真正生效的，而非硬编码。
  assert.equal(
    computeGrid9(feats, { ...DEFAULT_THRESHOLDS, cornerFillRoundMax: 0.05 }).verdict,
    VERDICT.SINGLE_AXIS_ONLY,
    '收紧圆档不应改变胶囊判定',
  );
  assert.equal(
    computeGrid9(feats, { ...DEFAULT_THRESHOLDS, capsuleAspectMin: 99, cornerFillRoundMax: 0.05 }).verdict,
    VERDICT.NEVER,
  );
  // 把放射门槛调低 -> 同一张图被判 NEVER（阈值真的在起作用）
  assert.equal(
    computeGrid9(feats, { ...DEFAULT_THRESHOLDS, radialSymmetryMax: 0.05 }).verdict,
    VERDICT.NEVER,
    '放宽放射门槛应把图判为放射纹 -> NEVER',
  );
});

// ---------------------------------------------------------------------
// ★ 合成素材全量验证：25 张切图的判定与人工预期一致
// ---------------------------------------------------------------------
test('★ 25 张合成切图的九宫格判定与人工预期一致', async (t) => {
  if (!fs.existsSync(ASSETS)) {
    t.skip('合成切图未生成，先跑 `npm run fixtures`');
    return;
  }
  const dec = createDecoder();
  const files = fs.readdirSync(ASSETS).filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f)).sort();
  assert.ok(files.length >= 20, `应至少有 20 张合成切图，实得 ${files.length}`);

  const report = [];
  let mismatched = 0;
  for (const f of files) {
    const buf = fs.readFileSync(path.join(ASSETS, f));
    const feats = extractFeatures(await dec.decodeToRgba(buf));
    const verdict = computeGrid9(feats, config.grid9);

    // 前缀归类：panel_/capsule_/circle_/radial_/矩形/组1200 -> CAN_9GRID
    const key = Object.keys(EXPECT).find((k) => f.startsWith(k));
    let want = key ? EXPECT[key] : null;
    if (!want) {
      if (f.startsWith('矩形') || f.startsWith('组1200')) want = VERDICT.CAN_9GRID;
      else if (f.startsWith('图层') || f.startsWith('特效')) want = VERDICT.NEVER;
    }
    const ok = want === null ? null : verdict.verdict === want;
    report.push({
      file: f, want: want || '(未约定)', got: verdict.verdict,
      conf: verdict.confidence, ok: ok === null ? '-' : (ok ? '✔' : '�’✘'),
      aspect: feats.aspectRatio, cornerFill: feats.cornerFill, radial: feats.radialSymmetry,
      grid: verdict.suggestedGrid || '',
    });
    if (ok === false) mismatched++;
  }

  const detail = report.map((r) => `${r.ok === '✔' ? '✔' : '✘'} ${r.file.padEnd(18)} `
    + `期望=${String(r.want).padEnd(17)} 实得=${String(r.got).padEnd(17)} `
    + `conf=${r.conf} aspect=${r.aspect} cornerFill=${r.cornerFill} radial=${r.radial} `
    + `grid=${r.grid}`).join('\n');
  assert.equal(mismatched, 0, `九宫格判定与人工预期不符（${mismatched} 张）：\n${detail}`);
});

test('胶囊素材的 scale9grid 建议与短边一致', async (t) => {
  if (!fs.existsSync(ASSETS)) {
    t.skip('合成切图未生成');
    return;
  }
  const dec = createDecoder();
  const files = fs.readdirSync(ASSETS).filter((f) => f.startsWith('capsule_')).sort();
  assert.ok(files.length >= 5);
  for (const f of files) {
    const buf = fs.readFileSync(path.join(ASSETS, f));
    const feats = extractFeatures(await dec.decodeToRgba(buf));
    const v = computeGrid9(feats, config.grid9);
    assert.equal(v.verdict, VERDICT.SINGLE_AXIS_ONLY, `${f} 应为 SINGLE_AXIS_ONLY`);
    const parts = v.suggestedGrid.split(',').map(Number);
    assert.equal(parts.length, 4);
    assert.equal(parts[1], 0, '★ 上边必须为 0（胶囊垂直方向不切）');
    assert.equal(parts[0], Math.floor(Math.min(feats.w, feats.h) / 2), 'r 应为短边一半');
    assert.equal(parts[2], feats.w - 2 * parts[0], '中心宽 = w - 2r');
    assert.equal(parts[3], feats.h, '中心高 = 全高');
  }
});

test('禁切档（NEVER）不产出任何 scale9grid 建议', async (t) => {
  if (!fs.existsSync(ASSETS)) {
    t.skip('合成切图未生成');
    return;
  }
  const dec = createDecoder();
  for (const prefix of ['circle_', 'radial_']) {
    const files = fs.readdirSync(ASSETS).filter((f) => f.startsWith(prefix)).sort();
    for (const f of files) {
      const buf = fs.readFileSync(path.join(ASSETS, f));
      const feats = extractFeatures(await dec.decodeToRgba(buf));
      const v = computeGrid9(feats, config.grid9);
      assert.equal(v.verdict, VERDICT.NEVER, `${f} 应为 NEVER`);
      assert.equal(v.suggestedGrid, null, `★ ${f} 禁切档不应给出 scale9grid 建议`);
    }
  }
});
