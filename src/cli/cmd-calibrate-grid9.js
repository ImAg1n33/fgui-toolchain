'use strict';
/**
 * src/cli/cmd-calibrate-grid9.js —— E-03 九宫格阈值标定工具
 *
 * usage:
 *   fgui-rb calibrate-grid9 --assets <切图目录> --labels <标注.json>
 *                            [--out <产物目录>] [--min-samples 30]
 *
 * 输入：
 *   --assets   切图目录（递归扫描，与 asset-index 同一套收集规则）
 *   --labels   人工标注文件（JSON，格式见 src/imaging/grid9-calibrate.js 的 parseLabels）：
 *                { "labels": { "按钮_胶囊.png": { "expected": "SINGLE_AXIS_ONLY" } } }
 *
 * 输出（写入 --out，默认 <root>/out）：
 *   grid9-calibration.json   完整标定报告（机器可读）
 *   grid9-calibration.md     人可读报告（逐张对账 + 建议阈值 + diff + 置信度）
 *
 * ★ 三条硬约束 ★
 *   1. **只读配置，绝不自动改 fgui.config.json** —— 只产出 diff 形式的建议值，
 *      是否采纳由人决定（本命令没有任何写配置文件的代码路径）。
 *   2. **确定性（B9）** —— 产物零时间戳，同一输入两次运行逐字节一致。
 *   3. **宁报错不静默** —— 标注文件非法 / 目录不存在 / 无可用样本都明确报错；
 *      未标注文件、标注但缺失、解码失败全部列进报告。
 */

const fs = require('fs');
const path = require('path');
const { collectImages } = require('../assets/indexer');
const { createDecoder } = require('../imaging/decoder');
const { extractFeatures } = require('../imaging/features');
const { computeGrid9 } = require('../imaging/grid9');
const {
  calibrateGrid9, parseLabels, renderCalibrationMarkdown, MIN_SAMPLES_FOR_PRODUCTION,
} = require('../imaging/grid9-calibrate');
const { writeJson, ensureDir } = require('../core/fs-json');
const { toPosixRel } = require('../core/determinism');
const { flagStr, flagNum } = require('./args');
const { AppError, CODES, EXIT } = require('../core/errors');

/**
 * 执行标定。
 * @param {Object} ctx CLI 上下文
 * @returns {Promise<number>} 退出码
 */
