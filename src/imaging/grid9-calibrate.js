'use strict';
/**
 * src/imaging/grid9-calibrate.js —— 九宫格阈值标定（E-03，回应 L5 / Q21）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 解决什么问题
 * ════════════════════════════════════════════════════════════════════════════
 * `grid9.js` 的三档判定（CAN_9GRID / SINGLE_AXIS_ONLY / NEVER）所有阈值都是
 * **对合成数据标的**（L5）。Q21 问「要不要用历史素材重标」—— 本模块就是
 * 重标工具的核心：输入「切图目录 + 人工标注」，输出「建议阈值 + 差异报告」。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 四条设计原则（与 grid9.js 的取值哲学一致）
 * ════════════════════════════════════════════════════════════════════════════
 * 1. **安全方向优先**：建议阈值按字典序比较（危险侧误判数升序 -> 正确数降序）。
 *    成本不对称：误判 NEVER 只是人工手切 10 秒；误判 CAN_9GRID 会把图拉花。
 *    「放松阈值能提高准确率但会误判条纹为可切」的候选**一律拒绝**并留痕。
 * 2. **只给建议，绝不自动改配置**：本模块与 CLI 都只读 fgui.config.json，
 *    产出 diff 形式的建议值，由人决定是否采纳。
 * 3. **诚实标注置信度**：样本量 < 30 明确警告「不可直接用于生产」，
 *    每个候选值的实测得分全部进报告（considered），不给虚假精确。
 * 4. **确定性（B9）**：纯函数 + 全排序 + 零时间戳，同输入两次运行逐字节一致。
 *
 * 方法（务实，不发明新算法）：**逐阈值贪心扫描**（坐标下降单轮）。
 *   对每个可调阈值，用「样本中观测到的特征值 + 相邻中点 + 当前值」作候选，
 *   逐一重算全量样本判定，按上述字典序取最优；其余阈值保持当前值。
 *   阈值按键名字典序扫描，顺序固定 -> 结果确定。
 */

const { computeGrid9, VERDICT, DEFAULT_THRESHOLDS } = require('./grid9');
const { round6 } = require('../core/determinism');

/** 人工标注允许的档位（与 computeGrid9 的 VERDICT 一致）。 */
const LABEL_VERDICTS = Object.freeze([
  VERDICT.CAN_9GRID, VERDICT.SINGLE_AXIS_ONLY, VERDICT.NEVER,
]);

/** 样本量低于此值 -> 警告「建议阈值不可直接用于生产」。 */
const MIN_SAMPLES_FOR_PRODUCTION = 30;

/**
 * 档位「放行度」：越大越宽松。安全方向优先策略的依据。
 *   NEVER            禁切（最保守）
 *   SINGLE_AXIS_ONLY 只放行一个轴
 *   CAN_9GRID        四角 + 中部都可切（最宽松）
 */
const PERMISSIVENESS = Object.freeze({
  [VERDICT.NEVER]: 0,
  [VERDICT.SINGLE_AXIS_ONLY]: 1,
  [VERDICT.CAN_9GRID]: 2,
});

/** 误判方向。 */
const DIRECTION = Object.freeze({
  OK: 'ok',                 // 与人工标注一致
  DANGEROUS: 'dangerous',   // 判得比人工标注**更宽松**（该禁切却给可切）= 危险侧
  SAFE_SLOWER: 'safe_slower', // 判得比人工标注**更保守** = 安全侧（人工手切 10 秒）
});

/** 方向的中文说明（进报告）。 */
const DIRECTION_NOTE = Object.freeze({
  [DIRECTION.OK]: '一致',
  [DIRECTION.DANGEROUS]: '危险侧误判（判得比人工标注更宽松，按此切会拉花图）',
  [DIRECTION.SAFE_SLOWER]: '安全侧漏判（判得比人工标注更保守，代价是人工手切一次）',
});

