'use strict';
/**
 * src/assets/indexer.js —— 递归扫描 + 增量 + 特征抽取编排
 *
 * 增量策略（R1-F8，双重校验）：
 *   1. 相对路径未变 -> 继续比 content_sha256
 *   2. sha256 相同 -> 跳过特征重算（**零重算**，A4 的基础）
 *   3. sha256 不同 -> 重新抽特征并 upsert
 *
 * 确定性要求（B9）：
 *   · 扫描顺序按 POSIX 相对路径字典序（不依赖 readdir 的返回序）
 *   · 产物 map.json / contact_sheet.html 内零时间戳
 *   · `runId` 由调用方注入（测试传固定值），不内部生成
 */

const fs = require('fs');
const path = require('path');
const { createDecoder } = require('../imaging/decoder');
const { extractFeatures } = require('../imaging/features');
const { computeGrid9 } = require('../imaging/grid9');
const { suggestName } = require('./suggest-name');
const { normalizeName, baseNameOf } = require('../core/normalize');
const { assetId, sha256, fingerprint } = require('../core/hash');
const { toPosixRel, round6 } = require('../core/determinism');
const { AppError, CODES } = require('../core/errors');

/**
 * 递归收集目录下所有受支持的图片文件（确定性排序）。
 * @param {string} root
 * @param {Object} [opts]
 * @param {string[]} [opts.extensions] 扩展名白名单
 * @returns {string[]} 绝对路径，字典序
 */
