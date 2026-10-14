'use strict';
/**
 * test/unit/grid9-calibrate.test.js —— E-03 九宫格阈值标定工具
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 独立对账原则（P0 BUG#1 教训）★
 *   ① 安全方向优先的用例用**手搓特征字面量**（不经过图片管线），期望值手算；
 *   ② 端到端用例的 ground truth 是**按构造已知**的形态（面板/胶囊/圆/放射），
 *      标注文件独立编写，验收标准是「建议阈值能按标注正确分类全部样本」；
 *   ③ 危险方向用例构造「放松阈值能提高准确率但会误判条纹为可切」的场景，
 *      断言工具**不会**建议那个阈值，且拒绝理由留痕。
 * ════════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCli } = require('../e2e/run-cli');
const {
  calibrateGrid9, evaluateSamples, classifyDirection,
  parseLabels, MIN_SAMPLES_FOR_PRODUCTION, DIRECTION,
} = require('../../src/imaging/grid9-calibrate');
const { computeGrid9, VERDICT, DEFAULT_THRESHOLDS } = require('../../src/imaging/grid9');
const { extractFeatures } = require('../../src/imaging/features');
const { createDecoder } = require('../../src/imaging/decoder');

const ROOT = path.resolve(__dirname, '../..');
const CONFIG_PATH = path.join(ROOT, 'fgui.config.json');

// ======================================================================
// ① 方向分类（安全方向优先的判据基础）
// ======================================================================

test('classifyDirection: 放行度更高的判定 = 危险侧', () => {
  assert.equal(classifyDirection(VERDICT.NEVER, VERDICT.CAN_9GRID), DIRECTION.DANGEROUS);
  assert.equal(classifyDirection(VERDICT.NEVER, VERDICT.SINGLE_AXIS_ONLY), DIRECTION.DANGEROUS);
  assert.equal(classifyDirection(VERDICT.SINGLE_AXIS_ONLY, VERDICT.CAN_9GRID), DIRECTION.DANGEROUS);
});

test('classifyDirection: 放行度更低的判定 = 安全侧', () => {
  assert.equal(classifyDirection(VERDICT.CAN_9GRID, VERDICT.NEVER), DIRECTION.SAFE_SLOWER);
  assert.equal(classifyDirection(VERDICT.CAN_9GRID, VERDICT.SINGLE_AXIS_ONLY), DIRECTION.SAFE_SLOWER);
  assert.equal(classifyDirection(VERDICT.SINGLE_AXIS_ONLY, VERDICT.NEVER), DIRECTION.SAFE_SLOWER);
});

test('classifyDirection: 一致 = ok', () => {
  for (const v of [VERDICT.CAN_9GRID, VERDICT.SINGLE_AXIS_ONLY, VERDICT.NEVER]) {
    assert.equal(classifyDirection(v, v), DIRECTION.OK);
  }
});

// ======================================================================
// ② parseLabels 校验（宁报错不静默）
// ======================================================================

test('parseLabels: 合法标注按文件名排序解析，note 缺省为空串', () => {
  const out = parseLabels({
    _comment: 'x',
    labels: {
      'b.png': { expected: 'NEVER' },
      'a.png': { expected: 'CAN_9GRID', note: '四角近方' },
    },
  });
  assert.deepEqual(out, [
    { file: 'a.png', expected: 'CAN_9GRID', note: '四角近方' },
    { file: 'b.png', expected: 'NEVER', note: '' },
  ]);
});

test('parseLabels: expected 非法 -> USAGE 错误并指出文件（不静默跳过）', () => {
  assert.throws(() => parseLabels({ labels: { 'a.png': { expected: 'MAYBE' } } }), (err) => {
    assert.equal(err.code, 'USAGE');
    assert.ok(err.message.includes('a.png'));
    assert.ok(err.message.includes('MAYBE'));
    return true;
  });
});

test('parseLabels: 缺 labels 对象 / 条目非对象 -> USAGE 错误', () => {
  assert.throws(() => parseLabels({}), (err) => err.code === 'USAGE');
  assert.throws(() => parseLabels({ labels: { 'a.png': 'CAN_9GRID' } }), (err) => err.code === 'USAGE');
});

// ======================================================================
// ③ ★ 安全方向优先（核心用例）
// ======================================================================

/**
 * 手搓特征字面量（不经过图片管线，期望值可手算对账）。
 *
 * 场景：5 张「带边框面板」+ 2 张「细长条纹」，当前 radialClusterMin=3。
 *   · clusterMin=3：条纹判 NEVER（对），面板判 NEVER（安全侧错）-> 正确 2 / 危险 0
 *   · clusterMin=2：面板判 CAN_9GRID（对），条纹也判 CAN_9GRID（**危险侧错**）
 *                   -> 正确 5 / 危险 2
 * 放松阈值（3->2）**提高准确率但误判条纹为可切** —— 工具必须拒绝。
 */
