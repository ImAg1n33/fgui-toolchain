'use strict';
/**
 * src/assets/map-cache.js —— R1-F6 映射缓存（**零重算**）
 *
 * 业务诉求（PRD US-2 / A4）：「我在缩略图上点选确认，映射关系会被缓存下来，
 * 这样我不用在资源管理器里一张张点开看」「第二次运行 100% 直接命中，零重算、零重问」。
 *
 * 失效检测（双重）：
 *   1. slot 对应的切图**内容指纹**变了（contentSha256 前 16 位）-> 缓存失效，需重新确认
 *   2. slot 对应的切图**从目录里消失了** -> 缓存失效
 *
 * ★ 确定性（B9）★：`confirmedAt` 是时间戳，**只允许出现在 slot-map.json 里**，
 *   且仅当调用方显式注入时。默认留空字符串，保证同一输入两次运行逐字节一致。
 *   （run_meta.json 是唯一允许记录真实时间的地方，见 §8.5 规则 8）
 */

const path = require('path');
const { fingerprint } = require('../core/hash');
const { sortBy } = require('../core/determinism');
const { readJson, writeJson } = require('../core/fs-json');
const { AppError, CODES } = require('../core/errors');

/** 缓存文件版本。 */
const MAP_VERSION = '1.0';

/**
 * 映射缓存。
 */
class MapCache {
  /**
   * @param {Object} opts
   * @param {string} opts.mapPath slot-map.json 路径
   * @param {import('./store').AssetStore} opts.store 素材库（用于查指纹与存在性）
   * @param {string} [opts.assetRoot] 用于把 relPath 转绝对路径校验存在性
   * @param {Logger} [opts.logger]
   */
  constructor(opts) {
    this.mapPath = opts.mapPath;
    this.store = opts.store;
    this.assetRoot = opts.assetRoot || '';
    this.logger = opts.logger || null;
    /** @type {Map<string, Object>} slot -> entry */
    this.entries = new Map();
    this.load();
  }

  /**
   * 从磁盘加载。
   * @returns {{loaded:number, stale:number}}
   */
  load() {
    const raw = readJson(this.mapPath);
    this.entries = new Map();
    if (!raw || !Array.isArray(raw.slots)) return { loaded: 0, stale: 0 };
    let stale = 0;
    for (const e of raw.slots) {
      if (!e || !e.slot || !e.assetId) continue;
      const entry = {
        slot: String(e.slot),
        assetId: String(e.assetId),
        relPath: String(e.relPath || ''),
        fingerprint: String(e.fingerprint || ''),
        confirmedBy: String(e.confirmedBy || ''),
        // confirmedAt 可能是时间戳，**不进确定性产物**；只在人读 map 里保留
        confirmedAt: String(e.confirmedAt || ''),
      };
      this.entries.set(entry.slot, entry);
      if (!this.isFresh(entry)) stale++;
    }
    return { loaded: this.entries.size, stale };
  }

  /**
   * 缓存是否仍然有效（指纹一致 + 文件仍在）。
   * @param {Object} entry
   * @returns {boolean}
   */
  isFresh(entry) {
    if (!entry) return false;
    const asset = this.store.byId(entry.assetId);
    if (!asset) return false;
    if (asset.contentSha256.slice(0, 16) !== entry.fingerprint) return false;
    return true;
  }

  /**
   * 查缓存。
   *
   * ★ 命中即零重算：不触发任何特征提取，只做一次主键查询。★
   *
   * @param {string} slot 语义槽位，如 popup_bg
   * @returns {{hit:boolean, entry:Object|null, asset:Object|null, reason:string}}
   */
  lookup(slot) {
    const entry = this.entries.get(slot);
    if (!entry) {
      return { hit: false, entry: null, asset: null, reason: 'no_cached_entry' };
    }
    const asset = this.store.byId(entry.assetId);
    if (!asset) {
      return {
        hit: false, entry, asset: null,
        reason: 'asset_missing:缓存指向的切图已不在素材库中',
      };
    }
    const currentFp = fingerprint(asset.contentSha256);
    if (currentFp !== entry.fingerprint) {
      return {
        hit: false, entry, asset,
        reason: `fingerprint_changed:缓存指纹 ${entry.fingerprint} != 当前 ${currentFp}（切图内容已变）`,
      };
    }
    return {
      hit: true,
      entry,
      asset,
      reason: `cache_hit:槽位 '${slot}' 已人工确认为 ${asset.relPath}，指纹 ${currentFp} 一致，零重算`,
    };
  }

  /**
   * 记录一次人工确认。
   *
   * @param {Object} args
   * @param {string} args.slot
   * @param {Object} args.asset AssetRow
   * @param {string} [args.confirmedBy='manual']
   * @param {string} [args.confirmedAt=''] 注入的时间戳；默认空串以保确定性
   * @returns {Object} entry
   */
  confirm(args) {
    const asset = args.asset;
    if (!asset) {
      throw new AppError(CODES.USAGE, 'confirm 需要 asset', { slot: args.slot });
    }
    const entry = {
      slot: args.slot,
      assetId: asset.id,
      relPath: asset.relPath,
      fingerprint: fingerprint(asset.contentSha256),
      confirmedBy: args.confirmedBy || 'manual',
      confirmedAt: args.confirmedAt || '',
    };
    this.entries.set(entry.slot, entry);
    // 同步进 DB，便于单查
    this.store.putSlot(entry);
    return entry;
  }

  /**
   * 移除一条缓存。
   * @param {string} slot
   * @returns {boolean}
   */
  remove(slot) {
    return this.entries.delete(slot);
  }

  /**
   * 条目数。
   * @returns {number}
   */
  size() {
    return this.entries.size;
  }

  /**
   * 全部条目（确定性排序）。
   * @returns {Object[]}
   */
  list() {
    return sortBy([...this.entries.values()], (e) => e.slot);
  }

  /**
   * 落盘（确定性 JSON）。
   * @returns {{path:string, bytes:number, count:number}}
   */
  save() {
    const payload = {
      version: MAP_VERSION,
      _comment: '人工确认的「语义槽位 -> 切图」映射（fgui-rb asset-search --confirm 产出）。'
        + '二次运行时命中此文件即**零重算**（PRD A4）。'
        + 'fingerprint 是切图内容指纹，切图内容变化会导致该条失效并要求重新确认。'
        + '可手工编辑 —— 直接改 assetId/relPath 即可改映射，改完重跑 diff-plan 生效。',
      _fieldNote: {
        slot: '语义槽位名，必须业务语义化（禁止 n0/img1 这类无语义名，PRD §8.3）',
        assetId: '切图 id（sha1(relPath) 前 16 位）',
        fingerprint: 'contentSha256 前 16 位，用于失效检测',
        confirmedBy: '确认人',
        confirmedAt: '确认时间（可留空；留空可保证同一输入两次运行逐字节一致）',
      },
      count: this.entries.size,
      slots: this.list(),
    };
    return writeJson(this.mapPath, payload);
  }

  /**
   * 把缓存条目同步进 DB 的 slot_map 表。
   */
  syncToStore() {
    this.store.clearSlots();
    for (const e of this.list()) this.store.putSlot(e);
  }
}

module.exports = { MapCache, MAP_VERSION };
