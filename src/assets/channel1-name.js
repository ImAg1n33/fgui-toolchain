'use strict';
/**
 * src/assets/channel1-name.js —— Ch-1 精确同名 + ±2px 尺寸校验（ARCHITECTURE §4.2）
 *
 * 这是整个检索策略的**地基**：画师在 `图层129` 上画，切出来也叫 `图层129.png`，
 * 预计覆盖 50~70%（PRD A2）。所以 Ch-1 的准确率直接决定 A1 能否达标。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★★ K5 双保险（PRD K5 / ARCHITECTURE D5）★★★
 *   实际文件名形如 `矩形1`、`矩形11`、`图层249(1)` ——
 *   **`矩形1` 是 `矩形11` 的前缀**，用 startsWith/includes 必然误匹配。
 *
 *   保险 1（归一化层）：本通道只做 `normalizeName(a) === normalizeName(b)` **全等匹配**。
 *                     归一化后 `矩形1` !== `矩形11`，两者是不同的检索主键。
 *                     代码里**没有** startsWith / includes / 正则子串匹配。
 *
 *   保险 2（尺寸校验层）：即便归一化后真同名（如 `矩形1.png` 与 `矩形1(1).png`
 *                     去副本后缀后都归一化成 `矩形1`），用 **±2px 尺寸校验**二次判别；
 *                     仍歧义则**全部返回**并标 `AMBIGUOUS` 进确认队列，
 *                     **绝不静默取第一个**。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 流程（ARCHITECTURE §4.2）：
 *   byNormName(normalizeName(queryName))
 *     ├─ 候选集为空 ──────────────► 落 Ch-2
 *     └─ 非空
 *        逐候选做 ±2px 尺寸校验 |bbox.w - img.w| <= 2 && |bbox.h - img.h| <= 2
 *          ├─ 通过者 = 1  → Ch1=1.0 命中，短路置顶，confidence=1.0
 *          ├─ 通过者 > 1  → 全部返回，confidence <= 0.6，evidence 标 AMBIGUOUS
 *          └─ 通过者 = 0  → 落 Ch-2
 *
 * ── E-02 倍率推断（回应 L6 / Q22，默认关闭）──────────────────────────────
 * 若切图目录混用 1x/2x（同素材两份：96×96 与 192×192），按 ±2px 校验
 * 2x 那份会被误判为不匹配。开启 `asset.scaleInfer` 后，尺寸校验按
 * **整数倍率缩放容差**：倍率 k 下判据为 |img - bbox·k| <= 2k（等价于
 * 先把图尺寸除以 k 再按 ±2px 比对）。
 *
 * ★ 三条保证 ★
 *   1. k=1 时判据与改造前逐字节一致 —— 不放松 1x 精度（K5 尺寸兜底不弱化）；
 *   2. 非整数比（150 vs 96 = 1.5625）不对应任何整数 k -> 不匹配，不硬凑；
 *   3. 同名同时命中 1x 与 2x -> **全部返回并标 AMBIGUOUS**，绝不静默取一个。
 *
 * 默认关闭的理由：Q22（是否真有 2x 混用）未确认，默认开启会改变现有行为。
 * 答案到位后只改 `fgui.config.json` 的 `asset.scaleInfer.enabled`。
 */

const { judgeCandidateSize, scaleEvidence } = require('./scale-infer');

/** 命中状态。 */
const CH1_STATUS = Object.freeze({
  HIT: 'HIT',                 // 唯一命中，短路置顶
  AMBIGUOUS: 'AMBIGUOUS',     // 多候选通过尺寸校验，全部返回待人工确认
  NO_SIZE_MATCH: 'NO_SIZE_MATCH', // 同名但尺寸都不符 -> 落 Ch-2
  NO_NAME_MATCH: 'NO_NAME_MATCH', // 无同名候选 -> 落 Ch-2
});

/**
 * ±2px 尺寸校验。
 * @param {{w:number,h:number}} layerBox 图层 bbox 尺寸
 * @param {{w:number,h:number}} imgSize 切图像素尺寸
 * @param {number} tol 容差 px
 * @returns {boolean}
 */
function sizeWithinTol(layerBox, imgSize, tol) {
  if (!layerBox || !imgSize) return false;
  if (!Number.isFinite(layerBox.w) || !Number.isFinite(imgSize.w)) return false;
  if (!Number.isFinite(layerBox.h) || !Number.isFinite(imgSize.h)) return false;
  return Math.abs(layerBox.w - imgSize.w) <= tol && Math.abs(layerBox.h - imgSize.h) <= tol;
}

/**
 * Ch-1 检索。
 *
 * @param {Object} args
 * @param {import('./store').AssetStore} args.index
 * @param {string} args.queryName IR 图层名 / 语义槽位名
 * @param {{w:number,h:number}|null} [args.layerBox] 图层 bbox，用于 ±2px 校验
 * @param {number} [args.tol=2] 尺寸容差（1x 基准；倍率推断开启时按倍率缩放）
 * @param {Object} [args.normalizeOpts]
 * @param {number} [args.ambiguousCap=0.6] 歧义时的置信度上限
 * @param {{enabled?:boolean, maxScale?:number}|null} [args.scaleInfer]
 *        E-02 倍率推断配置（fgui.config.json 的 asset.scaleInfer 段）。
 *        **默认关闭**：关闭时尺寸校验行为与改造前完全一致。
 * @returns {{status:string, ch1:number, confidence:number,
 *            candidates:Object[], evidence:string, ambiguous:boolean}}
 */
