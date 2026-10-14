'use strict';
/**
 * src/cli/cmd-psd-ir.js —— R2-F4 解析 PSD -> design_ir.json + ir_overlay.html
 *
 * usage:
 *   fgui-rb psd-ir --psd <文件.psd> [--label A] [--out <产物目录>]
 *                 [--mode full|structure] [--no-overlay]
 *   fgui-rb psd-ir --psd a.psd --psd b.psd   # R2-F7：多份一次解析
 *
 * 产出：
 *   design_ir.<label>.json   ★ 每字段带 _comment（PRD A10）
 *   ir_overlay.<label>.html  bbox 叠加效果图（R2-F6）
 *   run_meta.json            唯一允许含时间戳的产物
 */

const fs = require('fs');
const path = require('path');
const { readPsdFile, extractSlices, MODE } = require('../psd/reader');
const { IrBuilder } = require('../psd/ir-builder');
const { renderIrOverlay } = require('../report/ir-overlay');
const { writeJson, ensureDir } = require('../core/fs-json');
const { flagStr } = require('./args');
const { resolveNow } = require('../core/config');
const { AppError, CODES } = require('../core/errors');

/**
 * 解析一份（或多份）PSD。
 * @param {Object} ctx
 * @returns {Promise<number>}
 */
async function run(ctx) {
  const { flags, config, logger, rootDir } = ctx;
  const outDir = path.resolve(rootDir, flagStr(flags.out, config.paths.outDir || 'out'));
  const mode = flagStr(flags.mode, MODE.FULL);

  // 支持 --psd a.psd --psd b.psd（重复传）与位置参数
  const psdArgs = [];
  if (Array.isArray(flags.psd)) psdArgs.push(...flags.psd);
  else if (flags.psd) psdArgs.push(flagStr(flags.psd));
  psdArgs.push(...ctx.positional);
  if (!psdArgs.length) {
    throw new AppError(CODES.USAGE, '需要 --psd <文件.psd>（可重复传以支持 R2-F7 多份解析）');
  }

  ensureDir(outDir);
  const wantOverlay = ctx.bool(flags.overlay, true);

  /** @type {Object[]} */
  const results = [];

  for (let i = 0; i < psdArgs.length; i++) {
    const abs = path.resolve(rootDir, psdArgs[i]);
    if (!fs.existsSync(abs)) {
      throw new AppError(CODES.FILE_NOT_FOUND, `PSD 不存在: ${abs}`, { psd: abs });
    }
    // label：单份时用 --label（或文件名）；多份时用 --label 数组，或序号字母 A/B/C…
    const labels = flags.label
      ? (Array.isArray(flags.label) ? flags.label : [flags.label])
      : [];
    const label = psdArgs.length === 1
      ? (labels[0] || defaultLabel(abs))
      : (labels[i] || letterLabel(i));

    logger.info('解析 PSD', { file: path.basename(abs), mode, label });

    const parsed = readPsdFile(abs, { mode });
    const slices = extractSlices(parsed.psd);

    const ir = new IrBuilder({
      normalizeOpts: config.normalize,
      dpr: config.psd && config.psd.dpr ? config.psd.dpr : 1,
      withPhash: mode === MODE.FULL,
    }).build({
      psd: parsed.psd,
      psdPath: abs,
      sha256: parsed.sha256,
      slices,
    });

    const irPath = path.join(outDir, `design_ir.${label}.json`);
    writeJson(irPath, ir, { root: rootDir });

    // ---- overlay ----
    let overlayInfo = null;
    if (wantOverlay && mode === MODE.FULL) {
      const ov = await renderIrOverlay({ ir, psd: parsed.psd, title: `IR 校验图 · ${label} · ${path.basename(abs)}` });
      const ovPath = path.join(outDir, `ir_overlay.${label}.html`);
      fs.writeFileSync(ovPath, ov.html, 'utf8');
      overlayInfo = { path: ovPath, bytes: ov.bytes, hasBaseImage: ov.hasBaseImage };
    }

    results.push({
      label,
      psd: abs,
      psdSha256: parsed.sha256,
      irPath,
      ir,
      overlayInfo,
      stats: {
        layerCount: ir.layers.length,
        groupCount: ir.layers.filter((l) => l.type === 'group').length,
        textCount: ir.layers.filter((l) => l.type === 'text').length,
        mergedCount: ir.layers.filter((l) => l.merged).length,
        derivedBboxCount: ir.layers.filter((l) => l.bboxSource === 'derived').length,
        sliceCount: ir.sliceNames.length,
        warningCount: ir.warnings.length,
      },
    });
  }

  // ---- run_meta.json ----
  writeJson(path.join(outDir, 'run_meta.json'), {
    _comment: '本次运行的元信息。★ 唯一允许包含真实时间戳的产物，B9 比较范围不含本文件。',
    command: 'psd-ir',
    mode,
    inputs: results.map((r) => ({
      label: r.label,
      psd: r.psd.replace(/\\/g, '/'),
      sha256: r.psdSha256,
    })),
    generatedAt: resolveNow(ctx.now).iso,
    // ★ --now 注入点：传固定值可让 run_meta.json 也可复现（原为 new Date()，是空壳 flag）
  });

  process.stdout.write(JSON.stringify({
    command: 'psd-ir',
    ok: true,
    mode,
    outputs: results.map((r) => ({
      label: r.label,
      ir: path.relative(outDir, r.irPath).replace(/\\/g, '/'),
      overlay: r.overlayInfo
        ? path.relative(outDir, r.overlayInfo.path).replace(/\\/g, '/')
        : null,
    })),
    results: results.map((r) => ({
      label: r.label,
      canvas: r.ir.source.canvas,
      ...r.stats,
      mergedLayers: r.ir.layers.filter((l) => l.merged).map((l) => ({ id: l.id, name: l.name })),
      warnings: r.ir.warnings.map((w) => ({ code: w.code, layer: w.layer, msg: w.msg })),
      sliceNames: r.ir.sliceNames,
    })),
  }, null, 2) + '\n');

  return 0;
}

/**
 * 从文件名推断 label（去掉扩展名）。
 * @param {string} p
 * @returns {string}
 */
function defaultLabel(p) {
  return path.basename(p).replace(/\.[^.]+$/, '');
}

/**
 * 序号 -> 字母（A/B/C…）。
 * @param {number} i
 * @returns {string}
 */
function letterLabel(i) {
  return String.fromCharCode(65 + (i % 26));
}

module.exports = { run };
