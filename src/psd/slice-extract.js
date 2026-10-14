'use strict';
/**
 * src/psd/slice-extract.js —— R2-F3 导出切片
 *
 * 切片是「素材 ↔ 图层」最准的对应关系来源（Q7：若 PSD 保留了切片，L1 通道直接可用，
 * 准确率大幅提升）。但**不是所有 PSD 都有切片** —— 画师导出后往往不保存切片信息。
 *
 * 本模块的职责：把 PSD 里的切片整理成规范结构，并建立「切片 -> 图层」的归属关系。
 * 归属判定用**几何包含**（切片矩形完整落在某图层 bbox 内且面积占比最高），
 * 不用 `associatedLayerId` —— 实测该字段在多数文件里是 0 或指向错误的图层索引，
 * 直接采信会把切片挂到错误的节点上（比不挂更糟）。
 */

const { extractSlices } = require('./reader');

/**
 * 判断 rect1 是否完整包含 rect2。
 * @param {{x:number,y:number,w:number,h:number}} outer
 * @param {{x:number,y:number,w:number,h:number}} inner
 * @returns {boolean}
 */
function contains(outer, inner) {
  if (!outer || !inner) return false;
  return outer.x <= inner.x
    && outer.y <= inner.y
    && outer.x + outer.w >= inner.x + inner.w
    && outer.y + outer.h >= inner.y + inner.h;
}

/**
 * 两个矩形的重叠面积。
 * @param {{x:number,y:number,w:number,h:number}} a
 * @param {{x:number,y:number,w:number,h:number}} b
 * @returns {number}
 */
function overlapArea(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ix * iy;
}

/**
 * 把切片归属到图层。
 *
 * 规则（确定性、可解释）：
 *   1. 只考虑 raster / text / smartobject 图层（组不参与归属，组是容器）
 *   2. 切片矩形被图层 bbox **完整包含** 才算候选
 *   3. 多个候选时取 bbox 面积最小者（最贴合的那个图层），面积相同则取图层 id 小者
 *
 * @param {Object[]} layers IrBuilder 产出的扁平图层列表（已按 id 排序）
 * @param {Object[]} slices extractSlices 的输出
 * @returns {Map<string, {name:string, rect:Object, groupName:string}>} layerId -> slice
 */
function assignSlicesToLayers(layers, slices) {
  /** @type {Map<string, Object>} */
  const assigned = new Map();
  const candidates = layers.filter(
    (l) => l.type === 'raster' || l.type === 'text' || l.type === 'smartobject',
  );

  for (const s of slices) {
    let best = null;
    for (const l of candidates) {
      if (!contains(l.bbox, s.rect)) continue;
      const area = l.bbox.w * l.bbox.h;
      if (!best
        || area < best.area
        || (area === best.area && l.id < best.id)) {
        best = { layer: l, area };
      }
    }
    if (best) {
      assigned.set(best.layer.id, {
        name: s.name,
        rect: s.rect,
        groupName: s.groupName,
      });
    }
  }
  return assigned;
}

/**
 * 组装 Design IR 里的切片段落。
 *
 * @param {Object[]} slices extractSlices 的输出
 * @param {Map<string,Object>} assignment assignSlicesToLayers 的输出
 * @returns {{slices:Object[], sliceNames:string[], warnings:Object[]}}
 */
function buildSliceSection(slices, assignment) {
  const warnings = [];
  const assignedNames = new Set([...assignment.values()].map((v) => v.name));

  const out = slices.map((s) => {
    const entry = {
      name: s.name,
      type: s.type,
      groupName: s.groupName,
      rect: s.rect,
      layer: null,
    };
    // 反查归属图层（assignment 是 layerId -> slice，反向建一次）
    for (const [layerId, v] of assignment) {
      if (v.name === s.name) {
        entry.layer = layerId;
        break;
      }
    }
    if (!entry.layer) {
      warnings.push({
        code: 'NO_SLICE',
        layer: '',
        msg: `切片『${s.name}』(${s.rect.x},${s.rect.y},${s.rect.w}x${s.rect.h}) `
          + '未找到被它完整包含的图层，已保留切片记录但不参与 L1 匹配',
      });
    }
    return entry;
  });

  if (!slices.length) {
    warnings.push({
      code: 'NO_SLICE',
      layer: '',
      msg: 'PSD 内未找到导出切片信息，L1 最强匹配通道不可用，将退化为 L2 归一名匹配。'
        + '若画师能在 Photoshop 中保留切片，匹配准确率会显著提升（见 PRD Q7）',
    });
  }

  const sliceNames = slices.map((s) => s.name).filter((n) => !assignedNames.has(n) || true);
  return { slices: out, sliceNames: [...new Set(sliceNames)].sort(), warnings };
}

module.exports = {
  assignSlicesToLayers,
  buildSliceSection,
  contains,
  overlapArea,
  extractSlices,
};
