'use strict';
/**
 * src/diff/matcher.js —— L1 → L4 四级匹配
 *
 * 从强到弱逐级尝试，命中即锁定（不再参与后续级别），保证「同级证据优先」。
 *
 * | 级别 | 依据 | 说明 |
 * |---|---|---|
 * | L1 | `slice.name` 完全一致 | PSD 内切片名一致 = 同一素材，最强证据 |
 * | L2 | 图层名归一化后一致 | 画师命名习惯一致时的强证据（★ 只做全等，K5） |
 * | L3 | pHash + 尺寸 + 位置 | 名字被合并/改了就靠这个兜底 |
 * | L4 | 均不命中 | 判 `INFERRED`，进人工确认队列，**默认 skip 而非猜测** |
 *
 * ★ merged 组的三条硬规则（ARCHITECTURE §4.6 / PRD K4）★
 *   1. `merged=true` 的组内节点只允许 L3 匹配，**不允许 L1/L2** ——
 *      因为被合并的组里已经没有分层信息了，切片名与图层名都是画师重命名的产物，
 *      拿它们当证据等于自欺欺人。
 *   2. L3 命中后 `confidence` **强制封顶 0.5**。
 *   3. 匹配失败一律 L4 → INFERRED，`defaultIfUnconfirmed='skip'`。
 *
 * ★ L4 默认 skip 而非猜测 ★（PRD K4 第②条 / ARCHITECTURE 决策 9）：
 *   宁可少做一个节点让人补，也不要错一个。INFERRED 项在未确认前不写入 XML。
 */

const { normalizeName } = require('../core/normalize');
const { hamming64 } = require('../core/hash');
const { round6, sortBy } = require('../core/determinism');
const { searchAssets } = require('../assets/search');

/** 匹配级别。 */
const LEVEL = Object.freeze({ L1: 'L1', L2: 'L2', L3: 'L3', L4: 'L4' });

/**
 * 判断某个图层是否位于 merged 组内（沿 parent 链向上找）。
 *
 * @param {Object} layer IR 层节点
 * @param {Map<string,Object>} byId
 * @returns {boolean}
 */
function isUnderMerged(layer, byId) {
  let cur = layer;
  const seen = new Set();
  while (cur && cur.parent && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = byId.get(cur.parent);
    if (!parent) return false;
    if (parent.merged) return true;
    cur = parent;
  }
  return false;
}

/**
 * 尺寸是否一致（±tol）。
 * @param {{w:number,h:number}} a
 * @param {{w:number,h:number}} b
 * @param {number} tol
 * @returns {boolean}
 */
function sameSize(a, b, tol) {
  return Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;
}

/**
 * 位置是否一致（±tol）。
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @param {number} tol
 * @returns {boolean}
 */
function samePos(a, b, tol) {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
}

/**
 * L3 相似度：pHash + 尺寸 + 位置 加权。
 *
 * ★ 三道防误配的硬门槛（都是实测踩出来的）★
 *   1. **形状比相对门槛**：纯色/大面积平涂素材的 pHash 会退化得几乎一样
 *      （实测两个不同尺寸的纯色方块汉明距离仅 10，恰好等于阈值，
 *      于是 96x96 的奖励图标被误判为「40x40 角标的放大版」）。
 *      故要求两侧的「长边/短边」之比**相对**接近。
 *      ★ 必须用相对比较而非相减：相减在极端比值下会失效 ——
 *        480x8(比值 60) 与 560x8(比值 70) 只差 10，但 10 > 阈值 1.0 会被误杀，
 *        而它们确实是同一根横条缩放。相对比值 70/60 = 1.17，正确放行。
 *   2. **面积比门槛**：96x96 与 40x40 面积差 5.76 倍，显然不是同一素材。
 *      相对比较同理。
 *   3. **最低总分**：加权分低于 0.6 不认为匹配。
 *
 * @param {Object} a 基准层
 * @param {Object} b 目标层
 * @param {Object} cfg diff 配置
 * @returns {{score:number, parts:Object}|null} 不满足条件时返回 null
 */
