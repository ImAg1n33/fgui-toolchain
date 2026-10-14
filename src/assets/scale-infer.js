'use strict';
/**
 * src/assets/scale-infer.js —— 倍率推断（E-02，回应已知限制 L6 / Q22）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 背景
 * ════════════════════════════════════════════════════════════════════════════
 * Ch-1 用「图层 bbox 尺寸 vs 切图像素尺寸 ±2px」做同名匹配的二次判别，
 * 该容差是按 **1x** 设计的。若切图目录里同时存在 1x 与 2x 图
 * （PSD 里 96×96 的图标，实际文件可能有 96×96 与 192×192 两份），
 * 按 ±2px 校验 **2x 那份会被判为不匹配** —— 而它其实是同一个素材（L6/Q22）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 设计（三条铁律）
 * ════════════════════════════════════════════════════════════════════════════
 * 1. **不放松 1x 精度**：倍率 k 下容差为 `±tol·k`（等价于先把图尺寸除以 k
 *    再按 ±tol 比对）。k=1 时与改造前**逐字节一致** —— K5 命名陷阱
 *    （`矩形1` vs `矩形11`）正是靠 ±2px 尺寸校验兜底，放松会误匹配。
 * 2. **不硬凑倍率**：只有 `|imgW - bboxW·k| <= tol·k` **且**
 *    `|imgH - bboxH·k| <= tol·k` 同时成立才判定为该倍率。
 *    非整数比（如 150 vs 96 = 1.5625）任何整数 k 都不满足 -> 不匹配。
 * 3. **默认关闭**：`asset.scaleInfer.enabled` 默认 false（Q22 未确认
 *    是否有 2x，默认开启会改变现有行为）。答案到位后只改配置。
 *
 * 歧义处理不在本模块 —— 由 channel1-name 负责：一个图层名同时匹配到
 * 1x 与 2x 两份图时**全部返回并标 AMBIGUOUS**，绝不静默取一个
 * （PRD K5 / AssetStore.byNormName 返回数组就是为这个）。
 */

const { round6 } = require('../core/determinism');

/** 默认配置（与 fgui.config.json 的 asset.scaleInfer 段一致）。 */
const DEFAULT_SCALE_INFER = Object.freeze({
  /** 倍率推断开关。默认 false —— Q22 未答，不改变现有行为。 */
  enabled: false,
  /** 支持的最大倍率。1x/2x/3x 常见，4x 留余量。 */
  maxScale: 4,
});

/** 推断结果的原因码。 */
const INFER_REASON = Object.freeze({
  OK: 'OK',                       // 命中某个整数倍率
  INVALID_INPUT: 'INVALID_INPUT', // 入参缺失/非正数/非有限数
  NO_INTEGER_SCALE: 'NO_INTEGER_SCALE', // 比值不对应任何整数倍率（容差内）
});

/**
 * 尺寸对象是否可用（正有限数）。
 * @param {{w:number,h:number}|null|undefined} s
 * @returns {boolean}
 */
function isValidSize(s) {
  return !!s
    && Number.isFinite(s.w) && Number.isFinite(s.h)
    && s.w > 0 && s.h > 0;
}

/**
 * 倍率推断。
 *
 * 做法：对每个候选整数倍率 k（1..maxScale），检查
 *   `|imgW - bboxW·k| <= tol·k` 且 `|imgH - bboxH·k| <= tol·k`。
 * 全部通过的 k 中取**总偏差最小**者；并列时取更小的 k
 * （保守：倾向 1x 解释，不为放大容差而凑高倍率）。
 *
 * ★ k=1 时判据就是 `|img - bbox| <= tol`，与改造前完全一致 ★
 *   —— 这是「支持倍率不放松 1x 精度」的回归保证。
 *
 * @param {{w:number,h:number}} layerBox 图层 bbox 尺寸（1x 基准）
 * @param {{w:number,h:number}} imgSize 切图实际像素尺寸
 * @param {Object} [opts]
 * @param {number} [opts.tol=2] 1x 基准容差（px）。倍率 k 下缩放为 tol·k
 * @param {number} [opts.maxScale=4] 最大候选倍率
 * @returns {{matched:boolean, scale:number|null, ratioW:number|null,
 *            ratioH:number|null, deviation:number|null,
 *            devW:number|null, devH:number|null, reason:string}}
 */