/**
 * 可调阈值表。每个阈值绑定一个特征（标定就是「按样本特征分布定阈值」）。
 * kind: 'float' 候选取观测值与中点；'int' 候选取整。
 * min/max：候选项的合理区间（超出视为没有标定意义）。
 */
const TUNABLE_THRESHOLDS = Object.freeze([
  {
    key: 'radialSymmetryMax', kind: 'float', min: 0.5, max: 1,
    feature: 'radialSymmetry', desc: '角向纹理强度上限（radialSymmetry；超过且偏离扇区不成簇 -> 禁切）',
  },
  {
    key: 'radialClusterMin', kind: 'int', min: 1, max: 8,
    feature: 'radialMaxCluster', desc: '偏离扇区最小连续簇（radialMaxCluster；低于此值视为放射/对角纹理）',
  },
  {
    key: 'gradientMonotonicMin', kind: 'float', min: 0.5, max: 1,
    feature: 'midMonotonic', desc: '平滑渐变放行阈值（midMonotonic 一阶差分同号率；高于此值视为单调渐变）',
  },
  {
    key: 'minSideForShape', kind: 'int', min: 0, max: 128,
    feature: 'minSide', desc: '极小图保护（短边 min(w,h)；<= 此值形态特征不可靠，直接禁切）',
  },
  {
    key: 'cornerFillPanelMin', kind: 'float', min: 0.3, max: 1,
    feature: 'cornerFill', desc: '四角近方下限（cornerFill；>= 此值才考虑常规九宫格）',
  },
  {
    key: 'cornerFillCapsuleMax', kind: 'float', min: 0.3, max: 1,
    feature: 'cornerFill', desc: '胶囊角填充上限（cornerFill；< 此值且横向长条 -> 单轴）',
  },
  {
    key: 'cornerFillRoundMax', kind: 'float', min: 0, max: 0.6,
    feature: 'cornerFill', desc: '圆/菱/星上限（cornerFill；<= 此值且非长条 -> 禁切）',
  },
  {
    key: 'capsuleAspectMin', kind: 'float', min: 1, max: 4,
    feature: 'aspectRatio', desc: '胶囊长宽比下限（aspectRatio；>= 此值视为横向长条）',
  },
  {
    key: 'flatMidVarianceMax', kind: 'float', min: 0.05, max: 0.8,
    feature: 'flatMid', desc: '中部平坦度上限（max(midRowVariance, midColVariance)；平坦/渐变/边框三者之一放行）',
  },
]);

/** 按键名字典序排列的扫描顺序（固定 -> 确定性）。 */
const TUNABLE_ORDER = Object.freeze(
  [...TUNABLE_THRESHOLDS].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
);

/**
 * 从特征对象取某个阈值绑定的特征值。
 * @param {Object} features extractFeatures 的输出
 * @param {string} feature 特征名（'minSide' / 'flatMid' 为派生特征）
 * @returns {number|null}
 */
function featureValue(features, feature) {
  const f = features || {};
  switch (feature) {
    case 'minSide':
      return Number.isFinite(f.w) && Number.isFinite(f.h) ? Math.min(f.w, f.h) : null;
    case 'flatMid': {
      const a = Number.isFinite(f.midRowVariance) ? f.midRowVariance : 0;
      const b = Number.isFinite(f.midColVariance) ? f.midColVariance : 0;
      return Math.max(a, b);
    }
    default: {
      const v = f[feature];
      return Number.isFinite(v) ? v : null;
    }
  }
}

/**
 * 误判方向分类（安全方向优先的判据）。
 * @param {string} expected 人工标注
 * @param {string} verdict 现判定
 * @returns {string} DIRECTION.*
 */
function classifyDirection(expected, verdict) {
  if (expected === verdict) return DIRECTION.OK;
  return PERMISSIVENESS[verdict] > PERMISSIVENESS[expected]
    ? DIRECTION.DANGEROUS
    : DIRECTION.SAFE_SLOWER;
}

