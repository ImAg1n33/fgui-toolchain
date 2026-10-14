'use strict';
/**
 * src/diff/classifier.js —— 七类差异判定 + summary
 *
 * | 差异类型 | 判定条件 | FGUI 处理 |
 * |---|---|---|
 * | REUSE    | 同素材且几何完全一致 | 直接引用，**零新增节点** |
 * | MOVE     | 同素材，尺寸不变但位置变 | 优先 relation，相对关系复杂时 gearXY |
 * | RESIZE   | 同素材，尺寸变但比例不变 | 九宫格（**先过适用性检查**）；不合适 → gearSize |
 * | RESTYLE  | 同位置同尺寸，颜色/透明度/文本变 | **不生成新图**，用运行时 color + alpha（6 位色） |
 * | ADD      | 仅 B 有 | 新建节点；重复结构 → GList + Cell |
 * | REMOVE   | 仅 A 有 | 默认 visible=false 或移入 stash，**不直接删** |
 * | INFERRED | 匹配不确定 | 进人工确认队列，未确认前不写入（**默认 skip**） |
 *
 * ★ 每条 diff 必带可读 `evidence`★（PRD A10）：写清「为什么这么判」，
 *   让人能一眼复核或推翻。小 Q 不求助就能看懂并手工改。
 *
 * 纯计算，不碰文件系统（ARCHITECTURE §8.6）—— 保证可单测。
 */

const { round6 } = require('../core/determinism');
const { VERDICT } = require('../imaging/grid9');
const { LEVEL } = require('./matcher');

/** 差异类型。 */
const OP = Object.freeze({
  REUSE: 'REUSE',
  MOVE: 'MOVE',
  RESIZE: 'RESIZE',
  RESTYLE: 'RESTYLE',
  ADD: 'ADD',
  REMOVE: 'REMOVE',
  INFERRED: 'INFERRED',
});

/** op 的中文标签（summary 与人读输出用）。 */
const OP_LABEL = Object.freeze({
  REUSE: '完全复用',
  MOVE: '位置调整',
  RESIZE: '尺寸调整',
  RESTYLE: '样式调整',
  ADD: '新增',
  REMOVE: '移除',
  INFERRED: '待确认',
});

/**
 * 尺寸比例是否保持（用于区分 RESIZE 与「换了素材」）。
 * @param {{w:number,h:number}} a
 * @param {{w:number,h:number}} b
 * @param {number} tol 相对容差
 * @returns {boolean}
 */
function sameAspect(a, b, tol) {
  if (!a.w || !a.h || !b.w || !b.h) return false;
  const ra = a.w / a.h;
  const rb = b.w / b.h;
  return Math.abs(ra - rb) / Math.max(ra, rb) <= tol;
}

/**
 * 文本层是否发生了「内容/颜色/字号」变化。
 * @param {Object|null} a
 * @param {Object|null} b
 * @returns {{changed:boolean, parts:string[]}}
 */
function textChanged(a, b) {
  const parts = [];
  if (!a && !b) return { changed: false, parts };
  if (!a || !b) return { changed: true, parts: ['文本层新增或消失'] };
  if (a.value !== b.value) parts.push(`文本内容 '${a.value}' -> '${b.value}'`);
  if (a.color !== b.color) parts.push(`颜色 ${a.color} -> ${b.color}`);
  if (a.fontSize !== b.fontSize) parts.push(`字号 ${a.fontSize} -> ${b.fontSize}`);
  if (a.align !== b.align) parts.push(`对齐 ${a.align} -> ${b.align}`);
  return { changed: parts.length > 0, parts };
}

/**
 * 判断是否为颜色/透明度类变化（RESTYLE）。
 * @param {Object} a 基准层
 * @param {Object} b 目标层
 * @param {number} opacityDelta
 * @returns {{changed:boolean, parts:string[]}}
 */
function styleChanged(a, b, opacityDelta) {
  const parts = [];
  if (Math.abs((a.opacity === undefined ? 1 : a.opacity) - (b.opacity === undefined ? 1 : b.opacity)) > opacityDelta) {
    parts.push(`透明度 ${round6(a.opacity)} -> ${round6(b.opacity)}`);
  }
  if (a.visible !== b.visible) parts.push(`可见性 ${a.visible} -> ${b.visible}`);
  const tc = textChanged(a.text, b.text);
  if (tc.changed) parts.push(...tc.parts);
  return { changed: parts.length > 0, parts };
}

