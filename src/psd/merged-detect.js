'use strict';
/**
 * src/psd/merged-detect.js —— R2-F5 合并图层标记 + lost_info 告警
 *
 * 业务事实（PRD §1 / K4）：**第二份 PSD 只给新增素材分层，重复素材被合并、不再分层。**
 * 被合并的组一旦漏报，后面 R3 就一定会猜错素材（PRD 原文：漏报 = 后面必猜错）。
 *
 * 判据（ARCHITECTURE §4.6）：
 *   组 G 满足以下全部条件 -> merged = true
 *     ① G.childCount > 0
 *     ② G 的**整棵子树**里所有叶子层都是 raster（没有文本层 —— 文本层无法被合并掉）
 *     ③ G 的整棵子树里**没有任何图层携带 slice**（有切片说明画师还在按素材分层）
 *
 * merged=true 的图层在 R3 中的行为（架构 §4.6）：
 *   - 允许 L3（pHash）尝试匹配，但 confidence 强制封顶 0.5
 *   - 匹配失败一律 L4 -> INFERRED，defaultIfUnconfirmed='skip'
 *   - 不进人工确认队列的**自动写入**路径
 */

/**
 * 判断一个 ag-psd 图层是不是「组」。
 * @param {Object} layer
 * @returns {boolean}
 */
function isGroup(layer) {
  return !!(layer && Array.isArray(layer.children));
}

/**
 * 递归收集子树的叶子层（非组节点）。
 * @param {Object} layer
 * @returns {Object[]}
 */
function collectLeaves(layer) {
  if (!isGroup(layer)) return [layer];
  const out = [];
  for (const c of layer.children || []) out.push(...collectLeaves(c));
  return out;
}

/**
 * 递归收集子树的所有节点（含组自身之外的所有层）。
 * @param {Object} layer
 * @returns {Object[]}
 */
function collectAll(layer) {
  if (!isGroup(layer)) return [layer];
  const out = [];
  for (const c of layer.children || []) out.push(...collectAll(c));
  return out;
}

/**
 * 判定一个组是否被画师合并。
 *
 * @param {Object} groupLayer ag-psd 组图层
 * @param {Object} ctx
 * @param {Map<number,Object>} [ctx.sliceByLayerIndex] 图层索引 -> 是否有 slice
 *        （由 ir-builder 预先算好；缺省时视为无 slice）
 * @returns {{merged:boolean, reason:string, leafCount:number, textCount:number, sliceCount:number}}
 */
function detectMerged(groupLayer, ctx = {}) {
  const sliceByIndex = ctx.sliceByLayerIndex || new Map();
  const leaves = collectLeaves(groupLayer);

  if (!leaves.length) {
    return { merged: false, reason: 'empty_group', leafCount: 0, textCount: 0, sliceCount: 0 };
  }

  let textCount = 0;
  let smartCount = 0;
  let sliceCount = 0;
  for (const leaf of leaves) {
    if (leaf.text) textCount++;
    if (leaf.smartObject || leaf.placedLayer) smartCount++;
    if (sliceByIndex.get(leaf.__irIndex) !== undefined) sliceCount++;
  }

  // ① 空组不算合并
  if (leaves.length === 0) {
    return { merged: false, reason: 'empty_group', leafCount: 0, textCount, sliceCount };
  }
  // ② 含文本层 -> 画师还在分层（文本层没法被合并成一个像素块）
  if (textCount > 0) {
    return { merged: false, reason: 'has_text_layer', leafCount: leaves.length, textCount, sliceCount };
  }
  // ③ 含智能对象 -> 智能对象保留独立身份，不算合并
  if (smartCount > 0) {
    return { merged: false, reason: 'has_smart_object', leafCount: leaves.length, textCount, sliceCount };
  }
  // ③ 含切片 -> 画师仍按素材分层
  if (sliceCount > 0) {
    return { merged: false, reason: 'has_slice', leafCount: leaves.length, textCount, sliceCount };
  }
  // ② 叶子必须全是 raster（上面已排除 text/smartobject，这里再确认没有 group 混入）
  const nonRaster = leaves.filter((l) => l.text || l.smartObject || l.placedLayer);
  if (nonRaster.length) {
    return {
      merged: false,
      reason: 'has_non_raster',
      leafCount: leaves.length,
      textCount,
      sliceCount,
    };
  }

  return {
    merged: true,
    reason: 'all_raster_subtree_without_slice',
    leafCount: leaves.length,
    textCount,
    sliceCount,
  };
}

/**
 * 生成合并告警（进人工确认队列）。
 *
 * @param {Object} irGroup IR 里的组节点（含 id / name / childCount）
 * @param {Object} info detectMerged 的返回值
 * @returns {{code:string, layer:string, msg:string, lost_info:Object}}
 */
function buildMergedWarning(irGroup, info) {
  return {
    code: 'MERGED_LAYER_GROUP',
    layer: irGroup.id,
    msg: `组『${irGroup.name}』被合并，展开为 ${info.leafCount} 层扁平内容；`
      + '子层信息不可恢复，后续匹配将限 L3 且置信度封顶 0.5，未命中一律 skip',
    lost_info: {
      reason: 'merged_layer_group',
      leafCount: info.leafCount,
      textCount: info.textCount,
      sliceCount: info.sliceCount,
      groupName: irGroup.name,
      groupId: irGroup.id,
      // 明确写出「这层必须人工确认」，让下游不必再猜
      requiresHumanConfirm: true,
      allowedMatchLevel: 'L3',
      confidenceCap: 0.5,
      defaultIfUnconfirmed: 'skip',
    },
  };
}

module.exports = {
  detectMerged,
  buildMergedWarning,
  isGroup,
  collectLeaves,
  collectAll,
};
