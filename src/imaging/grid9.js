'use strict';
/**
 * src/imaging/grid9.js —— R1-F3 九宫格适用性启发式（ARCHITECTURE §4.5 / STANDARDS §2.7）
 *
 * ★ 取值哲学：不确定时返 NEVER。★
 *   理由是成本不对称：NEVER 的后果是「人工手切一次」（10 秒），
 *   误判 CAN_9GRID 的后果是「线上圆头按钮被拉成椭圆」（事故）。
 *   与 PRD「在生成阶段就阻止事故」的定位一致。
 *
 * ★ 明确不做精确几何判定。★ 只用已算好的特征做阈值判定，是启发式不是算法。
 *   阈值全部外置在 fgui.config.json 的 grid9 段，引擎师用真实素材回归后直接调。
 *
 * ── 与架构文档 §4.5 判据表的偏差（实测后修正，原因见 features.js 文件头）────
 * 架构原表用 `cornerSolidity` + `midRow/midColVariance` 区分形态，实测判别力不足：
 *   · 小圆角面板与胶囊的 cornerSolidity 数值区间重叠，分不开。
 *   · variance/255² 归一化后数值被压到 1e-3 量级，阈值失效。
 * 本实现改用语义更直接的 `cornerFill` 作主判据：
 *   常规面板  → cornerFill ≈ 0.97（四角几乎是方的）  → CAN_9GRID
 *   横向胶囊  → cornerFill ≈ 0.56（角被圆头切掉一半）→ SINGLE_AXIS_ONLY
 *   圆形      → cornerFill ≈ 0.13（角几乎全空）      → NEVER
 *   放射/扇形 → 角向高频纹理强                       → NEVER
 *
 * 三档输出：
 *   CAN_9GRID        四角近方 + 中部平坦         -> 常规九宫格
 *   SINGLE_AXIS_ONLY 胶囊/全圆头                 -> scale9grid="r,0,w-2r,h"（上/下不留角）
 *   NEVER            圆、放射、对角高光纹理      -> 禁切
 */

const { round6 } = require('../core/determinism');

/** 九宫格档位常量。 */
const VERDICT = Object.freeze({
  CAN_9GRID: 'CAN_9GRID',
  SINGLE_AXIS_ONLY: 'SINGLE_AXIS_ONLY',
  NEVER: 'NEVER',
});

/**
 * 默认阈值（与 fgui.config.json grid9 段一致；配置文件优先）。
 * 数值由 test/fixtures/make-assets.js 的 25 张合成切图标定，
 * 标定过程与实测特征值记录在 docs/IMPLEMENTATION-REPORT.md。
 */
const DEFAULT_THRESHOLDS = Object.freeze({
  // 放射/扇形纹理：角向高频能量强度（实测：放射纹 0.90~1.00，平滑渐变 <=0.55）
  radialSymmetryMax: 0.88,
  // ★ 偏离扇区的最大连续簇长度下限（QA BUG #3）
  //   >= 2：偏离扇区「聚成块」= 矩形描边 / 浮雕棱线（不是纹理）
  //   <  2：偏离扇区「交替出现」= 放射 / 对角纹理（必须禁切）
  //   实测：描边面板 idx=[8,9] -> cluster=2；放射 8 辐 idx=[5,9] -> cluster=1
  radialClusterMin: 2,
  // 扇区分散度（偏离扇区占比）：仅作 evidence 展示，不参与判定
  // （实测描边 0.17、放射 0.17 —— 单看它区分不开，靠 cluster 才有效）
  radialSpreadMin: 0.5,
  // ★ 单调渐变放行阈值：一阶差分同号率 >= 此值视为「平滑渐变」而非「无序纹理」
  //   真实 UI 面板几乎都带渐变（QA 实测横向/竖向渐变面板 mono=1.00）
  gradientMonotonicMin: 0.9,
  // ★ 极小图保护：短边 <= 此值时形态特征不可靠，直接返 NEVER
  //   QA 实测 1x1 / 8x8 / **10x10** 都会被误判 CAN_9GRID（短边越大越不可靠）
  minSideForShape: 12,
  // cornerFill 分档（实测：面板 0.88~0.95 / 胶囊 0.22 / 圆 0.14~0.19）
  cornerFillPanelMin: 0.7,      // >= 此值视为「四角近方」
  cornerFillCapsuleMax: 0.7,    // <  此值且横向长条 -> 胶囊
  cornerFillRoundMax: 0.25,     // <= 此值且非长条 -> 圆/菱/星
  // 胶囊还需满足横向长条
  capsuleAspectMin: 2.0,
  // 中部平坦（std/RMS 尺度无关指标；实测面板 0.05~0.11，圆/放射 0.22~0.46）
  // ★ 注意：渐变/描边面板的 flatMid 会到 0.29~0.47，超过此值也不判 NEVER ——
  //   改由 midMonotonic（平滑渐变）与 radialCluster（边框浮雕）放行。
  flatMidVarianceMax: 0.15,
  // 不确定时的置信度上限
  unknownConfidence: 0.4,
});