function panelFeat() {
  return {
    w: 100, h: 60, aspectRatio: 1.666667,
    cornerFill: 0.97, radialSymmetry: 1, radialMaxCluster: 2,
    midRowVariance: 0.575, midColVariance: 0.575, midMonotonic: 0.5,
  };
}
function stripeFeat() {
  return {
    w: 120, h: 40, aspectRatio: 3,
    cornerFill: 1, radialSymmetry: 1, radialMaxCluster: 2,
    midRowVariance: 0.575, midColVariance: 0.575, midMonotonic: 0.5,
  };
}

test('★ 安全方向优先: 放松阈值能提高准确率但会误判条纹为可切 -> 工具不建议该阈值', () => {
  const samples = [];
  for (let i = 0; i < 5; i++) samples.push({ file: `panel_${i}.png`, expected: VERDICT.CAN_9GRID, features: panelFeat() });
  for (let i = 0; i < 2; i++) samples.push({ file: `stripe_${i}.png`, expected: VERDICT.NEVER, features: stripeFeat() });

  // 现阈值：仅把 radialClusterMin 抬到 3（其余保持默认）
  const current = { ...DEFAULT_THRESHOLDS, radialClusterMin: 3 };

  // 先手算验证场景本身：确认「放松确实更准但更危险」
  const strict = evaluateSamples(samples, current);
  const relaxed = evaluateSamples(samples, { ...current, radialClusterMin: 2 });
  assert.equal(strict.correct, 2);
  assert.equal(strict.dangerous, 0);
  assert.equal(relaxed.correct, 5, '放松后正确数应更高（否则场景不成立）');
  assert.equal(relaxed.dangerous, 2, '放松后必须引入危险侧误判（否则场景不成立）');

  const report = calibrateGrid9({ samples, thresholds: current });

  // ★ 核心断言：不建议把 radialClusterMin 降到 2
  assert.equal(report.thresholds.suggested.radialClusterMin, 3,
    '★ 提高准确率但误判条纹为可切的阈值，工具不得建议');
  // 拒绝理由必须留痕可审计
  const clusterTrace = report.thresholds.trace.find((t) => t.key === 'radialClusterMin');
  const tempting = clusterTrace.considered.find((c) => c.value === 2);
  assert.ok(tempting, '候选 2 必须进 considered（审计用）');
  assert.equal(tempting.safetyRejected, true, '候选 2 必须被标记为「安全方向优先」拒绝');
  assert.equal(tempting.proposed, false);
  assert.equal(tempting.applied, false);
  assert.ok(tempting.reason.includes('危险侧'), '拒绝理由必须点明危险侧误判');
  assert.ok(tempting.reason.includes('拉花'), '拒绝理由必须说明后果（拉花）');
  assert.ok(tempting.correct > report.summary.suggested.correct,
    '留痕要能看出「被拒绝的候选其实更准」—— 这是有意识的取舍，不是碰巧');
  // 建议结果本身零危险侧
  assert.equal(report.summary.suggested.dangerous, 0);
});

