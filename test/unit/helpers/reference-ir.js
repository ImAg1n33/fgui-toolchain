'use strict';
/**
 * test/unit/helpers/reference-ir.js —— **独立编写**的 PSD→IR 对账基准（E-05）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ 这个文件存在的唯一理由：打破自证循环 ★★
 *
 * QA 两轮的核心批评：
 *   「所有 fixture 都是你自己造的、所有验证代码都是你自己写的，既造数据又写验证时
 *     『精确对账』会退化成自证循环。」BUG#1（组 bbox 不递归）正是这么漏过去的 ——
 *     对账算法与被测算法共享同一缺陷。
 *
 * 本文件的纪律（沿用 reference-union.js 的方向并推广到整条 IR 链路）：
 *   1. **零 src/ 依赖** —— 不 import 任何 src/ 模块，不调用 IrBuilder；
 *   2. **不同算法风格** —— 参考实现用「递归建嵌套树 + reduce 扁平化」，
 *      被测实现用「单遍迭代 walk + 栈」；深度上限取 100（被测是 256）；
 *   3. **只按文字定义实现** —— 依据 ARCHITECTURE §3.3 与 D3 的文字描述，
 *      不对照 ir-builder.js 的代码写（防止复制同一缺陷）；
 *   4. **可比形状显式定义** —— 两边都转成 {key, parentKey, type, depth, bbox,
 *      childCount, transform} + 告警码集合，按 name-path 连接（不按 id 连接，
 *      因为 id 分配策略本身就是被测逻辑的一部分）。
 *
 * 覆盖范围与边界（诚实声明）：
 *   · 覆盖：扁平化（父子/深度/类型）、叶子 bbox、**组 bbox 递归并集**、
 *     EMPTY_GROUP / EMPTY_LAYER / GROUP_BBOX_UNRESOLVED / TRANSFORMED_LAYER /
 *     合并组告警（两档语义：文档有切片 -> MERGED_LAYER_GROUP（仅强证据档）/
 *     无切片 -> SUSPECTED_MERGED_GROUP 疑似档；含切片树上的
 *     MERGED_LAYER_GROUP 对账仍被 skip，因切片归属是另一套算法）/ NO_SLICE
 *     告警预测；
 *   · 不覆盖：切片归属分配（assignSlicesToLayers，另一套算法，属 L1 通道）、
 *     pHash 数值（L3 兜底，与结构无关）。
 * ════════════════════════════════════════════════════════════════════════════
 */

/** 参考实现的独立深度上限（刻意与被测的 256 不同）。 */
const REF_MAX_DEPTH = 100;

/**
 * 参考实现的类型判定（按 ARCHITECTURE §3.3 type 字段的文字定义独立写）。
 * @param {Object} layer ag-psd Layer
 * @returns {'group'|'text'|'smartobject'|'raster'}
 */
function refType(layer) {
  if (Array.isArray(layer.children)) return 'group';
  if (layer.text && typeof layer.text === 'object') return 'text';
  if (layer.placedLayer || layer.smartObject) return 'smartobject';
  return 'raster';
}

/**
 * 参考实现的叶子 bbox（读自身坐标，组坐标不可信故组走递归）。
 * @param {Object} layer
 * @returns {{x:number,y:number,w:number,h:number}}
 */
function refLeafBox(layer) {
  const l = layer.left || 0;
  const t = layer.top || 0;
  const r = layer.right === undefined ? l : layer.right;
  const b = layer.bottom === undefined ? t : layer.bottom;
  return { x: l, y: t, w: Math.max(0, r - l), h: Math.max(0, b - t) };
}

/**
 * 参考实现的非单位变换提取（与 src 的实现各自独立写；规则同一份文字定义）。
 * @param {Object} layer
 * @returns {number[]|null}
 */
function refTransform(layer) {
  const raw = (layer.text && layer.text.transform)
    || (layer.placedLayer && layer.placedLayer.transform);
  if (!Array.isArray(raw) || raw.length < 6) return null;
  const m = raw.slice(0, 6).map((v) => Math.round(Number(v) * 1e6) / 1e6);
  if (m.some((v) => !Number.isFinite(v))) return null;
  const identity = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
  return identity ? null : m;
}

