'use strict';
/**
 * src/psd/merged-detect.js —— R2-F5 合并图层标记 + lost_info 告警
 *
 * 业务事实（PRD §1 / K4）：**第二份 PSD 只给新增素材分层，重复素材被合并、不再分层。**
 * 被合并的组一旦漏报，后面 R3 就一定会猜错素材（PRD 原文：漏报 = 后面必猜错）。
 *
 * 判据（ARCHITECTURE §4.6 + ★ UPSTREAM-FIX-1 两档语义 ★）：
 *
 *   ★ 为什么「无切片」不能单独当合并证据 ★（外部审查发现的误判，已核实）：
 *     本项目的业务背景是「第二份 PSD 只给新增素材分层，重复素材被合并」。
 *     旧规则把「子树无切片」当成了合并的正向证据 —— 但真实 PSD 很可能
 *     **整份都没有切片**（画师导出后不保存切片信息是常态，见 Q7）。
 *     在无切片的文档里，「无切片」是常态而不是异常信号，
 *     把常态当证据必然大面积误判（按钮背景/高光/装饰边框三个独立
 *     图层会被误标 merged -> planner 里限 L3、置信度封顶 0.5、
 *     未命中进 INFERRED -> 大量人工确认，恰好抵消提效目标）。
 *
 *   因此判据拆成两档：
 *
 *   【强证据 -> merged = true】文档本身有切片（docHasSlices = true，
 *   即全文档切片总数 > 0，说明画师确实在用切片工具）时：
 *     ① G.childCount > 0
 *     ② G 的**整棵子树**里所有叶子层都是 raster（没有文本层 / 智能对象）
 *     ③ G 的整棵子树里没有任何图层携带 slice
 *     —— 在「画师会用切片」的文档里，唯独某组整棵子树无切片才是异常信号。
 *     （TODO（正向像素证据，本轮未实现）：组 bbox 内像素与某单一切图一致、
 *       或子图层间存在完全相同的像素内容，可直接作为不依赖切片的强证据。）
 *
 *   【弱信号 -> merged = false，suspected = true】文档没有切片
 *   （docHasSlices = false）时，同样形态只降级为「疑似合并」：
 *     - IR 里不标 merged = true，只落 suspectedMerged = true，
 *       并发一条 SUSPECTED_MERGED_GROUP 轻度提示（info 级）。
 *
 * ★ 启发式信号的下游语义（★ UPSTREAM-FIX-4：成本不对称重构 ★）★
 *   merged / suspected 是**启发式信号，不改变匹配路径，仅影响未命中去向**：
 *     - merged/suspected 组内图层照常走 L1/L2/L3 全部匹配档位 ——
 *       匹配成功（尤其 L1 slice 名一致 / L2 归一名全等）本身就证明没被合并；
 *       「merged: true 建议人工确认后仍不成立时才排除」。
 *     - 未命中且位于 merged/suspected 组内的图层进 INFERRED（留人工确认）
 *       而非 ADD；REMOVE 侧同样压置信度（classifier.js / planner.js 职责）。
 *     - L3（视觉相似，弱证据）命中疑似合并对象时 confidence 封顶 0.5。
 *   成本不对称依据：误判 merged 若禁用精确匹配，会无理放弃正常独立组的
 *   L1/L2（高代价）；漏判时真合并组在第二份 PSD 里没有独立子层，L1/L2
 *   本来就会失败、自然落入 L3/未命中（低代价）—— 所以宁可让启发式只做
 *   保守的「去向修正」，不做激进的「路径封锁」。
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
 * 判定一个组是否被画师合并（两档语义，见文件头）。
 *
 * @param {Object} groupLayer ag-psd 组图层
 * @param {Object} ctx
 * @param {Map<number,Object>} [ctx.sliceByLayerIndex] 图层索引 -> 是否有 slice
 *        （由 ir-builder 预先算好；缺省时视为无 slice）
 * @param {boolean} [ctx.docHasSlices] 全文档是否存在切片（切片总数 > 0）。
 *        ★ 这是「无切片」信号有没有判别力的分水岭：文档有切片时
 *        「本组无切片」才是异常信号（强证据）；文档没有切片时
 *        「无切片」是常态，只能降级为疑似（弱信号）。
 * @returns {{merged:boolean, suspected:boolean, reason:string, evidenceStrength:string,
 *            leafCount:number, textCount:number, sliceCount:number}}
 */
