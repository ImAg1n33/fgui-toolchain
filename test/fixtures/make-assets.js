'use strict';
/**
 * test/fixtures/make-assets.js —— 合成切图（破解「本机没有真实素材」的死结）
 *
 * 产出 4 类形态，每类 5 张，共 20 张（ARCHITECTURE T01 验收⑤）：
 *   panel    常规面板        -> 期望 CAN_9GRID
 *   capsule  胶囊/全圆头      -> 期望 SINGLE_AXIS_ONLY
 *   circle   圆形            -> 期望 NEVER
 *   radial   放射/对角纹理    -> 期望 NEVER
 *
 * ★ 关键：同时产出 K5 命名陷阱样本 ★
 *   `矩形1.png` 与 `矩形11.png` 共存；另有 `图层249(1).png`（副本后缀样本）。
 *   这三个文件是 K5 单测的 ground truth。
 *
 * 用 sharp 生成（已实测运行时可用、两次编码逐字节一致）。
 */

const fs = require('fs');
const path = require('path');

/** 输出目录（相对项目根）。 */
const OUT_DIR = path.resolve(__dirname, 'golden', 'assets');

/** 形态清单：名称前缀 + 期望九宫格判定 + 数量。 */
const SHAPES = [
  { prefix: 'panel', expect: 'CAN_9GRID', count: 5 },
  { prefix: 'capsule', expect: 'SINGLE_AXIS_ONLY', count: 5 },
  { prefix: 'circle', expect: 'NEVER', count: 5 },
  { prefix: 'radial', expect: 'NEVER', count: 5 },
];

/**
 * 造一张 RGBA 图。
 * @param {number} w
 * @param {number} h
 * @param {function(number,number,number[]):void} shader (x,y,out) 写 out[0..3]
 * @returns {{width:number,height:number,data:Buffer}}
 */
function makeRgba(w, h, shader) {
  const data = Buffer.alloc(w * h * 4);
  const px = [0, 0, 0, 255];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      shader(x, y, px);
      const p = (y * w + x) * 4;
      data[p] = px[0];
      data[p + 1] = px[1];
      data[p + 2] = px[2];
      data[p + 3] = px[3];
    }
  }
  return { width: w, height: h, data };
}

/**
 * 常规面板：四角实心（不透明圆角矩形），中部平坦。
 * @param {number} w
 * @param {number} h
 * @param {number} variant 变体号，用于让 5 张各不相同
 * @returns {{width:number,height:number,data:Buffer}}
 */
function makePanel(w, h, variant) {
  const radius = Math.min(8, Math.floor(Math.min(w, h) / 8));
  const base = 60 + variant * 12;
  return makeRgba(w, h, (x, y, out) => {
    // 圆角矩形遮罩：四角切角，保证 cornerSolidity 高
    const inCorner = (cx, cy) => {
      const dx = x < radius ? radius - x : (x >= w - radius ? x - (w - radius - 1) : 0);
      const dy = y < radius ? radius - y : (y >= h - radius ? y - (h - radius - 1) : 0);
      return dx * dx + dy * dy <= radius * radius;
    };
    if (!inCorner(0, 0)) {
      out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
      return;
    }
    // 边框 2px + 内部平坦填充
    const border = x < 2 || y < 2 || x >= w - 2 || y >= h - 2;
    if (border) {
      out[0] = base; out[1] = base + 20; out[2] = base + 60; out[3] = 255;
    } else {
      out[0] = base + 40; out[1] = base + 70; out[2] = base + 120; out[3] = 255;
    }
  });
}

/**
 * 胶囊：横向长条 + 全圆头（左右两端半圆），上下边平直。
 * @param {number} w
 * @param {number} h
 * @param {number} variant
 * @returns {{width:number,height:number,data:Buffer}}
 */
function makeCapsule(w, h, variant) {
  const r = h / 2;
  const cx = r;
  const base = 40 + variant * 10;
  return makeRgba(w, h, (x, y, out) => {
    const dy = y - r;
    let inside;
    if (x < r) {
      inside = (x - cx) * (x - cx) + dy * dy <= r * r;
    } else if (x >= w - r) {
      const rx = w - r;
      inside = (x - rx) * (x - rx) + dy * dy <= r * r;
    } else {
      inside = true;
    }
    if (!inside) {
      out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
      return;
    }
    // 上浅下深的简单渐变 —— 保证 midColVariance 高（纵向有变化）
    const t = y / (h - 1);
    out[0] = Math.round(base + 60 * t);
    out[1] = Math.round(base + 90 * t);
    out[2] = Math.round(base + 140 * t);
    out[3] = 255;
  });
}

/**
 * 圆形：正方形画布 + 圆心圆盘，四角透明。
 * @param {number} size
 * @param {number} variant
 * @returns {{width:number,height:number,data:Buffer}}
 */
function makeCircle(size, variant) {
  const r = size / 2 - 1;
  const cx = size / 2;
  const cy = size / 2;
  const base = 70 + variant * 15;
  return makeRgba(size, size, (x, y, out) => {
    const dx = x - cx + 0.5;
    const dy = y - cy + 0.5;
    if (dx * dx + dy * dy > r * r) {
      out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
      return;
    }
    // 环状渐变：中心亮边缘暗，制造高 edgeDensity + 高 radialSymmetry
    const dist = Math.sqrt(dx * dx + dy * dy) / r;
    out[0] = Math.round(200 - 120 * dist);
    out[1] = Math.round(180 - 100 * dist);
    out[2] = Math.round(base);
    out[3] = 255;
  });
}

