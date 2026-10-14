'use strict';
/**
 * qa-p1a/qa3-e02-e03.js —— QA 第三轮·第 2 轮：E-02 倍率推断 + E-03 九宫格标定 独立验证
 *
 * E-02（src/assets/scale-infer.js + channel1-name.js 集成）：
 *   - QA 自造 1x/2x/3x 样本验证倍率推断
 *   - ★ 重点：k=1 行为与改造前完全一致（K5 命名陷阱靠尺寸校验兜底）★
 *   - 同名 1x+2x 混合 → AMBIGUOUS 全返回（不静默取一个）
 *   - 非整数倍（1.5625x）拒绝
 *   - 默认关闭不改现有行为（含守卫缺口侦察：嵌套 scaleInfer 键是否有对账）
 *
 * E-03（src/imaging/grid9-calibrate.js）：
 *   - QA 自造标注样本（含「条纹危险侧」真实形态）跑标定
 *   - 安全红线：放松阈值提正确数但加危险侧 → 必须拒绝
 *   - 样本不足警告；★ 绝不改 fgui.config.json（CLI 级 md5 验证）★
 *   - 确定性：同输入两次逐字节一致
 *   - 变异：安全比较器回退 → 测试必须红
 *
 * 运行：node qa-p1a/qa3-e02-e03.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = 'C:/Program Files/nodejs/node.exe';
const GOLDEN = path.join(ROOT, 'test/fixtures/golden');

const { inferScale, judgeCandidateSize, isValidSize, INFER_REASON } = require('../src/assets/scale-infer');
const { sizeWithinTol, channel1Name, CH1_STATUS } = require('../src/assets/channel1-name');
const {
  calibrateGrid9, classifyDirection, parseLabels,
} = require('../src/imaging/grid9-calibrate');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, evidence) {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  [FAIL] ${name}${evidence ? ' :: ' + evidence : ''}`);
  }
}
const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

// ════════════════════════════════════════════════════════════════════════
console.log('=== E2-1. inferScale 纯函数（QA 自造样本）===');
{
  // 1x/2x/3x
  ok('1x: 96x96 vs 96x96 → scale=1', inferScale({ w: 96, h: 96 }, { w: 96, h: 96 }).scale === 1);
  ok('2x: 96x96 vs 192x192 → scale=2', inferScale({ w: 96, h: 96 }, { w: 192, h: 192 }).scale === 2);
  ok('3x: 96x96 vs 288x288 → scale=3', inferScale({ w: 96, h: 96 }, { w: 288, h: 288 }).scale === 3);
  ok('2x 容差内（±4px @2x）: 96 vs 194 → scale=2',
    inferScale({ w: 96, h: 96 }, { w: 194, h: 194 }).scale === 2);
  ok('2x 容差外（±5px @2x）: 96 vs 197 → 不匹配',
    inferScale({ w: 96, h: 96 }, { w: 197, h: 197 }).matched === false);

  // 非整数倍拒绝（1.5625x）
  const r156 = inferScale({ w: 96, h: 96 }, { w: 150, h: 150 });
  ok('非整数倍 1.5625x 拒绝', r156.matched === false && r156.reason === INFER_REASON.NO_INTEGER_SCALE,
    JSON.stringify(r156));

  // 混合宽高（只有 W 是 2x）拒绝
  const rMix = inferScale({ w: 96, h: 96 }, { w: 192, h: 96 });
  ok('仅 W 为 2x（H 是 1x）→ 拒绝', rMix.matched === false, JSON.stringify(rMix));

  // 容差边界：恰好 ±tol
  ok('1x 边界 +2px 命中', inferScale({ w: 100, h: 100 }, { w: 102, h: 100 }).matched === true);
  ok('1x 边界 +3px 不命中', inferScale({ w: 100, h: 100 }, { w: 103, h: 100 }).matched === false);

  // 并列取更小 k（保守倾向 1x）：box 2x2 img 3x3 → k=1 dev1 命中；k=2 dev1 也命中 → 取 1
  ok('并列偏差取更小倍率（保守）', inferScale({ w: 2, h: 2 }, { w: 3, h: 3 }).scale === 1,
    JSON.stringify(inferScale({ w: 2, h: 2 }, { w: 3, h: 3 })));

  // 非法入参
  for (const [label, box, img] of [
    ['null box', null, { w: 1, h: 1 }],
    ['零尺寸 box', { w: 0, h: 0 }, { w: 1, h: 1 }],
    ['负数 img', { w: 1, h: 1 }, { w: -5, h: 5 }],
    ['NaN', { w: NaN, h: 1 }, { w: 1, h: 1 }],
  ]) {
    ok(`非法入参拒绝（${label}）`, inferScale(box, img).reason === INFER_REASON.INVALID_INPUT);
  }
  ok('isValidSize 契约', isValidSize({ w: 1, h: 1 }) === true && isValidSize(null) === false
    && isValidSize({ w: Infinity, h: 1 }) === false);
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n=== E2-2. ★ k=1 回归保证：关闭时与改造前逐字节一致 ★ ===');
{
  // 确定性扫描网格：box 50~110 步 17，img 相对 box -5..+5 步 2，以及 2x/3x 形态
  let mismatch = 0;
  let checked = 0;
  for (let bw = 50; bw <= 110; bw += 17) {
    for (let bh = 40; bh <= 90; bh += 13) {
      for (let dw = -5; dw <= 5; dw += 2) {
        for (let dh = -5; dh <= 5; dh += 2) {
          const box = { w: bw, h: bh };
          const img = { w: bw + dw, h: bh + dh };
          const off = judgeCandidateSize(box, img, 2, null);
          const legacy = sizeWithinTol(box, img, 2);
          checked++;
          if (off.matched !== legacy) mismatch++;
          if (off.scale !== null || off.infer !== null) mismatch++; // 关闭时不得带推断痕迹
        }
      }
    }
  }
  ok(`关闭时 judgeCandidateSize ≡ sizeWithinTol（${checked} 组网格全对，无推断痕迹）`,
    checked > 500 && mismatch === 0, `mismatch=${mismatch}`);

  // 开启时：1x 场景布尔判定也不变（|img-bbox|<=tol 的样本两种模式同判）
  let mismatchOn = 0;
  for (let bw = 50; bw <= 110; bw += 17) {
    for (let dw = -3; dw <= 3; dw++) {
      const box = { w: bw, h: bw };
      const img = { w: bw + dw, h: bw + dw };
      const on = judgeCandidateSize(box, img, 2, { enabled: true });
      const legacy = sizeWithinTol(box, img, 2);
      // 1x 邻域内：两者必须同判（开启不得把 1x 邻域内的样本判反）
      if (on.matched !== legacy) mismatchOn++;
    }
  }
  ok('开启时 1x 邻域（±3px）判定与改造前一致', mismatchOn === 0, `mismatch=${mismatchOn}`);

  // 开启时的行为增量：2x 邻域命中（这是 E-02 的目的）
  const on2x = judgeCandidateSize({ w: 96, h: 96 }, { w: 194, h: 194 }, 2, { enabled: true });
  ok('开启时 2x 容差内命中且带倍率', on2x.matched === true && on2x.scale === 2, JSON.stringify(on2x));
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n=== E2-3. channel1Name 集成（QA 自造 store）===');
{
  const rowSeq = (id, relPath, norm, w, h) => ({
    id, relPath, baseName: relPath, normName: norm, format: 'png',
    w, h, fileSize: 100, mtimeMs: 1, contentSha256: id,
    features: null, grid9: null, suggestedName: '',
  });
  const storeWith = (rows) => ({ byNormName: (n) => rows.filter((r) => r.normName === n) });

  // 场景 A：同名 1x+2x，开启 → AMBIGUOUS 全返回（不静默取一个）
  const sA = storeWith([
    rowSeq('a'.repeat(16), 'icon.png', 'icon', 96, 96),
    rowSeq('b'.repeat(16), 'icon@2x.png', 'icon', 192, 192),
  ]);
  const rA = channel1Name({ index: sA, queryName: 'icon', layerBox: { w: 96, h: 96 }, scaleInfer: { enabled: true } });
  ok('同名 1x+2x 开启 → AMBIGUOUS', rA.status === CH1_STATUS.AMBIGUOUS && rA.candidates.length === 2,
    `status=${rA.status} n=${rA.candidates.length}`);

  // 场景 B：同库同 bbox，关闭 → 只命中 1x（2x 排除 = 改造前行为）
  const rB = channel1Name({ index: sA, queryName: 'icon', layerBox: { w: 96, h: 96 } });
  ok('同名 1x+2x 关闭 → 只 1x 命中（旧行为）',
    rB.status === CH1_STATUS.HIT && rB.candidates.length === 1 && rB.candidates[0].w === 96,
    `status=${rB.status} n=${rB.candidates.length}`);

  // 场景 C：只有 2x 图，开启 → 命中且 evidence 说明倍率
  const sC = storeWith([rowSeq('c'.repeat(16), 'icon@2x.png', 'icon', 192, 192)]);
  const rC = channel1Name({ index: sC, queryName: 'icon', layerBox: { w: 96, h: 96 }, scaleInfer: { enabled: true } });
  ok('只有 2x 图开启 → 命中', rC.status === CH1_STATUS.HIT, JSON.stringify({ status: rC.status, n: rC.candidates.length }));
  ok('evidence 含倍率说明（2x 可追溯）', /2x|倍率/.test(rC.evidence || ''), rC.evidence && rC.evidence.slice(0, 80));

  // 场景 D：只有 2x 图，关闭 → 不命中（L6 旧行为保留）
  const rD = channel1Name({ index: sC, queryName: 'icon', layerBox: { w: 96, h: 96 } });
  ok('只有 2x 图关闭 → 不命中（L6 旧行为）', rD.status !== CH1_STATUS.HIT, `status=${rD.status}`);

  // 场景 E：非整数倍切图（150x150），开启 → 也不匹配（不硬凑）
  const sE = storeWith([rowSeq('e'.repeat(16), 'icon_mid.png', 'icon', 150, 150)]);
  const rE = channel1Name({ index: sE, queryName: 'icon', layerBox: { w: 96, h: 96 }, scaleInfer: { enabled: true } });
  ok('非整数倍 1.5625x 开启 → 也不命中（不硬凑倍率）', rE.status !== CH1_STATUS.HIT, `status=${rE.status}`);
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n=== E2-4. 默认关闭 + 配置守卫缺口侦察 ===');
{
  const { loadConfig, readRawConfig } = require('../src/core/config');
  const cfg = loadConfig({ rootDir: ROOT }).config;
  ok('运行时默认 enabled=false（Q22 未答不改变现有行为）', cfg.asset.scaleInfer.enabled === false);
  ok('fgui.config.json 的 scaleInfer.enabled=false', readRawConfig(path.join(ROOT, 'fgui.config.json')).raw.asset.scaleInfer.enabled === false);

  // ★ 守卫缺口侦察：asset 段守卫只查顶层键，嵌套 scaleInfer 子键是否有人对账？
  // 实验：把 fgui.config.json 的 scaleInfer.enabled 改成 true，跑全量测试看有没有红。
  const CONFIG = path.join(ROOT, 'fgui.config.json');
  const original = fs.readFileSync(CONFIG, 'utf8');
  try {
    const mutated = original.replace('"scaleInfer": {\n      "enabled": false,', '"scaleInfer": {\n      "enabled": true,')
      .replace('"scaleInfer": {\r\n      "enabled": false,', '"scaleInfer": {\r\n      "enabled": true,')
      .replace('"enabled": false,', '"enabled": true,');
    if (mutated === original) {
      ok('守卫侦察（变异锚点未命中）', false, '替换未生效，请检查 fgui.config.json 格式');
    } else {
      fs.writeFileSync(CONFIG, mutated, 'utf8');
      let out = '';
      try {
        out = execFileSync(NODE, ['--disable-warning=ExperimentalWarning', '--test', 'test/unit/scale-infer.test.js', 'test/unit/determinism.test.js'],
          { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 180000 });
      } catch (e) {
        out = (e.stdout || '') + (e.stderr || '');
      } finally {
        fs.writeFileSync(CONFIG, original, 'utf8');
      }
      const failed = [...out.matchAll(/^✖ (.+)$/gm)].map((x) => x[1].trim());
      // 断言意图：配置文件偷偷把默认打开，必须有测试红（否则「默认关」只是口头承诺）
      ok('★ 守卫侦察：配置文件改 enabled=true 必须有测试红', failed.length > 0,
        failed.length ? '' : '全绿 → 嵌套 scaleInfer 键无对账（守卫缺口，类似坑15 的嵌套版）');
      if (failed.length === 0) {
        console.log('  [INFO] 缺口详情：determinism 守卫只查 asset 段顶层键，scaleInfer.enabled/'
          + 'maxScale 嵌套键改名/改值无人对账（deepMerge 会用默认值补回，静默失效）');
      }
    }
    ok('fgui.config.json 已还原', fs.readFileSync(CONFIG, 'utf8') === original);
  } finally {
    fs.writeFileSync(CONFIG, original, 'utf8');
  }
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n=== E3-1. calibrateGrid9 纯函数（QA 自造标注样本，含条纹危险侧真实形态）===');
{
  // 特征工厂（对照 grid9.js 特征语义自造，非抄工程师测试值）
  const panel = (i) => ({
    file: `panel_${i}.png`, expected: 'CAN_9GRID',
    features: { w: 400 + i, h: 300, aspectRatio: (400 + i) / 300, cornerFill: 0.96 - i * 0.005,
      radialSymmetry: 0.15 + i * 0.01, radialMaxCluster: 5, midMonotonic: 0.1,
      midRowVariance: 0.03, midColVariance: 0.03 },
  });
  const capsule = (i) => ({
    file: `capsule_${i}.png`, expected: 'SINGLE_AXIS_ONLY',
    features: { w: 120, h: 36 + i, aspectRatio: 120 / (36 + i), cornerFill: 0.24,
      radialSymmetry: 0.3, radialMaxCluster: 2, midMonotonic: 0.9,
      midRowVariance: 0.02, midColVariance: 0.02 },
  });
  const circle = (i) => ({
    file: `circle_${i}.png`, expected: 'NEVER',
    features: { w: 80, h: 80, aspectRatio: 1, cornerFill: 0.08 - i * 0.005,
      radialSymmetry: 0.92 + i * 0.005, radialMaxCluster: 4, midMonotonic: 0.2,
      midRowVariance: 0.35, midColVariance: 0.35 },
  });
  // 条纹（HANDOFF §2.1 已知危险侧形态）：期望 NEVER，现阈值会判 CAN_9GRID
  const stripe = (i) => ({
    file: `stripe_${i}.png`, expected: 'NEVER',
    features: { w: 120, h: 40 + i, aspectRatio: 120 / (40 + i), cornerFill: 1.0,
      radialSymmetry: 1.0, radialMaxCluster: 2, midMonotonic: 0.55 - i * 0.02,
      midRowVariance: 0.4, midColVariance: 0.4 },
  });

  const samples = [
    ...[0, 1, 2, 3, 4].map(panel),
    ...[0, 1, 2, 3, 4].map(capsule),
    ...[0, 1, 2, 3, 4].map(circle),
    ...[0, 1, 2].map(stripe),
  ];

  const { computeGrid9 } = require('../src/imaging/grid9');
  const current = require('../src/imaging/grid9').DEFAULT_THRESHOLDS;
  const beforeDangerous = samples.filter((s) => classifyDirection(s.expected, computeGrid9(s.features, current).verdict) === 'dangerous').length;
  console.log(`  [INFO] QA 自造样本：现阈值下危险侧误判 ${beforeDangerous} 个（条纹形态，与 HANDOFF §2.1 一致）`);
  ok('fixture 自检：现阈值确实存在危险侧误判（否则标定无对象）', beforeDangerous > 0);

  const report = calibrateGrid9({ samples, thresholds: current });
  ok('标定后危险侧不增加（安全方向优先）',
    report.summary.suggested.dangerous <= report.summary.current.dangerous,
    `${report.summary.current.dangerous} → ${report.summary.suggested.dangerous}`);
  ok('标定建议全部候选可审计（considered 非空）',
    report.thresholds.trace.every((t) => t.considered.length > 0));
  // 建议阈值下重新判定：不允许把「一致」的样本搞成危险侧
  const afterByFile = new Map(report.reconciliation.suggested.map((i) => [i.file, i]));
  const newDangerous = samples.filter((s) => {
    const after = afterByFile.get(s.file);
    return after && after.direction === 'dangerous' && !report.reconciliation.current.find((c) => c.file === s.file && c.direction === 'dangerous');
  });
  ok('建议阈值不产生新的危险侧误判', newDangerous.length === 0, JSON.stringify(newDangerous.map((s) => s.file)));

  // 确定性
  const report2 = calibrateGrid9({ samples, thresholds: current });
  ok('同输入两次标定报告逐字节一致（B9）',
    JSON.stringify(report) === JSON.stringify(report2));

  // 样本不足警告
  const small = calibrateGrid9({ samples: samples.slice(0, 5), thresholds: current });
  ok('样本不足（5 < 30）→ 警告 + 置信度 low',
    small.warnings.some((w) => w.includes('样本不足')) && small.thresholds.confidence.level === 'low',
    JSON.stringify(small.thresholds.confidence));

  // 标注校验：非法 expected 抛错（宁报错不静默）
  let threw = null;
  try { parseLabels({ labels: { 'x.png': { expected: 'MAYBE' } } }); } catch (e) { threw = e; }
  ok('非法标注值 → USAGE 错（不静默跳过）', threw && threw.code === 'USAGE', threw && threw.code);

  // 安全红线单元：正确数更高但危险侧更多 → 不是更好的得分
  ok('isBetter 语义：危险侧优先（dangerous 少者胜，即使 correct 少）',
    classifyDirection('NEVER', 'CAN_9GRID') === 'dangerous'
    && classifyDirection('CAN_9GRID', 'NEVER') === 'safe_slower'
    && classifyDirection('NEVER', 'NEVER') === 'ok');
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n=== E3-2. 安全红线：放松阈值提正确数但加危险侧 → 必须拒绝 ===');
{
  // 构造：一批圆（期望 NEVER），其中混入「阈值放松后会判 CAN_9GRID」的形态。
  // 候选值若把 cornerFillRoundMax 抬高让圆变 CAN_9GRID（危险），即使碰巧
  // 修好别的样本，也必须被 safetyRejected。
  const circles = [];
  for (let i = 0; i < 6; i++) {
    circles.push({
      file: `red_circle_${i}.png`, expected: 'NEVER',
      features: { w: 90, h: 90, aspectRatio: 1, cornerFill: 0.05,
        radialSymmetry: 0.95, radialMaxCluster: 4, midMonotonic: 0.2,
        midRowVariance: 0.4, midColVariance: 0.4 },
    });
  }
  const report = calibrateGrid9({ samples: circles, thresholds: require('../src/imaging/grid9').DEFAULT_THRESHOLDS });
  const rejected = [];
  for (const t of report.thresholds.trace) {
    for (const c of t.considered) if (c.safetyRejected) rejected.push(`${t.key}=${c.value}`);
  }
  ok('全 NEVER 样本上，任何把圆判松的候选都被安全拒绝或不采纳',
    report.summary.suggested.dangerous === 0
    && report.reconciliation.suggested.every((i) => i.direction !== 'dangerous'),
    JSON.stringify({ dangerous: report.summary.suggested.dangerous, rejected }));

  // 直接验证建议阈值的语义：建议值下圆仍是 NEVER
  for (const s of circles) {
    const { computeGrid9 } = require('../src/imaging/grid9');
    const v = computeGrid9(s.features, report.thresholds.suggested);
    if (v.verdict !== 'NEVER') {
      ok('建议阈值下圆仍 NEVER', false, `${s.file} → ${v.verdict}`);
      break;
    }
  }
  ok('建议阈值下全部圆仍 NEVER', true);
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n=== E3-3. CLI 级：★ 绝不改 fgui.config.json ★ + 确定性 + 未标注/缺失处理 ===');
{
  const cfgPath = path.join(ROOT, 'fgui.config.json');
  const cfgBefore = md5(cfgPath);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qa3-e03-'));
  // QA 自己的标注文件：panel→CAN_9GRID、capsule→SINGLE_AXIS_ONLY、circle/radial→NEVER，
  // K5 陷阱样本故意不标注（测未标注路径）；再放一个目录里不存在的（测缺失路径）
  const labels = {
    labels: {},
  };
  for (let i = 1; i <= 5; i++) {
    labels.labels[`panel_${i}.png`] = { expected: 'CAN_9GRID' };
    labels.labels[`capsule_${i}.png`] = { expected: 'SINGLE_AXIS_ONLY' };
    labels.labels[`circle_${i}.png`] = { expected: 'NEVER' };
    labels.labels[`radial_${i}.png`] = { expected: 'NEVER' };
  }
  labels.labels['不存在的图.png'] = { expected: 'NEVER' };
  const labelsPath = path.join(d, 'labels.json');
  fs.writeFileSync(labelsPath, JSON.stringify(labels, null, 2));

  const runCli = (args) => {
    try {
      const out = execFileSync(NODE, ['--disable-warning=ExperimentalWarning', 'bin/fgui-rb.js', ...args],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 180000 });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status === undefined ? 1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
    }
  };
  const args = ['calibrate-grid9', '--root', ROOT, '--assets', path.join(GOLDEN, 'assets'), '--labels', labelsPath, '--out', d];
  const r1 = runCli(args);
  ok('CLI 标定成功', r1.code === 0, r1.out.slice(-200));
  ok('★ fgui.config.json 未被修改（红线）', md5(cfgPath) === cfgBefore,
    `${cfgBefore} → ${md5(cfgPath)}`);
  ok('产物 grid9-calibration.json 存在', fs.existsSync(path.join(d, 'grid9-calibration.json')));
  ok('产物 grid9-calibration.md 存在', fs.existsSync(path.join(d, 'grid9-calibration.md')));

  const report = JSON.parse(fs.readFileSync(path.join(d, 'grid9-calibration.json'), 'utf8'));
  ok('未标注文件被列出（K5 陷阱样本等）', report.inputs.unlabeledFiles.length >= 5,
    `实际 ${report.inputs.unlabeledFiles.length}`);
  ok('缺失标注文件被列出', report.inputs.missingFiles.includes('不存在的图.png'));
  ok('样本量 20 < 30 → 低置信警告', report.thresholds.confidence.level === 'low'
    && report.warnings.some((w) => w.includes('样本不足')));

  // 确定性：再跑一次逐字节一致
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qa3-e03-b-'));
  runCli(['calibrate-grid9', '--root', ROOT, '--assets', path.join(GOLDEN, 'assets'), '--labels', labelsPath, '--out', d2]);
  const json1 = fs.readFileSync(path.join(d, 'grid9-calibration.json'), 'utf8');
  const json2 = fs.readFileSync(path.join(d2, 'grid9-calibration.json'), 'utf8');
  // assetRoot/labelsPath 进了报告（绝对路径不同）——剔除这两个输入面字段后必须一致
  const strip = (s) => {
    const o = JSON.parse(s);
    o.inputs.assetRoot = ''; o.inputs.labelsPath = '';
    return JSON.stringify(o);
  };
  ok('同输入两次标定逐字节一致（剔除绝对路径输入面后）', strip(json1) === strip(json2));
  ok('产物内零时间戳', !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(json1));

  // 二次运行后 fgui.config.json 仍未动
  ok('二次运行后 fgui.config.json 仍未动', md5(cfgPath) === cfgBefore);
  fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(d2, { recursive: true, force: true });
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n=== E3-4/E2-5. 变异测试：修复/保护机制回退必须红 ===');
{
  const FILES = {
    cal: 'src/imaging/grid9-calibrate.js',
    scale: 'src/assets/scale-infer.js',
    cfgjs: 'src/core/config.js',
  };
  const TESTS = {
    cal: 'test/unit/grid9-calibrate.test.js',
    scale: 'test/unit/scale-infer.test.js',
  };
  const runTest = (file) => {
    try {
      execFileSync(NODE, ['--disable-warning=ExperimentalWarning', '--test', file],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 180000 });
      return { code: 0, out: '' };
    } catch (e) {
      return { code: e.status === undefined ? 1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
    }
  };
  const withMutation = (fileKey, from, to, testKey) => {
    const p = path.join(ROOT, FILES[fileKey]);
    const original = fs.readFileSync(p, 'utf8');
    if (!original.includes(from)) return { anchorMissing: true };
    fs.writeFileSync(p, original.replace(from, to), 'utf8');
    let r;
    try {
      r = runTest(TESTS[testKey]);
    } finally {
      fs.writeFileSync(p, original, 'utf8');
    }
    const failed = [...r.out.matchAll(/^✖ (.+)$/gm)].map((x) => x[1].trim());
    return { code: r.code, failed, restoreOk: fs.readFileSync(p, 'utf8') === original };
  };

  // M-E3a：安全比较器回退（只看正确数，忽略危险侧）→ 标定测试必须红
  const m1 = withMutation('cal',
    'if (a.dangerous !== b.dangerous) return a.dangerous < b.dangerous;',
    'if (false) return a.dangerous < b.dangerous;',
    'cal');
  const m1Safety = (m1.failed || []).length;
  ok('M-E3a 安全比较器回退（忽略危险侧）→ 标定测试变红',
    !m1.anchorMissing && m1.code !== 0 && m1Safety >= 1,
    `exit=${m1.code} failed=${JSON.stringify((m1.failed || []).slice(0, 4))}`);
  ok('M-E3a 恢复后复绿', m1.restoreOk && runTest(TESTS.cal).code === 0);

  // M-E2a：judgeCandidateSize 忽略开关（关闭也走推断）→ 1x 一致性测试必须红
  const m2 = withMutation('scale',
    'const enabled = !!(scaleInfer && scaleInfer.enabled);',
    'const enabled = true; // MUTATION',
    'scale');
  ok('M-E2a 开关失效（关闭也推断）→ scale-infer 测试变红',
    !m2.anchorMissing && m2.code !== 0 && (m2.failed || []).length >= 1,
    `exit=${m2.code} failed=${JSON.stringify((m2.failed || []).slice(0, 4))}`);
  ok('M-E2a 恢复后复绿', m2.restoreOk && runTest(TESTS.scale).code === 0);

  // M-E2b：并列 tie-break 反转（取更大倍率）→ 有没有测试守护？
  const m3 = withMutation('scale',
    'if (!best || deviation < best.deviation) {',
    'if (!best || deviation <= best.deviation) {',
    'scale');
  if (m3.anchorMissing) {
    ok('M-E2b 锚点未命中', false);
  } else if (m3.code === 0) {
    ok('M-E2b 侦察：并列 tie-break 反转无测试守护（记录为覆盖缺口）', true,
      '并列取小 k 是保守语义，工程师测试未覆盖（QA 已在 E2-1 覆盖）');
  } else {
    ok('M-E2b 并列 tie-break 反转 → 测试变红', true, JSON.stringify((m3.failed || []).slice(0, 3)));
  }
  ok('M-E2b 恢复后复绿', m3.restoreOk && runTest(TESTS.scale).code === 0);

  // M-E2c：config.js 默认 enabled 翻转 → 有没有测试守护？
  // ★ 实测结论（QA 第 2 轮）：不变红 —— fgui.config.json 显式写了 enabled:false，
  //   loadConfig 深合并时代码默认被配置文件遮蔽，本仓库内行为不变；
  //   但「无配置文件环境」（loadConfig 缺文件走纯默认）下翻转会静默生效，
  //   且无测试守护 defaultConfig().asset.scaleInfer.enabled === false。
  //   缓解：配置文件侧有守卫（E2-4 实测改 true 必红）、asset 段顶层键有对账
  //   （删整个 scaleInfer 段会红）。残余风险=无配置环境+代码默认翻转，低危。
  const m4 = withMutation('cfgjs',
    "scaleInfer: { enabled: false, maxScale: 4 },",
    "scaleInfer: { enabled: true, maxScale: 4 },",
    'scale');
  if (m4.anchorMissing) {
    ok('M-E2c 锚点未命中', false);
  } else if (m4.code === 0) {
    ok('M-E2c 侦察：config.js 代码默认翻转无测试直接守护（低危覆盖缺口，见上方分析）',
      true, '本仓库内被 fgui.config.json 遮蔽（行为不变）；无配置环境会静默生效');
  } else {
    ok('M-E2c 代码默认 enabled=true → 测试变红', true, JSON.stringify((m4.failed || []).slice(0, 3)));
  }
  ok('M-E2c 恢复后复绿', m4.restoreOk && runTest(TESTS.scale).code === 0);
}

console.log(`\n=== QA3-e02-e03 汇总: ${pass} pass / ${fail} fail ===`);
if (fail > 0) {
  console.log('失败项:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail > 0 ? 1 : 0);
