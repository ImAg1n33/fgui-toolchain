'use strict';
/**
 * src/psd/reader.js —— ag-psd 封装（结构 + 合成图两档）
 *
 * 两档解析模式（对应两种用途）：
 *   'structure'  skipLayerImageData:true,  skipCompositeImageData:true
 *                只要图层树/坐标/文本/切片 —— 快，内存小，用于「只要 IR 骨架」的场景。
 *   'full'       skipLayerImageData:false, skipCompositeImageData:false, useImageData:true
 *                连像素一起导出 —— 供 ir-overlay（合成图）与 L3 pHash 兜底用。
 *
 * ★ 两种模式都必须先装 CanvasShim ★
 *   实测：不装 shim 时 `skipLayerImageData:false` 直接抛
 *   `Error: Canvas not initialized`；即便带 `useImageData:true`，
 *   只要 skipLayerImageData 不是 true 就仍会走 imageDataToCanvas 而炸。
 *   装上 shim + useImageData:true 后，**图层与合成图的 imageData 都能正常导出**。
 */

const fs = require('fs');
const { installCanvasShim } = require('./canvas-shim');
const { sha256 } = require('../core/hash');
const { AppError, CODES } = require('../core/errors');

/** 解析模式常量。 */
const MODE = Object.freeze({ STRUCTURE: 'structure', FULL: 'full' });

/**
 * 由模式得到 ag-psd 的 readPsd 选项。
 * @param {string} mode
 * @returns {Object}
 */
function readOptionsFor(mode) {
  if (mode === MODE.STRUCTURE) {
    return { skipLayerImageData: true, skipCompositeImageData: true };
  }
  return {
    skipLayerImageData: false,
    skipCompositeImageData: false,
    // ★ 关键：强制走 imageData 路径而不是 canvas 路径（shim 只提供容器，不做渲染）
    useImageData: true,
  };
}

/**
 * 读取一份 PSD。
 *
 * @param {string} psdPath PSD 文件路径
 * @param {Object} [opts]
 * @param {string} [opts.mode='full'] 'structure' | 'full'
 * @returns {{psd:Object, psdPath:string, sha256:string, bytes:number, mode:string}}
 */
function readPsdFile(psdPath, opts = {}) {
  const mode = opts.mode || MODE.FULL;
  if (!fs.existsSync(psdPath)) {
    throw new AppError(CODES.FILE_NOT_FOUND, `PSD 不存在: ${psdPath}`, { psdPath });
  }
  const buf = fs.readFileSync(psdPath);

  // 幂等，但显式调用以保证「无论调用方是否已装，reader 自身是自洽的」
  installCanvasShim();
  // eslint-disable-next-line global-require
  const { readPsd } = require('ag-psd');

  let psd;
  try {
    psd = readPsd(buf, readOptionsFor(mode));
  } catch (err) {
    throw new AppError(CODES.PSD_PARSE_FAILED, `PSD 解析失败: ${psdPath}`, {
      cause: err.message,
      mode,
    });
  }

  return {
    psd,
    psdPath,
    sha256: sha256(buf),
    bytes: buf.length,
    mode,
  };
}

/**
 * 取合成图（效果图）。FULL 模式下才有。
 *
 * 优先取 `psd.imageData`；若只有 `psd.canvas`（真 canvas 路径），
 * 尝试从 shim canvas 内部取像素。
 *
 * @param {Object} psd
 * @returns {{width:number,height:number,data:Uint8ClampedArray}|null}
 */
function compositeImageData(psd) {
  if (!psd) return null;
  if (psd.imageData && psd.imageData.data) return psd.imageData;
  if (psd.canvas && psd.canvas.__isShim) {
    const px = psd.canvas._getPixels();
    if (px) return px;
  }
  return null;
}

/**
 * 取某个图层的 imageData（FULL 模式下才有）。
 * @param {Object} layer ag-psd Layer
 * @returns {{width:number,height:number,data:Uint8ClampedArray}|null}
 */
function layerImageData(layer) {
  if (!layer) return null;
  if (layer.imageData && layer.imageData.data) return layer.imageData;
  if (layer.canvas && layer.canvas.__isShim) {
    const px = layer.canvas._getPixels();
    if (px) return px;
  }
  return null;
}

/**
 * 取出 PSD 内的导出切片（若画师保留了切片信息 —— L1 最强匹配通道的来源）。
 *
 * ★ 实测：切片挂在 `psd.imageResources.slices`，不是 `psd.slices` ★
 *   ag-psd 源码 imageResources.js 用 `addHandler(1050, target => target.slices ...)`
 *   而 1050 号资源的 target 就是 imageResources 对象。
 *
 * @param {Object} psd
 * @returns {{groupName:string, name:string, type:string,
 *            rect:{x:number,y:number,w:number,h:number}}[]}
 */
function extractSlices(psd) {
  const groups = (psd && psd.imageResources && psd.imageResources.slices) || [];
  const out = [];
  for (const g of groups) {
    for (const s of (g.slices || [])) {
      const b = s.bounds || {};
      const x = b.left === undefined ? b.Left || 0 : b.left;
      const y = b.top === undefined ? b.Top || 0 : b.top;
      const right = b.right === undefined ? b.Rght || 0 : b.right;
      const bottom = b.bottom === undefined ? b.Btom || 0 : b.bottom;
      if (!s.name) continue; // 无名切片对检索无价值，跳过
      out.push({
        groupName: g.groupName || '',
        name: String(s.name),
        type: s.type === 'noImage' ? 'noImage' : 'image',
        rect: { x, y, w: right - x, h: bottom - y },
      });
    }
  }
  // 确定性排序：按名再按坐标
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1
    : (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x)));
  return out;
}

module.exports = {
  readPsdFile,
  readOptionsFor,
  compositeImageData,
  layerImageData,
  extractSlices,
  MODE,
};
