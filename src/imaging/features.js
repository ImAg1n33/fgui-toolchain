'use strict';
/**
 * src/imaging/features.js —— R1-F2 特征提取
 *
 * 输出全部为确定性数值（同输入必然同输出），字段定义见 ARCHITECTURE §3.2：
 *   { w, h, alphaRatio, alphaBox{x,y,w,h}, phash(16 hex),
 *     dominantR/G/B, edgeDensity, cornerSolidity, cornerFill,
 *     midRowVariance, midColVariance, radialSymmetry, aspectRatio }
 *
 * ── 特征语义（必须与 grid9.js 的判据语义严格一致）────────────────────────
 * 设计说明：架构文档 §4.5 给的判据表用 `cornerSolidity` 与「中行/中列方差」区分形态，
 * 实测（见 docs/IMPLEMENTATION-REPORT.md「与架构文档的偏差」）判别力不足：
 *   · `cornerSolidity`（角部 12% 小块内的平均 alpha）：小圆角面板与胶囊的数值区间重叠。
 *   · 「中列方差」若按 var/255² 归一化，数值被压到 1e-3 量级，阈值失去意义。
 * 因此本实现把主判据换成语义更直接的两个特征：
 *
 *   cornerFill       四角各 22%×22% 区块内的不透明像素占比（均值）。
 *                     实测：圆角面板 ≈0.97 / 全圆头胶囊 ≈0.56 / 圆形 ≈0.13。
 *                     ★ 曾试过用「alpha 包围盒中线 inset」——行不通：
 *                       胶囊半圆的最左端点**恰好落在中线高度上**，inset 全为 0，
 *                       与面板完全无法区分。已废弃该思路。
 *   radialSymmetry   角向**高频**能量占比（相邻扇区落差 / 扇区总落差）。
 *                     放射/扇形纹理高；平滑渐变（胶囊上浅下深、同心圆）低。
 *                     ★ 曾试过「旋转相似度」与「扇区方差比」——都判别力为零，
 *                       详见该函数注释里的「两个踩过的坑」。
 *
 * midRowVariance / midColVariance 保留在 schema 里（人工核对要看），
 * 归一化改为**尺度无关**的变异系数平方，判别力可用。
 */

const { phashFromRgba } = require('./phash');
const { round6 } = require('../core/determinism');

/** alpha 视为不透明的阈值。低于此值算透明。 */
const ALPHA_THRESHOLD = 128;
/** 特征分析用的降采样边长（alpha 包围盒与 edgeInsets 在全分辨率上算）。 */
const ANALYSIS_SIZE = 64;
/** Sobel 梯度阈值（0..255 亮度域）。 */
const EDGE_GRADIENT_THRESHOLD = 32;
/** 四角小块边长（相对短边）。 */
const CORNER_FRACTION = 0.12;
/** cornerFill 的区块边长占对应边长的比例。 */
const CORNER_BLOCK_FRACTION = 0.22;
/** 放射对称度：角度扇区数。12 个足够区分放射纹与平铺，且计算量可忽略。 */
const RADIAL_SECTORS = 12;

/**
 * 从 RGBA 原始像素计算 alpha 包围盒与不透明占比（全分辨率，精确）。
 * @param {{width:number,height:number,data:Uint8Array|Buffer}} rgba
 * @returns {{alphaRatio:number, alphaBox:{x:number,y:number,w:number,h:number}|null}}
 */
