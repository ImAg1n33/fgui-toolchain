'use strict';
/**
 * src/cli/cmd-asset-search.js —— R1-F5 检索 + 人工确认写 map.json
 *
 * usage:
 *   fgui-rb asset-search --assets <切图目录> --query <图层名> [--w <宽> --h <高>]
 *                       [--slot <语义槽位>] [--confirm <assetId|relPath>]
 *                       [--top-k 10] [--out <产物目录>]
 *
 * 行为：
 *   · 无 --confirm：只检索，输出 Top-K 候选 + 置信度 + 确定性标注
 *   · 有 --confirm：把该候选写入 slot-map.json（人工确认缓存，R1-F6）
 *
 * ★ 确定性标注（PRD 检索三通道硬要求）★
 *   每条结果都带 certainty：exact_name（同名确定）/ ambiguous（同名但歧义）/ guess（猜的）
 *   只有 exact_name 不需要人工确认，另两种都进确认队列。
 */

const fs = require('fs');
const path = require('path');
const { AssetStore } = require('../assets/store');
const { searchAssets, CERTAINTY, channel1Coverage } = require('../assets/search');
const { MapCache } = require('../assets/map-cache');
const { flagStr } = require('./args');
const { AppError, CODES, EXIT } = require('../core/errors');

/**
 * 执行检索 / 确认。
 * @param {Object} ctx
 * @returns {Promise<number>}
 */
async function run(ctx) {
  const { flags, config, logger, rootDir } = ctx;
  const outDir = path.resolve(rootDir, flagStr(flags.out, config.paths.outDir || 'out'));
  const dbPath = flags.db ? path.resolve(rootDir, flagStr(flags.db)) : path.join(outDir, 'assets.db');
  const assetRoot = path.resolve(rootDir, flagStr(flags.assets, 'assets'));

  if (!fs.existsSync(dbPath)) {
    throw new AppError(CODES.FILE_NOT_FOUND,
      `素材库不存在: ${dbPath}\n请先运行 \`fgui-rb asset-index --root <切图目录>\`。`,
      { dbPath });
  }

  const store = AssetStore.open({ dbPath, assetRoot });
  const mapPath = path.join(outDir, 'slot-map.json');
  const cache = new MapCache({ mapPath, store, assetRoot, logger });

  try {
    // ================= 确认模式 =================
    if (flags.confirm) {
      const slot = flagStr(flags.slot, '');
      if (!slot) {
        throw new AppError(CODES.USAGE, '--confirm 需要同时提供 --slot <语义槽位>');
      }
      const key = flagStr(flags.confirm, '');
      const asset = store.byId(key) || store.byRelPath(key);
      if (!asset) {
        throw new AppError(CODES.USAGE,
          `找不到素材: ${key}（可用 --confirm <assetId> 或 --confirm <relPath>）`);
      }
      const entry = cache.confirm({
        slot,
        asset,
        confirmedBy: flags.by ? flagStr(flags.by, 'manual') : 'manual',
        confirmedAt: flags['confirmed-at'] ? flagStr(flags['confirmed-at'], '') : '',
      });
      cache.save();
      cache.syncToStore();
      process.stdout.write(JSON.stringify({
        command: 'asset-search',
        action: 'confirm',
        ok: true,
        entry,
        mapPath: path.relative(outDir, mapPath).replace(/\\/g, '/'),
      }, null, 2) + '\n');
      return EXIT.OK;
    }

    // ================= 检索模式 =================
    const query = flagStr(flags.query, '');
    if (!query) {
      throw new AppError(CODES.USAGE, '需要 --query <图层名>');
    }
    const w = flags.w === undefined ? null : ctx.num(flags.w, 0);
    const h = flags.h === undefined ? null : ctx.num(flags.h, 0);
    const layerBox = w && h ? { w, h } : null;

    // 优先查人工确认缓存（A4：命中即零重算）
    const slot = flags.slot ? flagStr(flags.slot) : null;
    let cacheHit = null;
    if (slot) {
      const r = cache.lookup(slot);
      if (r.hit) cacheHit = r;
    }

    if (cacheHit) {
      process.stdout.write(JSON.stringify({
        command: 'asset-search',
        ok: true,
        query,
        slot,
        certainty: 'confirmed_by_human',
        needsConfirm: false,
        zeroRecompute: true,
        asset: {
          id: cacheHit.asset.id,
          relPath: cacheHit.asset.relPath,
          size: { w: cacheHit.asset.w, h: cacheHit.asset.h },
          grid9: cacheHit.asset.grid9,
        },
        evidence: cacheHit.reason,
      }, null, 2) + '\n');
      return EXIT.OK;
    }

    const res = searchAssets({
      index: store,
      queryName: query,
      layerBox,
      phash: flags.phash ? flagStr(flags.phash) : null,
      topK: ctx.num(flags['top-k'], config.search.topK || 10),
      config: config.search,
      normalizeOpts: config.normalize,
      // E-02：倍率推断开关（asset.scaleInfer，默认关闭 -> 行为与改造前一致）
      scaleInfer: config.asset ? config.asset.scaleInfer : null,
    });

    const coverage = channel1Coverage([res]);

    process.stdout.write(JSON.stringify({
      command: 'asset-search',
      ok: true,
      query,
      layerBox,
      slot,
      certainty: res.certainty,
      needsConfirm: res.needsConfirm,
      certaintyNote: res.certainty === CERTAINTY.EXACT_NAME
        ? '同名确定：Ch-1 精确同名 + 尺寸校验通过，无需人工确认'
        : res.certainty === CERTAINTY.AMBIGUOUS
          ? '同名但歧义：多张切图同时通过尺寸校验，已全部返回，**必须人工确认**'
          : '推测结果：Ch-1 未命中，靠尺寸/pHash 猜的，**必须人工确认**',
      evidence: res.evidence,
      channels: res.channels,
      channel1Coverage: coverage,
      hits: res.hits.map((h) => ({
        assetId: h.asset.id,
        relPath: h.asset.relPath,
        normName: h.asset.normName,
        size: { w: h.asset.w, h: h.asset.h },
        score: h.score,
        confidence: h.confidence,
        level: h.level,
        certainty: h.certainty,
        needsConfirm: h.needsConfirm,
        channels: { ch1: h.ch1, ch2: h.ch2, ch3: h.ch3 },
        grid9: h.asset.grid9,
        // E-02：仅倍率推断开启时带 scale 字段（默认关闭时本键不出现，输出与改造前一致）
        ...(h.scale === undefined ? {} : { scale: h.scale }),
        evidence: h.evidence,
        confirmHint: slot
          ? `确认此条：fgui-rb asset-search --slot ${slot} --confirm ${h.asset.id}`
          : `确认此条请加 --slot <语义槽位> --confirm ${h.asset.id}`,
      })),
    }, null, 2) + '\n');

    return EXIT.OK;
  } finally {
    store.close();
  }
}

module.exports = { run };