function l3Similarity(a, b, cfg) {
  if (!a.phash || !b.phash) return null;

  const aw = Math.max(1, a.bbox.w);
  const ah = Math.max(1, a.bbox.h);
  const bw = Math.max(1, b.bbox.w);
  const bh = Math.max(1, b.bbox.h);

  // ---- 门槛 1：形状比（长边/短边）相对接近 ----
  const shapeRatioA = Math.max(aw, ah) / Math.min(aw, ah);
  const shapeRatioB = Math.max(bw, bh) / Math.min(bw, bh);
  const shapeRatioFactor = Math.max(shapeRatioA, shapeRatioB) / Math.min(shapeRatioA, shapeRatioB);
  const maxShapeFactor = cfg.maxShapeRatioFactor === undefined ? 1.6 : cfg.maxShapeRatioFactor;
  if (shapeRatioFactor > maxShapeFactor) return null;

  // ---- 门槛 2：面积比 ----
  const areaA = aw * ah;
  const areaB = bw * bh;
  const areaRatio = Math.max(areaA, areaB) / Math.max(1, Math.min(areaA, areaB));
  const maxAreaRatio = cfg.maxAreaRatio === undefined ? 4 : cfg.maxAreaRatio;
  if (areaRatio > maxAreaRatio) return null;

  // ---- 门槛 3：pHash 汉明距离 ----
  const dist = hamming64(a.phash, b.phash);
  const maxDistance = cfg.phashMaxDistance === undefined ? 10 : cfg.phashMaxDistance;
  if (dist > maxDistance) return null;

  // ---- 加权打分（全部用相对差异，尺度无关）----
  const phashSim = 1 - dist / maxDistance;
  const sizeSim = 1 - Math.min(1, (Math.abs(a.bbox.w - b.bbox.w) / Math.max(aw, bw))
    + (Math.abs(a.bbox.h - b.bbox.h) / Math.max(ah, bh)));
  const posSim = 1 - Math.min(1,
    (Math.abs(a.bbox.x - b.bbox.x) / Math.max(1, canvasExtentHint(a, b)))
    + (Math.abs(a.bbox.y - b.bbox.y) / Math.max(1, canvasExtentHint(a, b))));
  const score = cfg.phashWeight * phashSim + cfg.sizeWeight * sizeSim + cfg.positionWeight * posSim;

  // ---- 门槛 4：最低总分 ----
  const minScore = cfg.l3MinScore === undefined ? 0.6 : cfg.l3MinScore;
  if (score < minScore) return null;

  return {
    score: round6(score),
    parts: {
      hamming: dist,
      phashSim: round6(phashSim),
      sizeSim: round6(sizeSim),
      posSim: round6(posSim),
      areaRatio: round6(areaRatio),
      shapeRatioFactor: round6(shapeRatioFactor),
    },
  };
}

/**
 * 位置比较的归一化尺度：用两侧图层的最大跨度，避免除以固定常数。
 * @param {Object} a
 * @param {Object} b
 * @returns {number}
 */
function canvasExtentHint(a, b) {
  return Math.max(
    Math.abs(a.bbox.x) + a.bbox.w, Math.abs(b.bbox.x) + b.bbox.w,
    Math.abs(a.bbox.y) + a.bbox.h, Math.abs(b.bbox.y) + b.bbox.h,
    1,
  );
}

/**
 * 四级匹配主入口。
 *
 * @param {Object} args
 * @param {Object[]} args.baseLayers 基准态（状态 A）图层，已按 id 排序
 * @param {Object[]} args.targetLayers 目标态（状态 B）图层，已按 id 排序
 * @param {Object} [args.config] fgui.config.json 的 diff 段
 * @param {import('../assets/store').AssetStore} [args.index] 可选：有则用检索兜底 L3
 * @param {Object} [args.searchConfig] 检索配置
 * @returns {{pairs:Object[], unmatchedBase:Object[], unmatchedTarget:Object[], stats:Object}}
 */