function computeAlphaStats(rgba) {
  const { width, height, data } = rgba;
  let opaque = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (data[p + 3] >= ALPHA_THRESHOLD) {
        opaque++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const total = Math.max(1, width * height);
  if (maxX < 0) return { alphaRatio: 0, alphaBox: null };
  return {
    alphaRatio: round6(opaque / total),
    alphaBox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

/**
 * 四角区块实心度 = 四角各一块区域内不透明像素的占比（均值）。
 *
 * 这是区分「常规面板 / 胶囊 / 圆形」的决定性特征。实测取值：
 *   圆角半径 8px 的 120×80 面板      -> ≈0.95（四角几乎是方的）
 *   全圆头 120×36~180×36 胶囊        -> ≈0.45~0.50（角被切掉一半）
 *   64×64 圆                        -> ≈0.14（角几乎全空）
 *
 * ★ 区块边长必须相对**短边**，不能用相对宽高各自的比例 ★
 *   胶囊的圆角半径恒等于「短边的一半」。若区块宽按 22%*W 取，
 *   胶囊越宽区块就越宽、越容易越过圆头而显得「角是实的」，
 *   实测 aspectRatio 从 3.3 升到 5.1 时 cornerFill 会从 0.71 升到 0.81，
 *   导致宽胶囊被误判为 CAN_9GRID。改用 min(w,h) 后该值稳定在 0.45~0.50。
 *
 * ★ 为什么不用「inset」或「cornerSolidity」★
 *   · inset（alpha 包围盒中线到首像素的距离）：胶囊半圆的最左端点**恰好落在中线高度上**，
 *     故 inset 全为 0，与面板完全无法区分。已废弃该思路。
 *   · cornerSolidity（角部 12% 小块内的平均 alpha）：块太小，数值区间与面板重叠。
 *     保留字段（人工核对要看）但不作为主判据。
 *
 * @param {{width:number,height:number,data:Uint8Array|Buffer}} rgba
 * @param {number} [fraction=0.22] 区块边长占**短边**的比例
 * @returns {number} 0..1
 */
function cornerFill(rgba, fraction = CORNER_BLOCK_FRACTION) {
  const { width, height, data } = rgba;
  const side = Math.max(2, Math.round(Math.min(width, height) * fraction));
  const corners = [
    [0, 0],
    [width - side, 0],
    [0, height - side],
    [width - side, height - side],
  ];
  let sum = 0;
  for (const [ox, oy] of corners) {
    let opaque = 0;
    let total = 0;
    for (let y = oy; y < oy + side; y++) {
      for (let x = ox; x < ox + side; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        total++;
        if (data[(y * width + x) * 4 + 3] >= ALPHA_THRESHOLD) opaque++;
      }
    }
    sum += total ? opaque / total : 0;
  }
  return sum / corners.length;
}

/**
 * 桶平均降采样到 n×n 的灰度矩阵（透明像素按白底合成）。
 * @param {{width:number,height:number,data:Uint8Array|Buffer}} rgba
 * @param {number} n
 * @returns {{gray:Float64Array, alpha:Float64Array}} 灰度 0..255，alpha 0..1
 */
function downsample(rgba, n) {
  const { width, height, data } = rgba;
  const gray = new Float64Array(n * n);
  const alpha = new Float64Array(n * n);
  for (let gy = 0; gy < n; gy++) {
    const y0 = Math.floor((gy * height) / n);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / n));
    for (let gx = 0; gx < n; gx++) {
      const x0 = Math.floor((gx * width) / n);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / n));
      let gsum = 0;
      let asum = 0;
      let cnt = 0;
      for (let y = y0; y < Math.min(y1, height); y++) {
        for (let x = x0; x < Math.min(x1, width); x++) {
          const p = (y * width + x) * 4;
          const a = data[p + 3] / 255;
          const r = data[p] * a + 255 * (1 - a);
          const g = data[p + 1] * a + 255 * (1 - a);
          const b = data[p + 2] * a + 255 * (1 - a);
          gsum += 0.299 * r + 0.587 * g + 0.114 * b;
          asum += a;
          cnt++;
        }
      }
      gray[gy * n + gx] = cnt ? gsum / cnt : 255;
      alpha[gy * n + gx] = cnt ? asum / cnt : 0;
    }
  }
  return { gray, alpha };
}

/**
 * Sobel 边缘密度。
 * @param {Float64Array} gray n×n
 * @param {Float64Array} alpha n×n
 * @param {number} n
 * @returns {number} 0..1
 */
function edgeDensity(gray, alpha, n) {
  let edges = 0;
  let total = 0;
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      const gx =
        -gray[i - n - 1] + gray[i - n + 1] +
        -2 * gray[i - 1] + 2 * gray[i + 1] +
        -gray[i + n - 1] + gray[i + n + 1];
      const gy =
        -gray[i - n - 1] - 2 * gray[i - n] - gray[i - n + 1] +
        gray[i + n - 1] + 2 * gray[i + n] + gray[i + n + 1];
      const mag = Math.sqrt(gx * gx + gy * gy);
      const alphaJump = Math.abs(alpha[i - 1] - alpha[i + 1]) + Math.abs(alpha[i - n] - alpha[i + n]);
      if (mag > EDGE_GRADIENT_THRESHOLD || alphaJump > 0.5) edges++;
      total++;
    }
  }
  return total ? edges / total : 0;
}

