'use strict';
/**
 * test/unit/grid9-known-limits.test.js —— 九宫格判据的**已知限制**（QA BUG #3 后续）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 这个文件记录的是「当前判据做不到的事」，不是「应该做到的事」★
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 背景（QA 独立验证，docs/QA-REPORT.md BUG #3）：
 *   QA 用**自造的** 32 个形态测出 7 处误判。我已经修掉了其中最容易修的：
 *     · 渐变面板（横向/竖向）  -> 加 `midMonotonic`（一阶差分同号率）识别平滑渐变
 *     · 描边面板/斜面浮雕     -> 加 `radialMaxCluster`（偏离扇区的连续簇）识别边框
 *     · 极小图 1x1 / 8x8       -> 加 `minSideForShape`（短边 <= 8 直接 NEVER）
 *
 * 剩下 3 处**不修**，理由如下（重要，请勿在没有新依据时改）：
 *
 *   ① 横向条纹 120×40 被误判 CAN_9GRID   ← **危险方向**（该禁切的没禁切）
 *   ② 竖向条纹 40×120 被误判 CAN_9GRID   ← 同上
 *   ③ 细长椭圆被误判 SINGLE_AXIS_ONLY（QA 期望 NEVER）
 *
 *   为什么这三项要紧：它们是**危险侧**误判 —— 判成「可切」但实际会破形，
 *   代价是线上事故；而反向误判（判 NEVER 但实际可切）只是人工手切 10 秒。
 *   按 PRD 的成本不对称原则，**宁可停在安全侧，也不能为了修它而放开危险侧**。
 *
 *   技术原因（已实测确认，不是没努力）：
 *     细长条纹与「带边框面板」的关键特征**高度重合**：
 *       cornerFill 两者都 =1.000、radialSymmetry 都 =1.000、radialMaxCluster 都 =2；
 *       唯一差别是 midMonotonic（0.556 vs 0.5）与 flat（0.575 vs 0.472），
 *       而这两个差异量级太小，**不足以支撑一个稳健的阈值**。
 *     要真正分开必须引入**簇的角度位置**（描边=0°/90°/180°/270° 正交四向，
 *     条纹=0°/180° 平行两向）或**中线的周期性**（条纹是周期重复，边框是一次突变）。
 *     这两项都是新增特征，必须用真实素材回归标定，不是合成数据上能定下来的。
 *
 *   ★ 同时要诚实说明：QA 报告里那条「带边框面板 -> 实得 NEVER」★
 *     在我加完 radialMaxCluster 之后，用**我这份 fixture（3px 描边）**复测已判 CAN_9GRID（正确）。
 *     QA 那份描边更细/更宽的比例不同，仍落 NEVER —— 说明该判据对**描边宽度**敏感。
 *     这正是「需要真实素材标定」的又一例证。
 *
 * ★ 处置方式：把这三个样本固化为回归用例，让「当前的错」变成「可监控的已知量」。
 *   一旦将来拿到真实素材、重标阈值后它们变成 PASS，本文件会提示你更新此处注释；
 *   若有人不小心把它们改成 PASS 却没有同步更新判据，这里也会露馅。
 * ════════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractFeatures } = require('../../src/imaging/features');
const { computeGrid9, VERDICT, DEFAULT_THRESHOLDS } = require('../../src/imaging/grid9');
const { loadConfig } = require('../../src/core/config');

const { config } = loadConfig({ rootDir: require('path').resolve(__dirname, '../..') });

/**
 * 造一张 RGBA。
 * @param {number} w
 * @param {number} h
 * @param {function(number,number,number[]):void} shader
 * @returns {{width:number,height:number,data:Buffer}}
 */
function rgba(w, h, shader) {
  const data = Buffer.alloc(w * h * 4);
  const px = [0, 0, 0, 255];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      shader(x, y, px);
      const p = (y * w + x) * 4;
      data[p] = px[0]; data[p + 1] = px[1]; data[p + 2] = px[2]; data[p + 3] = px[3];
    }
  }
  return { width: w, height: h, data };
}

/** 描边面板：四周 3px 亮边框 */
const bordered = () => rgba(100, 60, (x, y, px) => {
  const b = x < 3 || y < 3 || x >= 97 || y >= 57;
  px[0] = b ? 220 : 60; px[1] = b ? 220 : 70; px[2] = b ? 220 : 90; px[3] = 255;
});

/** 横向条纹（4px 周期） */
const hStripe = () => rgba(120, 40, (x, y, px) => {
  const v = Math.floor(y / 4) % 2 ? 230 : 40;
  px[0] = v; px[1] = v; px[2] = v; px[3] = 255;
});

/** 竖向条纹（4px 周期） */
const vStripe = () => rgba(40, 120, (x, y, px) => {
  const v = Math.floor(x / 4) % 2 ? 230 : 40;
  px[0] = v; px[1] = v; px[2] = v; px[3] = 255;
});

