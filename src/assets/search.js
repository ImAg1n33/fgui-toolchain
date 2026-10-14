'use strict';
/**
 * src/assets/search.js —— 三通道检索 + 加权评分
 *
 * 排序规则（PRD / ARCHITECTURE §3.2）：
 *   · Ch-1 命中**短路置顶**（唯一命中时 confidence=1.0，不与他人竞争）
 *   · 其余按 `score = 0.5·Ch1 + 0.3·Ch2 + 0.2·Ch3` 降序
 *   · 同分时按 assetId 字典序 —— 保证确定性（B9）
 *
 * ★ 结果必须显式标注「同名确定」还是「猜的」★（PRD 检索三通道明文要求）：
 *   `certainty: 'exact_name' | 'ambiguous' | 'guess'`
 *   只有 `exact_name` 才是确定的；`ambiguous` 与 `guess` 都必须进人工确认队列。
 *   `needsConfirm` 字段直接给出这个判断，下游不必自己推断。
 */

const { channel1Name, CH1_STATUS } = require('./channel1-name');
const { channel2Shape } = require('./channel2-shape');
const { channel3Phash } = require('./channel3-phash');
const { round6 } = require('../core/determinism');

/** 确定性来源。 */
const CERTAINTY = Object.freeze({
  EXACT_NAME: 'exact_name',   // Ch-1 唯一命中且尺寸校验通过
  AMBIGUOUS: 'ambiguous',     // Ch-1 多候选通过尺寸校验
  GUESS: 'guess',             // 靠 Ch-2/Ch-3 猜的
});

/**
 * 三通道检索主入口。
 *
 * @param {Object} args
 * @param {import('./store').AssetStore} args.index
 * @param {string} args.queryName IR 图层名 / 语义槽位名
 * @param {{w:number,h:number}|null} [args.layerBox] 图层 bbox，用于尺寸校验
 * @param {{w:number,h:number}|null} [args.wantSize] 期望切图尺寸（缺省用 layerBox）
 * @param {string|null} [args.phash] 查询 pHash（Ch-3 用，通常来自图层像素）
 * @param {{r:number,g:number,b:number}|null} [args.dominant] 查询主色
 * @param {number} [args.topK=10]
 * @param {Object} [args.config] fgui.config.json 的 search 段
 * @param {Object} [args.scaleInfer] fgui.config.json 的 asset.scaleInfer 段
 *        （E-02 倍率推断开关，**默认关闭**；关闭时 Ch-1 尺寸校验与改造前一致）
 * @param {Object} [args.normalizeOpts]
 * @param {boolean} [args.layerMerged=false] 图层是否在 merged 组里（降置信度）
 * @param {number} [args.mergedConfidenceCap=0.5] merged 组的置信度上限
 * @returns {{hits:Object[], evidence:string, channels:Object, certainty:string, needsConfirm:boolean}}
 */