/**
 * 为一个已匹配的 pair 分类。
 *
 * @param {Object} pair matchLayers 的 pair
 * @param {Object} base 基准层
 * @param {Object} target 目标层
 * @param {Object} ctx
 * @param {Object} ctx.cfg diff 配置
 * @param {Function} [ctx.slotOf] layer -> 槽位名
 * @param {Function} [ctx.grid9Of] layerId -> Grid9VerdictResult|null
 * @param {Function} [ctx.relationOf] (base, target) -> relation|null
 * @returns {Object} PlanDiff
 */
function classifyPair(pair, base, target, ctx) {
  const cfg = ctx.cfg || {};
  const sizeTol = cfg.sizeTolerancePx === undefined ? 2 : cfg.sizeTolerancePx;
  const posTol = cfg.positionTolerancePx === undefined ? 4 : cfg.positionTolerancePx;
  const opacityDelta = cfg.restyleOpacityDelta === undefined ? 0.02 : cfg.restyleOpacityDelta;

  const sizeSame = Math.abs(base.bbox.w - target.bbox.w) <= sizeTol
    && Math.abs(base.bbox.h - target.bbox.h) <= sizeTol;
  const posSame = Math.abs(base.bbox.x - target.bbox.x) <= posTol
    && Math.abs(base.bbox.y - target.bbox.y) <= posTol;

  const level = pair.level;
  const baseName = `fgui.config/${base.name}`; // 仅作 evidence 里的可读标识

  // ---- REUSE：几何完全一致 ----
  if (sizeSame && posSame && !level.startsWith('L3')) {
    const style = styleChanged(base, target, opacityDelta);
    if (!style.changed) {
      return {
        op: OP.REUSE,
        slot: ctx.slotOf ? ctx.slotOf(target) : target.normName || target.name,
        node: target.id,
        matchLevel: level,
        confidence: pair.confidence,
        evidence: `${level} 匹配 '${base.name}' -> '${target.name}'，`
          + `位置与尺寸完全一致（${target.bbox.x},${target.bbox.y},${target.bbox.w}x${target.bbox.h}），`
          + '几何与样式均无变化 —— 直接引用现有素材，**零新增节点**',
        fguiStrategy: { type: 'reuse', detail: { refName: base.normName || base.name } },
        candidates: [],
        defaultIfUnconfirmed: 'skip',
        grid9: null,
      };
    }
    // ---- RESTYLE：同位置同尺寸但样式变了 ----
    // ★ 不生成新图：用运行时 color + alpha（6 位色，PRD §5.3 硬约束）
    return {
      op: OP.RESTYLE,
      slot: ctx.slotOf ? ctx.slotOf(target) : target.normName || target.name,
      node: target.id,
      matchLevel: level,
      confidence: pair.confidence,
      evidence: `${level} 匹配 '${base.name}' -> '${target.name}'，位置与尺寸完全一致，`
        + `但 ${style.parts.join('；')} —— 判定为样式调整。`
        + '**不生成新图**，改用运行时 color（6 位 #RRGGBB）+ alpha 属性控制；'
        + '注意上游坑：8 位 #RRGGBBAA 运行时只取后 6 位会渲染成纯蓝',
      fguiStrategy: {
        type: 'color',
        detail: {
          // 只给 6 位色，透明度单独走 alpha 属性
          color: target.text ? target.text.color : undefined,
          alpha: round6(target.opacity === undefined ? 1 : target.opacity),
          changes: style.parts,
        },
      },
      candidates: [],
      defaultIfUnconfirmed: 'skip',
      grid9: null,
    };
  }

  // ---- MOVE：尺寸不变位置变 ----
  if (sizeSame && !posSame) {
    const rel = ctx.relationOf ? ctx.relationOf(base, target) : null;
    return {
      op: OP.MOVE,
      slot: ctx.slotOf ? ctx.slotOf(target) : target.normName || target.name,
      node: target.id,
      matchLevel: level,
      confidence: pair.confidence,
      evidence: `${level} 匹配 '${base.name}' -> '${target.name}'，`
        + `尺寸不变（${target.bbox.w}x${target.bbox.h}）但位置从 `
        + `(${base.bbox.x},${base.bbox.y}) 移到 (${target.bbox.x},${target.bbox.y})`
        + `（位移 ${target.bbox.x - base.bbox.x},${target.bbox.y - base.bbox.y}）`
        + ` —— 判定为位置调整，优先用 relation（${rel ? rel.describe : '无明显相对关系，退用 gearXY'}）`,
      fguiStrategy: rel && rel.usable
        ? { type: 'relation', detail: { sidePair: rel.sidePair, describe: rel.describe } }
        : { type: 'gearXY', detail: { x: target.bbox.x, y: target.bbox.y } },
      candidates: [],
      defaultIfUnconfirmed: 'skip',
      grid9: null,
    };
  }

  // ---- RESIZE：尺寸变了 ----
  // ★ 先过九宫格适用性检查（这正是 R1-F3 的价值：防止给圆头按钮切常规九宫格）
  const grid9 = ctx.grid9Of ? ctx.grid9Of(target.id) : null;
  const aspectOk = sameAspect(base.bbox, target.bbox, cfg.aspectTolerance || 0.02);

  if (grid9 && grid9.verdict === VERDICT.CAN_9GRID) {
    return {
      op: OP.RESIZE,
      slot: ctx.slotOf ? ctx.slotOf(target) : target.normName || target.name,
      node: target.id,
      matchLevel: level,
      confidence: pair.confidence,
      evidence: `${level} 匹配 '${base.name}' -> '${target.name}'，`
        + `尺寸从 ${base.bbox.w}x${base.bbox.h} 变为 ${target.bbox.w}x${target.bbox.h}`
        + (aspectOk ? '，宽高比保持不变' : '，⚠ 宽高比也变了（不是等比缩放）')
        + `；九宫格适用性判定为 CAN_9GRID（置信度 ${grid9.confidence}，四角实心中部平坦），`
        + '可安全使用常规九宫格拉伸',
      fguiStrategy: {
        type: 'scale9grid',
        detail: { scale9grid: grid9.suggestedGrid || defaultScale9(target.bbox) },
      },
      candidates: [],
      defaultIfUnconfirmed: 'skip',
      grid9,
    };
  }

  if (grid9 && grid9.verdict === VERDICT.SINGLE_AXIS_ONLY) {
    return {
      op: OP.RESIZE,
      slot: ctx.slotOf ? ctx.slotOf(target) : target.normName || target.name,
      node: target.id,
      matchLevel: level,
      confidence: pair.confidence,
      evidence: `${level} 匹配 '${base.name}' -> '${target.name}'，`
        + `尺寸从 ${base.bbox.w}x${base.bbox.h} 变为 ${target.bbox.w}x${target.bbox.h}；`
        + '九宫格判定为 SINGLE_AXIS_ONLY：素材是胶囊/全圆头，'
        + `**只能水平单轴切分，垂直方向不切**，建议 scale9grid="${grid9.suggestedGrid}"。`
        + '若误用常规九宫格，圆头会被拉成椭圆 —— 这正是工具要在生成阶段拦截的事故',
      fguiStrategy: {
        type: 'scale9grid',
        detail: { scale9grid: grid9.suggestedGrid || capsuleScale9(target.bbox), singleAxisOnly: true },
      },
      candidates: [],
      defaultIfUnconfirmed: 'skip',
      grid9,
    };
  }

  // NEVER 或无判定 -> gearSize（不切九宫格，改用 controller 控尺寸）
  return {
    op: OP.RESIZE,
    slot: ctx.slotOf ? ctx.slotOf(target) : target.normName || target.name,
    node: target.id,
    matchLevel: level,
    confidence: pair.confidence,
    evidence: `${level} 匹配 '${base.name}' -> '${target.name}'，`
      + `尺寸从 ${base.bbox.w}x${base.bbox.h} 变为 ${target.bbox.w}x${target.bbox.h}；`
      + (grid9
        ? `九宫格判定为 ${grid9.verdict}（${grid9.verdict === VERDICT.NEVER
          ? '圆形/放射/对角纹理类素材，九宫格拉伸必然破形'
          : '不确定，按「不确定返 NEVER」原则禁切'}），故不建议切九宫格`
        : '未做九宫格适用性判定（无切图特征），按保守原则不切九宫格')
      + ' —— 改用 gearSize 由代码控制尺寸；若确需拉伸，请人工确认后手动设置',
    fguiStrategy: { type: 'gearSize', detail: { width: target.bbox.w, height: target.bbox.h } },
    candidates: [],
    defaultIfUnconfirmed: 'skip',
    grid9: grid9 || null,
  };
}