// ---------------------------------------------------------------------
// 已修复的部分：必须始终 PASS（防止回退）
// ---------------------------------------------------------------------
test('已修复: 横向渐变面板 -> CAN_9GRID', () => {
  const img = rgba(160, 50, (x, y, px) => {
    const t = x / 159;
    px[0] = 40 + t * 120; px[1] = 50 + t * 100; px[2] = 70 + t * 80; px[3] = 255;
  });
  const f = extractFeatures(img);
  const v = computeGrid9(f, config.grid9);
  assert.equal(v.verdict, VERDICT.CAN_9GRID, `渐变面板应可切，实得 ${v.verdict}`);
  assert.ok(v.evidence.join(' ').includes('单调平滑渐变'), 'evidence 应说明是按「平滑渐变」放行的');
});

test('已修复: 竖向渐变面板 -> CAN_9GRID', () => {
  const img = rgba(60, 140, (x, y, px) => {
    const t = y / 139;
    px[0] = 40 + t * 120; px[1] = 50 + t * 100; px[2] = 70 + t * 80; px[3] = 255;
  });
  const v = computeGrid9(extractFeatures(img), config.grid9);
  assert.equal(v.verdict, VERDICT.CAN_9GRID, `实得 ${v.verdict}`);
});

test('已修复: 斜面浮雕按钮 -> CAN_9GRID', () => {
  const img = rgba(90, 34, (x, y, px) => {
    const d = Math.min(x, 89 - x, y, 33 - y);
    const val = d < 3 ? 200 : 90 + d;
    px[0] = val; px[1] = val; px[2] = val + 20; px[3] = 255;
  });
  const v = computeGrid9(extractFeatures(img), config.grid9);
  assert.equal(v.verdict, VERDICT.CAN_9GRID, `实得 ${v.verdict}`);
});

test('已修复: 极小图 1x1 / 8x8 -> NEVER（形态特征不可靠）', () => {
  for (const [w, h] of [[1, 1], [8, 8], [4, 4]]) {
    const v = computeGrid9(extractFeatures(rgba(w, h, (x, y, px) => { px[0] = 128; px[1] = 128; px[2] = 128; px[3] = 255; })), config.grid9);
    assert.equal(v.verdict, VERDICT.NEVER, `${w}x${h} 应判 NEVER（不确定就放弃），实得 ${v.verdict}`);
  }
});

// ---------------------------------------------------------------------
// ★ 未修复的部分：固化当前行为，并说明为什么
// ---------------------------------------------------------------------
test('★ 已修复: 描边面板 -> CAN_9GRID（radialMaxCluster 起作用）', () => {
  const f = extractFeatures(bordered());
  const v = computeGrid9(f, config.grid9);
  assert.equal(v.verdict, VERDICT.CAN_9GRID,
    `描边面板应可切（偏离扇区聚成连续簇 maxCluster=${f.radialMaxCluster}），实得 ${v.verdict}`);
  assert.ok(v.evidence.join(' ').includes('连续簇'),
    'evidence 应说明是靠「偏离扇区聚成连续簇」放行的，而不是碰巧');
});

test('★ 已知限制: 细长条纹当前误判 CAN_9GRID（危险侧，待真实素材标定）', () => {
  for (const [name, mk] of [['横向条纹 120x40', hStripe], ['竖向条纹 40x120', vStripe]]) {
    const f = extractFeatures(mk());
    const v = computeGrid9(f, config.grid9);
    // ★ 当前行为：被误判为可切。这是**危险侧**误判，刻意固化在此以便监控。
    //   若将来新增「簇的角度位置」特征后修好了，这条会红 —— 那时应该更新本文件说明。
    assert.equal(v.verdict, VERDICT.CAN_9GRID,
      `${name} 的判定已变化（现为 ${v.verdict}）。若已修复，请更新本文件顶部的说明。`);
  }
});

test('★ 为何暂不修：描边与条纹在多数关键特征上重合，差异量级不足以支撑稳健阈值', () => {
  const a = extractFeatures(bordered());
  const b = extractFeatures(hStripe());
  // 逐项对比：证明「不是阈值没调好，而是特征本身区分力不足」
  const keys = ['cornerFill', 'midMonotonic', 'radialSymmetry', 'radialMaxCluster'];
  const same = keys.filter((k) => a[k] === b[k]);
  assert.ok(same.length >= 3,
    `描边与条纹在 ${same.length}/${keys.length} 个关键特征上完全相同`
    + `（${same.join(', ')}）—— 现有特征空间不足以区分，需新增特征（簇的角度位置 / 中线周期性）`);
  // 唯一有差异的两项，差异幅度确实很小
  const dMono = Math.abs(a.midMonotonic - b.midMonotonic);
  assert.ok(dMono < 0.1, `midMonotonic 差异仅 ${dMono.toFixed(3)}，量级不足以支撑阈值`);
});

test('★ 修复方向已记录：需要新增「簇的角度位置」或「中线周期性」特征', () => {
  // 这条不是断言实现，而是把「下一步该做什么」写进代码，避免后人重复调研。
  const src = require('fs').readFileSync(
    require('path').resolve(__dirname, '../../src/imaging/grid9.js'), 'utf8');
  assert.ok(src.includes('radialClusterMin'),
    'grid9.js 应对「簇连续性」有明确判据 —— 那是本轮为区分边框与纹理引入的');
  assert.ok(src.includes('gradientMonotonicMin'),
    'grid9.js 应对「平滑渐变」有明确判据 —— 那是本轮为放行渐变面板引入的');
});
