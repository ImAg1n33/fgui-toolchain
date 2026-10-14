'use strict';
/**
 * src/psd/canvas-shim.js —— ★ 免原生 canvas 垫片（ARCHITECTURE D2，坑 1）
 *
 * 背景与实测：
 *   `readPsd(buf, {skipLayerImageData:false})` 不装 canvas → `Error: Canvas not initialized`。
 *   装 `canvas` 原生包在本机装失败（缺 canvas.node），且引入原生编译是纯粹的失败面。
 *   但 ag-psd 其实**不需要真实渲染**，它只需要一个 ImageData 容器来装像素。
 *   实测：注入最小 2D context 垫片 + `useImageData:true` 后，
 *         图层 imageData 与合成图 imageData 都能正常导出，**零原生依赖**。
 *
 * ag-psd 侧的实际调用点（v31.0.3 源码核对）：
 *   - `helpers.createCanvas(w,h)`  → 我们提供 shim canvas
 *   - `helpers.createImageData(w,h)` → 我们直接给 {width,height,data:Uint8ClampedArray}
 *   - `imageDataToCanvas()` 会调 `canvas.getContext('2d').putImageData(imageData,0,0)`
 *   - `psdWriter` 的缩略图路径会调 `getContext('2d').drawImage(canvas,0,0)`
 *   故垫片至少要有：createImageData / getImageData / putImageData / drawImage
 *
 * 本模块同时提供一层「ImageData 工厂」供 fixture 造图使用（test/fixtures/make-psd.js）。
 */

'use strict';

/**
 * 创建一个 ImageData 等价对象。
 * @param {number} width
 * @param {number} height
 * @param {Uint8ClampedArray} [data] 可复用底层缓冲（避免重复分配）
 * @returns {{width:number, height:number, data:Uint8ClampedArray, colorSpace:string}}
 */
function createImageData(width, height, data) {
  const w = Math.max(0, Math.floor(width) || 0);
  const h = Math.max(0, Math.floor(height) || 0);
  return {
    width: w,
    height: h,
    data: data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(w * h * 4),
    // Node 环境没有 ColorSpace 全局；给出结构上正确的中性值，避免下游解构报错
    colorSpace: 'srgb',
  };
}

/**
 * 创建最小 canvas 垫片。
 *
 * 实现要点：
 *   - 像素存于 `_pixels`（ImageData 对象），putImageData 记录它，getImageData 按区域拷出。
 *   - drawImage 支持 (canvas|imageData, dx, dy) 与 (…, dx, dy, dw, dh) 两种最常见签名，
 *     做最近邻缩放。ag-psd 只用它做缩略图与合成预览，精度要求不高。
 *   - 记录调用计数，便于单测断言「确实走了垫片路径」。
 *
 * @param {number} width
 * @param {number} height
 * @returns {Object} canvas 垫片
 */