/**
 * 常规九宫格建议值（四边留角，取短边 1/4 并夹紧）。
 * @param {{w:number,h:number}} box
 * @returns {string}
 */
function defaultScale9(box) {
  const c = Math.max(1, Math.floor(Math.min(box.w, box.h) / 4));
  return `${c},${c},${box.w - 2 * c},${box.h - 2 * c}`;
}

/**
 * 胶囊单轴九宫格建议值（上/下不留角）。
 * @param {{w:number,h:number}} box
 * @returns {string}
 */
function capsuleScale9(box) {
  const r = Math.max(1, Math.floor(Math.min(box.w, box.h) / 2));
  return `${r},0,${Math.max(0, box.w - 2 * r)},${box.h}`;
}

/**
 * 为未匹配的**目标层**分类（ADD 或 INFERRED）。
 *
 * ★ 关键区分 ★
 *   ADD       —— 该层在基准态**确实没有对应物**，且没有任何候选证据 -> 确定的新增
 *   INFERRED  —— 存在候选但无法确定（比如在 merged 组里、或者有低分候选）-> 猜，默认 skip
 *
 * 判定「存在候选」的方式：
 *   1. 该层位于 merged 组内 -> 一定有候选（合并意味着基准态里可能有同一素材）
 *   2. 检索给出了候选但置信度低
 *
 * @param {Object} target 未匹配的目标层
 * @param {Object} ctx
 * @param {Object[]} ctx.candidates 该层的候选（来自检索，可为空）
 * @param {boolean} ctx.underMerged
 * @param {Object} ctx.cfg
 * @param {string} [ctx.groupName]
 * @returns {Object} PlanDiff
 */