/**
 * 递归求组 bbox 并集（reduce 风格；被测实现是 for + min/max）。
 * @param {Object[]} children
 * @param {number} depth
 * @returns {{x:number,y:number,w:number,h:number}|null} 空组/全跳过返 null
 */
function refGroupBox(children, depth) {
  if (!Array.isArray(children) || children.length === 0) return null;
  if (depth > REF_MAX_DEPTH) return null; // 独立深度上限
  const rects = children.reduce((acc, child) => {
    if (!child) return acc;
    if (Array.isArray(child.children)) {
      const inner = refGroupBox(child.children, depth + 1);
      if (inner) acc.push(inner);
      return acc;
    }
    const b = refLeafBox(child);
    if (b.w > 0 && b.h > 0) acc.push(b);
    return acc;
  }, []);
  if (rects.length === 0) return null;
  return {
    x: Math.min(...rects.map((r) => r.x)),
    y: Math.min(...rects.map((r) => r.y)),
    w: Math.max(...rects.map((r) => r.x + r.w)) - Math.min(...rects.map((r) => r.x)),
    h: Math.max(...rects.map((r) => r.y + r.h)) - Math.min(...rects.map((r) => r.y)),
  };
}

/**
 * 参考实现：收集子树全部叶子（判 merged 用）。
 * @param {Object} layer
 * @returns {Object[]}
 */
function refLeaves(layer) {
  if (!Array.isArray(layer.children)) return layer ? [layer] : [];
  return layer.children.reduce((acc, c) => acc.concat(refLeaves(c)), []);
}

/**
 * 参考实现：psd → 可比 IR 形状。
 *
 * @param {Object} psd ag-psd 读回结果
 * @param {Object} [opts]
 * @param {boolean} [opts.buggyGroupBox=false] true = 模拟 BUG#1（组 bbox 读自身坐标，
 *        而组自身坐标恒 0）—— 用于反向断言「对账基准能区分对错」
 * @returns {{layers:Object[], warnings:{code:string, layer:string|null}[], byKey:Map}}
 */
function referenceBuildIr(psd, opts = {}) {
  const buggy = !!opts.buggyGroupBox;
  const layers = [];
  const warnings = [];

  // ★ UPSTREAM-FIX-1：文档切片总数决定「无切片」信号是强证据还是常态 ★
  //   与被测实现（ir-builder 的 docHasSlices = slices.length > 0）同一份文字定义，
  //   但此处从 psd.imageResources 独立统计（不 import src）。
  const docSliceCount = ((psd.imageResources && psd.imageResources.slices) || [])
    .reduce((n, grp) => n + ((grp.slices || []).length), 0);
  const docHasSlices = docSliceCount > 0;

  /**
   * 递归遍历（建嵌套路径 key：父路径/名字#同名序号）。
   * @param {Object[]} siblings
   * @param {string|null} parentKey
   * @param {string} parentPath
   * @param {number} depth
   */
  const walk = (siblings, parentKey, parentPath, depth) => {
    if (!Array.isArray(siblings)) return;
    const nameCount = new Map();
    for (const layer of siblings) {
      if (!layer) continue;
      const name = layer.name || '';
      const seen = nameCount.get(name) || 0;
      nameCount.set(name, seen + 1);
      const key = `${parentPath}/${name}#${seen}`;
      const type = refType(layer);
      const childCount = Array.isArray(layer.children) ? layer.children.length : 0;

      let bbox = null;
      if (type === 'group') {
        bbox = buggy ? refLeafBox(layer) : refGroupBox(layer.children, 0);
        if (bbox === null) bbox = { x: 0, y: 0, w: 0, h: 0 };
      } else {
        bbox = refLeafBox(layer);
      }

      const transform = refTransform(layer);
      layers.push({
        key, name, parentKey, type, depth,
        bbox, childCount, transform,
      });

      // ---- 告警预测（与 ir-builder 的告警语义逐条对应，独立实现）----
      if (type === 'group' && childCount === 0) {
        warnings.push({ code: 'EMPTY_GROUP', layer: key });
      }
      if (type === 'group' && childCount > 0 && bbox.w === 0 && bbox.h === 0) {
        warnings.push({ code: 'GROUP_BBOX_UNRESOLVED', layer: key });
      }
      if (type !== 'group' && (bbox.w === 0 || bbox.h === 0)) {
        warnings.push({ code: 'EMPTY_LAYER', layer: key });
      }
      if (transform) {
        warnings.push({ code: 'TRANSFORMED_LAYER', layer: key });
      }

      if (type === 'group' && childCount > 0) {
        // 合并组预测（两档语义，与 merged-detect.js 的文字定义独立实现）：
        //   子树叶子全 raster、无 text、无 smartobject 时：
        //   - 文档有切片 -> 强证据 -> MERGED_LAYER_GROUP
        //   - 文档无切片 -> 弱信号（常态） -> SUSPECTED_MERGED_GROUP（info 级）
        const leaves = refLeaves(layer);
        const hasText = leaves.some((l) => refType(l) === 'text');
        const hasSmart = leaves.some((l) => refType(l) === 'smartobject');
        if (leaves.length > 0 && !hasText && !hasSmart) {
          warnings.push({
            code: docHasSlices ? 'MERGED_LAYER_GROUP' : 'SUSPECTED_MERGED_GROUP',
            layer: key,
          });
        }
        walk(layer.children, key, key, depth + 1);
      }
    }
  };

  walk(psd.children || [], null, '', 0);

  // NO_SLICE 预测（无切片资源时）
  const sliceGroups = (psd.imageResources && psd.imageResources.slices) || [];
  const sliceCount = sliceGroups.reduce((n, g) => n + ((g.slices || []).length), 0);
  const docWarnings = [];
  if (sliceCount === 0) docWarnings.push('NO_SLICE');

  const byKey = new Map(layers.map((l) => [l.key, l]));
  return { layers, warnings, docWarnings, byKey };
}

