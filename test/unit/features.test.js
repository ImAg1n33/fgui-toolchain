'use strict';
/**
 * test/unit/features.test.js —— 特征提取（R1-F2）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  extractFeatures, computeAlphaStats, cornerFill, edgeDensity,
  cornerSolidity, midVariances, radialSymmetry, longestHotCluster,
  dominantColor, normalizedVariance, monotonicity,
  ALPHA_THRESHOLD, RADIAL_SECTORS,
} = require('../../src/imaging/features');
const { createDecoder } = require('../../src/imaging/decoder');

const ASSETS = path.resolve(__dirname, '../fixtures/golden/assets');

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

test('computeAlphaStats: 全不透明图 alphaRatio=1 且包围盒=整图', () => {
  const img = rgba(20, 10, (x, y, px) => { px[0] = 100; px[3] = 255; });
  const s = computeAlphaStats(img);
  assert.equal(s.alphaRatio, 1);
  assert.deepEqual(s.alphaBox, { x: 0, y: 0, w: 20, h: 10 });
});

test('computeAlphaStats: 全透明图 alphaBox 为 null', () => {
  const img = rgba(20, 10, (x, y, px) => { px[3] = 0; });
  const s = computeAlphaStats(img);
  assert.equal(s.alphaRatio, 0);
  assert.equal(s.alphaBox, null);
});

test('computeAlphaStats: 包围盒只含不透明像素', () => {
  // 中间 10x8 不透明，四周透明
  const img = rgba(20, 20, (x, y, px) => {
    if (x >= 5 && x < 15 && y >= 6 && y < 14) { px[0] = 255; px[3] = 255; }
    else px[3] = 0;
  });
  const s = computeAlphaStats(img);
  assert.deepEqual(s.alphaBox, { x: 5, y: 6, w: 10, h: 8 });
  assert.equal(s.alphaRatio, (10 * 8) / (20 * 20));
});

test('computeAlphaStats: alpha 阈值边界（127 透明 / 128 不透明）', () => {
  const img = rgba(2, 1, (x, y, px) => { px[3] = x === 0 ? ALPHA_THRESHOLD - 1 : ALPHA_THRESHOLD; });
  const s = computeAlphaStats(img);
  assert.equal(s.alphaRatio, 0.5, '恰在阈值上算不透明');
  assert.deepEqual(s.alphaBox, { x: 1, y: 0, w: 1, h: 1 });
});

test('★ cornerFill: 面板高 / 胶囊中 / 圆低（这是九宫格主判据）', () => {
  // 面板：整块不透明（含边框），只有极小的圆角
  const panel = rgba(40, 40, (x, y, px) => {
    const dx = Math.min(x, 39 - x);
    const dy = Math.min(y, 39 - y);
    px[0] = 100;
    px[3] = (dx < 2 && dy < 2 && dx * dx + dy * dy > 4) ? 0 : 255;
  });
  const cfPanel = cornerFill(panel);

  // 圆：四角透明
  const circle = rgba(40, 40, (x, y, px) => {
    const dx = x - 20; const dy = y - 20;
    px[3] = dx * dx + dy * dy <= 18 * 18 ? 255 : 0;
  });
  const cfCircle = cornerFill(circle);

  // 胶囊：四角半实（左右各切一个半径）
  const capsule = rgba(80, 40, (x, y, px) => {
    const r = 20;
    const dy = y - 20;
    let inside = true;
    if (x < r) inside = (x - r) * (x - r) + dy * dy <= r * r;
    else if (x >= 80 - r) inside = (x - (80 - r)) * (x - (80 - r)) + dy * dy <= r * r;
    px[3] = inside ? 255 : 0;
  });
  const cfCapsule = cornerFill(capsule);

  assert.ok(cfPanel > 0.85, `面板 cornerFill 应 > 0.85，实得 ${cfPanel}`);
  assert.ok(cfCircle < 0.35, `圆 cornerFill 应 < 0.35，实得 ${cfCircle}`);
  assert.ok(cfCapsule > cfCircle && cfCapsule < cfPanel,
    `胶囊应居中（圆 ${cfCircle} < 胶囊 ${cfCapsule} < 面板 ${cfPanel}）`);
});

test('★ cornerFill: 区块边长相对短边（宽胶囊不会因变宽而显得「角是实的」）', () => {
  // 同一圆头形态，只改宽度：cornerFill 应基本稳定
  const cf = (w) => cornerFill(rgba(w, 40, (x, y, px) => {
    const r = 20;
    const dy = y - 20;
    let inside = true;
    if (x < r) inside = (x - r) * (x - r) + dy * dy <= r * r;
    else if (x >= w - r) inside = (x - (w - r)) * (x - (w - r)) + dy * dy <= r * r;
    px[3] = inside ? 255 : 0;
  }));
  const a = cf(80);
  const b = cf(200);
  assert.ok(Math.abs(a - b) < 0.02,
    `★ 同形态不同宽度 cornerFill 应稳定（80: ${a} vs 200: ${b}）—— 若区块按宽度取值则会漂移`);
});

test('★ radialSymmetry: 返回强度/分散度/连续簇三个量', () => {
  const rays = rgba(64, 64, (x, y, px) => {
    const ang = Math.atan2(y - 32, x - 32);
    px[0] = Math.round((Math.sin(ang * 12) * 0.5 + 0.5) * 255);
    px[3] = 255;
  });
  const r = radialSymmetry(...downsampleArgs(rays, 64));
  // ★ BUG#3 后返回对象而非标量 —— 断言形状可防止调用方漏改
  assert.equal(typeof r, 'object');
  assert.ok(typeof r.intensity === 'number', '应有 intensity');
  assert.ok(typeof r.spread === 'number', '应有 spread');
  assert.ok(typeof r.maxCluster === 'number', '★ 应有 maxCluster（区分边框与纹理的决定性指标）');
});

test('★ radialSymmetry: 放射纹强度高且偏离扇区分散成簇（交替出现）', () => {
  const rays = rgba(64, 64, (x, y, px) => {
    const ang = Math.atan2(y - 32, x - 32);
    px[0] = Math.round((Math.sin(ang * 8) * 0.5 + 0.5) * 255);
    px[1] = px[0]; px[2] = px[0]; px[3] = 255;
  });
  const r = radialSymmetry(...downsampleArgs(rays, 64));
  assert.ok(r.intensity > 0.6, `放射纹强度应 > 0.6，实得 ${r.intensity}`);
  // ★ 关键：8 辐的偏离扇区是**交替**的（亮暗亮暗），最大连续簇应为 1
  assert.ok(r.maxCluster < 2, `★ 放射纹的偏离扇区应交替出现（maxCluster<2），实得 ${r.maxCluster}`);
});

test('★ radialSymmetry: 矩形描边的偏离扇区聚成连续簇（区别于放射纹）', () => {
  // QA BUG #3：描边面板曾被误判成放射纹
  const bordered = rgba(100, 60, (x, y, px) => {
    const border = x < 3 || y < 3 || x >= 97 || y >= 57;
    px[0] = border ? 220 : 60;
    px[1] = border ? 220 : 70;
    px[2] = border ? 220 : 90;
    px[3] = 255;
  });
  const r = radialSymmetry(...downsampleArgs(bordered, 60));
  assert.ok(r.maxCluster >= 2,
    `★ 矩形描边的偏离扇区应聚成连续簇（maxCluster>=2），实得 ${r.maxCluster} —— 这是与放射纹的核心区别`);
});

test('★ radialSymmetry: 平滑渐变的强度远低于放射纹', () => {
  const gradient = rgba(64, 64, (x, y, px) => {
    px[0] = Math.round((y / 63) * 255);
    px[3] = 255;
  });
  const r = radialSymmetry(...downsampleArgs(gradient, 64));
  const rays = rgba(64, 64, (x, y, px) => {
    const ang = Math.atan2(y - 32, x - 32);
    px[0] = Math.round((Math.sin(ang * 8) * 0.5 + 0.5) * 255);
    px[3] = 255;
  });
  const rr = radialSymmetry(...downsampleArgs(rays, 64));
  assert.ok(rr.intensity - r.intensity > 0.3,
    `放射纹(${rr.intensity}) 应明显高于平滑渐变(${r.intensity})`);
});

/**
 * 把 RGBA 降采样后返回 radialSymmetry 需要的两个参数。
 * @param {{width:number,height:number,data:Buffer}} img
 * @param {number} n
 * @returns {[Float64Array, number]}
 */