test('★ 安全方向优先: 现阈值有危险侧误判时，报告必须警告并建议对症修复', () => {
  // 场景（手搓特征，期望值可手算）：
  //   X = 面板（CAN_9GRID）：四角近方、中部平坦、偏离扇区聚成 3 簇（描边/浮雕）
  //   Y = 条纹（NEVER）：   四角近方、中部高方差、偏离扇区只聚成 2 簇
  // 两者尺寸/长宽比/cornerFill 完全相同 —— 只有 cluster 与 flatMid 不同，
  // 现阈值（clusterMin=2）把 Y 也放行 -> 危险侧误判。
  // 对症修复是 radialClusterMin 2->3（X 的 cluster=3 不受影响，Y 的 cluster=2 被禁切）。
  const panelX = {
    w: 120, h: 80, aspectRatio: 1.5,
    cornerFill: 0.97, radialSymmetry: 1, radialMaxCluster: 3,
    midRowVariance: 0.1, midColVariance: 0.1, midMonotonic: 0.5,
  };
  const stripeY = {
    w: 120, h: 80, aspectRatio: 1.5,
    cornerFill: 0.97, radialSymmetry: 1, radialMaxCluster: 2,
    midRowVariance: 0.575, midColVariance: 0.575, midMonotonic: 0.5,
  };
  const samples = [
    { file: 'panel_x.png', expected: VERDICT.CAN_9GRID, features: panelX },
    { file: 'stripe_y.png', expected: VERDICT.NEVER, features: stripeY },
  ];

  // 先手算验证场景：现阈值下 Y 确实危险侧误判，且对症修复确实有效
  const before = evaluateSamples(samples, DEFAULT_THRESHOLDS);
  assert.equal(before.dangerous, 1, 'Y 在当前默认阈值下应危险侧误判');
  assert.equal(before.correct, 1);
  const fixed = evaluateSamples(samples, { ...DEFAULT_THRESHOLDS, radialClusterMin: 3 });
  assert.equal(fixed.dangerous, 0);
  assert.equal(fixed.correct, 2, 'clusterMin=3 应让两个样本都判对');

  const report = calibrateGrid9({ samples, thresholds: DEFAULT_THRESHOLDS });

  // 现阈值危险侧误判 -> 必须警告
  assert.ok(report.warnings.some((w) => w.includes('危险侧误判')),
    '现阈值存在危险侧误判时必须给警告');
  // 对症修复必须被建议（且不被「一刀切禁切」的钝阈值劫持）
  assert.equal(report.thresholds.suggested.radialClusterMin, 3,
    '★ 消除危险侧误判的对症改动应当被建议');
  assert.equal(report.summary.suggested.dangerous, 0);
  assert.equal(report.summary.suggested.correct, 2);
  // 劫持性的钝阈值不得被应用（cornerFillRoundMax=0.97 会把 X 一起误杀）
  assert.equal(report.thresholds.suggested.cornerFillRoundMax, DEFAULT_THRESHOLDS.cornerFillRoundMax,
    '★ 一刀切禁切的钝阈值不得劫持对症修复');
  assert.equal(report.thresholds.suggested.minSideForShape, DEFAULT_THRESHOLDS.minSideForShape);
  // 改动清单里应只有对症的那一项
  assert.deepEqual(report.thresholds.changes.map((c) => c.key), ['radialClusterMin']);
});

test('标定: 纯函数对「已最优」样本集不给无意义改动（少改动原则）', () => {
  // 默认阈值下全部判对的样本 -> 建议值应等于当前值（每个阈值都不换）
  const samples = [
    { file: 'p.png', expected: VERDICT.CAN_9GRID, features: panelFeat() },
    { file: 's.png', expected: VERDICT.NEVER, features: { ...stripeFeat(), radialMaxCluster: 1 } },
  ];
  const report = calibrateGrid9({ samples, thresholds: DEFAULT_THRESHOLDS });
  const final = evaluateSamples(samples, report.thresholds.suggested);
  assert.equal(final.correct, samples.length);
  assert.equal(final.dangerous, 0);
  for (const t of report.thresholds.trace) {
    if (t.changed) {
      // 若改了，必须严格更优（本就不该发生，发生了要能解释）
      assert.ok(t.scoreAfter.correct > t.scoreBefore.correct
        || t.scoreAfter.dangerous < t.scoreBefore.dangerous,
      `阈值 ${t.key} 的改动未带来严格改进`);
    }
  }
});

// ======================================================================
// ④ 端到端：合成素材跑 CLI（ground truth 按构造已知）
// ======================================================================