function createShimCanvas(width, height) {
  let w = Math.max(1, Math.floor(width) || 1);
  let h = Math.max(1, Math.floor(height) || 1);
  /** @type {{width:number,height:number,data:Uint8ClampedArray}|null} */
  let pixels = null;
  const stats = { put: 0, get: 0, draw: 0, create: 0 };

  const canvas = {
    /** 统计计数，单测断言用 */
    __shimStats: stats,
    /** ag-psd / 单测判定「这是垫片而非真 canvas」 */
    __isShim: true,

    get width() { return w; },
    set width(v) {
      w = Math.max(1, Math.floor(v) || 1);
      // 与浏览器一致：改尺寸清空像素
      pixels = null;
    },
    get height() { return h; },
    set height(v) {
      h = Math.max(1, Math.floor(v) || 1);
      pixels = null;
    },

    /**
     * @param {string} [type='2d']
     * @returns {Object} 2D context 垫片
     */
    getContext(type) {
      if (type && type !== '2d') return null; // 只支持 2d；ag-psd 也只用 2d
      return context;
    },

    /** 取出当前像素（ir-overlay 需要合成图时可用） */
    _getPixels() {
      return pixels;
    },
  };

  const context = {
    canvas,

    /**
     * @param {number} iw
     * @param {number} ih
     * @returns {Object} ImageData
     */
    createImageData(iw, ih) {
      stats.create++;
      return createImageData(iw, ih);
    },

    /**
     * @param {number} x
     * @param {number} y
     * @param {number} gw
     * @param {number} gh
     * @returns {Object}
     */
    getImageData(x, y, gw, gh) {
      stats.get++;
      const out = createImageData(gw, gh);
      if (!pixels) return out;
      for (let row = 0; row < gh; row++) {
        const sy = y + row;
        if (sy < 0 || sy >= h) continue;
        for (let col = 0; col < gw; col++) {
          const sx = x + col;
          if (sx < 0 || sx >= w) continue;
          const src = (sy * w + sx) * 4;
          const dst = (row * gw + col) * 4;
          out.data[dst] = pixels.data[src];
          out.data[dst + 1] = pixels.data[src + 1];
          out.data[dst + 2] = pixels.data[src + 2];
          out.data[dst + 3] = pixels.data[src + 3];
        }
      }
      return out;
    },

    /**
     * @param {Object} imgData
     * @param {number} [dx=0]
     * @param {number} [dy=0]
     */
    putImageData(imgData, dx = 0, dy = 0) {
      stats.put++;
      if (!imgData || !imgData.data) return;
      // 尺寸可能被 putImageData 之外的代码改过；这里对齐到 canvas 尺寸
      if (pixels && (pixels.width !== w || pixels.height !== h)) pixels = null;
      if (!pixels) pixels = createImageData(w, h);
      const x0 = Math.max(0, Math.floor(dx) || 0);
      const y0 = Math.max(0, Math.floor(dy) || 0);
      for (let row = 0; row < imgData.height; row++) {
        const ty = y0 + row;
        if (ty >= h) break;
        for (let col = 0; col < imgData.width; col++) {
          const tx = x0 + col;
          if (tx >= w) break;
          const src = (row * imgData.width + col) * 4;
          const dst = (ty * w + tx) * 4;
          pixels.data[dst] = imgData.data[src];
          pixels.data[dst + 1] = imgData.data[src + 1];
          pixels.data[dst + 2] = imgData.data[src + 2];
          pixels.data[dst + 3] = imgData.data[src + 3];
        }
      }
    },

    /**
     * 最小 drawImage：支持 (src, dx, dy) 与 (src, dx, dy, dw, dh)，最近邻采样。
     * @param {Object} src canvas 垫片或 ImageData
     * @param {number} dx
     * @param {number} dy
     * @param {number} [dw]
     * @param {number} [dh]
     */
    drawImage(src, dx, dy, dw, dh) {
      stats.draw++;
      const srcPixels = src && src.__isShim ? src._getPixels() : (src && src.data ? src : null);
      if (!srcPixels) return;
      if (!pixels || pixels.width !== w || pixels.height !== h) pixels = createImageData(w, h);
      const tw = dw === undefined ? srcPixels.width : Math.max(1, Math.floor(dw));
      const th = dh === undefined ? srcPixels.height : Math.max(1, Math.floor(dh));
      const x0 = Math.max(0, Math.floor(dx) || 0);
      const y0 = Math.max(0, Math.floor(dy) || 0);
      for (let ty = 0; ty < th; ty++) {
        const dy2 = y0 + ty;
        if (dy2 >= h) break;
        // 最近邻：源像素按比例取
        const sy = Math.min(srcPixels.height - 1, Math.floor((ty * srcPixels.height) / th));
        for (let tx = 0; tx < tw; tx++) {
          const dx2 = x0 + tx;
          if (dx2 >= w) break;
          const sx = Math.min(srcPixels.width - 1, Math.floor((tx * srcPixels.width) / tw));
          const s = (sy * srcPixels.width + sx) * 4;
          const d = (dy2 * w + dx2) * 4;
          // 简单 source-over（alpha 合成），足够缩略图用途
          const sa = srcPixels.data[s + 3] / 255;
          if (sa >= 1) {
            pixels.data[d] = srcPixels.data[s];
            pixels.data[d + 1] = srcPixels.data[s + 1];
            pixels.data[d + 2] = srcPixels.data[s + 2];
            pixels.data[d + 3] = 255;
          } else if (sa > 0) {
            const da = pixels.data[d + 3] / 255;
            const oa = sa + da * (1 - sa);
            if (oa > 0) {
              pixels.data[d] = Math.round((srcPixels.data[s] * sa + pixels.data[d] * da * (1 - sa)) / oa);
              pixels.data[d + 1] = Math.round((srcPixels.data[s + 1] * sa + pixels.data[d + 1] * da * (1 - sa)) / oa);
              pixels.data[d + 2] = Math.round((srcPixels.data[s + 2] * sa + pixels.data[d + 2] * da * (1 - sa)) / oa);
              pixels.data[d + 3] = Math.round(oa * 255);
            }
          }
        }
      }
    },

    /** ag-psd 未用到，但给出以防扩展调用 */
    clearRect() {},
    fillRect() {},
    save() {},
    restore() {},
  };

  return canvas;
}