/**
 * 四角实心度：四角小块内平均 alpha。
 * 保留此特征（人工核对要看），但**不作为九宫格主判据**（见文件头说明）。
 * @param {Float64Array} alpha n×n
 * @param {number} n
 * @returns {number} 0..1
 */
function cornerSolidity(alpha, n) {
  const c = Math.max(2, Math.round(n * CORNER_FRACTION));
  const corners = [
    [0, 0],
    [n - c, 0],
    [0, n - c],
    [n - c, n - c],
  ];
  let sum = 0;
  for (const [ox, oy] of corners) {
    let s = 0;
    let cnt = 0;
    for (let y = oy; y < oy + c; y++) {
      for (let x = ox; x < ox + c; x++) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        s += alpha[y * n + x];
        cnt++;
      }
    }
    sum += cnt ? s / cnt : 0;
  }
  return sum / corners.length;
}

/**
 * 尺度无关的平坦度 = 标准差 / 均方根（std / RMS）。
 *
 * 为什么不按 var/255² 归一化：那样所有特征值都会被压到 1e-3 以下，阈值失去意义
 * （实测合成胶囊的 midColVariance 在 var/255² 下只有 0.010，判别力完全失效）。
 *
 * 为什么用 std/RMS 而不是 std/mean（变异系数）—— 实测踩到的坑：
 *   · std/mean 在「均值趋近 0」时爆炸。实测**全零数组**会得到 1.0，
 *     显然错误（一条恒为 0 的中行，应该是「完全平坦」= 0，不是 1）。
 *     代码里若用 `if (mean < 1) mean = 1` 兜底，同样会把全零数组算成 1.0。
 *   · std/RMS 由 Cauchy-Schwarz 保证 std <= RMS，值天然落在 [0,1]，无需截断；
 *     全黑/全白/全常数都稳定返回 0。
 *   · 它仍然是**尺度无关**的：整条曲线乘以 10，值不变。
 *
 * @param {number[]} values
 * @returns {number} 0..1
 */
function normalizedVariance(values) {
  if (values.length < 2) return 0;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= values.length;
  let acc = 0;
  for (const v of values) acc += (v - mean) * (v - mean);
  const variance = acc / values.length;
  const std = Math.sqrt(variance);
  const rms = Math.sqrt(mean * mean + variance);
  if (rms < 1e-9) return 0; // 恒定值（含全零）-> 完全平坦
  return Math.min(1, std / rms);
}

/**
 * 平滑度：单调渐变 vs 无序噪声
 * = 相邻像素差分的「符号一致率」（0..1，1 = 完全单调）。
 *
 * ★ 为什么需要这个特征（QA BUG #3 实测逼出来的）★
 *   QA 用自造的形态测出：横向渐变面板被误判 NEVER，归因是
 *   `midRowVar=0.241 > flatMidVarianceMax=0.15`。
 *   即：**真实 UI 面板几乎都有渐变**，而「平坦度」这个判据把渐变当成了纹理。
 *
 *   但不能靠调高 `flatMidVarianceMax` 解决 —— 那会同时放过棋盘格、条纹、
 *   放射纹（它们的中行/中列方差同样高）。
 *
 *   区分点在于**分布形态**：
 *     单调渐变：沿一条线亮度**单调**变化，一阶差分几乎全同号
 *     无序纹理：一阶差分正负乱跳
 *   故用「一阶差分同号率」把两者分开，与亮度变化幅度无关。
 *
 * @param {number[]} values 灰度序列
 * @returns {number} 0..1，1 表示完全单调
 */
function monotonicity(values) {
  if (values.length < 3) return 1; // 点太少，无法判断趋势，视为单调（交给其它判据）
  let up = 0;
  let down = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0.5) up++;
    else if (d < -0.5) down++;
  }
  const moves = up + down;
  if (moves === 0) return 1; // 完全平坦，当然单调
  // 主导方向的变化占比
  return Math.max(up, down) / moves;
}

/**
 * 中间行 / 中间列平坦度 + 平滑度。
 * @param {Float64Array} gray n×n
 * @param {number} n
 * @returns {{midRowVariance:number, midColVariance:number,
 *            midRowMonotonic:number, midColMonotonic:number,
 *            midMonotonic:number}}
 */