function downsampleArgs(img, n) {
  const { downsample } = require('../../src/imaging/features');
  const { gray } = downsample(img, n);
  return [gray, n];
}

test('normalizedVariance: 尺度无关（整体乘 10 值不变）', () => {
  const a = [20, 25, 15, 22];
  const b = a.map((v) => v * 10);
  const va = normalizedVariance(a);
  const vb = normalizedVariance(b);
  assert.ok(Math.abs(va - vb) < 1e-9,
    `★ 整体放大后应得同值（${va} vs ${vb}）—— 这是「尺度无关」的含义`);
});

test('normalizedVariance: 全常数返回 0（含全零，实测踩过的坑）', () => {
  assert.equal(normalizedVariance(new Array(32).fill(0)), 0,
    '★ 全零数组必须为 0（用 std/mean 会被算成 1，明显错误）');
  assert.equal(normalizedVariance(new Array(32).fill(128)), 0);
  assert.equal(normalizedVariance(new Array(32).fill(255)), 0);
});

test('normalizedVariance: 值恒在 0..1 且随起伏单调递增', () => {
  const flat = normalizedVariance([100, 100, 100, 100]);
  const slight = normalizedVariance([100, 104, 96, 100]);
  const rough = normalizedVariance([0, 255, 0, 255]);
  for (const v of [flat, slight, rough]) {
    assert.ok(v >= 0 && v <= 1, `越界: ${v}`);
  }
  assert.equal(flat, 0);
  assert.ok(slight > flat, '起伏增大应得分变高');
  assert.ok(rough > slight, '剧烈起伏应得分更高');
  assert.ok(rough < 1, '恒定交替应接近但不超过 1');
});