/**
 * 已初始化标记（ag-psd 的 helpers 是模块级单例，重复 initializeCanvas 无害但要能查）。
 */
let initialized = false;

/**
 * 初始化 ag-psd 的 canvas 垫片。**幂等**。
 * @param {Object} [opts]
 * @param {boolean} [opts.force=false] 已初始化时是否强制重装
 * @returns {{initialized:boolean, agPsd:Object}} agPsd 模块引用，便于调用方直接用 readPsd
 */
function installCanvasShim(opts = {}) {
  // eslint-disable-next-line global-require
  const agPsd = require('ag-psd');
  if (initialized && !opts.force) return { initialized: true, agPsd };
  agPsd.initializeCanvas(createShimCanvas, createImageData);
  initialized = true;
  return { initialized: true, agPsd };
}

/**
 * 是否已安装垫片。
 * @returns {boolean}
 */
function isInstalled() {
  return initialized;
}

/**
 * 便捷读取：把 ag-psd 的 imageData 转成 Buffer（ir-overlay 需要 base64 PNG 时用）。
 * @param {{width:number,height:number,data:Uint8ClampedArray}} imageData
 * @returns {Buffer}
 */
function imageDataToBuffer(imageData) {
  if (!imageData || !imageData.data) return Buffer.alloc(0);
  return Buffer.from(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);
}

/**
 * 造一张纯色 ImageData（fixture 用）。
 * @param {number} w
 * @param {number} h
 * @param {[number,number,number,number]} rgba
 * @returns {Object}
 */
function solidImageData(w, h, rgba) {
  const img = createImageData(w, h);
  const [r, g, b, a] = rgba;
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = a;
  }
  return img;
}

/**
 * ★ 把图层树合成为预览图（写 PSD 前的必要步骤）★
 *
 * ## 为什么不提供这个函数就会静默产出全黑图
 *
 * 实测（QA BUG #2 的根因）：`ag-psd` 的 writer **不会自动把图层合成成预览图**。
 * 源码 `psdWriter.js:218` 只做这三件事：
 *     let imageData = psd.imageData;
 *     if (!imageData && psd.canvas) { imageData = psd.canvas.getContext('2d').getImageData(...) }
 *     // 之后直接把这个 imageData 写进 PSD 的合成图区
 * —— 它**只写你给的** `psd.imageData`。不给，读回来就是一张**全黑不透明图**。
 *
 * 为什么这个坑危险：`ir_overlay.html` 的唯一用途是让小 Q 把 bbox 叠在效果图上
 * 人工核对。全黑底图 = 把人工校验手段本身搞坏，而且「看起来正常」。
 * 更隐蔽的是它**不会报错**：alpha 通道照样是 255，所以「非空」类断言查不出来。
 *
 * ## 用法（写 PSD 之前）
 *     const psd = { width, height, children: layers };
 *     psd.imageData = composeImageData(width, height, layers);  // ← 少了这行就是全黑图
 *     const buf = writePsdBuffer(psd);
 *
 * @param {number} canvasW
 * @param {number} canvasH
 * @param {Object[]} layers ag-psd Layer 树（组用 children 表达）
 * @returns {{width:number, height:number, data:Uint8ClampedArray}}
 */