function midVariances(gray, n) {
  const mid = Math.floor(n / 2);
  const rowVals = [];
  for (let x = 0; x < n; x++) rowVals.push(gray[mid * n + x]);
  const colVals = [];
  for (let y = 0; y < n; y++) colVals.push(gray[y * n + mid]);
  const rowMono = monotonicity(rowVals);
  const colMono = monotonicity(colVals);
  return {
    midRowVariance: normalizedVariance(rowVals),
    midColVariance: normalizedVariance(colVals),
    midRowMonotonic: round6(rowMono),
    midColMonotonic: round6(colMono),
    // 判据用「两条中线里更不单调的那条」：只要有一条是无序纹理，就不是平滑渐变
    midMonotonic: round6(Math.min(rowMono, colMono)),
  };
}

/**
 * 放射/扇形纹理强度 = 角向**高频**能量占比。
 *
 * 语义：图像的明暗是否随角度**快速交替**（扇形光束、放射线、对角硬边高光）。
 * 这类图一旦九宫格拉伸，明暗条会被拉成扇形/楔形，必然破形 → 禁切。
 *
 * 实现：把中心区域按角度分成 RADIAL_SECTORS 份，算每份的均值 d[i]，
 *   纹理强度 = 平均相邻扇区落差 / 扇区均值总落差
 *     放射纹（8~16 条明暗束）→ 每对相邻扇区都在跳 -> 比值接近 1
 *     平滑渐变（胶囊的上浅下深、同心圆环）→ 只有 2 个扇区在跳 -> 比值很小
 *     纯色 / 平铺面板 → 几乎不跳 -> 比值 ≈ 0
 *
 * ⚠ 两个踩过的坑，都写在这里防止回退：
 *   1. 不能用「旋转相似度」（把图转 90°/180° 与原图比）当这个指标 ——
 *      实测那样纯色图、面板、圆全都得 ~1.0，判别力为零。
 *   2. 不能用「扇区均值方差 / 总方差」—— 实测胶囊的竖向渐变也得 0.87
 *      （上下两个扇区天然不同），与放射纹无法区分。
 *   必须用**相邻扇区落差**才能区分「快速交替」与「平滑渐变」。
 *
 * @param {Float64Array} gray n×n
 * @param {number} n
 * @returns {number} 0..1
 */
/**
 * 放射/扇形纹理强度 = 角向**高频**能量占比，且要求能量**分散在多个扇区**。
 *
 * 语义：图像的明暗是否随角度**快速交替**（扇形光束、放射线、对角硬边高光）。
 * 这类图一旦九宫格拉伸，明暗条会被拉成扇形/楔形，必然破形 → 禁切。
 *
 * 实现：把中心区域按角度分成 RADIAL_SECTORS 份，算每份的均值 d[i]，
 *   intensity = 平均相邻扇区落差 / 扇区均值总落差
 *     放射纹（8~16 条明暗束）→ 每对相邻扇区都在跳 -> intensity ≈ 1
 *     平滑渐变（胶囊上浅下深、同心圆环）→ 只有 2 个扇区在跳 -> intensity 很低
 *
 * ★★ 但只用 intensity 会把**矩形描边**误判成放射纹 ★★（QA BUG #3 实测）
 *   QA 自造的「带边框面板」radial=1.000 —— 矩形边框只有 4 条边，
 *   在扇区统计里形成 4 个「高」扇区 + 8 个「低」扇区，
 *   相邻扇区落差/总落差 ≈ 1，与真正的放射纹无法区分。
 *
 *   区分点在于**扇区分布的分散度**：
 *     矩形描边 → 能量集中在 4 个扇区（角向呈「稀疏脉冲」）
 *     真正放射纹 → 能量分散在 8~12 个扇区（角向呈「密集交替」）
 *   故增加 `spread` = 「明显高于均值的扇区占比」。
 *   实测：描边面板 spread≈0.33，放射纹 spread≈0.67~1.0。
 *   grid9 的判据是「intensity 高 **且** spread 高」才判放射纹。
 *
 * ⚠ 三个踩过的坑，写在这里防止回退：
 *   1. 不能用「旋转相似度」—— 实测那样纯色图与所有对称图都是 ~1.0，判别力为零。
 *   2. 不能只用「扇区均值方差比」—— 实测胶囊的竖向渐变也 0.87，分不开。
 *   3. 不能只用「相邻扇区落差」—— 实测矩形描边也得 ~1.0（就是上面那个 bug）。
 *
 * @param {Float64Array} gray n×n
 * @param {number} n
 * @returns {{intensity:number, spread:number}}
 */
