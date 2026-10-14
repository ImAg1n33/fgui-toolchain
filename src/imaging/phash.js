'use strict';
/**
 * src/imaging/phash.js —— 自实现 64bit DCT pHash（ARCHITECTURE D7）
 *
 * 为什么自实现：Python 的 imagehash 需要维护第二套 venv，跨语言调用在 Windows 上
 * 路径/编码问题多，且 PSD 解析在 Node 侧无法共享解析结果。纯 JS 无依赖，够用且稳定。
 *
 * 算法（标准 pHash 流程）：
 *   1. 灰度缩放到 32×32
 *   2. 二维 DCT-II，取左上 8×8 低频系数（跳过 DC 分量）
 *   3. 取这 63 个系数的中位数为阈值
 *   4. 每位 `coef > median ? 1 : 0` → 64bit → 16 位十六进制
 *
 * 确定性：所有运算为定长循环，无随机、无并发、无浮点累积顺序差异；
 * 输出定点化为整数数组，故跨机器逐字节一致（B9）。
 */

/** 灰度化目标尺寸。 */
const GRAY_SIZE = 32;
/** 低频取样尺寸。 */
const LOW_FREQ = 8;

/**
 * 预计算 DCT 基（cos 表），避免每次重算。
 * @param {number} n
 * @returns {Float64Array[]} basis[u][x] = cos((2x+1)u*PI/(2n))
 */
function dctBasis(n) {
  const table = [];
  for (let u = 0; u < n; u++) {
    const row = new Float64Array(n);
    for (let x = 0; x < n; x++) {
      row[x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * n));
    }
    table.push(row);
  }
  return table;
}

/** 32×32 与 8×8 的基表，只建一次。 */
const BASIS_32 = dctBasis(GRAY_SIZE);

/**
 * 二维 DCT-II（先行后列，可分离）。输入输出均为 n×n。
 * @param {Float64Array} pixels 长度 n*n 的灰度值（0..255）
 * @param {number} n
 * @returns {Float64Array} 长度 n*n 的 DCT 系数
 */
function dct2d(pixels, n) {
  // 先行：tmp[y][u] = sum_x pixels[y][x] * cos((2x+1)u*pi/2n)
  const tmp = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let u = 0; u < n; u++) {
      let sum = 0;
      const basis = BASIS_32[u];
      const rowOff = y * n;
      for (let x = 0; x < n; x++) sum += pixels[rowOff + x] * basis[x];
      tmp[rowOff + u] = sum;
    }
  }
  // 再列：out[v][u] = sum_y tmp[y][u] * cos((2y+1)v*pi/2n)
  const out = new Float64Array(n * n);
  for (let u = 0; u < n; u++) {
    for (let v = 0; v < n; v++) {
      let sum = 0;
      const basis = BASIS_32[v];
      for (let y = 0; y < n; y++) sum += tmp[y * n + u] * basis[y];
      out[v * n + u] = sum;
    }
  }
  return out;
}

/**
 * 从 32×32 灰度矩阵计算 64bit pHash。
 * @param {Uint8Array|Buffer|Float64Array} gray 长度 1024，值 0..255
 * @returns {string} 16 位小写十六进制
 */
function phashFromGray(gray) {
  const px = new Float64Array(GRAY_SIZE * GRAY_SIZE);
  for (let i = 0; i < px.length; i++) px[i] = gray[i];

  const coeffs = dct2d(px, GRAY_SIZE);

  // 取左上 8×8，跳过 (0,0) DC 分量 —— DC 只反映整体亮度，对结构无信息
  const low = [];
  for (let v = 0; v < LOW_FREQ; v++) {
    for (let u = 0; u < LOW_FREQ; u++) {
      if (u === 0 && v === 0) continue;
      low.push(coeffs[v * GRAY_SIZE + u]);
    }
  }

  // 中位数阈值。63 个元素 -> 取排序后第 31 个（下中位），保证确定性。
  const sorted = [...low].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  let bits = 0;
  let idx = 0;
  for (let v = 0; v < LOW_FREQ; v++) {
    for (let u = 0; u < LOW_FREQ; u++) {
      if (u === 0 && v === 0) continue;
      const bit = coeffs[v * GRAY_SIZE + u] > median ? 1 : 0;
      bits |= bit << idx;
      idx++;
    }
  }

  // 固定 16 位（不足补 0），保证输出长度恒定
  return (bits >>> 0).toString(16).padStart(16, '0');
}

/**
 * 从 RGBA 原始像素（decoder.decodeToRgba 的输出）直接算 pHash，不经 sharp 的 greyscale。
 * 用于「已经在内存里有像素」的路径（如 PSD 图层），避免重复解码。
 *
 * 灰度化用 Rec.601；缩放用最近邻（32×32 桶平均在此尺寸下噪声可忽略）。
 *
 * @param {{width:number, height:number, data:Uint8Array|Buffer}} rgba
 * @returns {string} 16 位 hex
 */
function phashFromRgba(rgba) {
  const { width, height, data } = rgba;
  const gray = new Uint8Array(GRAY_SIZE * GRAY_SIZE);
  const cellW = width / GRAY_SIZE;
  const cellH = height / GRAY_SIZE;
  for (let gy = 0; gy < GRAY_SIZE; gy++) {
    const y0 = Math.floor(gy * cellH);
    const y1 = Math.max(y0 + 1, Math.floor((gy + 1) * cellH));
    for (let gx = 0; gx < GRAY_SIZE; gx++) {
      const x0 = Math.floor(gx * cellW);
      const x1 = Math.max(x0 + 1, Math.floor((gx + 1) * cellW));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < Math.min(y1, height); y++) {
        for (let x = x0; x < Math.min(x1, width); x++) {
          const p = (y * width + x) * 4;
          // 透明像素按白底合成，避免 alpha 边界污染结构特征
          const a = data[p + 3] / 255;
          const r = data[p] * a + 255 * (1 - a);
          const g = data[p + 1] * a + 255 * (1 - a);
          const b = data[p + 2] * a + 255 * (1 - a);
          sum += 0.299 * r + 0.587 * g + 0.114 * b;
          n++;
        }
      }
      gray[gy * GRAY_SIZE + gx] = n ? Math.round(sum / n) : 255;
    }
  }
  return phashFromGray(gray);
}

/**
 * 便捷入口：文件 Buffer -> pHash。需要 decoder（sharp 或 pngjs）。
 *
 * ⚠ decoder.toGreyscale 是 async（sharp 的 toBuffer 只有 Promise 版），
 *   故本函数也是 async。调用方必须 await。
 *
 * @param {Buffer} buffer
 * @param {Object} decoder createDecoder() 的结果
 * @returns {Promise<string>} 16 位 hex
 */
async function phashFromBuffer(buffer, decoder) {
  const g = await decoder.toGreyscale(buffer, GRAY_SIZE);
  return phashFromGray(g.data);
}

module.exports = {
  phashFromGray,
  phashFromRgba,
  phashFromBuffer,
  dct2d,
  GRAY_SIZE,
  LOW_FREQ,
};
