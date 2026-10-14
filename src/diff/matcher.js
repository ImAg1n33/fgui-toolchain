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
 * ★ merged/suspected 启发式的联动语义（★ UPSTREAM-FIX-4：成本不对称重构 ★）★
 *
 *   旧行为（已废除）：merged=true 的组内节点**预先禁用** L1/L2、只允许 L3
 *   且封顶 0.5。外部审查指出这会误伤：画师可能给弹窗建了切片但没给按钮组
 *   建切片，「文档有切片 + 某组无切片」并不证明该组被合并 —— 误判会**无理
 *   放弃正常独立组的精确匹配**（高代价）。
 *
 *   成本不对称：
 *     · 误判 merged 的代价：精确匹配被禁用 -> 人工确认增加（高）。
 *     · 漏判 merged 的代价：真被合并的组在第二份 PSD 里根本没有独立子层，
 *       L1（要求双侧 slice 名一致）/L2（要求双侧归一名全等）本来就会失败，
 *       自然落入 L3/未命中（低）。
 *
 *   新语义：
 *     1. merged/suspected 状态**不改变匹配路径**：组内图层照常走 L1/L2/L3
 *        全部档位 —— 匹配成功（尤其 L1 slice 名一致 / L2 归一名全等）本身
 *        就证明没被合并，精确结果优先。
 *     2. 只影响**未命中去向**：未匹配且位于 merged/suspected 组内的图层
 *        进 INFERRED（留人工确认）而非 ADD；REMOVE 侧同样压置信度
 *        （classifier.js 职责）。
 *     3. L3（视觉相似，弱证据）命中且疑似合并时 confidence 封顶 0.5 ——
 *        疑似合并的对象可能只是「碰巧长得像」扁平内容，弱证据需打折。
 *
 * ★ UPSTREAM-FIX-3：身份加作用域（跨 PSD 节点 ID 碰撞）★
 *   base 与 target 的图层 id 各自从 L001 独立编号，**必然碰撞**。
 *   旧实现把两份图层放进同一张 byId（target 覆盖 base），merged 父链爬升
 *   会走错侧的父节点（base 的 L002 查到 target 的 L001）。现在按侧建表
 *   （baseById/targetById），under* 表用 `base:${id}` / `target:${id}`
 *   作用域键 —— **绝不把两份图层放进同一张以局部 id 为键的 Map**。
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
 * 判断某个图层是否位于携带指定标记（merged / suspectedMerged）的组内
 * （沿 parent 链向上找，**只在传入的同一份 byId 内爬** —— 调用方必须保证
 * byId 是单侧的图层表，跨侧合并表会因 ID 碰撞走错父链）。
 *
 * @param {Object} layer IR 层节点
 * @param {Map<string,Object>} byId 单侧的 id -> layer 表
 * @param {string} [flag='merged'] 组节点上参与判定的字段名
 * @returns {boolean}
 */
function isUnderFlag(layer, byId, flag = 'merged') {
  let cur = layer;
  const seen = new Set();
  while (cur && cur.parent && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = byId.get(cur.parent);
    if (!parent) return false;
    if (parent[flag]) return true;
    cur = parent;
  }
  return false;
}

/**
 * 判断某个图层是否位于 merged 组内（isUnderFlag 的 merged 便捷封装）。
 *
 * @param {Object} layer IR 层节点
 * @param {Map<string,Object>} byId 单侧的 id -> layer 表
 * @returns {boolean}
 */