function radialSymmetry(gray, n) {
  const c = (n - 1) / 2;
  const radius = Math.max(1e-6, c);
  const sums = new Float64Array(RADIAL_SECTORS);
  const counts = new Float64Array(RADIAL_SECTORS);

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x - c;
      const dy = y - c;
      // 只统计中心圆盘，避开角落的无关信息
      if (Math.sqrt(dx * dx + dy * dy) > radius) continue;
      const v = gray[y * n + x];
      let ang = Math.atan2(dy, dx); // -PI..PI
      if (ang < 0) ang += Math.PI * 2;
      const sec = Math.min(RADIAL_SECTORS - 1, Math.floor((ang / (Math.PI * 2)) * RADIAL_SECTORS));
      sums[sec] += v;
      counts[sec]++;
    }
  }

  // 扇区太少（极小图）无法判定，给低分而不是瞎猜
  let filled = 0;
  for (let s = 0; s < RADIAL_SECTORS; s++) if (counts[s] > 0) filled++;
  if (filled < RADIAL_SECTORS) return { intensity: 0, spread: 0, maxCluster: 0 };

  const means = new Float64Array(RADIAL_SECTORS);
  let grand = 0;
  for (let s = 0; s < RADIAL_SECTORS; s++) {
    means[s] = sums[s] / counts[s];
    grand += means[s];
  }
  grand /= RADIAL_SECTORS;

  // 总落差：扇区均值偏离全体均值的幅度（衡量「角向变化有多大」）
  let spreadTotal = 0;
  for (let s = 0; s < RADIAL_SECTORS; s++) spreadTotal += Math.abs(means[s] - grand);
  // 角向完全一致（纯色/正圆盘）-> 无方向性纹理
  if (spreadTotal < 1e-9) return { intensity: 0, spread: 0, maxCluster: 0 };

  // 相邻扇区落差（含环回首尾）
  let adjacent = 0;
  for (let s = 0; s < RADIAL_SECTORS; s++) {
    adjacent += Math.abs(means[(s + 1) % RADIAL_SECTORS] - means[s]);
  }
  const intensity = Math.max(0, Math.min(1, adjacent / spreadTotal));

  // ★ 扇区分散度：明显偏离均值的扇区占比
  //   矩形描边 -> 只有 4 个扇区偏离 -> spread ≈ 0.17~0.33
  //   真正放射纹 -> 8~12 个扇区偏离 -> spread 更高
  const meanAbsDev = spreadTotal / RADIAL_SECTORS;
  const threshold = meanAbsDev * 1.5;
  const hotFlags = [];
  let hot = 0;
  for (let s = 0; s < RADIAL_SECTORS; s++) {
    const isHot = Math.abs(means[s] - grand) > threshold;
    hotFlags.push(isHot);
    if (isHot) hot++;
  }

  // ★★ 最大连续簇长度：区分「边框/浮雕」与「角向纹理」的决定性指标 ★★
  //   矩形描边  -> 高扇区**聚成 2~3 个连续簇**（对应 4 条边的成对方向）
  //   斜面浮雕  -> 同上
  //   放射/对角 -> 高扇区**彼此分离**（8 辐是 8 个孤立扇区，隔一个亮一个暗）
  //   实测：描边 idx=[8,9] 连续簇=2；放射 idx=[5,9] 连续簇=1
  const maxCluster = longestHotCluster(hotFlags);

  return { intensity, spread: hot / RADIAL_SECTORS, maxCluster };
}

/**
 * 求「高扇区」标记数组里的最长连续簇长度（环形，相邻即连续）。
 *
 * ★ 为什么需要它（QA BUG #3 的第二层）★
 *   只看「扇区分散度」仍会误判：矩形描边与放射纹的偏离扇区数可能相同，
 *   但**空间组织完全不同**：
 *     描边  -> 偏离扇区**成对相邻**（0°/90°/180°/270° 四条边）
 *     放射纹 -> 偏离扇区**交替出现**（亮暗亮暗，隔一个才亮）
 *   故用「最大连续簇」把两者分开：簇越长越像边框，越短越像角向纹理。
 *
 * @param {boolean[]} flags 长度 = 扇区数的标记数组
 * @returns {number} 最长连续 true 的个数（环形计）
 */