/**
 * 只算得分（不收集逐条 items）—— 扫描候选用，避免无谓的 evidence 收集。
 * @param {{file:string, expected:string, features:Object}[]} samples
 * @param {Object} thresholds
 * @returns {{total:number, correct:number, dangerous:number, safeSlower:number}}
 */
function scoreSamples(samples, thresholds) {
  let correct = 0;
  let dangerous = 0;
  let safeSlower = 0;
  for (const s of samples) {
    const v = computeGrid9(s.features, thresholds);
    const dir = classifyDirection(s.expected, v.verdict);
    if (dir === DIRECTION.OK) correct++;
    else if (dir === DIRECTION.DANGEROUS) dangerous++;
    else safeSlower++;
  }
  return { total: samples.length, correct, dangerous, safeSlower };
}

/**
 * 用给定阈值跑全量样本，汇总得分 + 逐条对账。
 * @param {{file:string, expected:string, features:Object}[]} samples
 * @param {Object} thresholds 阈值（会被 computeGrid9 与默认值合并）
 * @returns {{total:number, correct:number, dangerous:number, safeSlower:number,
 *            items:{file:string, expected:string, verdict:string, direction:string, evidence:string[]}[]}}
 */
function evaluateSamples(samples, thresholds) {
  const items = [];
  let correct = 0;
  let dangerous = 0;
  let safeSlower = 0;
  for (const s of samples) {
    const v = computeGrid9(s.features, thresholds);
    const dir = classifyDirection(s.expected, v.verdict);
    if (dir === DIRECTION.OK) correct++;
    else if (dir === DIRECTION.DANGEROUS) dangerous++;
    else safeSlower++;
    items.push({
      file: s.file,
      expected: s.expected,
      verdict: v.verdict,
      direction: dir,
      directionNote: DIRECTION_NOTE[dir],
      evidence: v.evidence,
    });
  }
  // 确定性排序：按文件名
  items.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { total: samples.length, correct, dangerous, safeSlower, items };
}

/**
 * 字典序比较：危险侧误判少的优；危险侧相同则正确数多的优；再相同则不换（保守）。
 * @param {Object} a 候选得分
 * @param {Object} b 基准得分
 * @returns {boolean} a 是否严格优于 b
 */
function isBetterScore(a, b) {
  if (a.dangerous !== b.dangerous) return a.dangerous < b.dangerous;
  if (a.correct !== b.correct) return a.correct > b.correct;
  return false;
}

/**
 * 生成某个阈值的候选值。
 *
 * 候选来源（确定性）：
 *   ① 样本中观测到的特征值（边界阈值的最强候选）
 *   ② 相邻观测值的中点（区分两类样本的边界）
 *   ③ 当前值及其邻步（int: ±1/+2；float: ±0.05）—— 修复方向常常是
 *      「在当前值基础上抬/降一格」（如 radialClusterMin 2->3 才能禁切条纹），
 *      仅靠观测值生成不到这种候选
 * 全部钳制在 [min,max] 内，按 kind 取整/定点，去重升序。
 *
 * @param {Object} spec TUNABLE_THRESHOLDS 的一项
 * @param {Object[]} samples
 * @param {number} current 当前值
 * @returns {number[]} 升序去重
 */