function inferScale(layerBox, imgSize, opts = {}) {
  const tol = opts.tol === undefined ? 2 : opts.tol;
  const maxScale = opts.maxScale === undefined
    ? DEFAULT_SCALE_INFER.maxScale
    : opts.maxScale;

  if (!isValidSize(layerBox) || !isValidSize(imgSize)) {
    return {
      matched: false, scale: null, ratioW: null, ratioH: null,
      deviation: null, devW: null, devH: null,
      reason: INFER_REASON.INVALID_INPUT,
    };
  }

  const ratioW = imgSize.w / layerBox.w;
  const ratioH = imgSize.h / layerBox.h;
  const maxK = Math.max(1, Math.floor(maxScale));

  /** @type {{scale:number, deviation:number, devW:number, devH:number}|null} */
  let best = null;
  for (let k = 1; k <= maxK; k++) {
    const devW = Math.abs(imgSize.w - layerBox.w * k);
    const devH = Math.abs(imgSize.h - layerBox.h * k);
    if (devW <= tol * k && devH <= tol * k) {
      const deviation = devW + devH;
      // 严格小于才替换 -> 并列时保留更小的倍率（保守倾向 1x）
      if (!best || deviation < best.deviation) {
        best = { scale: k, deviation, devW, devH };
      }
    }
  }

  if (!best) {
    return {
      matched: false, scale: null, ratioW, ratioH,
      deviation: null, devW: null, devH: null,
      reason: INFER_REASON.NO_INTEGER_SCALE,
    };
  }
  return {
    matched: true,
    scale: best.scale,
    ratioW: round6(ratioW),
    ratioH: round6(ratioH),
    deviation: round6(best.deviation),
    devW: round6(best.devW),
    devH: round6(best.devH),
    reason: INFER_REASON.OK,
  };
}

/**
 * 单候选的尺寸判别（Ch-1 保险 2 的倍率感知版）。
 *
 * · scaleInfer 关闭 -> 行为与改造前**完全一致**（`sizeWithinTol(layerBox, imgSize, tol)`）
 * · scaleInfer 开启 -> 按整数倍率缩放容差；命中时返回推断倍率
 *
 * @param {{w:number,h:number}} layerBox 图层 bbox 尺寸
 * @param {{w:number,h:number}} imgSize 切图像素尺寸
 * @param {number} tol 1x 基准容差
 * @param {{enabled?:boolean, maxScale?:number}|null|undefined} scaleInfer 配置段
 * @returns {{matched:boolean, scale:number|null, infer:Object|null}}
 */
function judgeCandidateSize(layerBox, imgSize, tol, scaleInfer) {
  const enabled = !!(scaleInfer && scaleInfer.enabled);
  if (!enabled) {
    // 延迟 require 避免模块初始化期循环依赖风险（与本文件其它部分风格一致）
    // eslint-disable-next-line global-require
    const { sizeWithinTol } = require('./channel1-name');
    return { matched: sizeWithinTol(layerBox, imgSize, tol), scale: null, infer: null };
  }
  const infer = inferScale(layerBox, imgSize, { tol, maxScale: scaleInfer.maxScale });
  return { matched: infer.matched, scale: infer.matched ? infer.scale : null, infer };
}

/**
 * 生成 Ch-1 evidence 里的倍率说明（仅 scaleInfer 开启时非空）。
 * @param {Object|null} infer inferScale 的返回
 * @param {number} tol 1x 基准容差
 * @returns {string}
 */
function scaleEvidence(infer, tol) {
  if (!infer || !infer.matched) return '';
  return `；推断倍率 ${infer.scale}x（切图 ${infer.ratioW}x/${infer.ratioH}x 于图层，`
    + `容差按倍率缩放为 ±${tol * infer.scale}px，总偏差 ${infer.deviation}px）`;
}

module.exports = {
  inferScale,
  judgeCandidateSize,
  scaleEvidence,
  isValidSize,
  DEFAULT_SCALE_INFER,
  INFER_REASON,
};
