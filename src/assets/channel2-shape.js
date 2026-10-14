'use strict';
/**
 * src/assets/channel2-shape.js —— Ch-2 尺寸 + alpha 包围盒 IoU
 *
 * 覆盖场景：画师改了图层名（`矩形11` 变成 `组1200拷贝`），但图形没变、尺寸没变。
 *
 * 打分逻辑：
 *   1. 尺寸硬过滤：|图层 bbox 尺寸 - 切图尺寸| <= tol（与 Ch-1 同一容差，默认 ±2px）
 *   2. alpha 包围盒 IoU：把图层 bbox 与切图 alpha 包围盒都归一化到单位框后算交并比。
 *      为什么要归一化：切图本身通常就是紧贴内容的（图层 bbox ≈ 切图尺寸），
 *      直接算绝对 IoU 会退化成尺寸比较；归一化后比较的是**内容形状分布**，
 *      对「同一图形但切图留了边白」这类情况更鲁棒。
 *   3. 输出 0..1 的 ch2 分。
 */

const { round6 } = require('../core/determinism');

/**
 * 把 bbox 归一化到 [0,1]×[0,1]（保留长宽比信息：x/w, y/h）。
 * @param {{x:number,y:number,w:number,h:number}} box
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
function normalizeBox(box) {
  if (!box || box.w <= 0 || box.h <= 0) return null;
  return {
    x: box.x / box.w,
    y: box.y / box.h,
    w: 1,
    h: 1,
  };
}

/**
 * 两个 bbox 的 IoU（交并比），0..1。
 * @param {{x:number,y:number,w:number,h:number}} a
 * @param {{x:number,y:number,w:number,h:number}} b
 * @returns {number}
 */
function iou(a, b) {
  if (!a || !b) return 0;
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni <= 0 ? 0 : inter / uni;
}

/**
 * Ch-2 检索。
 *
 * @param {Object} args
 * @param {import('./store').AssetStore} args.index
 * @param {{w:number,h:number}|null} args.layerBox
 * @param {number} [args.tol=2] 尺寸容差 px
 * @returns {{ch2ById:Map<string, number>, candidates:Object[], evidence:string}}
 *          ch2ById: assetId -> 0..1 分值（供 search.js 加权）
 */
function channel2Shape(args) {
  const { index, layerBox } = args;
  const tol = args.tol === undefined ? 2 : args.tol;
  /** @type {Map<string, number>} */
  const ch2ById = new Map();
  const candidates = [];

  if (!layerBox || !Number.isFinite(layerBox.w) || !Number.isFinite(layerBox.h)) {
    return {
      ch2ById,
      candidates,
      evidence: 'Ch-2 跳过：未提供图层 bbox 尺寸',
    };
  }

  const wantSize = { w: layerBox.w, h: layerBox.h };
  const rows = index.bySize(wantSize, tol);
  if (!rows.length) {
    return {
      ch2ById,
      candidates,
      evidence: `Ch-2 未命中：素材库中没有尺寸落在 ${wantSize.w}x${wantSize.h} ±${tol}px 的切图`,
    };
  }

  // 归一化后的图层框（用 bbox 自身尺寸归一，原点即 0,0）
  const normLayer = normalizeBox({ x: 0, y: 0, w: layerBox.w, h: layerBox.h });

  for (const r of rows) {
    // 尺寸接近度：容差内线性衰减，容差边缘 -> 0
    const dw = Math.abs(r.w - layerBox.w);
    const dh = Math.abs(r.h - layerBox.h);
    const sizeScore = 1 - (dw + dh) / (2 * tol || 1);
    // alpha 包围盒 IoU（切图有 alpha 信息时才用，否则退化为 1，让尺寸说话）
    const normAsset = normalizeBox(
      (r.features && r.features.alphaBox)
        ? { x: r.features.alphaBox.x, y: r.features.alphaBox.y, w: r.features.alphaBox.w, h: r.features.alphaBox.h }
        : { x: 0, y: 0, w: r.w, h: r.h },
    );
    const shapeScore = iou(normLayer, normAsset);
    // 综合：尺寸 0.6 + 形状 0.4（形状权重低是因为 alpha 包围盒信息常常缺失）
    const score = Math.max(0, Math.min(1, sizeScore * 0.6 + shapeScore * 0.4));
    ch2ById.set(r.id, round6(score));
    candidates.push({ asset: r, ch2: round6(score), sizeScore: round6(sizeScore), shapeScore: round6(shapeScore) });
  }

  // 确定性排序：分值降序，同分按 id 升序
  candidates.sort((a, b) => (b.ch2 - a.ch2)
    || (a.asset.id < b.asset.id ? -1 : a.asset.id > b.asset.id ? 1 : 0));

  return {
    ch2ById,
    candidates,
    evidence: `Ch-2 命中 ${rows.length} 张同尺寸切图，`
      + `最高分 ${candidates.length ? candidates[0].ch2 : 0}`
      + `（${candidates.length ? candidates[0].asset.relPath : '-'}）`,
  };
}

module.exports = { channel2Shape, iou, normalizeBox };