test('dominantColor: 返回不透明像素的众数色', () => {
  const img = rgba(10, 10, (x, y, px) => {
    if (x < 8) { px[0] = 200; px[1] = 30; px[2] = 30; px[3] = 255; }
    else { px[0] = 30; px[1] = 30; px[2] = 200; px[3] = 255; }
  });
  const d = dominantColor(img);
  // 8 列红 vs 2 列蓝 —— 取左半区众数（并列时按量化键序取小者）
  assert.ok(d.r > d.b, `应偏向红色区，实得 ${JSON.stringify(d)}`);
  assert.ok(d.r >= 190 && d.r <= 210);
});

test('edgeDensity / cornerSolidity: 纯色图为 0 / 1', () => {
  const solid = rgba(32, 32, (x, y, px) => { px[0] = 128; px[3] = 255; });
  const { downsample } = require('../../src/imaging/features');
  const { gray, alpha } = downsample(solid, 32);
  assert.equal(edgeDensity(gray, alpha, 32), 0, '纯色图无边缘');
  assert.equal(cornerSolidity(alpha, 32), 1, '纯色图四角实心');
});

test('midVariances: 条纹图中列方差高于中行方差（横向拉伸有风险）', () => {
  // 横向条纹：中列（竖直方向穿过多条纹）方差大，中行方差小
  const stripes = rgba(32, 32, (x, y, px) => {
    px[0] = Math.floor(y / 4) % 2 ? 255 : 0;
    px[3] = 255;
  });
  const { downsample } = require('../../src/imaging/features');
  const { gray } = downsample(stripes, 32);
  const m = midVariances(gray, 32);
  assert.equal(m.midRowVariance, 0, '中行穿过同一根条纹，应完全平坦');
  assert.ok(m.midColVariance > 0.5,
    `中列穿过多根条纹应强烈起伏，实得 ${m.midColVariance}`);
});

test('extractFeatures: 输出字段完整且全部定点化', () => {
  const img = rgba(40, 30, (x, y, px) => {
    const inCorner = (x < 4 && y < 4) || (x >= 36 && y < 4) || (x < 4 && y >= 26) || (x >= 36 && y >= 26);
    px[0] = inCorner ? 0 : 120;
    px[3] = inCorner ? 0 : 255;
  });
  const f = extractFeatures(img);
  for (const key of ['w', 'h', 'alphaRatio', 'alphaBox', 'phash', 'dominantR', 'dominantG',
    'dominantB', 'edgeDensity', 'cornerSolidity', 'cornerFill',
    'midRowVariance', 'midColVariance', 'radialSymmetry', 'aspectRatio']) {
    assert.ok(key in f, `缺字段 ${key}`);
  }
  assert.equal(f.w, 40);
  assert.equal(f.aspectRatio, Number((40 / 30).toFixed(6)), 'aspectRatio 应定点化到 6 位');
  assert.match(f.phash, /^[0-9a-f]{16}$/);
  // 定点化：6 位小数内
  for (const key of ['alphaRatio', 'edgeDensity', 'cornerFill', 'radialSymmetry', 'aspectRatio']) {
    const v = f[key];
    assert.equal(v, Number(v.toFixed(6)), `${key}=${v} 应已定点化`);
  }
});

test('extractFeatures: 同输入两次结果完全一致（确定性）', () => {
  const img = rgba(50, 40, (x, y, px) => { px[0] = (x * 5) % 256; px[3] = 255; });
  const a = extractFeatures(img);
  const b = extractFeatures(img);
  assert.deepEqual(a, b, '★ 同输入必须完全一致');
});

