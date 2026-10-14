'use strict';
/**
 * test/unit/helpers/reference-union.js —— **独立编写**的递归并集对账基准
 *
 * ★★ 这个文件存在的唯一理由：打破自证循环 ★★
 *
 * QA 的核心批评一针见血：
 * > 「工程师的 ir-builder.test.js 有一条『组 bbox 与独立算一遍的子层并集精确对账』
 * >   （assert.deepEqual），看起来很严格。**但它对账用的递归算法里有和被测代码一样的缺陷**
 * >   （只算叶子不递归子组），**所以『精确对账』是拿同一把尺子量自己**。」
 *
 * 本文件**不 import 任何 src/ 代码**，不调用 `deriveGroupBox`，
 * 完全按 ARCHITECTURE D3 的文字定义独立实现一遍：
 *   「组的 bbox 由子层并集推导；子层是组则递归其子层；绝不读组自身坐标。」
 *
 * 实现风格也与被测代码刻意不同（用 filter + reduce 而非 for 循环 + min/max），
 * 尽量避免「同一个笔误被复制两份」。
 */

/**
 * 算某个组节点的 bbox 并集（按 parentId 索引的扁平图层列表）。
 *
 * @param {string} nodeId 目标组节点的 id
 * @param {Object[]} nodes 扁平图层列表（每项含 id/parent/type/bbox）
 * @param {number} [depth=0] 内部递归用
 * @returns {{x:number,y:number,w:number,h:number}|null} 空组返回 null
 */
function referenceUnionBox(nodeId, nodes, depth) {
  const d = depth || 0;
  if (d > 512) return null; // 独立实现的深度保护（与被测代码用不同常量）

  const children = nodes.filter((n) => n.parent === nodeId);
  if (children.length === 0) return null;

  // 收集所有「参与并集的矩形」
  const rects = children.reduce((acc, child) => {
    if (child.type === 'group') {
      // ★ 关键：子层是组 -> 递归求它的并集，绝不用它自己的坐标
      const inner = referenceUnionBox(child.id, nodes, d + 1);
      if (inner) acc.push(inner);
      return acc;
    }
    // 叶子：零尺寸不参与
    const b = child.bbox;
    if (b && b.w > 0 && b.h > 0) acc.push(b);
    return acc;
  }, []);

  if (rects.length === 0) return null;

  const lefts = rects.map((r) => r.x);
  const tops = rects.map((r) => r.y);
  const rights = rects.map((r) => r.x + r.w);
  const bottoms = rects.map((r) => r.y + r.h);

  return {
    x: Math.min(...lefts),
    y: Math.min(...tops),
    w: Math.max(...rights) - Math.min(...lefts),
    h: Math.max(...bottoms) - Math.min(...tops),
  };
}

/**
 * 算「完全不递归、且组自身坐标恒为 0」的并集 —— 用来**模拟旧 bug**，
 * 从而证明对账基准确实能区分「递归」与「不递归」（若两者相同，测试就是恒真的）。
 *
 * @param {string} nodeId
 * @param {Object[]} nodes
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
function buggyNonRecursiveUnionBox(nodeId, nodes) {
  const children = nodes.filter((n) => n.parent === nodeId);
  const rects = [];
  for (const c of children) {
    if (c.type === 'group') {
      // ★ 旧 bug：组被整体跳过（因为它自身坐标恒为 0 -> w<=0）
      continue;
    }
    const b = c.bbox;
    if (b && b.w > 0 && b.h > 0) rects.push(b);
  }
  if (!rects.length) return null;
  const lefts = rects.map((r) => r.x);
  const tops = rects.map((r) => r.y);
  const rights = rects.map((r) => r.x + r.w);
  const bottoms = rects.map((r) => r.y + r.h);
  return {
    x: Math.min(...lefts),
    y: Math.min(...tops),
    w: Math.max(...rights) - Math.min(...lefts),
    h: Math.max(...bottoms) - Math.min(...tops),
  };
}

module.exports = { referenceUnionBox, buggyNonRecursiveUnionBox };