/**
 * 参考实现的 BUG#1 模拟版：组 bbox 读自身坐标（实测恒 0）而非递归并集。
 * 用于反向断言：证明对账基准确实能区分「递归」与「不递归」。
 * @param {Object} psd
 * @returns {Object} 同 referenceBuildIr 形状
 */
function referenceBuildIrBuggy(psd) {
  return referenceBuildIr(psd, { buggyGroupBox: true });
}

/**
 * 把 IrBuilder 的输出转成与参考实现**同形状**的可比对象。
 * （测试侧胶水：不 import src，只消费 IR 对象。）
 *
 * ★ key 规则必须与参考实现逐字一致 ★
 *   `父key/名字#同名序号`，其中「同名序号」= 同一父下按文档序的同名兄弟计数。
 *   黄金样本 B 的 `奖励组` 下有 3 个都叫 `图层249` 的兄弟层 —— 不带序号就会
 *   三层撞同一个 key，对账退化成「神秘的一致」（E-05 自己踩过的坑）。
 *
 * @param {Object} ir IrBuilder.build 的返回值
 * @returns {{layers:Object[], warnings:{code:string, layer:string|null}[], byKey:Map}}
 */
function irToComparable(ir) {
  const byId = new Map(ir.layers.map((l) => [l.id, l]));
  // 按文档序遍历（IR 的 layers 已按 id 排序 = 文档序，父必先于子），
  // 逐节点算 key：父key 此时一定已算好。
  const keyById = new Map();
  const siblingNameCount = new Map(); // parentId -> Map<name, count>
  for (const node of ir.layers) {
    const parentId = node.parent || '';
    let counts = siblingNameCount.get(parentId);
    if (!counts) {
      counts = new Map();
      siblingNameCount.set(parentId, counts);
    }
    const seen = counts.get(node.name) || 0;
    counts.set(node.name, seen + 1);
    const parentKey = node.parent ? keyById.get(node.parent) : '';
    keyById.set(node.id, `${parentKey}/${node.name}#${seen}`);
  }

  const layers = ir.layers.map((node) => ({
    key: keyById.get(node.id),
    name: node.name,
    parentKey: node.parent ? keyById.get(node.parent) : null,
    type: node.type,
    depth: node.depth,
    bbox: { x: node.bbox.x, y: node.bbox.y, w: node.bbox.w, h: node.bbox.h },
    childCount: node.childCount,
    transform: node.transform || null,
  }));

  const warnings = ir.warnings.map((w) => ({
    code: w.code,
    layer: w.layer ? (keyById.get(w.layer) || null) : null,
  }));

  const docWarnings = ir.warnings.filter((w) => !w.layer).map((w) => w.code);
  const byKey = new Map(layers.map((l) => [l.key, l]));
  return { layers, warnings, docWarnings, byKey };
}