function matchLayers(args) {
  const cfg = args.config || {};
  const sizeTol = cfg.sizeTolerancePx === undefined ? 2 : cfg.sizeTolerancePx;
  const posTol = cfg.positionTolerancePx === undefined ? 4 : cfg.positionTolerancePx;
  const mergedCap = cfg.mergedConfidenceCap === undefined ? 0.5 : cfg.mergedConfidenceCap;
  const l4Confidence = cfg.l4Confidence === undefined ? 0.15 : cfg.l4Confidence;

  const allLayers = [...args.baseLayers, ...args.targetLayers];
  const byId = new Map(allLayers.map((l) => [l.id, l]));

  // 标记每个图层是否在 merged 组内 + 是否本身是组
  const underMerged = new Map();
  for (const l of allLayers) underMerged.set(l.id, isUnderMerged(l, byId));

  const pairs = [];
  const usedTarget = new Set();

  /**
   * 尝试配对。
   * @param {Object} base
   * @param {Object} target
   * @param {string} level
   * @param {number} confidence
   * @param {string} evidence
   * @param {Object} [extra]
   */
  const take = (base, target, level, confidence, evidence, extra) => {
    let conf = confidence;
    const merged = underMerged.get(base.id) || underMerged.get(target.id);
    // ★ merged 组内节点的置信度强制封顶（无论哪一级）
    if (merged) conf = Math.min(conf, mergedCap);
    pairs.push({
      baseId: base.id,
      targetId: target.id,
      level,
      confidence: round6(conf),
      underMerged: !!merged,
      evidence,
      ...(extra || {}),
    });
    usedTarget.add(target.id);
  };

  const claimable = (l) => l.type !== 'group';

  // ================= L1：slice 名完全一致 =================
  // merged 组内节点不走 L1（见文件头规则 1）
  const bySlice = new Map();
  for (const t of args.targetLayers) {
    if (!claimable(t) || !t.sliceName) continue;
    if (!bySlice.has(t.sliceName)) bySlice.set(t.sliceName, []);
    bySlice.get(t.sliceName).push(t);
  }
  for (const b of args.baseLayers) {
    if (!claimable(b) || !b.sliceName) continue;
    if (underMerged.get(b.id)) continue;
    const cands = bySlice.get(b.sliceName) || [];
    const hit = cands.find((t) => !usedTarget.has(t.id));
    if (!hit) continue;
    const sizeOk = sameSize(b.bbox, hit.bbox, sizeTol);
    take(b, hit, LEVEL.L1, sizeOk ? 1 : 0.9,
      `L1 slice 名一致：两侧切片名均为 '${b.sliceName}'，`
      + (sizeOk
        ? `且尺寸完全吻合（${b.bbox.w}x${b.bbox.h}）—— 这是最强证据，同一素材`
        : `但尺寸有变化（${b.bbox.w}x${b.bbox.h} -> ${hit.bbox.w}x${hit.bbox.h}），置信度降为 0.9`),
      { sizeMatched: sizeOk, posMatched: samePos(b.bbox, hit.bbox, posTol) });
  }

  // ================= L2：图层名归一化后全等一致 =================
  // ★ K5：只用 normalizeName 全等，绝不用 startsWith/includes
  const byNorm = new Map();
  for (const t of args.targetLayers) {
    if (!claimable(t) || !t.normName) continue;
    if (!byNorm.has(t.normName)) byNorm.set(t.normName, []);
    byNorm.get(t.normName).push(t);
  }
  for (const b of args.baseLayers) {
    if (!claimable(b) || !b.normName) continue;
    if (usedTarget.size && pairs.some((p) => p.baseId === b.id)) continue;
    if (underMerged.get(b.id)) continue;
    const cands = (byNorm.get(b.normName) || []).filter((t) => !usedTarget.has(t.id));
    if (!cands.length) continue;
    // 同名多候选：优先尺寸吻合的；仍多个则取 id 最小的（确定性），并降置信度 + 标 AMBIGUOUS
    const sized = cands.filter((t) => sameSize(b.bbox, t.bbox, sizeTol));
    const pool = sized.length ? sized : cands;
    const hit = pool.slice().sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))[0];
    const ambiguous = pool.length > 1;
    const sizeOk = sameSize(b.bbox, hit.bbox, sizeTol);
    take(b, hit, LEVEL.L2, ambiguous ? 0.7 : (sizeOk ? 0.95 : 0.8),
      `L2 归一化名全等一致：'${b.name}' 与 '${hit.name}' 归一化后均为 '${b.normName}'`
      + '（仅做全等匹配，未使用前缀/子串包含，避免「矩形1」误配「矩形11」）'
      + (sizeOk
        ? `，且尺寸吻合（${b.bbox.w}x${b.bbox.h}）`
        : `，但尺寸有变化（${b.bbox.w}x${b.bbox.h} -> ${hit.bbox.w}x${hit.bbox.h}）`)
      + (ambiguous ? `；⚠ 同名候选 ${pool.length} 个，已按尺寸与 id 确定性取 '${hit.name}'，需人工复核` : ''),
      { sizeMatched: sizeOk, posMatched: samePos(b.bbox, hit.bbox, posTol), ambiguous });
  }

  // ================= L3：pHash + 尺寸 + 位置 =================
  const l3Cfg = {
    phashMaxDistance: cfg.phashMaxDistance === undefined ? 10 : cfg.phashMaxDistance,
    phashWeight: cfg.phashWeight === undefined ? 0.5 : cfg.phashWeight,
    sizeWeight: cfg.sizeWeight === undefined ? 0.3 : cfg.sizeWeight,
    positionWeight: cfg.positionWeight === undefined ? 0.2 : cfg.positionWeight,
    maxShapeRatioFactor: cfg.maxShapeRatioFactor === undefined ? 1.6 : cfg.maxShapeRatioFactor,
    maxAreaRatio: cfg.maxAreaRatio === undefined ? 4 : cfg.maxAreaRatio,
    l3MinScore: cfg.l3MinScore === undefined ? 0.6 : cfg.l3MinScore,
  };

  const remainingBase = args.baseLayers.filter((l) => claimable(l) && !pairs.some((p) => p.baseId === l.id));
  const remainingTarget = args.targetLayers.filter((l) => claimable(l) && !usedTarget.has(l.id));

  // 候选对：算出所有相似度后做**全局贪心**（取最高分），避免「按 base 顺序先到先得」
  /** @type {Object[]} */
  const candPairs = [];
  for (const b of remainingBase) {
    for (const t of remainingTarget) {
      const sim = l3Similarity(b, t, l3Cfg);
      if (!sim) continue;
      candPairs.push({ b, t, sim });
    }
  }
  candPairs.sort((x, y) => (y.sim.score - x.sim.score)
    || (x.b.id < y.b.id ? -1 : x.b.id > y.b.id ? 1 : 0)
    || (x.t.id < y.t.id ? -1 : x.t.id > y.t.id ? 1 : 0));

  const takenBase = new Set();
  for (const cp of candPairs) {
    if (takenBase.has(cp.b.id) || usedTarget.has(cp.t.id)) continue;
    takenBase.add(cp.b.id);
    const merged = underMerged.get(cp.b.id) || underMerged.get(cp.t.id);
    // merged 组内只允许 L3，且封顶 0.5 —— take() 里已统一封顶
    take(cp.b, cp.t, LEVEL.L3, cp.sim.score,
      `L3 视觉+几何相似：pHash 汉明距离 ${cp.sim.parts.hamming}（<= ${l3Cfg.phashMaxDistance}），`
      + `尺寸 ${cp.b.bbox.w}x${cp.b.bbox.h} vs ${cp.t.bbox.w}x${cp.t.bbox.h}，`
      + `位置 (${cp.b.bbox.x},${cp.b.bbox.y}) vs (${cp.t.bbox.x},${cp.t.bbox.y})，`
      + `加权相似度 ${cp.sim.score}`
      + (merged
        ? `；该层位于 merged 组『${findMergedGroupName(cp.b, byId, underMerged)}』内，`
          + `按规则置信度封顶 ${mergedCap}`
        : ''),
      { sizeMatched: sameSize(cp.b.bbox, cp.t.bbox, sizeTol), posMatched: samePos(cp.b.bbox, cp.t.bbox, posTol), ...cp.sim.parts });
  }

  // ================= 检索兜底（可选）=================
  // 有素材库时，对剩余的 base 层跑一次三通道检索，把「同名确定的切图」也算作 L3 证据。
  // 没有素材库就跳过（纯 IR 对 IR 也能跑）。
  const searchNotes = [];
  if (args.index) {
    for (const b of remainingBase) {
      if (takenBase.has(b.id)) continue;
      if (!b.phash) continue;
      const res = searchAssets({
        index: args.index,
        queryName: b.normName,
        layerBox: { w: b.bbox.w, h: b.bbox.h },
        phash: b.phash,
        topK: 3,
        config: args.searchConfig,
        layerMerged: underMerged.get(b.id),
      });
      searchNotes.push({ baseId: b.id, certainty: res.certainty, hits: res.hits.length, evidence: res.evidence });
    }
  }

  // ================= 未匹配 =================
  const matchedBase = new Set(pairs.map((p) => p.baseId));
  const unmatchedBase = sortBy(
    args.baseLayers.filter((l) => !matchedBase.has(l.id) && claimable(l)),
    (l) => l.id,
  );
  const unmatchedTarget = sortBy(
    args.targetLayers.filter((l) => !usedTarget.has(l.id) && claimable(l)),
    (l) => l.id,
  );

  // 确定性排序：按 (level, baseId)
  const sortedPairs = sortBy(pairs,
    (p) => ['L1', 'L2', 'L3', 'L4'].indexOf(p.level),
    (p) => p.baseId);

  return {
    pairs: sortedPairs,
    unmatchedBase,
    unmatchedTarget,
    stats: {
      baseCount: args.baseLayers.filter(claimable).length,
      targetCount: args.targetLayers.filter(claimable).length,
      l1: sortedPairs.filter((p) => p.level === LEVEL.L1).length,
      l2: sortedPairs.filter((p) => p.level === LEVEL.L2).length,
      l3: sortedPairs.filter((p) => p.level === LEVEL.L3).length,
      l4: unmatchedTarget.length,
      mergedCapped: sortedPairs.filter((p) => p.underMerged).length,
      searchFallback: searchNotes.length,
    },
    searchNotes,
  };
}

/**
 * 找到某层所属的 merged 组名（用于 evidence 文案）。
 * @param {Object} layer
 * @param {Map<string,Object>} byId
 * @param {Map<string,boolean>} underMerged
 * @returns {string}
 */
function findMergedGroupName(layer, byId, underMerged) {
  let cur = layer;
  const seen = new Set();
  while (cur && cur.parent && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = byId.get(cur.parent);
    if (!parent) break;
    if (parent.merged) return parent.name;
    cur = parent;
  }
  return '(未知)';
}

module.exports = {
  matchLayers,
  isUnderMerged,
  l3Similarity,
  sameSize,
  samePos,
  LEVEL,
};
