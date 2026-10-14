'use strict';
/**
 * src/cli/cmd-asset-index.js —— R1-F1 建索引
 *
 * usage:
 *   fgui-rb asset-index --assets <切图目录> [--out <产物目录>] [--no-features]
 *                      [--no-incremental] [--no-contact-sheet] [--db <路径>]
 *
 * 产出：
 *   assets.db             SQLite 特征库
 *   map.json              人可读素材清单（每字段带 _comment）
 *   contact_sheet.html    单文件缩略图总览（全部内嵌，可离线打开）
 *   run_meta.json         ★ 唯一允许出现真实时间戳的产物
 *
 * 日志走 stderr，结果 JSON 走 stdout（ARCHITECTURE §8.2）。
 */

const fs = require('fs');
const path = require('path');
const { AssetStore } = require('../assets/store');
const { buildIndex, buildMapJson } = require('../assets/indexer');
const { renderContactSheet } = require('../assets/contact-sheet');
const { createDecoder } = require('../imaging/decoder');
const { writeJson, ensureDir } = require('../core/fs-json');
const { flagStr } = require('./args');
const { resolveNow } = require('../core/config');
const { AppError, CODES } = require('../core/errors');

/**
 * 执行建索引。
 * @param {Object} ctx CLI 上下文
 * @returns {Promise<number>} 退出码
 */
async function run(ctx) {
  const { flags, config, logger, rootDir } = ctx;
  const assetRoot = path.resolve(rootDir, flagStr(flags.assets, 'assets'));
  const outDir = path.resolve(rootDir, flagStr(flags.out, config.paths.outDir || 'out'));
  const dbPath = flags.db ? path.resolve(rootDir, flagStr(flags.db)) : path.join(outDir, 'assets.db');
  const withFeatures = ctx.bool(flags.features, true);
  const incremental = ctx.bool(flags.incremental, true);
  const wantSheet = ctx.bool(flags['contact-sheet'], true);

  if (!fs.existsSync(assetRoot)) {
    throw new AppError(CODES.FILE_NOT_FOUND,
      `切图目录不存在: ${assetRoot}\n`
      + '提示：先用 `npm run fixtures` 生成合成切图（test/fixtures/golden/assets），'
      + '或用 --root 指向真实的切图目录。',
      { assetRoot });
  }

  ensureDir(outDir);
  const store = AssetStore.open({ dbPath, assetRoot });

  try {
    const result = await buildIndex({
      store,
      assetRoot,
      config,
      logger,
      runId: flags['run-id'] ? flagStr(flags['run-id'], 'manual') : 'manual',
      withFeatures,
      incremental,
    });

    // ---- map.json ----
    const mapJson = buildMapJson(result.assets, { decoder: result.decoder });
    const mapPath = path.join(outDir, 'map.json');
    writeJson(mapPath, mapJson);

    // ---- contact_sheet.html ----
    let sheetInfo = null;
    if (wantSheet) {
      const decoder = createDecoder();
      const sheet = await renderContactSheet({
        assets: result.assets,
        config,
        thumbOf: async (asset) => {
          const abs = path.join(assetRoot, asset.relPath);
          if (!fs.existsSync(abs)) return '';
          return decoder.makeThumbDataUri(fs.readFileSync(abs),
            (config.asset && config.asset.thumbSize) || 96);
        },
      });
      const sheetPath = path.join(outDir, 'contact_sheet.html');
      fs.writeFileSync(sheetPath, sheet.html, 'utf8');
      sheetInfo = { path: sheetPath, inlined: sheet.inlined, omitted: sheet.omitted, bytes: sheet.bytes };
      logger.info('contact_sheet 已生成', {
        inlined: sheet.inlined, omitted: sheet.omitted, bytes: sheet.bytes,
      });
    }

    // ---- run_meta.json：★ 唯一允许记录真实时间戳的产物（§8.5 规则 8）----
    const runMeta = {
      _comment: '本次运行的元信息。★ 这是**唯一**允许包含真实时间戳的产物 —— '
        + 'B9 的逐字节一致性比较范围不含本文件。',
      command: 'asset-index',
      assetRoot: assetRoot.replace(/\\/g, '/'),
      dbPath: path.basename(dbPath),
      decoder: result.decoder,
      withFeatures,
      incremental,
      scanned: result.scanned,
      indexed: result.indexed,
      skipped: result.skipped,
      failed: result.failed,
      errors: result.errors.slice(0, 50),
      generatedAt: resolveNow(ctx.now).iso,
      // ★ --now 注入点：传固定值可让 run_meta.json 也可复现（原为 new Date()，是空壳 flag）
    };
    writeJson(path.join(outDir, 'run_meta.json'), runMeta);

    // ---- stdout：结果 JSON ----
    const stdoutPayload = {
      command: 'asset-index',
      ok: true,
      assetRoot: assetRoot.replace(/\\/g, '/'),
      outputs: {
        db: path.relative(outDir, dbPath).replace(/\\/g, '/'),
        map: path.relative(outDir, mapPath).replace(/\\/g, '/'),
        contactSheet: sheetInfo ? path.relative(outDir, sheetInfo.path).replace(/\\/g, '/') : null,
        runMeta: 'run_meta.json',
      },
      scanned: result.scanned,
      indexed: result.indexed,
      skipped: result.skipped,
      failed: result.failed,
      byVerdict: (() => {
        const acc = {};
        for (const a of result.assets) {
          const v = a.grid9 && a.grid9.verdict;
          if (v) acc[v] = (acc[v] || 0) + 1;
        }
        return acc;
      })(),
      failedSamples: result.errors.slice(0, 5),
    };
    process.stdout.write(JSON.stringify(stdoutPayload, null, 2) + '\n');

    return result.failed > 0 ? CODES.OK : CODES.OK; // 单张失败不阻断整体
  } finally {
    store.close();
  }
}

module.exports = { run };