/**
 * 交叉对账：参考实现 vs 被测 IR（同形状）。
 *
 * @param {Object} ref irToComparable(referenceBuildIr(psd)) 的结果
 * @param {Object} got irToComparable(ir) 的结果
 * @param {Object} [opts]
 * @param {string[]} [opts.skipLayerWarnCodes] 跳过的告警码（含切片树上跳过 MERGED）
 * @returns {{mismatches:string[]}} 空数组 = 一致
 */
function crossCheck(ref, got, opts = {}) {
  const skip = new Set(opts.skipLayerWarnCodes || []);
  const mismatches = [];

  // ---- 1. 层集合对账（key 维度，双向）----
  const refKeys = new Set(ref.layers.map((l) => l.key));
  const gotKeys = new Set(got.layers.map((l) => l.key));
  for (const k of refKeys) {
    if (!gotKeys.has(k)) mismatches.push(`IR 缺少层: ${k}`);
  }
  for (const k of gotKeys) {
    if (!refKeys.has(k)) mismatches.push(`IR 多出层: ${k}`);
  }

  // ---- 2. 共有层的字段对账 ----
  for (const k of refKeys) {
    if (!gotKeys.has(k)) continue;
    const a = ref.byKey.get(k);
    const b = got.byKey.get(k);
    const fields = ['name', 'parentKey', 'type', 'depth', 'childCount'];
    for (const f of fields) {
      if (a[f] !== b[f]) mismatches.push(`${k}.${f}: 参考=${JSON.stringify(a[f])} 实现=${JSON.stringify(b[f])}`);
    }
    for (const f of ['x', 'y', 'w', 'h']) {
      if (a.bbox[f] !== b.bbox[f]) {
        mismatches.push(`${k}.bbox.${f}: 参考=${a.bbox[f]} 实现=${b.bbox[f]}（整框 参考=${JSON.stringify(a.bbox)} 实现=${JSON.stringify(b.bbox)}）`);
      }
    }
    const at = a.transform ? a.transform.join(',') : '';
    const bt = b.transform ? b.transform.join(',') : '';
    if (at !== bt) mismatches.push(`${k}.transform: 参考=[${at}] 实现=[${bt}]`);
  }

  // ---- 3. 告警码集合对账（按层）----
  // 文档级告警（layer 为 null/空）只在第 4 节对账，不混进按层集合
  const refWarn = new Map();
  for (const w of ref.warnings) {
    if (skip.has(w.code) || !w.layer) continue;
    const arr = refWarn.get(w.layer) || [];
    arr.push(w.code);
    refWarn.set(w.layer, arr);
  }
  const gotWarn = new Map();
  for (const w of got.warnings) {
    if (skip.has(w.code) || !w.layer) continue;
    const arr = gotWarn.get(w.layer) || [];
    arr.push(w.code);
    gotWarn.set(w.layer, arr);
  }
  const allWarnKeys = new Set([...refWarn.keys(), ...gotWarn.keys()]);
  for (const k of allWarnKeys) {
    const a = (refWarn.get(k) || []).sort().join('+');
    const b = (gotWarn.get(k) || []).sort().join('+');
    if (a !== b) mismatches.push(`${k} 告警码: 参考=[${a}] 实现=[${b}]`);
  }

  // ---- 4. 文档级告警对账 ----
  const refDoc = [...ref.docWarnings].sort().join('+');
  const gotDoc = [...got.docWarnings].sort().join('+');
  if (refDoc !== gotDoc) mismatches.push(`文档级告警: 参考=[${refDoc}] 实现=[${gotDoc}]`);

  return { mismatches };
}

module.exports = {
  referenceBuildIr,
  referenceBuildIrBuggy,
  irToComparable,
  crossCheck,
  REF_MAX_DEPTH,
};