async function run(ctx) {
  const { flags, config, logger, rootDir } = ctx;
  const assetRoot = path.resolve(rootDir, flagStr(flags.assets, 'assets'));
  const outDir = path.resolve(rootDir, flagStr(flags.out, config.paths.outDir || 'out'));
  const labelsPath = path.resolve(rootDir, flagStr(flags.labels, ''));
  const minSamples = flagNum(flags['min-samples'], MIN_SAMPLES_FOR_PRODUCTION);

  // ---- 入参校验（宁报错不静默）----
  if (!flags.labels) {
    throw new AppError(CODES.USAGE,
      '需要 --labels <标注.json>。格式：{ "labels": { "xxx.png": { "expected": "CAN_9GRID|SINGLE_AXIS_ONLY|NEVER" } } }');
  }
  if (!fs.existsSync(labelsPath)) {
    throw new AppError(CODES.FILE_NOT_FOUND, `标注文件不存在: ${labelsPath}`, { labelsPath });
  }
  if (!fs.existsSync(assetRoot)) {
    throw new AppError(CODES.FILE_NOT_FOUND, `切图目录不存在: ${assetRoot}`, { assetRoot });
  }

  // ---- 标注文件 ----
  let labelsRaw;
  try {
    labelsRaw = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
  } catch (err) {
    throw new AppError(CODES.USAGE, `标注文件不是合法 JSON: ${labelsPath}`, { cause: err.message });
  }
  const labels = parseLabels(labelsRaw);
  if (!labels.length) {
    throw new AppError(CODES.USAGE, `标注文件没有任何标注: ${labelsPath}`);
  }
  const labelByBase = new Map(labels.map((l) => [l.file, l]));

  // ---- 扫描切图目录 ----
  const files = collectImages(assetRoot, { extensions: config.asset ? config.asset.extensions : undefined });
  if (!files.length) {
    throw new AppError(CODES.USAGE,
      `切图目录里没有可标定的图片: ${assetRoot}（支持 ${(config.asset ? config.asset.extensions : []).join(' ')}）`);
  }

  // ---- 逐张：解码 -> 特征 -> 现阈值判定 ----
  const decoder = createDecoder();
  /** @type {{file:string, expected:string, note:string, features:Object}[]} */
  const samples = [];
  const unlabeledFiles = [];
  const failedFiles = [];
  const missingFiles = [];
  const seenBases = new Map();

  for (const abs of files) {
    const relPath = toPosixRel(assetRoot, abs);
    const base = path.basename(relPath);
    // 同名不同目录 -> 无法用文件名标注唯一确定，明确列出（不静默取一个）
    if (seenBases.has(base)) {
      seenBases.get(base).push(relPath);
      continue;
    }
    seenBases.set(base, [relPath]);
  }

  for (const [base, relPaths] of [...seenBases.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (relPaths.length > 1) {
      failedFiles.push({ relPath: base, reason: `文件名不唯一（${relPaths.join(', ')}），无法用文件名标注，已跳过` });
      continue;
    }
    const label = labelByBase.get(base);
    if (!label) {
      unlabeledFiles.push(relPaths[0]);
      continue;
    }
    const abs = path.join(assetRoot, relPaths[0]);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch (err) {
      failedFiles.push({ relPath: relPaths[0], reason: `读取失败: ${err.message}` });
      continue;
    }
    try {
      const rgba = await decoder.decodeToRgba(buf);
      const features = extractFeatures(rgba);
      // 现阈值判定也在这里算一次（报告对账用；calibrateGrid9 内部会重算，纯函数无副作用）
      const verdict = computeGrid9(features, config.grid9 || {});
      logger.debug('标定样本', { file: base, expected: label.expected, verdict: verdict.verdict });
      samples.push({ file: base, expected: label.expected, note: label.note, features });
    } catch (err) {
      failedFiles.push({ relPath: relPaths[0], reason: `解码/特征提取失败: ${err.message}` });
    }
  }

  // 标注了但目录里找不到的文件（可能是标注文件写错了文件名）
  for (const l of labels) {
    if (!seenBases.has(l.file)) missingFiles.push(l.file);
  }

  if (!samples.length) {
    throw new AppError(CODES.USAGE,
      '没有可标定的样本（目录内图片与标注文件没有任何交集）。'
      + `未标注 ${unlabeledFiles.length} 张、缺失 ${missingFiles.length} 个、失败 ${failedFiles.length} 个。`,
      { unlabeledFiles, missingFiles, failedFiles });
  }

  // ---- 标定（纯函数）----
  const inputs = {
    assetRoot: assetRoot.replace(/\\/g, '/'),
    labelsPath: labelsPath.replace(/\\/g, '/'),
    unlabeledFiles,
    missingFiles,
    failedFiles,
    warnings: [
      ...(unlabeledFiles.length
        ? [`目录内有 ${unlabeledFiles.length} 张图片未标注，已跳过（标注覆盖率 ${samples.length}/${samples.length + unlabeledFiles.length}）`]
        : []),
      ...(missingFiles.length
        ? [`标注文件中有 ${missingFiles.length} 个文件在目录里找不到，已忽略：${missingFiles.join(', ')}`]
        : []),
      ...(failedFiles.length
        ? [`${failedFiles.length} 个文件未能处理，已跳过：${failedFiles.map((f) => f.relPath).join(', ')}`]
        : []),
    ],
  };
  const report = calibrateGrid9({
    samples,
    thresholds: config.grid9 || {},
    minSamples,
    inputs,
  });

  // ---- 产物（零时间戳 -> B9 逐字节一致）----
  ensureDir(outDir);
  const jsonPath = path.join(outDir, 'grid9-calibration.json');
  const mdPath = path.join(outDir, 'grid9-calibration.md');
  writeJson(jsonPath, report);
  fs.writeFileSync(mdPath, renderCalibrationMarkdown(report), 'utf8');

  logger.info('标定完成', {
    samples: samples.length,
    correctBefore: report.summary.current.correct,
    dangerousBefore: report.summary.current.dangerous,
    correctAfter: report.summary.suggested.correct,
    dangerousAfter: report.summary.suggested.dangerous,
    changedKeys: report.thresholds.changes.map((c) => c.key),
  });
  if (report.warnings.length) {
    for (const w of report.warnings) logger.warn('标定警告', { warning: w });
  }

  // ---- stdout：结果 JSON（日志在 stderr，不污染管道）----
  process.stdout.write(JSON.stringify({
    command: 'calibrate-grid9',
    ok: true,
    outputs: {
      json: path.relative(outDir, jsonPath).replace(/\\/g, '/'),
      markdown: path.relative(outDir, mdPath).replace(/\\/g, '/'),
    },
    sampleCount: samples.length,
    unlabeled: unlabeledFiles.length,
    missing: missingFiles.length,
    failed: failedFiles.length,
    summary: report.summary,
    suggestedChanges: report.thresholds.changes.map((c) => ({ key: c.key, from: c.from, to: c.to })),
    confidence: report.thresholds.confidence.level,
    warnings: report.warnings,
    _note: '★ 本工具未修改 fgui.config.json。建议值见报告 diff，是否采纳由人决定。',
  }, null, 2) + '\n');

  return EXIT.OK;
}

module.exports = { run };