function candidatesFor(spec, samples, current) {
  /** @type {Set<number>} */
  const values = new Set();
  const push = (v) => {
    if (!Number.isFinite(v)) return;
    const x = spec.kind === 'int' ? Math.round(v) : round6(v);
    if (x < spec.min || x > spec.max) return;
    values.add(x);
  };
  const observed = samples
    .map((s) => featureValue(s.features, spec.feature))
    .filter((v) => v !== null)
    .sort((a, b) => a - b);
  for (const v of observed) push(v);
  for (let i = 1; i < observed.length; i++) push((observed[i - 1] + observed[i]) / 2);
  push(current);
  // 当前值的邻步：int 阈值 ±1/+2，float 阈值 ±0.05（小幅推移边界）
  if (spec.kind === 'int') {
    push(current - 1);
    push(current + 1);
    push(current + 2);
  } else {
    push(current - 0.05);
    push(current + 0.05);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * 逐阈值标定：并行评估 + 按改进幅度排序应用（单轮）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么不是「按键名字典序逐个贪心」
 * ════════════════════════════════════════════════════════════════════════════
 * 实测（本模块开发期）发现纯贪心有个致命陷阱：**钝阈值劫持**。
 *   例：条纹危险侧误判时，`cornerFillRoundMax=0.97` / `minSideForShape=80`
 *   这类「一刀切禁切」的改动也能把危险侧压到 0（靠把正常样本一起误杀），
 *   若它字母序在前被先采纳，真正对症的 `radialClusterMin=3` 就变成
 *   「无改进」而不再被建议 —— 工具会给出一个没用的建议。
 *
 * 现行设计（确定性，同输入同输出）：
 *   ① **并行评估**：每个阈值都在「其余阈值保持当前值」的基准下找最优候选；
 *   ② **排序应用**：所有改进提案按（危险侧下降数 desc -> 正确数提升数 desc
 *      -> 键名 asc）排序，逐个应用；应用前对照**当时已演化的配置**重新验证，
 *      只有仍严格优于才落盘 —— 钝阈值劫持的提案会在这一步被跳过；
 *   ③ **全程留痕**：每个阈值评估过的所有候选值及得分都进 considered，
 *      被安全原则拒绝的候选标 `safetyRejected` 并附理由。
 *
 * 已知边界（写进报告，不装作没有）：单轮并行不是联合最优；
 * 阈值间存在「A 的改动才能激发 B 的改进」时可能找不到。工具只给建议，
 * 最终由人决定 —— 这与「只输出建议，不自动改配置」的定位一致。
 *
 * @param {Object[]} samples
 * @param {Object} currentThresholds 当前阈值（fgui.config.json 的 grid9 段）
 * @returns {{thresholds:Object, trace:Object[]}}
 */
function suggestThresholds(samples, currentThresholds) {
  const current = { ...DEFAULT_THRESHOLDS, ...(currentThresholds || {}) };
  const suggested = { ...current };
  const baseline = scoreSamples(samples, current);
  const summarize = (sc) => ({
    total: sc.total, correct: sc.correct, dangerous: sc.dangerous, safeSlower: sc.safeSlower,
  });

  // ---- ① 并行评估：每个阈值在「其余保持当前」的基准下找最优候选 ----
  /** @type {Object[]} */
  const proposals = [];
  /** @type {Object[]} */
  const trace = [];
  for (const spec of TUNABLE_ORDER) {
    const startValue = current[spec.key];
    const cands = candidatesFor(spec, samples, startValue);
    /** @type {Object[]} */
    const considered = [];
    let bestValue = startValue;
    let bestScore = baseline;
    for (const v of cands) {
      const sc = scoreSamples(samples, { ...current, [spec.key]: v });
      if (v === startValue) {
        considered.push({
          value: v, isCurrent: true, ...summarize(sc), proposed: false, applied: false, safetyRejected: false,
        });
        continue;
      }
      const better = isBetterScore(sc, bestScore);
      if (better) {
        bestValue = v;
        bestScore = sc;
      }
      const entry = {
        value: v,
        isCurrent: false,
        ...summarize(sc),
        proposed: better,
        applied: false,
        // 安全方向优先的拒绝留痕：正确数更高但会引入/增加危险侧误判
        safetyRejected: !better && sc.correct > baseline.correct && sc.dangerous > baseline.dangerous,
      };
      if (entry.safetyRejected) {
        entry.reason = `正确数 ${sc.correct} 高于当前 ${baseline.correct}，但危险侧误判 ${sc.dangerous} > ${baseline.dangerous}`
          + '（该禁切却判可切，按此切会把图拉花）—— 按「安全方向优先」拒绝：'
          + '误判禁切只是人工手切 10 秒，误判可切是线上事故';
      } else if (!better) {
        entry.reason = `未优于当前值（正确数 ${sc.correct} / 危险侧 ${sc.dangerous} vs 当前 ${baseline.correct} / ${baseline.dangerous}）`;
      }
      considered.push(entry);
    }
    trace.push({
      key: spec.key,
      feature: spec.feature,
      desc: spec.desc,
      kind: spec.kind,
      current: startValue,
      suggested: startValue, // 应用阶段可能改
      changed: false,
      scoreBefore: summarize(baseline),
      scoreAfter: summarize(bestScore),
      considered,
    });
    if (bestValue !== startValue) {
      proposals.push({
        key: spec.key,
        value: bestValue,
        deltaDangerous: baseline.dangerous - bestScore.dangerous,
        deltaCorrect: bestScore.correct - baseline.correct,
      });
    }
  }

  // ---- ② 排序应用：改进大的先上，应用前对照演化中的配置重新验证 ----
  proposals.sort((a, b) =>
    (b.deltaDangerous - a.deltaDangerous)
    || (b.deltaCorrect - a.deltaCorrect)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const p of proposals) {
    const trial = { ...suggested, [p.key]: p.value };
    const sc = scoreSamples(samples, trial);
    const now = scoreSamples(samples, suggested);
    if (isBetterScore(sc, now)) {
      suggested[p.key] = p.value;
      const tr = trace.find((t) => t.key === p.key);
      tr.suggested = p.value;
      tr.changed = true;
      tr.scoreAfter = summarize(sc);
      for (const c of tr.considered) if (c.value === p.value) c.applied = true;
    }
  }

  return { thresholds: suggested, trace };
}

/**
 * 置信度评级（样本量驱动，不给虚假精确）。
 * @param {number} n 标注样本数
 * @returns {{level:string, note:string}}
 */
function confidenceOf(n) {
  if (n >= 100) {
    return { level: 'high', note: `样本量 ${n} >= 100，统计意义较强（仍建议人工抽检边界样本）` };
  }
  if (n >= MIN_SAMPLES_FOR_PRODUCTION) {
    return { level: 'medium', note: `样本量 ${n}（30~99），建议阈值可用，仍建议人工抽检边界样本` };
  }
  return {
    level: 'low',
    note: `样本量 ${n} < ${MIN_SAMPLES_FOR_PRODUCTION}，建议阈值置信度低，**不可直接用于生产**，请扩充标注样本后重跑`,
  };
}

/**
 * 标定主入口（纯函数，不做任何 I/O）。
 *
 * @param {Object} args
 * @param {{file:string, expected:string, note?:string, features:Object}[]} args.samples
 *        已与标注配对的样本（features 为 extractFeatures 输出）
 * @param {Object} [args.thresholds] 当前阈值（fgui.config.json 的 grid9 段）
 * @param {number} [args.minSamples=30] 样本量警告线
 * @param {Object} [args.inputs] 输入面信息（进报告：未标注/缺失/失败清单）
 * @returns {Object} 标定报告（确定性：同输入逐字节可复现）
 */
function calibrateGrid9(args) {
  const samples = args.samples || [];
  const minSamples = args.minSamples === undefined
    ? MIN_SAMPLES_FOR_PRODUCTION
    : args.minSamples;
  const current = { ...DEFAULT_THRESHOLDS, ...(args.thresholds || {}) };

  const currentEval = evaluateSamples(samples, current);
  const { thresholds: suggested, trace } = suggestThresholds(samples, current);
  const suggestedEval = evaluateSamples(samples, suggested);

  const changes = trace
    .filter((t) => t.changed)
    .map((t) => ({
      key: t.key,
      feature: t.feature,
      desc: t.desc,
      from: t.current,
      to: t.suggested,
      scoreBefore: t.scoreBefore,
      scoreAfter: t.scoreAfter,
    }));

  const warnings = [];
  if (samples.length < minSamples) {
    warnings.push(`样本不足：标注样本 ${samples.length} 张 < ${minSamples} 张。`
      + '建议阈值置信度低，**不可直接用于生产** —— 请扩充人工标注样本后重跑。');
  }
  if (currentEval.dangerous > 0) {
    warnings.push(`现阈值存在 ${currentEval.dangerous} 个**危险侧误判**`
      + '（该禁切却判可切，按此切会把图拉花）—— 优先处理这些样本。');
  }
  if (suggestedEval.dangerous > 0) {
    warnings.push(`建议阈值仍残留 ${suggestedEval.dangerous} 个危险侧误判`
      + '（现有特征空间分不开，需新增特征而非继续调阈值，见 grid9-known-limits.test.js）。');
  }
  for (const w of (args.inputs && args.inputs.warnings) || []) warnings.push(w);

  const confidence = confidenceOf(samples.length);

  return {
    version: '1.0',
    _comment: '九宫格阈值标定报告（fgui-rb calibrate-grid9 产出）。'
      + '★ 本工具只给建议，绝不自动修改 fgui.config.json —— 是否采纳由人决定。'
      + '建议策略：安全方向优先（字典序：危险侧误判少 > 正确数多 > 少改动），'
      + '理由是不对称成本：误判禁切只是人工手切 10 秒，误判可切会把图拉花。'
      + '本文件零时间戳，同一输入两次运行逐字节一致（B9）。',
    inputs: {
      sampleCount: samples.length,
      unlabeledFiles: ((args.inputs || {}).unlabeledFiles || []).slice().sort(),
      missingFiles: ((args.inputs || {}).missingFiles || []).slice().sort(),
      failedFiles: ((args.inputs || {}).failedFiles || []).slice(),
      assetRoot: (args.inputs || {}).assetRoot || '',
      labelsPath: (args.inputs || {}).labelsPath || '',
    },
    warnings,
    summary: {
      current: {
        total: currentEval.total, correct: currentEval.correct,
        dangerous: currentEval.dangerous, safeSlower: currentEval.safeSlower,
        accuracy: currentEval.total ? round6(currentEval.correct / currentEval.total) : 0,
      },
      suggested: {
        total: suggestedEval.total, correct: suggestedEval.correct,
        dangerous: suggestedEval.dangerous, safeSlower: suggestedEval.safeSlower,
        accuracy: suggestedEval.total ? round6(suggestedEval.correct / suggestedEval.total) : 0,
      },
    },
    reconciliation: {
      _comment: '逐张对账：现阈值判定 vs 人工标注。direction=dangerous 是危险侧（优先处理）。',
      current: currentEval.items,
      suggested: suggestedEval.items,
    },
    thresholds: {
      current,
      suggested,
      changes,
      trace,
      confidence,
      minSamplesForProduction: MIN_SAMPLES_FOR_PRODUCTION,
    },
    configSuggestion: {
      _comment: '★ 仅建议值。fgui.config.json 未被本工具修改；是否采纳由人决定。'
        + '采纳时把下面 grid9 段的改动合入 fgui.config.json 即可，不需要改代码。',
      changedKeys: changes.map((c) => c.key),
      grid9: { ...suggested },
    },
  };
}

/**
 * 渲染人可读的 Markdown 报告（确定性：同输入逐字节一致）。
 * @param {Object} report calibrateGrid9 的输出
 * @returns {string}
 */
function renderCalibrationMarkdown(report) {
  const L = [];
  L.push('# 九宫格阈值标定报告（calibrate-grid9）');
  L.push('');
  L.push('> ★ 本工具**只给建议，绝不自动修改 `fgui.config.json`**。是否采纳由人决定。');
  L.push('> 建议策略：**安全方向优先**（危险侧误判少 > 正确数多 > 少改动）——');
  L.push('> 误判禁切只是人工手切 10 秒，误判可切会把图拉花（与 `grid9.js` 取值哲学一致）。');
  L.push('');

  // ---- 1. 概览 ----
  L.push('## 1. 概览');
  L.push('');
  const s = report.summary;
  L.push(`- 标注样本：**${report.inputs.sampleCount}** 张`);
  if (report.inputs.unlabeledFiles.length) {
    L.push(`- 目录内未标注（已跳过）：${report.inputs.unlabeledFiles.length} 张 —— ${report.inputs.unlabeledFiles.join(', ')}`);
  }
  if (report.inputs.missingFiles.length) {
    L.push(`- 标注了但目录里找不到：${report.inputs.missingFiles.length} 个 —— ${report.inputs.missingFiles.join(', ')}`);
  }
  if (report.inputs.failedFiles.length) {
    L.push(`- 读取/特征提取失败：${report.inputs.failedFiles.length} 个 —— ${report.inputs.failedFiles.map((f) => `${f.relPath}（${f.reason}）`).join(', ')}`);
  }
  L.push(`- 现阈值：正确 **${s.current.correct}/${s.current.total}**，危险侧误判 **${s.current.dangerous}**，安全侧漏判 ${s.current.safeSlower}`);
  L.push(`- 建议阈值：正确 **${s.suggested.correct}/${s.suggested.total}**，危险侧误判 **${s.suggested.dangerous}**，安全侧漏判 ${s.suggested.safeSlower}`);
  L.push('');

  // ---- 2. 警告 ----
  L.push('## 2. 警告');
  L.push('');
  if (report.warnings.length) {
    for (const w of report.warnings) L.push(`- ⚠ ${w}`);
  } else {
    L.push('- 无');
  }
  L.push('');

  // ---- 3. 逐张对账 ----
  L.push('## 3. 逐张对账（现阈值 vs 人工标注）');
  L.push('');
  L.push('| 文件 | 人工标注 | 现判定 | 方向 | 建议阈值下判定 |');
  L.push('|---|---|---|---|---|');
  const afterByFile = new Map(report.reconciliation.suggested.map((i) => [i.file, i]));
  for (const i of report.reconciliation.current) {
    const after = afterByFile.get(i.file);
    const mark = i.direction === DIRECTION.DANGEROUS ? '**危险侧**'
      : i.direction === DIRECTION.SAFE_SLOWER ? '安全侧' : '一致';
    L.push(`| ${escapeMd(i.file)} | ${i.expected} | ${i.verdict} | ${mark} | ${after ? after.verdict : '-'} |`);
  }
  L.push('');

  // ---- 4. 建议阈值 ----
  L.push('## 4. 建议阈值（按特征逐个标定）');
  L.push('');
  L.push('| 阈值（特征） | 现值 | 建议值 | 正确数 前→后 | 危险侧 前→后 | 说明 |');
  L.push('|---|---|---|---|---|---|');
  for (const t of report.thresholds.trace) {
    const b = t.scoreBefore;
    const a = t.scoreAfter;
    const mark = t.changed ? '**改动**' : '不变';
    L.push(`| \`${t.key}\`（${t.feature}） | ${t.current} | ${t.suggested} | ${b.correct}→${a.correct} | ${b.dangerous}→${a.dangerous} | ${mark} ${escapeMd(t.desc)} |`);
  }
  L.push('');
  L.push('每个阈值评估过的候选值及实测得分（审计用，`safetyRejected=true` 即被安全原则拒绝的候选）：');
  L.push('');
  for (const t of report.thresholds.trace) {
    L.push(`- \`${t.key}\`：${t.considered.map((c) =>
      `${c.value}${c.isCurrent ? '(当前)' : ''}${c.accepted ? '(采纳)' : ''}`
      + `${c.safetyRejected ? '(安全拒绝)' : ''}`
      + `[正确${c.correct}/危险${c.dangerous}]`).join('，')}`);
  }
  L.push('');

  // ---- 5. 配置 diff ----
  L.push('## 5. `fgui.config.json` 的 grid9 段建议 diff');
  L.push('');
  L.push('```diff');
  for (const c of report.thresholds.changes) {
    L.push(`-  "${c.key}": ${JSON.stringify(c.from)},`);
    L.push(`+  "${c.key}": ${JSON.stringify(c.to)},   // ${c.desc}`);
  }
  if (!report.thresholds.changes.length) {
    L.push('   （无改动建议 —— 现有阈值已是该样本集上的安全最优）');
  }
  L.push('```');
  L.push('');

  // ---- 6. 置信度 ----
  L.push('## 6. 置信度');
  L.push('');
  L.push(`- 等级：**${report.thresholds.confidence.level}**`);
  L.push(`- 说明：${report.thresholds.confidence.note}`);
  L.push(`- 样本量警告线：${report.thresholds.minSamplesForProduction} 张（低于此值不可直接用于生产）`);
  L.push('');
  L.push('---');
  L.push('');
  L.push('本报告由 `fgui-rb calibrate-grid9` 生成：纯本地、零网络、零时间戳，同一输入两次运行逐字节一致。');
  L.push('');
  return L.join('\n');
}

/**
 * Markdown 表格单元格转义。
 * @param {string} s
 * @returns {string}
 */
function escapeMd(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * 解析并校验人工标注文件（JSON，人可读可改）。
 *
 * 格式：
 * ```jsonc
 * {
 *   "_comment": "每张图的人工标注。expected 取 CAN_9GRID / SINGLE_AXIS_ONLY / NEVER",
 *   "labels": {
 *     "按钮_胶囊.png": { "expected": "SINGLE_AXIS_ONLY", "note": "左右圆头" },
 *     "边框_方形.png": { "expected": "CAN_9GRID" }
 *   }
 * }
 * ```
 *
 * ★ 宁报错不静默 ★：expected 非法 / 结构不对 -> 抛 USAGE 错误并指出具体文件，
 *   绝不跳过坏条目继续跑。
 *
 * @param {Object} raw JSON.parse 的结果
 * @returns {{file:string, expected:string, note:string}[]} 按文件名排序（确定性）
 */
function parseLabels(raw) {
  // eslint-disable-next-line global-require
  const { AppError, CODES } = require('../core/errors');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError(CODES.USAGE, '标注文件必须是 JSON 对象（含 labels 字段）');
  }
  const labels = raw.labels;
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
    throw new AppError(CODES.USAGE,
      '标注文件必须含 labels 对象，形如 { "labels": { "xxx.png": { "expected": "CAN_9GRID" } } }');
  }
  const out = [];
  for (const file of Object.keys(labels).sort()) {
    const entry = labels[file];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AppError(CODES.USAGE,
        `标注文件: '${file}' 的条目必须是对象（{ "expected": "..." }），实得 ${JSON.stringify(entry)}`);
    }
    const expected = entry.expected;
    if (!LABEL_VERDICTS.includes(expected)) {
      throw new AppError(CODES.USAGE,
        `标注文件: '${file}' 的 expected 非法: ${JSON.stringify(expected)}`
        + `（允许值：${LABEL_VERDICTS.join(' / ')}）`);
    }
    out.push({
      file,
      expected,
      note: typeof entry.note === 'string' ? entry.note : '',
    });
  }
  return out;
}

module.exports = {
  calibrateGrid9,
  suggestThresholds,
  evaluateSamples,
  classifyDirection,
  candidatesFor,
  confidenceOf,
  featureValue,
  renderCalibrationMarkdown,
  parseLabels,
  LABEL_VERDICTS,
  MIN_SAMPLES_FOR_PRODUCTION,
  PERMISSIVENESS,
  DIRECTION,
  DIRECTION_NOTE,
  TUNABLE_THRESHOLDS,
};