function isUnderMerged(layer, byId) {
  return isUnderFlag(layer, byId, 'merged');
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

  // ★★ UPSTREAM-FIX-3：按侧建表，绝不用一张合并 Map ★★
  //   两份 PSD 的 id 各自从 L001 独立编号必然碰撞；merged/suspected 的父链
  //   爬升必须走**本侧**的父节点。under* 表用 `base:${id}` / `target:${id}`
  //   作用域键，两个方向互不污染。
  const baseById = new Map(args.baseLayers.map((l) => [l.id, l]));
  const targetById = new Map(args.targetLayers.map((l) => [l.id, l]));

  /**
   * 计算单侧每个图层的「位于 merged/suspected 组内」标记（作用域键）。
   * @param {Object[]} layers 单侧图层
   * @param {Map<string,Object>} byIdSide 单侧查表
   * @param {string} side 'base' | 'target'
   * @returns {Map<string,boolean>}
   */
  const computeUnder = (layers, byIdSide, side) => {
    const out = new Map();
    for (const l of layers) {
      out.set(`${side}:${l.id}`,
        isUnderMerged(l, byIdSide) || isUnderFlag(l, byIdSide, 'suspectedMerged'));
    }
    return out;
  };
  // 标记每个图层是否在 merged/suspected 组内（含两侧；键带作用域前缀）
  const underMerged = new Map([
    ...computeUnder(args.baseLayers, baseById, 'base'),
    ...computeUnder(args.targetLayers, targetById, 'target'),
  ]);

  const pairs = [];
  const usedTarget = new Set();

  /**
   * 尝试配对。
   *
   * ★ UPSTREAM-FIX-4：封顶只作用于 L3 ★
   *   merged/suspected 不再禁用 L1/L2、也不对精确匹配封顶 —— 匹配成功
   *   本身就是「没被合并」的证据。只有 L3（视觉相似弱证据）命中且任一侧
   *   疑似合并时才封顶（疑似合并的对象可能只是碰巧长得像扁平内容）。
   *
   * @param {Object} base
   * @param {Object} target
   * @param {string} level
   * @param {number} confidence
   * @param {string} evidence
   * @param {Object} [extra]
   */
  const take = (base, target, level, confidence, evidence, extra) => {
    const suspect = underMerged.get(`base:${base.id}`) || underMerged.get(`target:${target.id}`);
    let conf = confidence;
    if (suspect && level === LEVEL.L3) conf = Math.min(conf, mergedCap);
    pairs.push({
      baseId: base.id,
      targetId: target.id,
      level,
      confidence: round6(conf),
      underMerged: !!suspect,
      evidence,
      ...(extra || {}),
    });
    usedTarget.add(target.id);
  };

  const claimable = (l) => l.type !== 'group';

  // ================= L1：slice 名完全一致 =================
  // ★ UPSTREAM-FIX-4：merged/suspected 组内节点照常参与 L1 ——
  //   双侧 slice 名一致是最强证据，命中即证明未合并
  const bySlice = new Map();
  for (const t of args.targetLayers) {
    if (!claimable(t) || !t.sliceName) continue;
    if (!bySlice.has(t.sliceName)) bySlice.set(t.sliceName, []);
    bySlice.get(t.sliceName).push(t);
  }
  for (const b of args.baseLayers) {
    if (!claimable(b) || !b.sliceName) continue;
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
    const cands = (byNorm.get(b.normName) || []).filter((t) => !usedTarget.has(t.id));
    if (!cands.length) continue;
    // 同名多候选：优先尺寸吻合的；仍多个则取 id 最小的（确定性），并降置信度 + 标 AMBIGUOUS
    const sized = cands.filter((t) => sameSize(b.bbox, t.bbox, sizeTol));
    const pool = sized.length ? sized : cands;
    // ★ UPSTREAM-FIX-7：歧义必须保留**全部候选**供人工选择（只留被选中的那一个，
    //   人工就无法在 change_plan.json 里改判 —— 确定性取第一个可能取错素材）
    const poolIds = pool.slice()
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      .map((t) => t.id);
    const hit = pool.find((t) => t.id === poolIds[0]);
    const ambiguous = poolIds.length > 1;
    const sizeOk = sameSize(b.bbox, hit.bbox, sizeTol);
    take(b, hit, LEVEL.L2, ambiguous ? 0.7 : (sizeOk ? 0.95 : 0.8),
      `L2 归一化名全等一致：'${b.name}' 与 '${hit.name}' 归一化后均为 '${b.normName}'`
      + '（仅做全等匹配，未使用前缀/子串包含，避免「矩形1」误配「矩形11」）'
      + (sizeOk
        ? `，且尺寸吻合（${b.bbox.w}x${b.bbox.h}）`
        : `，但尺寸有变化（${b.bbox.w}x${b.bbox.h} -> ${hit.bbox.w}x${hit.bbox.h}）`)
      + (ambiguous
        ? `；⚠ 同名候选 ${poolIds.length} 个（${poolIds.join('、')}），已按尺寸与 id 确定性取 '${hit.name}'，`
          + '**需人工复核**：请在 change_plan.json 里把该条目的 resolved 设为选定候选的 id'
        : ''),
      {
        sizeMatched: sizeOk,
        posMatched: samePos(b.bbox, hit.bbox, posTol),
        ambiguous,
        ambiguousCandidates: ambiguous ? poolIds : [],
      });
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
    const suspect = underMerged.get(`base:${cp.b.id}`) || underMerged.get(`target:${cp.t.id}`);
    take(cp.b, cp.t, LEVEL.L3, cp.sim.score,
      `L3 视觉+几何相似：pHash 汉明距离 ${cp.sim.parts.hamming}（<= ${l3Cfg.phashMaxDistance}），`
      + `尺寸 ${cp.b.bbox.w}x${cp.b.bbox.h} vs ${cp.t.bbox.w}x${cp.t.bbox.h}，`
      + `位置 (${cp.b.bbox.x},${cp.b.bbox.y}) vs (${cp.t.bbox.x},${cp.t.bbox.y})，`
      + `加权相似度 ${cp.sim.score}`
      + (suspect
        ? `；该层疑似位于合并组『${findMergedGroupName(cp.b, baseById)
          || findMergedGroupName(cp.t, targetById)}』内，`
          + `视觉相似属弱证据，置信度封顶 ${mergedCap}（UPSTREAM-FIX-4：精确匹配不受限，仅弱证据打折）`
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
        layerMerged: underMerged.get(`base:${b.id}`),
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
 * 找到某层所属的 merged/suspected 组名（用于 evidence 文案）。
 * ★ UPSTREAM-FIX-3：byId 必须是该层所属侧的单侧表（跨侧合并表会撞 id）。
 * @param {Object} layer
 * @param {Map<string,Object>} byId 单侧 id -> layer
 * @returns {string} 组名；不在任何 merged/suspected 组内时返回 ''
 */
function findMergedGroupName(layer, byId) {
  let cur = layer;
  const seen = new Set();
  while (cur && cur.parent && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = byId.get(cur.parent);
    if (!parent) break;
    if (parent.merged || parent.suspectedMerged) return parent.name;
    cur = parent;
  }
  return '';
}

module.exports = {
  matchLayers,
  isUnderMerged,
  isUnderFlag,
  l3Similarity,
  sameSize,
  samePos,
  LEVEL,
};