/**
 * 胶囊/全圆头的建议九宫格字符串。
 *
 * 语义（ARCHITECTURE §5.2）：常规九宫格是 l,t,w,h 四边留角；
 * 胶囊是**上/下不留角**（垂直方向不切），即 l=r, t=0, w=imgW-2r, h=imgH。
 * 输出 `r,0,w-2r,h`（首值=左=右=r，次值上=0，第三值中心宽，第四值中心高=全高）。
 *
 * ⚠ 此格式待小 Q 用真实胶囊素材确认（ARCHITECTURE Q17）。
 *
 * @param {number} imgW
 * @param {number} imgH
 * @returns {string}
 */
function capsuleGrid(imgW, imgH) {
  const r = Math.max(1, Math.min(Math.floor(Math.min(imgW, imgH) / 2), Math.floor(imgW / 2)));
  const innerW = Math.max(0, imgW - 2 * r);
  return `${r},0,${innerW},${imgH}`;
}

/**
 * 判断特征是否「够用」—— 任一关键特征缺失就归入 UNKNOWN -> NEVER。
 * @param {Object} f
 * @returns {boolean}
 */
function hasRequiredFeatures(f) {
  const needed = ['aspectRatio', 'cornerFill'];
  // radialSymmetry 缺失时不算「特征不完整」—— 会在下面按 spread 缺失保守处理
  for (const key of needed) {
    const v = f[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  }
  return typeof f.w === 'number' && typeof f.h === 'number' && f.w > 0 && f.h > 0;
}

/**
 * 九宫格适用性判定。
 *
 * @param {Object} features extractFeatures 的输出
 * @param {Object} [thresholds] 阈值覆盖（来自 fgui.config.json 的 grid9 段）
 * @returns {{verdict:string, confidence:number, evidence:string[], suggestedGrid:string|null}}
 */
function computeGrid9(features, thresholds) {
  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const f = features || {};

  // ---- 档 0：特征缺失 -> UNKNOWN -> NEVER ----
  if (!hasRequiredFeatures(f)) {
    return {
      verdict: VERDICT.NEVER,
      confidence: round6(t.unknownConfidence),
      evidence: [
        '特征不完整（缺 aspectRatio / radialSymmetry / cornerFill），无法可靠判定',
        '按「不确定返 NEVER」原则禁切，请人工确认后再决定',
      ],
      suggestedGrid: null,
    };
  }

  const evidence = [];
  const aspect = f.aspectRatio;
  const cf = f.cornerFill;

  // ---- 档 0b：极小图 -> NEVER ----
  // 短边 < 8px 时，任何形态特征都不可靠（QA 实测 1x1 / 8x8 纯色被误判 CAN_9GRID）。
  // 按「不确定返 NEVER」处理，不做任何形态判定。
  // ★ 用 <= 而非 < ★：8x8 的形态特征同样不可靠（QA 实测被误判 CAN_9GRID）
  //   分辨不出 8x8 是面板还是纯色块，不该给任何正面结论。
  const minSide = t.minSideForShape === undefined ? 12 : t.minSideForShape;
  if (Math.min(f.w, f.h) <= minSide) {
    evidence.push(
      `图片尺寸 ${f.w}x${f.h} 过小（短边 <= ${minSide}px），形态特征不可靠`,
      '按「不确定返 NEVER」原则禁切，请人工确认',
    );
    return { verdict: VERDICT.NEVER, confidence: 0.3, evidence, suggestedGrid: null };
  }

  // ---- 档 1：放射/扇形纹理 -> NEVER ----
  // 角向明暗快速交替 = 扇形光束/放射线。九宫格拉伸会把明暗条拉成楔形。
  //
  // ★ 必须同时看「强度」与「扇区分散度」（QA BUG #3）★
  //   矩形描边面板的 radialSymmetry 也接近 1（只有 4 条边，在扇区统计里
  //   同样形成 4 高 8 低的强交替），但它的能量**集中在 4 个扇区**；
  //   真正的放射纹能量分散在 8~12 个扇区。只看强度会把描边面板误杀。
  const radialIntensity = f.radialSymmetry || 0;
  const radialSpread = f.radialSpread === undefined ? 0 : f.radialSpread;
  const radialCluster = f.radialMaxCluster === undefined ? 0 : f.radialMaxCluster;
  // ★ 角向纹理判据 = 强度高 **且** 偏离扇区「分散不成簇」★
  //   矩形描边：偏离扇区聚成 2 个连续簇（对应 4 条边的成对方向）-> cluster>=2
  //   放射/对角：偏离扇区交替出现（8 辐 = 8 个孤立扇区）-> cluster==1
  const looksLikeAngularTexture = radialIntensity > t.radialSymmetryMax
    && radialCluster < t.radialClusterMin;
  if (looksLikeAngularTexture) {
    evidence.push(
      `角向纹理 强度=${radialIntensity} > ${t.radialSymmetryMax}、偏离扇区最大连续簇=${radialCluster} `
      + `< ${t.radialClusterMin}：明暗随角度**交替**出现（放射/扇形/对角高光）`,
      '九宫格拉伸会把放射纹拉成楔形，判定为禁切',
    );
    return { verdict: VERDICT.NEVER, confidence: 0.9, evidence, suggestedGrid: null };
  }
  if (radialIntensity > t.radialSymmetryMax && !looksLikeAngularTexture) {
    evidence.push(
      `角向强度=${radialIntensity} 虽高，但偏离扇区聚成连续簇（maxCluster=${radialCluster} `
      + `>= ${t.radialClusterMin}）：能量集中在少数方向（典型是矩形描边的 4 条边 / 浮雕棱线），`
      + '判定为边框而非角向纹理，继续后续判定',
    );
  }

  // ---- 档 2：横向长条 + 角被圆头切掉 -> SINGLE_AXIS_ONLY ----
  // 判定顺序刻意放在「圆形」之前：胶囊的 cornerFill(≈0.22) 与圆(≈0.14~0.19)
  // 数值接近，靠 aspectRatio 区分（胶囊是长条，圆是方的）。长条优先判胶囊。
  if (aspect >= t.capsuleAspectMin && cf < t.cornerFillCapsuleMax) {
    evidence.push(
      `aspectRatio=${aspect} >= ${t.capsuleAspectMin}：横向长条形态`,
      `cornerFill=${cf} < ${t.cornerFillCapsuleMax}：四角被圆头切掉一部分`,
      '判定为胶囊/全圆头，只能单轴（水平）九宫格，垂直方向不切',
    );
    return {
      verdict: VERDICT.SINGLE_AXIS_ONLY,
      confidence: 0.8,
      evidence,
      suggestedGrid: capsuleGrid(f.w, f.h),
    };
  }

  // ---- 档 3：四角几乎全空且不是长条 -> NEVER ----
  // 圆形 / 菱形 / 星形：角部被大幅切掉，任何九宫格方案都会在角上露出空白或错位。
  if (cf <= t.cornerFillRoundMax) {
    evidence.push(
      `cornerFill=${cf} <= ${t.cornerFillRoundMax} 且 aspectRatio=${aspect}（非长条）：四角区块几乎全透明，轮廓是圆/菱/星形`,
      '这类轮廓九宫格必然在角部露出空白，判定为禁切',
    );
    return { verdict: VERDICT.NEVER, confidence: 0.85, evidence, suggestedGrid: null };
  }

  // ---- 档 4：四角近方 + 中部「平坦 / 平滑渐变 / 带边框」-> CAN_9GRID ----
  //
  // ★ 为什么放宽到三种中部形态（QA BUG #3）★
  //   真实 UI 面板最常见的不是纯色，而是：渐变面板、带描边面板、斜面浮雕按钮。
  //   QA 自造样本实测：
  //     横向渐变面板 midVar=0.287 mono=1.00 spread=0.33
  //     竖向渐变面板 midVar=0.287 mono=1.00 spread=0.33
  //     描边面板     midVar=0.472 mono=0.50 spread=0.17
  //     斜面浮雕     midVar=0.307 mono=0.50 spread=0.17
  //   三者都该给 CAN_9GRID，但都过不了原来的 `midVar <= 0.15`。
  //
  // ★ 为什么不用「调高 midVar 阈值」这种简单做法 ★
  //   那会同时放过棋盘格(midVar=0.575)与横条纹(0.575) —— 它们同样是「高方差」，
  //   但拉伸会露出明显纹理。所以判据必须看**分布形态**而非幅度：
  //
  //   中部形态 = 平坦          midVar 小
  //            | 平滑渐变      mono 高（>=0.9）—— 单调，一阶差分几乎全同号
  //            | 带边框/浮雕    spread 低（<=0.5）—— 角向能量集中在 4 条边/几条棱
  //   无序纹理（棋盘/条纹/放射）三者都不满足，继续落到档 5 -> NEVER。
  const flatMid = Math.max(f.midRowVariance || 0, f.midColVariance || 0);
  const mono = f.midMonotonic === undefined ? 1 : f.midMonotonic;
  const isSmoothGradient = mono >= t.gradientMonotonicMin;
  // ★ 边框/浮雕：角向强度虽高，但能量集中在少数扇区（不是角向均匀分布的纹理）
  const isEdgeOrBevel = radialIntensity >= t.radialSymmetryMax
    && radialCluster >= t.radialClusterMin;
  const midKind = flatMid <= t.flatMidVarianceMax ? 'flat'
    : isSmoothGradient ? 'gradient'
      : isEdgeOrBevel ? 'edge_or_bevel' : null;
  if (cf >= t.cornerFillPanelMin && midKind !== null) {
    const why = {
      flat: `中部平坦度 max(midRow,midCol)=${flatMid} <= ${t.flatMidVarianceMax}：中心区拉伸不变形`,
      gradient: `中部平坦度 max(midRow,midCol)=${flatMid} 偏高，但一阶差分同号率=${mono} `
        + `>= ${t.gradientMonotonicMin}：属**单调平滑渐变**（非无序纹理），拉伸不会破形`,
      edge_or_bevel: `中部平坦度=${flatMid} 偏高且一阶差分同号率=${mono}（存在边框/浮雕的突变），`
        + `但角向偏离扇区聚成连续簇（maxCluster=${radialCluster} >= ${t.radialClusterMin}）：`
        + '能量集中在少数方向（矩形描边的 4 条边 / 浮雕棱线），不是角向交替的纹理，拉伸不会破形',
    }[midKind];
    evidence.push(
      `cornerFill=${cf} >= ${t.cornerFillPanelMin}：四角区块基本实心，轮廓接近矩形`,
      why,
      '判定为常规九宫格候选',
    );
    return { verdict: VERDICT.CAN_9GRID, confidence: 0.75, evidence, suggestedGrid: null };
  }

  // ---- 档 5：落在阈值间空白区 -> UNKNOWN -> NEVER ----
  evidence.push(
    `未命中任何明确档位：aspectRatio=${aspect}, cornerFill=${cf}, ` +
    `radialTexture=${f.radialSymmetry}, flatMid=${flatMid}`,
    '落在阈值间空白区，按「不确定返 NEVER」原则禁切，请人工确认',
  );
  return { verdict: VERDICT.NEVER, confidence: round6(t.unknownConfidence), evidence, suggestedGrid: null };
}

module.exports = {
  computeGrid9,
  capsuleGrid,
  hasRequiredFeatures,
  VERDICT,
  DEFAULT_THRESHOLDS,
};
