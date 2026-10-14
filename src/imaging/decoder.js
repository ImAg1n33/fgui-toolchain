'use strict';
/**
 * src/imaging/decoder.js —— ImageDecoder 接口 + 两个实现（sharp 默认 / pngjs 降级）
 *
 * 为什么有降级实现：sharp 是 P0 唯一需要联网安装的包（其余都是内置或已装）。
 * 为防公司机器装不上导致整条链路不可用，这里定义接口并提供 pngjs 降级实现（仅 PNG）。
 * 降级实现只保证「能跑通冒烟」，不保证速度与格式覆盖。
 *
 * 接口约定（三处实现一致）：
 *   readSize(bufferOrPath)          -> { width, height, format }   只读 header，快
 *   decodeToRgba(buffer)            -> { width, height, data }     RGBA Uint8Array
 *   makeThumbDataUri(buffer, size)  -> string                      base64 data: URI
 */

const fs = require('fs');
const path = require('path');
const { AppError, CODES } = require('../core/errors');

/** 支持的扩展名（与 fgui.config.json asset.extensions 对齐）。 */
const SUPPORTED_EXT = Object.freeze(['.png', '.jpg', '.jpeg', '.webp']);

/**
 * 兼容 image-size v1 / v2 的导出形态。
 *
 * ★ 实测坑 ★：`image-size@2.0.4` 的 CJS 导出是**对象**，
 *   `{ disableTypes, imageSize, default, types }`，直接 `sizeOf(buf)` 会抛
 *   `sizeOf is not a function`。必须取 `.default` 或 `.imageSize`。
 *   v1 则是直接导出函数。这里一次性兼容两种，未来换版本也不会炸。
 *
 * @returns {function(Buffer): {width:number, height:number, type:string}}
 */
function resolveImageSize() {
  // eslint-disable-next-line global-require
  const mod = require('image-size');
  if (typeof mod === 'function') return mod;
  if (typeof mod.imageSize === 'function') return mod.imageSize;
  if (typeof mod.default === 'function') return mod.default;
  throw new AppError(CODES.DEP_MISSING,
    'image-size 不可用：未找到可调用的导出（v1 应直接导出函数，v2 应有 .default/.imageSize）',
    { exports: Object.keys(mod || {}) });
}

/**
 * 由文件路径判断扩展名是否为支持的图片格式。
 * @param {string} filePath
 * @returns {boolean}
 */
function isSupportedImage(filePath) {
  return SUPPORTED_EXT.includes(path.extname(String(filePath || '')).toLowerCase());
}

/**
 * sharp 实现（默认）。
 *
 * 关键 API 说明：
 *   `sharp(buf).ensureAlpha().raw().toBuffer({resolveWithObject:true})` → 拿到 RGBA 通道。
 *   `sharp(buf).greyscale().resize(32,32,{fit:'fill'}).raw()` → 1024 字节灰度矩阵。
 *   `sharp(buf).stats()` → `dominant` 主色。
 *   `sharp(buf).resize(size,size,{fit:'inside'}).png()` → 缩略图（确定性输出）。
 */
class SharpDecoder {
  constructor() {
    try {
      // 延迟 require：sharp 是可选依赖，缺它时降级实现仍可工作
      // eslint-disable-next-line global-require
      this.sharp = require('sharp');
    } catch (err) {
      throw new AppError(CODES.DEP_MISSING,
        'sharp 不可用。请 `npm i sharp`，或改用 pngjs 降级实现（仅 PNG）。',
        { cause: err.message });
    }
  }

  /** @returns {string} 实现名 */
  get name() { return 'sharp'; }

  /**
   * 只读 header 拿尺寸（Ch-1 ±2px 校验的快路径）。image-size 只读 header，比解码快。
   * @param {Buffer|string} input Buffer 或文件路径
   * @returns {{width:number, height:number, format:string}}
   */
  readSize(input) {
    const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
    const sizeOf = resolveImageSize();
    const dim = sizeOf(buf);
    const fmt = String(dim.type || path.extname(String(input)) || '').toLowerCase();
    return {
      width: dim.width,
      height: dim.height,
      format: fmt.replace(/^\./, '') || 'unknown',
    };
  }

  /**
   * 解码为 RGBA 原始像素。
   *
   * ⚠ sharp 的 `toBuffer()` 只提供 Promise 版（无同步 API），故本方法为 async。
   *   下游 `extractFeatures()` / `computeGrid9()` 保持**同步纯函数** —— I/O 在此收敛，
   *   特征计算不引入任何异步，便于单测与确定性保证。
   *
   * @param {Buffer} buffer
   * @returns {Promise<{width:number, height:number, data:Buffer, channels:number}>}
   */
  async decodeToRgba(buffer) {
    const { data, info } = await this.sharp(buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data, channels: info.channels };
  }

  /**
   * 灰度缩放到 n×n（pHash 用）。
   * @param {Buffer} buffer
   * @param {number} n
   * @returns {Promise<{width:number, height:number, data:Buffer}>}
   */
  async toGreyscale(buffer, n) {
    const { data, info } = await this.sharp(buffer)
      .greyscale()
      .resize(n, n, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data };
  }

  /**
   * 主色统计。
   * @param {Buffer} buffer
   * @returns {Promise<{r:number,g:number,b:number}>}
   */
  async dominantColor(buffer) {
    const st = await this.sharp(buffer).stats();
    const d = st.dominant || { r: 0, g: 0, b: 0 };
    return { r: d.r, g: d.g, b: d.b };
  }