function collectImages(root, opts = {}) {
  const exts = (opts.extensions || ['.png', '.jpg', '.jpeg', '.webp']).map((e) => e.toLowerCase());
  /** @type {string[]} */
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // 排序保证确定性（readdir 顺序在某些文件系统上不稳定）
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(full);
      } else if (e.isFile() && exts.includes(path.extname(e.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  walk(root);
  // 全局字典序（相对路径序 = 绝对路径序，同一 root 下等价）
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/**
 * 建索引主流程。
 *
 * @param {Object} args
 * @param {import('./store').AssetStore} args.store
 * @param {string} args.assetRoot 素材根目录
 * @param {Object} [args.config] fgui.config.json
 * @param {Object} [args.logger]
 * @param {string} [args.runId='run'] 注入的 run 标识（不进产物内容，只进 first/last_seen_run 列）
 * @param {boolean} [args.withFeatures=true] false 时只建索引不算特征（--no-features）
 * @param {boolean} [args.incremental=true]
 * @returns {Promise<{scanned:number, indexed:number, skipped:number, failed:number,
 *                    assets:Object[], errors:Object[]}>}
 */
async function buildIndex(args) {
  const { store, assetRoot } = args;
  const cfg = args.config || {};
  const logger = args.logger;
  const runId = args.runId || 'run';
  const withFeatures = args.withFeatures !== false;
  const incremental = args.incremental !== false;
  const decoder = createDecoder();
  const grid9Thresholds = cfg.grid9 || {};

  if (!assetRoot || !fs.existsSync(assetRoot)) {
    throw new AppError(CODES.FILE_NOT_FOUND, `素材目录不存在: ${assetRoot}`, { assetRoot });
  }

  const files = collectImages(assetRoot, { extensions: cfg.asset ? cfg.asset.extensions : undefined });
  const stats = { scanned: files.length, indexed: 0, skipped: 0, failed: 0 };
  const errors = [];
  /** @type {Object[]} */
  const assets = [];

  for (const abs of files) {
    const relPath = toPosixRel(assetRoot, abs);
    const baseName = baseNameOf(relPath);
    let buf;
    let stat;
    try {
      buf = fs.readFileSync(abs);
      stat = fs.statSync(abs);
    } catch (err) {
      stats.failed++;
      errors.push({ relPath, reason: `读取失败: ${err.message}` });
      continue;
    }

    const contentHash = sha256(buf);
    const id = assetId(relPath);
    const existing = store.byRelPath(relPath);

    // ---- 增量：内容未变则跳过特征重算 ----
    if (incremental && existing && existing.contentSha256 === contentHash) {
      stats.skipped++;
      assets.push(existing);
      continue;
    }

    // ---- 尺寸（只读 header，快）----
    let size;
    try {
      size = decoder.readSize(buf);
    } catch (err) {
      stats.failed++;
      errors.push({ relPath, reason: `读尺寸失败: ${err.message}` });
      continue;
    }

    // ---- 特征（可选）----
    let features = null;
    let grid9 = null;
    if (withFeatures) {
      try {
        const rgba = await decoder.decodeToRgba(buf);
        features = extractFeatures(rgba);
        grid9 = computeGrid9(features, grid9Thresholds);
        grid9.suggestedGrid = grid9.suggestedGrid || null;
      } catch (err) {
        stats.failed++;
        errors.push({ relPath, reason: `特征提取失败: ${err.message}` });
        continue;
      }
    }

    const row = {
      id,
      relPath,
      baseName,
      normName: normalizeName(baseName, cfg.normalize || {}),
      // ★ BUG-D 修复：format 写路径也归一为小写 ★
      //   只归一读路径不够 —— 文件扩展名大小写（.PNG）会让 fresh 路径的
      //   格式值本身带大写，与读路径的 toLowerCase 仍可能不一致；
      //   两路径都归一到小写后，fresh 与 cached 的 map.json 才逐字节一致。
      format: String(size.format || path.extname(abs).slice(1)).toLowerCase(),
      w: size.width,
      h: size.height,
      fileSize: buf.length,
      mtimeMs: Math.floor(stat.mtimeMs),
      contentSha256: contentHash,
      features,
      grid9,
      suggestedName: features ? suggestName({ relPath, features, grid9 }) : '',
      firstSeenRun: existing ? existing.firstSeenRun || runId : runId,
      lastSeenRun: runId,
    };

    store.upsert(row);
    stats.indexed++;
    assets.push(row);
  }

  store.setMeta('last_run', runId);
  store.setMeta('asset_root', assetRoot);
  store.setMeta('decoder', decoder.name);

  if (logger) {
    logger.info('asset-index 完成', {
      scanned: stats.scanned, indexed: stats.indexed,
      skipped: stats.skipped, failed: stats.failed, decoder: decoder.name,
    });
  }
  if (errors.length && logger) {
    for (const e of errors.slice(0, 20)) logger.warn('asset-index 跳过', e);
  }

  return { ...stats, assets, errors, decoder: decoder.name };
}

/**
 * 导出 map.json（人可读的素材清单，含每个字段的 _comment 说明 —— PRD A10）。
 *
 * ★ 注意：map.json 里**不含时间戳**（B9 逐字节一致的前提）。
 *   人工确认记录（confirmedBy/confirmedAt）走 slot_map 表与单独的 map 缓存文件。
 *
 * @param {Object[]} assets buildIndex 返回的 assets
 * @param {Object} args
 * @param {number} args.decoderVersion 1
 * @returns {Object}
 */
function buildMapJson(assets, args = {}) {
  const rows = assets.map((a) => ({
    id: a.id,
    relPath: a.relPath,
    baseName: a.baseName,
    normName: a.normName,
    format: a.format,
    size: { w: a.w, h: a.h },
    contentSha256: a.contentSha256,
    fingerprint: fingerprint(a.contentSha256),
    grid9: a.grid9
      ? {
        verdict: a.grid9.verdict,
        confidence: round6(a.grid9.confidence),
        suggestedGrid: a.grid9.suggestedGrid || null,
        evidence: a.grid9.evidence || [],
      }
      : null,
    suggestedName: a.suggestedName || '',
  }));
  rows.sort((x, y) => (x.relPath < y.relPath ? -1 : x.relPath > y.relPath ? 1 : 0));
  return {
    version: '1.0',
    _comment: '切图素材清单（fgui-rb asset-index 产出）。'
      + 'normName 是检索主键（去副本后缀/全半角/大小写/空格/繁简后的名字）；'
      + '检索时**只做全等匹配**，不做前缀或子串包含（PRD K5：矩形1 与 矩形11 是不同主键）。'
      + 'grid9.verdict 为九宫格适用性判定，NEVER 表示禁切、需人工手切。'
      + '本文件可手工编辑，人工确认结果请写入 slot-map.json（不覆盖本文件）。',
    _fieldNote: {
      id: 'sha1(relPath) 前 16 位，稳定可复现',
      relPath: '相对素材根目录的 POSIX 路径',
      normName: '归一化名，检索主键',
      size: '像素尺寸 {w,h}',
      fingerprint: 'contentSha256 前 16 位，用于映射缓存失效检测',
      grid9: '九宫格判定：verdict=CAN_9GRID|SINGLE_AXIS_ONLY|NEVER',
      suggestedName: '建议名（只建议不重命名，PRD R1-F7）',
    },
    decoder: args.decoder || 'unknown',
    count: rows.length,
    assets: rows,
  };
}

module.exports = { buildIndex, collectImages, buildMapJson };