function classifyUnmatchedTarget(target, ctx) {
  const cfg = ctx.cfg || {};
  const l4Confidence = cfg.l4Confidence === undefined ? 0.15 : cfg.l4Confidence;
  const mergedCap = cfg.mergedConfidenceCap === undefined ? 0.5 : cfg.mergedConfidenceCap;
  const slot = ctx.slotOf ? ctx.slotOf(target) : (target.normName || target.name);
  // 候选既可能是 AssetRow（取 relPath），也可能是已归一化的字符串
  const candidates = (ctx.candidates || [])
    .map((c) => (typeof c === 'string' ? c : (c.relPath || c.assetId || c.id)))
    .filter(Boolean);

  // ---- INFERRED：不确定，默认 skip ----
  if (ctx.underMerged || (candidates.length > 0 && candidates.length < 3)) {
    const why = ctx.underMerged
      ? `父组『${ctx.groupName || '(未知)'}』merged=true，子层信息不可恢复，`
        + '无法确定基准态里是否有同一素材'
      : `检索到 ${candidates.length} 个可能的候选但均无法确定对应关系`;
    return {
      op: OP.INFERRED,
      slot,
      node: target.id,
      matchLevel: LEVEL.L4,
      confidence: round6(ctx.underMerged ? Math.min(l4Confidence, mergedCap) : l4Confidence),
      evidence: `L1/L2/L3 均未命中，${why}。`
        + (candidates.length ? `候选切图：${candidates.join('、')}。` : '')
        + '按 PRD K4 第②条，**低置信度一律 skip 而非猜测**：宁可少做一个节点让人补，也不要错一个。'
        + '需人工确认后才写入',
      fguiStrategy: null,
      candidates,
      defaultIfUnconfirmed: 'skip',
      grid9: ctx.grid9 || null,
      _attention: '低置信度一律 skip 而非猜测（PRD K4 第②条）',
    };
  }

  // ---- ADD：确定的新增 ----
  const grid9 = ctx.grid9 || null;
  return {
    op: OP.ADD,
    slot,
    node: target.id,
    matchLevel: LEVEL.L4,
    confidence: round6(ctx.underMerged ? mergedCap : 0.9),
    evidence: `L1（slice 名）、L2（归一名全等）、L3（pHash+尺寸+位置）三级均未命中，`
      + `且无任何候选切图 —— 判定为确定的新增节点『${target.name}』`
      + `（${target.bbox.w}x${target.bbox.h} @ ${target.bbox.x},${target.bbox.y}）。`
      + '注意：即便如此，仍**不允许自动改 package.xml** 登记新图资源'
      + '（PRD R4-F6：把改 package.xml 这件最危险的事踢出自动化路径）',
    fguiStrategy: { type: 'button', detail: { extention: 'Button', hint: '需人工指定控件类型' } },
    candidates: [],
    defaultIfUnconfirmed: 'skip',
    grid9,
  };
}