  /**
   * 生成缩略图 data: URI（contact sheet 用）。
   * @param {Buffer} buffer
   * @param {number} size
   * @returns {string} `data:image/png;base64,...`
   */
  async makeThumbDataUri(buffer, size) {
    const out = await this.sharp(buffer)
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9, effort: 4 })
      .toBuffer();
    return `data:image/png;base64,${out.toString('base64')}`;
  }
}

/**
 * pngjs 降级实现（仅 PNG）。sharp 装不上时的冒烟路径。
 */
class PngJsDecoder {
  constructor() {
    try {
      // eslint-disable-next-line global-require
      this.PNG = require('pngjs').PNG;
      this.sizeOf = resolveImageSize();
    } catch (err) {
      throw new AppError(CODES.DEP_MISSING, 'pngjs 降级实现不可用', { cause: err.message });
    }
  }

  /** @returns {string} */
  get name() { return 'pngjs'; }

  /**
   * @param {Buffer|string} input
   * @returns {{width:number, height:number, format:string}}
   */
  readSize(input) {
    const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
    const dim = this.sizeOf(buf);
    return { width: dim.width, height: dim.height, format: String(dim.type || 'png').toLowerCase() };
  }

  /**
   * @param {Buffer} buffer
   * @returns {{width:number, height:number, data:Buffer, channels:number}}
   */
  decodeToRgba(buffer) {
    const png = this.PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: png.data, channels: 4 };
  }

  /**
   * 灰度缩放（最近邻，够用）。
   * @param {Buffer} buffer
   * @param {number} n
   * @returns {{width:number, height:number, data:Buffer}}
   */
  toGreyscale(buffer, n) {
    const { width, height, data } = this.decodeToRgba(buffer);
    const out = Buffer.alloc(n * n);
    for (let y = 0; y < n; y++) {
      const sy = Math.min(height - 1, Math.floor((y * height) / n));
      for (let x = 0; x < n; x++) {
        const sx = Math.min(width - 1, Math.floor((x * width) / n));
        const s = (sy * width + sx) * 4;
        // Rec.601 亮度
        out[y * n + x] = Math.round(0.299 * data[s] + 0.587 * data[s + 1] + 0.114 * data[s + 2]);
      }
    }
    return { width: n, height: n, data: out };
  }

  /**
   * 主色：4bit 量化直方图众数（降级实现，精度低于 sharp 的 k-means）。
   * @param {Buffer} buffer
   * @returns {{r:number,g:number,b:number}}
   */
  dominantColor(buffer) {
    const { width, height, data } = this.decodeToRgba(buffer);
    const bins = new Map();
    for (let i = 0; i < width * height; i++) {
      if (data[i * 4 + 3] < 128) continue;
      const r = data[i * 4] >> 4;
      const g = data[i * 4 + 1] >> 4;
      const b = data[i * 4 + 2] >> 4;
      const key = (r << 8) | (g << 4) | b;
      const cur = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      cur.n++;
      cur.r += data[i * 4];
      cur.g += data[i * 4 + 1];
      cur.b += data[i * 4 + 2];
      bins.set(key, cur);
    }
    let best = null;
    for (const [key, v] of [...bins.entries()].sort((a, b) => a[0] - b[0])) {
      if (!best || v.n > best.v.n) best = { key, v };
    }
    if (!best) return { r: 0, g: 0, b: 0 };
    return {
      r: Math.round(best.v.r / best.v.n),
      g: Math.round(best.v.g / best.v.n),
      b: Math.round(best.v.b / best.v.n),
    };
  }

  /**
   * 缩略图 data: URI（最近邻缩放后重编码，确定性）。
   * @param {Buffer} buffer
   * @param {number} size
   * @returns {Promise<string>}
   */
  async makeThumbDataUri(buffer, size) {
    const { width, height, data } = this.decodeToRgba(buffer);
    const tw = Math.max(1, Math.min(size, width));
    const th = Math.max(1, Math.round((height * tw) / width));
    const out = new this.PNG({ width: tw, height: th });
    for (let y = 0; y < th; y++) {
      const sy = Math.min(height - 1, Math.floor((y * height) / th));
      for (let x = 0; x < tw; x++) {
        const sx = Math.min(width - 1, Math.floor((x * width) / tw));
        const s = (sy * width + sx) * 4;
        const d = (y * tw + x) * 4;
        out.data[d] = data[s];
        out.data[d + 1] = data[s + 1];
        out.data[d + 2] = data[s + 2];
        out.data[d + 3] = data[s + 3];
      }
    }
    const buf = this.PNG.sync.write(out);
    return `data:image/png;base64,${buf.toString('base64')}`;
  }
}

/**
 * 创建 decoder。优先 sharp，失败降级 pngjs。
 * @param {Object} [opts]
 * @param {'auto'|'sharp'|'pngjs'} [opts.prefer='auto']
 * @returns {SharpDecoder|PngJsDecoder}
 */
function createDecoder(opts = {}) {
  const prefer = opts.prefer || 'auto';
  if (prefer === 'pngjs') return new PngJsDecoder();
  if (prefer === 'sharp') return new SharpDecoder();
  try {
    return new SharpDecoder();
  } catch {
    return new PngJsDecoder();
  }
}

module.exports = {
  SharpDecoder,
  PngJsDecoder,
  createDecoder,
  isSupportedImage,
  resolveImageSize,
  SUPPORTED_EXT,
};
