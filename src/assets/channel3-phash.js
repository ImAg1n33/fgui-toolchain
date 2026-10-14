'use strict';
/**
 * src/assets/channel3-phash.js —— Ch-3 pHash + 主色 + 宽高比（兜底通道）
 *
 * 覆盖场景：图层名被合并/改了，尺寸也变了（拉伸过），只剩视觉相似。
 * 预计覆盖 10~20%（PRD 检索三通道表）。
 *
 * 打分 = 0.6·pHash 相似度 + 0.25·主色相似度 + 0.15·宽高比相似度
 *   · pHash 相似度 = 1 - 汉明距离/64
 *   · 主色相似度 = 1 - RGB 欧氏距离/最大距离
 *   · 宽高比相似度 = min(r1,r2)/max(r1,r2)（1 = 完全一致）
 *
 * 宽高比同时作为**硬过滤**：差异过大直接排除（拉伸过的图不该被当成同一素材）。
 */

const { hamming64, colorDistance } = require('../core/hash');
const { round6 } = require('../core/determinism');

/** 三个子项的权重（和为 1）。 */
const WEIGHTS = Object.freeze({ phash: 0.6, color: 0.25, aspect: 0.15 });

/**
 * 宽高比相似度。
 * @param {number} a
 * @param {number} b
 * @returns {number} 0..1
 */
function aspectSimilarity(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return 0;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return lo / hi;
}

/**
 * Ch-3 检索。
 *
 * @param {Object} args
 * @param {import('./store').AssetStore} args.index
 * @param {string|null} [args.phash] 查询的 pHash（16 位 hex）
 * @param {{r:number,g:number,b:number}|null} [args.dominant] 查询主色
 * @param {number} [args.aspectRatio] 查询宽高比
 * @param {number} [args.maxDistance=12] pHash 汉明距离上限（超过直接排除）
 * @param {number} [args.aspectTolerance=0.05] 宽高比相对容差（硬过滤）
 * @param {number} [args.topK=20] 只取前 N 个参与打分（全表扫，几千张内够用）
 * @returns {{ch3ById:Map<string, number>, candidates:Object[], evidence:string}}
 */
function channel3Phash(args) {
  const { index } = args;
  const maxDistance = args.maxDistance === undefined ? 12 : args.maxDistance;
  const aspectTol = args.aspectTolerance === undefined ? 0.05 : args.aspectTolerance;
  const topK = args.topK || 20;

  /** @type {Map<string, number>} */
  const ch3ById = new Map();
  const candidates = [];

  // 没有 pHash 就没法做视觉匹配，老实说清楚
  if (!args.phash) {
    return { ch3ById, candidates, evidence: 'Ch-3 跳过：查询未提供 pHash（无像素可比）' };
  }

  // 全表扫（几百到几千张，SQLite 直扫足够；ARCHITECTURE §9.4 明确本轮不上 BK-tree）
  const rows = index.all({ withFeatures: true });
  if (!rows.length) {
    return { ch3ById, candidates, evidence: 'Ch-3 跳过：素材库无带特征的素材' };
  }

  for (const r of rows) {
    const f = r.features;
    if (!f || !f.phash) continue;

    // 宽高比硬过滤
    const ar = args.aspectRatio;
    if (Number.isFinite(ar) && Number.isFinite(f.aspectRatio) && f.aspectRatio > 0) {
      const rel = Math.abs(ar - f.aspectRatio) / Math.max(ar, f.aspectRatio);
      if (rel > aspectTol) continue;
    }

    const dist = hamming64(args.phash, f.phash);
    if (dist > maxDistance) continue;

    const phashSim = 1 - dist / 64;
    const colorSim = args.dominant
      ? 1 - colorDistance(args.dominant, { r: f.dominantR, g: f.dominantG, b: f.dominantB })
      : 0;
    const arSim = aspectSimilarity(ar, f.aspectRatio);

    const score = Math.max(0, Math.min(1,
      WEIGHTS.phash * phashSim + WEIGHTS.color * colorSim + WEIGHTS.aspect * arSim));
    ch3ById.set(r.id, round6(score));
    candidates.push({
      asset: r,
      ch3: round6(score),
      hamming: dist,
      phashSim: round6(phashSim),
      colorSim: round6(colorSim),
      aspectSim: round6(arSim),
    });
  }

  candidates.sort((a, b) => (b.ch3 - a.ch3)
    || (a.asset.id < b.asset.id ? -1 : a.asset.id > b.asset.id ? 1 : 0));

  const trimmed = candidates.slice(0, topK);
  return {
    ch3ById,
    candidates: trimmed,
    evidence: `Ch-3 命中 ${candidates.length} 张（汉明距离 <= ${maxDistance}，宽高比容差 ${aspectTol}），`
      + `最高分 ${trimmed.length ? trimmed[0].ch3 : 0}`
      + `（${trimmed.length ? trimmed[0].asset.relPath : '-'}，汉明距离 ${trimmed.length ? trimmed[0].hamming : '-'}）`,
  };
}

module.exports = { channel3Phash, aspectSimilarity, WEIGHTS };