/**
 * 放射纹理：从中心向外的射线（角度相关），radialSymmetry 高。
 * @param {number} size
 * @param {number} variant
 * @returns {{width:number,height:number,data:Buffer}}
 */
function makeRadial(size, variant) {
  const cx = size / 2;
  const cy = size / 2;
  const rays = 8 + variant * 2;
  return makeRgba(size, size, (x, y, out) => {
    const dx = x - cx + 0.5;
    const dy = y - cy + 0.5;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > size / 2 - 1) {
      out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
      return;
    }
    // 角度函数 -> 放射状明暗条
    const ang = Math.atan2(dy, dx);
    const v = Math.sin(ang * rays) * 0.5 + 0.5;
    // 叠加径向衰减
    const fall = 1 - dist / (size / 2);
    const level = Math.round((40 + 180 * v) * (0.4 + 0.6 * fall));
    out[0] = level;
    out[1] = Math.round(level * 0.85);
    out[2] = Math.round(level * 0.6);
    out[3] = 255;
  });
}

/**
 * 把 RGBA 编码为 PNG（用我们的 canvas 垫片 + sharp 编码，保证零原生 canvas 依赖）。
 * @param {{width:number,height:number,data:Buffer}} rgba
 * @returns {Promise<Buffer>}
 */
async function encodePng(rgba) {
  const sharp = require('sharp');
  return sharp(rgba.data, { raw: { width: rgba.width, height: rgba.height, channels: 4 } })
    .png({ compressionLevel: 9, effort: 4 })
    .toBuffer();
}

/**
 * 生成全部合成切图。
 * @param {Object} [opts]
 * @param {string} [opts.outDir] 输出目录
 * @returns {Promise<{outDir:string, files:string[], expectByName:Object}>}
 */
async function makeAssets(opts = {}) {
  const outDir = opts.outDir || OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });

  // 清掉旧产物，保证重建干净（确定性前提）
  for (const f of fs.readdirSync(outDir)) {
    if (/\.(png|jpg|jpeg|webp)$/i.test(f)) fs.unlinkSync(path.join(outDir, f));
  }

  const sharp = require('sharp');
  /** @type {string[]} */
  const files = [];
  /** 名称 -> 期望九宫格判定（测试断言用） */
  const expectByName = {};

  const write = async (name, rgba) => {
    const buf = await sharp(rgba.data, {
      raw: { width: rgba.width, height: rgba.height, channels: 4 },
    }).png({ compressionLevel: 9, effort: 4 }).toBuffer();
    fs.writeFileSync(path.join(outDir, name), buf);
    files.push(name);
  };

  // ---- 4 类形态 × 5 ----
  for (let i = 0; i < 5; i++) {
    const p = `panel_${i + 1}.png`;
    await write(p, makePanel(120 + i * 8, 80 + i * 4, i));
    expectByName[p] = 'CAN_9GRID';
  }
  for (let i = 0; i < 5; i++) {
    const c = `capsule_${i + 1}.png`;
    await write(c, makeCapsule(120 + i * 16, 36, i));
    expectByName[c] = 'SINGLE_AXIS_ONLY';
  }
  for (let i = 0; i < 5; i++) {
    const s = 64 + i * 8;
    const c = `circle_${i + 1}.png`;
    await write(c, makeCircle(s, i));
    expectByName[c] = 'NEVER';
  }
  for (let i = 0; i < 5; i++) {
    const s = 72 + i * 8;
    const c = `radial_${i + 1}.png`;
    await write(c, makeRadial(s, i));
    expectByName[c] = 'NEVER';
  }

  // ---- K5 命名陷阱样本（★ 单测 ground truth）----
  // 矩形1 = 100x50 ；矩形11 = 180x90 —— 尺寸差很大，±2px 校验能二次判别
  await write('矩形1.png', makePanel(100, 50, 0));
  expectByName['矩形1.png'] = 'CAN_9GRID';
  await write('矩形11.png', makePanel(180, 90, 2));
  expectByName['矩形11.png'] = 'CAN_9GRID';
  // 图层249(1) —— 副本后缀样本，归一化后应为 图层249
  await write('图层249(1).png', makeCircle(48, 1));
  expectByName['图层249(1).png'] = 'NEVER';
  // 特效 / 组1200拷贝 —— PRD 里出现过的真实命名形态
  await write('特效.png', makeRadial(80, 1));
  expectByName['特效.png'] = 'NEVER';
  await write('组1200拷贝.png', makePanel(96, 96, 3));
  expectByName['组1200拷贝.png'] = 'CAN_9GRID';

  files.sort();
  return { outDir, files, expectByName };
}

module.exports = { makeAssets, makePanel, makeCapsule, makeCircle, makeRadial, SHAPES, OUT_DIR };

// 直接执行时生成（npm run fixtures）
if (require.main === module) {
  makeAssets()
    .then((res) => {
      process.stdout.write(`make-assets: 生成 ${res.files.length} 张合成切图 -> ${res.outDir}\n`);
    })
    .catch((err) => {
      process.stderr.write(`make-assets 失败: ${err.stack}\n`);
      process.exitCode = 1;
    });
}