function searchAssets(args) {
  const cfg = args.config || {};
  const weights = cfg.weights || { ch1: 0.5, ch2: 0.3, ch3: 0.2 };
  const tol = cfg.sizeTolerancePx === undefined ? 2 : cfg.sizeTolerancePx;
  const topK = args.topK || cfg.topK || 10;
  const ambiguousCap = cfg.ambiguousConfidenceCap === undefined ? 0.6 : cfg.ambiguousConfidenceCap;
  const mergedCap = args.mergedConfidenceCap === undefined ? 0.5 : args.mergedConfidenceCap;

  const layerBox = args.layerBox || null;
  const wantSize = args.wantSize || (layerBox ? { w: layerBox.w, h: layerBox.h } : null);
  // E-02：倍率推断开关透传。关闭时下方一切行为与改造前一致。
  const scaleInfer = args.scaleInfer || null;
  const scaleInferOn = !!(scaleInfer && scaleInfer.enabled);

  // ---- Ch-1 ----
  const ch1 = channel1Name({
    index: args.index,
    queryName: args.queryName,
    layerBox,
    tol,
    normalizeOpts: args.normalizeOpts,
    ambiguousCap,
    scaleInfer,
  });

  const channels = {
    ch1: { status: ch1.status, ch1: ch1.ch1, confidence: ch1.confidence, evidence: ch1.evidence },
    ch2: null,
    ch3: null,
  };

  // ---- Ch-1 唯一命中：短路置顶，不再跑 Ch-2/Ch-3（省时间，且避免弱通道污染强证据）----
  if (ch1.status === CH1_STATUS.HIT) {
    const hit = ch1.candidates[0];
    let confidence = 1;
    if (args.layerMerged) confidence = Math.min(confidence, mergedCap);
    const hitObj = {
      asset: hit,
      score: 1,
      level: 'L1',
      certainty: CERTAINTY.EXACT_NAME,
      ch1: 1,
      ch2: 0,
      ch3: 0,
      confidence: round6(confidence),
      needsConfirm: args.layerMerged,
      confirmed: false,
      evidence: ch1.evidence
        + (args.layerMerged
          ? `；注意：该图层位于 merged 组内，置信度按规则封顶 ${mergedCap}`
          : '；Ch-1 命中已短路置顶，未执行 Ch-2/Ch-3'),
    };
    // E-02：仅在倍率推断开启时输出 scale 字段（默认关闭时产物与改造前逐字节一致）
    if (scaleInferOn) hitObj.scale = hit.scale === undefined ? null : hit.scale;
    return {
      hits: [hitObj],
      certainty: CERTAINTY.EXACT_NAME,
      needsConfirm: !!args.layerMerged,
      channels,
      evidence: ch1.evidence,
    };
  }

  // ---- Ch-1 歧义：全部返回，不做加权竞争（加权会让某个候选"胜出"，那是静默选择）----
  // E-02：1x/2x 倍图同时通过校验时同样全部返回，各带 scale 字段，人工确认选哪份。
  if (ch1.status === CH1_STATUS.AMBIGUOUS) {
    return {
      hits: ch1.candidates.map((c) => {
        const obj = {
          asset: c,
          score: round6(ambiguousCap),
          level: 'L2',
          certainty: CERTAINTY.AMBIGUOUS,
          ch1: ch1.ch1,
          ch2: 0,
          ch3: 0,
          confidence: round6(ambiguousCap),
          needsConfirm: true,
          confirmed: false,
          evidence: ch1.evidence,
        };
        if (scaleInferOn) obj.scale = c.scale === undefined ? null : c.scale;
        return obj;
      }),
      certainty: CERTAINTY.AMBIGUOUS,
      needsConfirm: true,
      channels,
      evidence: ch1.evidence,
    };
  }

  // ---- Ch-2 ----
  const ch2 = channel2Shape({
    index: args.index,
    layerBox: wantSize ? { w: wantSize.w, h: wantSize.h } : null,
    tol,
  });
  channels.ch2 = { status: ch2.candidates.length ? 'HIT' : 'MISS', evidence: ch2.evidence };

  // ---- Ch-3 ----
  const ch3 = channel3Phash({
    index: args.index,
    phash: args.phash || null,
    dominant: args.dominant || null,
    aspectRatio: wantSize ? wantSize.w / wantSize.h : undefined,
    maxDistance: cfg.phashMaxDistance,
    aspectTolerance: cfg.aspectTolerance,
  });
  channels.ch3 = { status: ch3.candidates.length ? 'HIT' : 'MISS', evidence: ch3.evidence };

  // ---- 加权合并 ----
  /** @type {Map<string, Object>} */
  const merged = new Map();
  const absorb = (list, key, level) => {
    for (const item of list) {
      const id = item.asset.id;
      let slot = merged.get(id);
      if (!slot) {
        slot = { asset: item.asset, ch1: 0, ch2: 0, ch3: 0, levels: [], parts: {} };
        merged.set(id, slot);
      }
      slot[key] = item[key];
      slot.levels.push(level);
      slot.parts[key] = item;
    }
  };
  absorb(ch2.candidates, 'ch2', 'L3');
  absorb(ch3.candidates, 'ch3', 'L3');

  const hits = [];
  for (const slot of merged.values()) {
    const score = weights.ch1 * slot.ch1 + weights.ch2 * slot.ch2 + weights.ch3 * slot.ch3;
    // 置信度取「各通道里最像 exact 的那个」，但整体是 guess —— 不因为 Ch-2/Ch-3 命中就装确定
    let confidence = Math.max(slot.ch2, slot.ch3);
    if (args.layerMerged) confidence = Math.min(confidence, mergedCap);
    hits.push({
      asset: slot.asset,
      score: round6(score),
      level: 'L3',
      certainty: CERTAINTY.GUESS,
      ch1: 0,
      ch2: slot.ch2,
      ch3: slot.ch3,
      confidence: round6(confidence),
      needsConfirm: true,
      confirmed: false,
      evidence: `${ch1.evidence} | ${ch2.evidence} | ${ch3.evidence} | `
        + `加权得分 ${round6(score)} = ${weights.ch1}·0 + ${weights.ch2}·${slot.ch2} + ${weights.ch3}·${slot.ch3}`
        + '；Ch-1 未命中，本条为推测结果，必须人工确认',
    });
  }

  // 确定性排序：分数降序 -> assetId 升序
  hits.sort((a, b) => (b.score - a.score)
    || (a.asset.id < b.asset.id ? -1 : a.asset.id > b.asset.id ? 1 : 0));

  const top = hits.slice(0, topK);
  return {
    hits: top,
    certainty: top.length ? CERTAINTY.GUESS : CERTAINTY.GUESS,
    needsConfirm: true,
    channels,
    evidence: top.length
      ? `检索到 ${top.length} 个候选，最高分 ${top[0].score}（${top[0].asset.relPath}）；Ch-1 未命中，全部为推测结果`
      : `${ch1.evidence} | ${ch2.evidence} | ${ch3.evidence} | 三通道均无候选`,
  };
}

/**
 * ★ 统计 Ch-1 覆盖率（PRD A2 指标：>= 50%）★
 *
 * @param {{certainty:string}[]} results
 * @returns {{total:number, exactName:number, coverage:number}}
 */
function channel1Coverage(results) {
  const total = results.length;
  const exactName = results.filter((r) => r.certainty === CERTAINTY.EXACT_NAME).length;
  return {
    total,
    exactName,
    coverage: total ? round6(exactName / total) : 0,
  };
}

module.exports = { searchAssets, channel1Coverage, CERTAINTY };