/**
 * 为未匹配的**基准层**分类（REMOVE）。
 *
 * ★ 默认不删 ★（PRD R3）：`visible=false` 或移入 `stash/`，
 *   保留现场以便回溯 —— 画师合并素材导致的「误删」是这类工具最常见的事故。
 *
 * ★ merged 组内也要压置信度 ★（ARCHITECTURE §4.6 的同一条规则）：
 *   被合并的组里子层信息不可恢复，「基准态有、目标态没有」完全可能是
 *   **合并把这一层藏起来了**，而不是画师真的删了它。所以置信度封顶 0.5，
 *   且 evidence 必须写明这个可能性 —— 否则会建议小 Q 删掉其实还在用的节点。
 *
 * @param {Object} base 未匹配的基准层
 * @param {Object} ctx
 * @returns {Object} PlanDiff
 */
function classifyUnmatchedBase(base, ctx) {
  const cfg = ctx.cfg || {};
  const mergedCap = cfg.mergedConfidenceCap === undefined ? 0.5 : cfg.mergedConfidenceCap;
  const underMerged = !!ctx.underMerged;
  const confidence = underMerged ? mergedCap : 0.9;

  const mergedNote = underMerged
    ? `；⚠ 该层位于被合并的组『${ctx.groupName || '(未知)'}』内，`
      + '**子层信息不可恢复**，「目标态找不到」很可能是被合并藏起来了而非真被删除，'
      + `故置信度封顶 ${mergedCap}，请人工确认后再决定是否移除`
    : '';

  return {
    op: OP.REMOVE,
    slot: ctx.slotOf ? ctx.slotOf(base) : (base.normName || base.name),
    node: base.id,
    matchLevel: LEVEL.L4,
    confidence: round6(confidence),
    evidence: `图层『${base.name}』(${base.bbox.w}x${base.bbox.h} @ ${base.bbox.x},${base.bbox.y}) `
      + '在目标态中找不到任何对应物（L1/L2/L3 均未命中）—— 判定为需移除。'
      + '**默认不直接删除**：置 visible=false 或移入 stash/ 保留现场，'
      + '因为「基准态有、目标态没有」也可能是画师合并图层导致的漏分层，直接删会丢信息'
      + mergedNote,
    fguiStrategy: { type: 'stash', detail: { action: 'visible_false', hint: '或移入 stash/，勿直接删除' } },
    candidates: [],
    defaultIfUnconfirmed: 'skip',
    grid9: null,
  };
}

/**
 * 统计 summary。
 * @param {Object[]} diffs
 * @returns {Object}
 */
function summarize(diffs) {
  const summary = {};
  for (const op of Object.values(OP)) summary[op] = 0;
  for (const d of diffs) {
    if (summary[d.op] === undefined) summary[d.op] = 0;
    summary[d.op]++;
  }
  summary.total = diffs.length;
  return summary;
}

module.exports = {
  classifyPair,
  classifyUnmatchedTarget,
  classifyUnmatchedBase,
  summarize,
  sameAspect,
  styleChanged,
  textChanged,
  defaultScale9,
  capsuleScale9,
  OP,
  OP_LABEL,
};