test('extractFeatures: 入参非法时抛错（不静默返回垃圾）', () => {
  assert.throws(() => extractFeatures(null), /decodeToRgba/);
  assert.throws(() => extractFeatures({ width: 0, height: 0, data: Buffer.alloc(0) }), /decodeToRgba/);
});

test('withPhash=false 时不算 pHash（--no-features 快路径）', () => {
  const img = rgba(20, 20, (x, y, px) => { px[0] = 100; px[3] = 255; });
  const f = extractFeatures(img, { withPhash: false });
  assert.equal(f.phash, null);
  assert.ok(f.cornerFill !== undefined, '其他特征仍应计算');
});

test('常量与设计一致', () => {
  assert.equal(ALPHA_THRESHOLD, 128);
  assert.equal(RADIAL_SECTORS, 12);
});

test('真实合成切图：特征提取无异常且字段合法', async (t) => {
  if (!fs.existsSync(ASSETS)) {
    t.skip('合成切图未生成');
    return;
  }
  const dec = createDecoder();
  const files = fs.readdirSync(ASSETS).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
  assert.ok(files.length >= 20);
  for (const f of files) {
    const buf = fs.readFileSync(path.join(ASSETS, f));
    const feats = extractFeatures(await dec.decodeToRgba(buf));
    assert.match(feats.phash, /^[0-9a-f]{16}$/, `${f} phash 非法`);
    assert.ok(feats.alphaRatio >= 0 && feats.alphaRatio <= 1, `${f} alphaRatio 越界`);
    assert.ok(feats.cornerFill >= 0 && feats.cornerFill <= 1, `${f} cornerFill 越界`);
    assert.ok(feats.radialSymmetry >= 0 && feats.radialSymmetry <= 1, `${f} radialSymmetry 越界`);
    assert.ok(feats.aspectRatio > 0);
    if (feats.alphaBox) {
      assert.ok(feats.alphaBox.w > 0 && feats.alphaBox.h > 0, `${f} alphaBox 非法`);
    }
  }
});


test('longestHotCluster: 环形连续簇计算正确', () => {
  assert.equal(longestHotCluster([true, true, false, false]), 2);
  assert.equal(longestHotCluster([false, true, true, true, false]), 3);
  assert.equal(longestHotCluster([false, false, false]), 0);
  // 环形：首尾相接算连续
  assert.equal(longestHotCluster([true, false, false, true]), 2);
  // 全 true -> n
  assert.equal(longestHotCluster([true, true, true, true]), 4);
  assert.equal(longestHotCluster([]), 0);
});

test('monotonicity: 单调序列趋近 1，交替序列趋近 0.5', () => {
  assert.equal(monotonicity([0, 10, 20, 30, 40]), 1, '严格单调递增');
  assert.equal(monotonicity([40, 30, 20, 10, 0]), 1, '严格单调递减');
  // 8 个点 = 7 段差分：升 4 段、降 3 段 -> 4/7
  assert.ok(Math.abs(monotonicity([0, 10, 20, 30, 40, 30, 20, 10]) - 4 / 7) < 1e-9,
    '先升后降：升 4 段 / 总 7 段 = 0.571');
  // 交替
  const alt = monotonicity([0, 255, 0, 255, 0, 255, 0, 255]);
  assert.ok(alt < 0.6, `交替序列应 < 0.6，实得 ${alt}`);
  // 点太少 -> 返回 1（无法判断趋势，交给其它判据）
  assert.equal(monotonicity([5]), 1);
  assert.equal(monotonicity([5, 6]), 1);
  // 全平坦
  assert.equal(monotonicity([7, 7, 7, 7]), 1);
});

test('★ extractFeatures: 暴露 BUG#3 新增的特征字段', () => {
  const img = rgba(60, 40, (x, y, px) => { px[0] = 100; px[3] = 255; });
  const f = extractFeatures(img);
  assert.ok('midMonotonic' in f, '应有 midMonotonic');
  assert.ok('midRowMonotonic' in f, '应有 midRowMonotonic');
  assert.ok('midColMonotonic' in f, '应有 midColMonotonic');
  assert.ok('radialSpread' in f, '应有 radialSpread');
  assert.ok('radialMaxCluster' in f, '★ 应有 radialMaxCluster');
  // 定点化
  for (const k of ['midMonotonic', 'radialSpread']) {
    assert.equal(f[k], Number(f[k].toFixed(6)), `${k} 应定点化`);
  }
  assert.equal(typeof f.radialMaxCluster, 'number');
  assert.ok(Number.isInteger(f.radialMaxCluster), 'maxCluster 应是整数（簇长度）');
});