/** 临时目录。 */
function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fgui-cal-${name}-`));
}

/** 1x1 透明 PNG（CLI 入参校验用例用）。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('端到端: 合成素材 -> 建议阈值能按人工标注正确分类全部样本', async (t) => {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    return t.skip('sharp 不可用（需要 NODE_PATH 指向 node_modules）');
  }
  const { makePanel, makeCapsule, makeCircle, makeRadial } = require('../fixtures/make-assets');

  const assetDir = tmpDir('assets');
  /** @type {Object<string,string>} 文件名 -> 期望判定（按构造已知） */
  const expect = {};
  const jobs = [
    ['panel_1.png', () => makePanel(120, 80, 0), VERDICT.CAN_9GRID],
    ['panel_2.png', () => makePanel(128, 84, 1), VERDICT.CAN_9GRID],
    ['panel_3.png', () => makePanel(136, 88, 2), VERDICT.CAN_9GRID],
    ['panel_4.png', () => makePanel(144, 92, 3), VERDICT.CAN_9GRID],
    ['capsule_1.png', () => makeCapsule(120, 36, 0), VERDICT.SINGLE_AXIS_ONLY],
    ['capsule_2.png', () => makeCapsule(136, 36, 1), VERDICT.SINGLE_AXIS_ONLY],
    ['capsule_3.png', () => makeCapsule(152, 36, 2), VERDICT.SINGLE_AXIS_ONLY],
    ['circle_1.png', () => makeCircle(64, 0), VERDICT.NEVER],
    ['circle_2.png', () => makeCircle(72, 1), VERDICT.NEVER],
    ['circle_3.png', () => makeCircle(80, 2), VERDICT.NEVER],
    ['radial_1.png', () => makeRadial(72, 0), VERDICT.NEVER],
    ['radial_2.png', () => makeRadial(80, 1), VERDICT.NEVER],
  ];
  for (const [name, mk, expected] of jobs) {
    const rgba = mk();
    await sharp(rgba.data, {
      raw: { width: rgba.width, height: rgba.height, channels: 4 },
    }).png({ compressionLevel: 9, effort: 4 }).toFile(path.join(assetDir, name));
    expect[name] = expected;
  }

  // 标注文件（独立编写；故意漏标 2 张，验证「未标注跳过且可见」）
  const labels = { _comment: '测试标注', labels: {} };
  const labeled = Object.keys(expect).slice(0, 10);
  for (const name of labeled) {
    labels.labels[name] = { expected: expect[name] };
  }
  const labelsPath = path.join(assetDir, '..', 'labels.json');
  fs.writeFileSync(labelsPath, JSON.stringify(labels, null, 2));

  // 临时 root：放一份 fgui.config.json 副本（验证工具不改它）
  const root = tmpDir('root');
  const configBytes = fs.readFileSync(CONFIG_PATH);
  fs.writeFileSync(path.join(root, 'fgui.config.json'), configBytes);
  const outDir = path.join(root, 'out');

  const r = runCli([
    'calibrate-grid9',
    '--root', root,
    '--assets', assetDir,
    '--labels', labelsPath,
    '--out', outDir,
  ], { cwd: root });
  assert.equal(r.code, 0, `CLI 应成功，stderr: ${r.stderr}`);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.sampleCount, 10, '只标了 10 张');
  assert.equal(payload.unlabeled, 2, '未标注的 2 张应被报告出来（不静默）');

  // ---- 样本不足警告 + 低置信度 ----
  assert.equal(payload.confidence, 'low');
  assert.ok(payload.warnings.some((w) => w.includes('样本不足') && w.includes(String(MIN_SAMPLES_FOR_PRODUCTION))),
    `12 张以内应警告样本不足，实得: ${JSON.stringify(payload.warnings)}`);
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'grid9-calibration.json'), 'utf8'));

  // ---- 建议阈值能按标注正确分类全部样本（独立重算对账）----
  const decoder = createDecoder();
  for (const name of labeled) {
    const buf = fs.readFileSync(path.join(assetDir, name));
    const rgba = await decoder.decodeToRgba(buf);
    const features = extractFeatures(rgba);
    const v = computeGrid9(features, report.thresholds.suggested);
    assert.equal(v.verdict, expect[name],
      `★ 建议阈值下 ${name} 应判 ${expect[name]}，实得 ${v.verdict}`
      + `（建议值 radialClusterMin=${report.thresholds.suggested.radialClusterMin} 等）`);
  }
  // 建议阈值下零危险侧
  assert.equal(report.summary.suggested.dangerous, 0);
  // Markdown 报告也生成了且含关键节
  const md = fs.readFileSync(path.join(outDir, 'grid9-calibration.md'), 'utf8');
  assert.ok(md.includes('安全方向优先'));
  assert.ok(md.includes('fgui.config.json'));
  assert.ok(md.includes('逐张对账'));

  // ---- 工具不自动改配置 ----
  assert.ok(fs.readFileSync(path.join(root, 'fgui.config.json')).equals(configBytes),
    '★ calibrate-grid9 绝不修改 fgui.config.json');

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(assetDir, { recursive: true, force: true });
  fs.rmSync(labelsPath, { force: true });
});

// ======================================================================
// ⑤ B9 确定性：同输入两次运行逐字节一致
// ======================================================================

test('B9: 同一输入两次运行，两个产物逐字节一致', async (t) => {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    return t.skip('sharp 不可用');
  }
  const { makePanel, makeCircle } = require('../fixtures/make-assets');
  const assetDir = tmpDir('assets');
  const jobs = [
    ['panel_1.png', () => makePanel(120, 80, 0), VERDICT.CAN_9GRID],
    ['panel_2.png', () => makePanel(128, 84, 1), VERDICT.CAN_9GRID],
    ['circle_1.png', () => makeCircle(64, 0), VERDICT.NEVER],
    ['circle_2.png', () => makeCircle(72, 1), VERDICT.NEVER],
  ];
  const labels = { labels: {} };
  for (const [name, mk, expected] of jobs) {
    const rgba = mk();
    await sharp(rgba.data, {
      raw: { width: rgba.width, height: rgba.height, channels: 4 },
    }).png({ compressionLevel: 9, effort: 4 }).toFile(path.join(assetDir, name));
    labels.labels[name] = { expected };
  }
  const labelsPath = path.join(assetDir, '..', 'labels-b9.json');
  fs.writeFileSync(labelsPath, JSON.stringify(labels));

  const runOnce = () => {
    const root = tmpDir('root');
    fs.writeFileSync(path.join(root, 'fgui.config.json'), fs.readFileSync(CONFIG_PATH));
    const outDir = path.join(root, 'out');
    const r = runCli([
      'calibrate-grid9', '--root', root, '--assets', assetDir,
      '--labels', labelsPath, '--out', outDir,
    ], { cwd: root });
    assert.equal(r.code, 0, r.stderr);
    const json = fs.readFileSync(path.join(outDir, 'grid9-calibration.json'));
    const md = fs.readFileSync(path.join(outDir, 'grid9-calibration.md'));
    fs.rmSync(root, { recursive: true, force: true });
    return { json, md };
  };

  const a = runOnce();
  const b = runOnce();
  assert.ok(a.json.equals(b.json), '★ grid9-calibration.json 两次运行必须逐字节一致');
  assert.ok(a.md.equals(b.md), '★ grid9-calibration.md 两次运行必须逐字节一致');
  // 报告里不允许出现时间戳
  const text = a.json.toString('utf8');
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), '报告不得包含 ISO 时间戳（B9）');

  fs.rmSync(assetDir, { recursive: true, force: true });
  fs.rmSync(labelsPath, { force: true });
});

// ======================================================================
// ⑥ CLI 入参校验（宁报错不静默）
// ======================================================================

test('CLI: 缺 --labels -> USAGE（退出码 2）', () => {
  const r = runCli(['calibrate-grid9', '--assets', ROOT], { cwd: ROOT });
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes('labels'));
});

test('CLI: 标注 expected 非法 -> USAGE 且指明文件', () => {
  const assetDir = tmpDir('assets');
  fs.writeFileSync(path.join(assetDir, 'a.png'), PNG_1X1);
  const labelsPath = path.join(assetDir, '..', 'bad-labels.json');
  fs.writeFileSync(labelsPath, JSON.stringify({ labels: { 'a.png': { expected: ' perhaps ' } } }));
  const r = runCli([
    'calibrate-grid9', '--assets', assetDir, '--labels', labelsPath,
  ], { cwd: ROOT });
  assert.equal(r.code, 2, `非法标注应 USAGE，实得 ${r.code}`);
  assert.ok(/a\.png/.test(r.stderr) && /expected/.test(r.stderr),
    `错误信息应指明文件与字段，实得: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(assetDir, { recursive: true, force: true });
  fs.rmSync(labelsPath, { force: true });
});