function detectMerged(groupLayer, ctx = {}) {
  const sliceByIndex = ctx.sliceByLayerIndex || new Map();
  const docHasSlices = ctx.docHasSlices === true;
  const leaves = collectLeaves(groupLayer);

  if (!leaves.length) {
    return {
      merged: false, suspected: false, reason: 'empty_group',
      evidenceStrength: 'none', leafCount: 0, textCount: 0, sliceCount: 0,
    };
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
    return {
      merged: false, suspected: false, reason: 'empty_group',
      evidenceStrength: 'none', leafCount: 0, textCount, sliceCount,
    };
  }
  // ② 含文本层 -> 画师还在分层（文本层没法被合并成一个像素块）
  if (textCount > 0) {
    return {
      merged: false, suspected: false, reason: 'has_text_layer',
      evidenceStrength: 'none', leafCount: leaves.length, textCount, sliceCount,
    };
  }
  // ③ 含智能对象 -> 智能对象保留独立身份，不算合并
  if (smartCount > 0) {
    return {
      merged: false, suspected: false, reason: 'has_smart_object',
      evidenceStrength: 'none', leafCount: leaves.length, textCount, sliceCount,
    };
  }
  // ④ 含切片 -> 画师仍按素材分层（无论文档级有没有切片，本组都明确未合并）
  if (sliceCount > 0) {
    return {
      merged: false, suspected: false, reason: 'has_slice',
      evidenceStrength: 'none', leafCount: leaves.length, textCount, sliceCount,
    };
  }
  // ⑤ 叶子必须全是 raster（上面已排除 text/smartobject，这里再确认没有 group 混入）
  const nonRaster = leaves.filter((l) => l.text || l.smartObject || l.placedLayer);
  if (nonRaster.length) {
    return {
      merged: false, suspected: false, reason: 'has_non_raster',
      evidenceStrength: 'none', leafCount: leaves.length, textCount, sliceCount,
    };
  }

  // ---- 两档分叉点：全部 raster 且子树无切片 ----
  if (docHasSlices) {
    // 强证据：画师在这个文档里确实在用切片，唯独本组整棵子树没有 —— 异常信号成立
    return {
      merged: true,
      suspected: false,
      reason: 'all_raster_subtree_without_slice',
      evidenceStrength: 'strong',
      leafCount: leaves.length,
      textCount,
      sliceCount,
    };
  }
  // 弱信号：整份文档没有切片，「无切片」是常态而非证据 —— 只降级为疑似，
  // 绝不标 merged（否则 planner/matcher 的 L3 封顶与 INFERRED 联动会被常态误触发）
  return {
    merged: false,
    suspected: true,
    reason: 'all_raster_subtree_without_slice',
    evidenceStrength: 'weak',
    leafCount: leaves.length,
    textCount,
    sliceCount,
  };
}

/**
 * 生成「疑似合并」的轻度提示（info 级，进 IR warnings 但不进人工确认队列）。
 *
 * 与 buildMergedWarning 的区别：
 *   - code 是 SUSPECTED_MERGED_GROUP（不是 MERGED_LAYER_GROUP）；
 *   - requiresHumanConfirm = false —— 不拦截流程、不触发 planner 联动；
 *   - 文案明确说「这只是疑似」，避免下游把提示当结论。
 *
 * @param {Object} irGroup IR 里的组节点（含 id / name / childCount）
 * @param {Object} info detectMerged 的返回值（suspected 档）
 * @returns {{code:string, layer:string, msg:string, lost_info:Object}}
 */
function buildSuspectedMergedWarning(irGroup, info) {
  return {
    code: 'SUSPECTED_MERGED_GROUP',
    layer: irGroup.id,
    msg: `组『${irGroup.name}』(${irGroup.id}) 由 ${info.leafCount} 个纯栅格叶子组成，`
      + '整棵子树无文本层/智能对象/切片。注意：本 PSD 整份没有切片信息，'
      + '「无切片」在此是常态而非合并证据，因此**不判定为合并组**，仅作疑似提示：'
      + '子层可能仍独立可编辑。若人工核对该组内容确实被扁平化，请按合并组处理',
    lost_info: {
      reason: 'all_raster_subtree_without_slice',
      leafCount: info.leafCount,
      textCount: info.textCount,
      sliceCount: info.sliceCount,
      groupName: irGroup.name,
      groupId: irGroup.id,
      // info 级：不要求人工确认、不触发任何联动（与强证据档的关键区别）
      severity: 'info',
      suspected: true,
      requiresHumanConfirm: false,
    },
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
  buildSuspectedMergedWarning,
  isGroup,
  collectLeaves,
  collectAll,
};