function longestHotCluster(flags) {
  const n = flags.length;
  if (n === 0) return 0;
  let best = 0;
  for (let start = 0; start < n; start++) {
    if (!flags[start]) continue;
    let len = 0;
    for (let k = 0; k < n && flags[(start + k) % n]; k++) len++;
    if (len > best) best = len;
  }
  return best;
}

/**
 * 主色：不透明像素的 4bit 量化直方图众数。
 * @param {{width:number,height:number,data:Uint8Array|Buffer}} rgba
 * @returns {{r:number,g:number,b:number}}
 */
function dominantColor(rgba) {
  const { width, height, data } = rgba;
  const bins = new Map();
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    if (data[p + 3] < ALPHA_THRESHOLD) continue;
    const key = ((data[p] >> 4) << 8) | ((data[p + 1] >> 4) << 4) | (data[p + 2] >> 4);
    const cur = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    cur.n++;
    cur.r += data[p];
    cur.g += data[p + 1];
    cur.b += data[p + 2];
    bins.set(key, cur);
  }
  if (!bins.size) return { r: 0, g: 0, b: 0 };
  let best = null;
  for (const key of [...bins.keys()].sort((a, b) => a - b)) {
    const v = bins.get(key);
    if (!best || v.n > best.n) best = v;
  }
  return {
    r: Math.round(best.r / best.n),
    g: Math.round(best.g / best.n),
    b: Math.round(best.b / best.n),
  };
}

/**
 * 特征提取主入口（同步纯函数：I/O 已在 decoder 里收敛）。
 * @param {{width:number,height:number,data:Uint8Array|Buffer}} rawImage decoder.decodeToRgba 的输出
 * @param {Object} [opts]
 * @param {boolean} [opts.withPhash=true] 是否算 pHash（--no-features 时可关）
 * @returns {Object} AssetFeatures（全部字段定点化）
 */
function extractFeatures(rawImage, opts = {}) {
  const withPhash = opts.withPhash !== false;
  if (!rawImage || !rawImage.data || !rawImage.width || !rawImage.height) {
    throw new Error('extractFeatures: 入参必须是 decoder.decodeToRgba 的输出 {width,height,data}');
  }
  const { width, height } = rawImage;
  const alphaStats = computeAlphaStats(rawImage);
  const n = Math.min(ANALYSIS_SIZE, Math.max(8, Math.min(width, height)));
  const { gray, alpha } = downsample(rawImage, n);
  const dom = dominantColor(rawImage);
  const mid = midVariances(gray, n);
  const radial = radialSymmetry(gray, n);

  return {
    w: width,
    h: height,
    alphaRatio: alphaStats.alphaRatio,
    alphaBox: alphaStats.alphaBox,
    phash: withPhash ? phashFromRgba(rawImage) : null,
    dominantR: dom.r,
    dominantG: dom.g,
    dominantB: dom.b,
    edgeDensity: round6(edgeDensity(gray, alpha, n)),
    cornerSolidity: round6(cornerSolidity(alpha, n)),
    cornerFill: round6(cornerFill(rawImage)),
    midRowVariance: round6(mid.midRowVariance),
    midColVariance: round6(mid.midColVariance),
    // ★ 平滑度：一阶差分同号率。用来区分「单调渐变」（真实 UI 面板极常见）
    //   与「无序纹理」（棋盘/条纹/放射）。见 midVariances 的注释。
    midRowMonotonic: mid.midRowMonotonic,
    midColMonotonic: mid.midColMonotonic,
    midMonotonic: mid.midMonotonic,
    // ★ 放射纹强度与扇区分散度。两者合用才能把「矩形描边」与「放射纹」分开，
    //   见 radialSymmetry 注释里的 BUG #3 说明。
    radialSymmetry: round6(radial.intensity),
    radialSpread: round6(radial.spread),
    radialMaxCluster: radial.maxCluster,
    aspectRatio: round6(width / height),
  };
}

module.exports = {
  extractFeatures,
  computeAlphaStats,
  cornerFill,
  downsample,
  edgeDensity,
  cornerSolidity,
  midVariances,
  radialSymmetry,
  monotonicity,
  longestHotCluster,
  dominantColor,
  normalizedVariance,
  ALPHA_THRESHOLD,
  ANALYSIS_SIZE,
  CORNER_BLOCK_FRACTION,
  RADIAL_SECTORS,
};