function composeImageData(canvasW, canvasH, layers) {
  const data = new Uint8ClampedArray(canvasW * canvasH * 4); // 全透明起始

  /**
   * source-over 混合一张带 alpha 的图层。
   * @param {Object} layer
   */
  const draw = (layer) => {
    if (Array.isArray(layer.children)) {
      // 组本身不贡献像素，只合成其子层
      // ★ 组内同样倒序：children[0] = 最上层（组内语义与顶层一致）
      for (let i = layer.children.length - 1; i >= 0; i--) draw(layer.children[i]);
      return;
    }
    const img = layer.imageData;
    if (!img || !img.data || img.width <= 0 || img.height <= 0) return;
    if (layer.hidden) return;

    const layerOpacity = layer.opacity === undefined ? 1 : layer.opacity;
    const lx = layer.left || 0;
    const ly = layer.top || 0;

    for (let y = 0; y < img.height; y++) {
      const dy = ly + y;
      if (dy < 0 || dy >= canvasH) continue;
      for (let x = 0; x < img.width; x++) {
        const dx = lx + x;
        if (dx < 0 || dx >= canvasW) continue;
        const s = (y * img.width + x) * 4;
        const d = (dy * canvasW + dx) * 4;

        const sa = (img.data[s + 3] / 255) * layerOpacity;
        if (sa <= 0) continue;
        const da = data[d + 3] / 255;
        const oa = sa + da * (1 - sa);
        if (oa <= 0) {
          data[d] = 0; data[d + 1] = 0; data[d + 2] = 0; data[d + 3] = 0;
          continue;
        }
        data[d] = Math.round((img.data[s] * sa + data[d] * da * (1 - sa)) / oa);
        data[d + 1] = Math.round((img.data[s + 1] * sa + data[d + 1] * da * (1 - sa)) / oa);
        data[d + 2] = Math.round((img.data[s + 2] * sa + data[d + 2] * da * (1 - sa)) / oa);
        data[d + 3] = Math.round(oa * 255);
      }
    }
  };

  // children[0] = 最上层 -> 倒序才是「从下到上」
  for (let i = layers.length - 1; i >= 0; i--) draw(layers[i]);

  return { width: canvasW, height: canvasH, data };
}

/**
 * 校验合成图是否真的有内容（全黑 / 全透明 = 造错了，不该放行）。
 *
 * ★ 这个自检的价值 ★：`checkComposite` 返回 ok=false 时**应当直接抛错**，
 *   而不是继续写盘 —— 「造出一张全黑图还以为成功了」正是 BUG #2 的成因。
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} img
 * @param {Object} [opts]
 * @param {number} [opts.minNonBlackRatio=0.01] 非黑像素占比下限
 * @param {number} [opts.minDistinctColors=3] 不同颜色数下限
 * @returns {{ok:boolean, nonBlackRatio:number, distinctColors:number, msg:string}}
 */
function checkComposite(img, opts = {}) {
  const minRatio = opts.minNonBlackRatio === undefined ? 0.01 : opts.minNonBlackRatio;
  const minColors = opts.minDistinctColors === undefined ? 3 : opts.minDistinctColors;
  if (!img || !img.data) {
    return { ok: false, nonBlackRatio: 0, distinctColors: 0, msg: '合成图为空' };
  }
  const seen = new Set();
  let nonBlack = 0;
  let sampled = 0;
  // 大图抽样，避免自检本身成为瓶颈（抽样只用于「是否退化」的判定）
  const stride = img.width * img.height > 400000 ? 4 : 1;
  for (let i = 0; i < img.data.length; i += 4 * stride) {
    sampled++;
    const r = img.data[i];
    const g = img.data[i + 1];
    const b = img.data[i + 2];
    if (r || g || b) nonBlack++;
    if (seen.size < 64) seen.add(`${r >> 3},${g >> 3},${b >> 3}`);
  }
  const ratio = nonBlack / Math.max(1, sampled);
  const ok = ratio > minRatio && seen.size > minColors;
  return {
    ok,
    nonBlackRatio: Math.round(ratio * 1e6) / 1e6,
    distinctColors: seen.size,
    msg: ok
      ? `合成图 OK：非黑 ${(ratio * 100).toFixed(1)}%，${seen.size} 种颜色`
      : `★ 合成图退化：非黑仅 ${(ratio * 100).toFixed(2)}%，${seen.size} 种颜色 —— `
        + '通常是图层顺序写反（全幅底框盖住了子层）或漏了 psd.imageData',
  };
}

module.exports = {
  createImageData,
  createShimCanvas,
  installCanvasShim,
  isInstalled,
  imageDataToBuffer,
  solidImageData,
  composeImageData,
  checkComposite,
};