function channel1Name(args) {
  const { index, queryName } = args;
  const tol = args.tol === undefined ? 2 : args.tol;
  const ambiguousCap = args.ambiguousCap === undefined ? 0.6 : args.ambiguousCap;
  const scaleInfer = args.scaleInfer || null;
  const scaleEnabled = !!(scaleInfer && scaleInfer.enabled);
  // 延迟 require 避免循环依赖（normalize 不依赖 assets，其实不需要，但保持风格一致）
  // eslint-disable-next-line global-require
  const { normalizeName } = require('../core/normalize');

  const norm = normalizeName(queryName, args.normalizeOpts || {});
  if (!norm) {
    return {
      status: CH1_STATUS.NO_NAME_MATCH,
      ch1: 0,
      confidence: 0,
      candidates: [],
      evidence: `查询名 '${queryName}' 归一化后为空串，无法做 Ch-1 匹配`,
      ambiguous: false,
    };
  }

  // ★ 保险 1：这里只做**全等**查表（SQL 的 = ），绝不用 LIKE / GLOB
  const rows = index.byNormName(norm);
  if (!rows.length) {
    return {
      status: CH1_STATUS.NO_NAME_MATCH,
      ch1: 0,
      confidence: 0,
      candidates: [],
      evidence: `Ch-1 未命中：归一名 '${norm}' 在素材库中无同名切图`
        + '（注意：仅做全等匹配，未使用前缀/子串包含，避免「矩形1」误配「矩形11」）',
      ambiguous: false,
    };
  }

  // 没有图层尺寸可校验时，同名单候选即视为歧义（不能盲选）
  if (!args.layerBox) {
    return {
      status: CH1_STATUS.AMBIGUOUS,
      ch1: 0.5,
      confidence: ambiguousCap,
      candidates: rows,
      evidence: `Ch-1 归一名 '${norm}' 命中 ${rows.length} 张切图，`
        + '但未提供图层 bbox 无法做 ±2px 尺寸校验，全部返回待人工确认（AMBIGUOUS）',
      ambiguous: true,
    };
  }

  // ★ 保险 2：±2px 尺寸校验（E-02：scaleInfer 开启时按整数倍率缩放容差）
  // 关闭 scaleInfer 时 judgeCandidateSize 就是原 sizeWithinTol，行为逐字节一致。
  const judged = rows.map((r) => ({
    row: r,
    ...judgeCandidateSize(args.layerBox, { w: r.w, h: r.h }, tol, scaleInfer),
  }));
  // 开启倍率推断时，通过者带 `scale` 字段（浅拷贝，不改动 store 行对象本身）；
  // 关闭时原样返回行对象，与改造前完全一致。
  const passed = judged
    .filter((j) => j.matched)
    .map((j) => (scaleEnabled ? { ...j.row, scale: j.scale } : j.row));
  const rejected = judged.filter((j) => !j.matched).map((j) => j.row);
  // 首个通过者的推断明细（evidence 用）
  const firstInfer = judged.find((j) => j.matched);
  const inferNote = scaleEnabled && firstInfer ? scaleEvidence(firstInfer.infer, tol) : '';

  if (passed.length === 1) {
    const hit = passed[0];
    return {
      status: CH1_STATUS.HIT,
      ch1: 1,
      confidence: 1,
      candidates: [hit],
      ambiguous: false,
      evidence: `Ch-1 精确同名命中：归一名 '${norm}' 唯一命中 '${hit.relPath}'，`
        + `且尺寸校验通过（图层 ${args.layerBox.w}x${args.layerBox.h} vs 切图 ${hit.w}x${hit.h}，容差 ±${tol}px）`
        + inferNote
        + (rejected.length
          ? `；同名但尺寸不符已排除 ${rejected.length} 张（${rejected.map((r) => `${r.relPath}(${r.w}x${r.h})`).join(', ')}）`
          : ''),
    };
  }

  if (passed.length > 1) {
    // ★ 全部返回 + 标 AMBIGUOUS，绝不静默取第一个
    // E-02：1x 与 2x 同时通过（倍率容差缩放）时同样全部返回，
    //       每张候选带 `scale` 字段标明推断倍率，由人工确认选哪份。
    return {
      status: CH1_STATUS.AMBIGUOUS,
      ch1: 0.5,
      confidence: ambiguousCap,
      candidates: passed,
      ambiguous: true,
      evidence: `Ch-1 AMBIGUOUS：归一名 '${norm}' 有 ${passed.length} 张切图同时通过 ±${tol}px 尺寸校验`
        + `（图层 ${args.layerBox.w}x${args.layerBox.h}）：`
        + passed.map((r) => `${r.relPath}(${r.w}x${r.h}${scaleEnabled ? `,${r.scale}x` : ''})`).join(', ')
        + (scaleEnabled
          ? '。注意：同时通过的可能包含同一素材的 1x/2x 倍图（已标注倍率），选哪份需人工确认'
          : '')
        + '。尺寸无法区分，已全部返回并进人工确认队列，不做静默选择。',
    };
  }

  // 同名但尺寸全不符 -> 落 Ch-2
  return {
    status: CH1_STATUS.NO_SIZE_MATCH,
    ch1: 0,
    confidence: 0,
    candidates: [],
    evidence: `Ch-1 同名但尺寸校验失败：归一名 '${norm}' 命中 ${rows.length} 张切图，`
      + `但没有一张满足 ±${tol}px（图层 ${args.layerBox.w}x${args.layerBox.h} vs `
      + rows.map((r) => `${r.relPath}=${r.w}x${r.h}`).join(', ') + '），落 Ch-2'
      + (scaleEnabled
        ? '（倍率推断已开启：仍不对应任何整数倍率，未硬凑）'
        : '（倍率推断未开启：若存在 1x/2x 倍图混用，可在 fgui.config.json 开 asset.scaleInfer）'),
    ambiguous: false,
  };
}

module.exports = { channel1Name, sizeWithinTol, CH1_STATUS };
