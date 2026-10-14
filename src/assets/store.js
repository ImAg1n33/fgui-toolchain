'use strict';
/**
 * src/assets/store.js —— AssetStore（node:sqlite DDL + 查询）
 *
 * 用 Node 内置的 `node:sqlite`（DatabaseSync），**不用 better-sqlite3** ——
 * 后者需原生编译，在公司机器上是纯粹的失败面（ARCHITECTURE D6）。
 *
 * ★ K5 防御的 API 级体现 ★
 *   `byNormName()` 的返回类型是**数组**，不是单值。这是刻意的 API 设计：
 *   强制每一个调用方都必须处理「归一化后同名多图」的歧义。
 *   如果返回单值，调用方迟早会写成 `const hit = store.byNormName(x)` 然后直接用，
 *   歧义就被静默吞掉了 —— 那正是 PRD K5 事故的成因。
 */

const { DatabaseSync } = require('node:sqlite');
const { AppError, CODES } = require('../core/errors');

/** 表结构版本。变更时递增并写迁移。 */
const SCHEMA_VERSION = 1;

/**
 * DDL。字段与 ARCHITECTURE §3.5 一致。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS asset (
  id              TEXT PRIMARY KEY,
  rel_path        TEXT NOT NULL UNIQUE,
  base_name       TEXT NOT NULL,
  norm_name       TEXT NOT NULL,
  format          TEXT NOT NULL,
  w               INTEGER,
  h               INTEGER,
  file_size       INTEGER,
  mtime_ms        INTEGER,
  content_sha256  TEXT NOT NULL,
  alpha_ratio     REAL,
  alpha_x         INTEGER,
  alpha_y         INTEGER,
  alpha_w         INTEGER,
  alpha_h         INTEGER,
  phash           TEXT,
  dominant_r      INTEGER,
  dominant_g      INTEGER,
  dominant_b      INTEGER,
  edge_density    REAL,
  corner_solidity REAL,
  corner_fill     REAL,
  mid_row_variance REAL,
  mid_col_variance REAL,
  radial_symmetry REAL,
  aspect_ratio    REAL,
  grid9_verdict   TEXT,
  grid9_confidence REAL,
  grid9_evidence  TEXT,
  grid9_suggested_grid TEXT,
  suggested_name  TEXT,
  first_seen_run  TEXT,
  last_seen_run   TEXT
);
CREATE INDEX IF NOT EXISTS idx_norm  ON asset(norm_name);
CREATE INDEX IF NOT EXISTS idx_size  ON asset(w, h);
CREATE INDEX IF NOT EXISTS idx_phash ON asset(phash);
CREATE INDEX IF NOT EXISTS idx_run   ON asset(last_seen_run);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS slot_map (
  slot          TEXT PRIMARY KEY,
  asset_id      TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  confirmed_by  TEXT,
  confirmed_at  TEXT
);
`;

/** asset 表的列顺序（INSERT / SELECT * 依赖它，必须与 DDL 一致）。 */
const ASSET_COLUMNS = Object.freeze([
  'id', 'rel_path', 'base_name', 'norm_name', 'format', 'w', 'h', 'file_size', 'mtime_ms',
  'content_sha256', 'alpha_ratio', 'alpha_x', 'alpha_y', 'alpha_w', 'alpha_h', 'phash',
  'dominant_r', 'dominant_g', 'dominant_b', 'edge_density', 'corner_solidity', 'corner_fill',
  'mid_row_variance', 'mid_col_variance', 'radial_symmetry', 'aspect_ratio',
  'grid9_verdict', 'grid9_confidence', 'grid9_evidence', 'grid9_suggested_grid', 'suggested_name',
  'first_seen_run', 'last_seen_run',
]);

/**
 * 逐条执行 DDL（容错版本）。
 *
 * ★ 为什么逐条 + 容错 ★（BUG-D 修复配套）
 *   整段 `db.exec(DDL)` 在遇到**旧 schema 缺列**时会整体失败
 *   （如 `CREATE INDEX idx_phash ON asset(phash)` 遇到没有 phash 列的旧表）。
 *   assets.db 是可再生缓存，但「同目录二次运行打不开库」是差体验；
 *   逐条执行后，索引建不了只损失查询性能（正确性不受影响），
 *   列缺失由 migrateAssetColumns 幂等补上。
 *
 * @param {Object} db DatabaseSync
 * @param {string} ddl
 */
function execDdlTolerant(db, ddl) {
  for (const stmt of ddl.split(';').map((s) => s.trim()).filter(Boolean)) {
    try {
      db.exec(stmt);
    } catch (err) {
      // 旧 schema 缺列导致索引建不了 —— 降级为无索引，不阻断打开
      if (!/no such column/i.test(err.message)) throw err;
    }
  }
}

/**
 * 旧库迁移：为 P0 时期创建的 assets.db 补上后加的列。
 *
 * ★ 为什么需要 ★（BUG-D 修复的配套）
 *   `CREATE TABLE IF NOT EXISTS` 对**已存在**的旧表不会加列 —— 若用户机器上
 *   有 P0 时期生成的 assets.db，直接 INSERT 新列会报 "table asset has no column
 *   named grid9_suggested_grid"。assets.db 是**可再生缓存**（删掉重建即可），
 *   但「同目录二次运行直接报错」本身就是差劲的体验，故做幂等增列。
 *
 * @param {Object} db DatabaseSync
 */
function migrateAssetColumns(db) {
  const cols = db.prepare('PRAGMA table_info(asset)').all();
  if (!cols.length) return; // 表还未建（全新库），DDL 已含全部列
  const have = new Set(cols.map((c) => c.name));
  const ADDITIONS = [
    ['grid9_suggested_grid', 'TEXT'],
  ];
  for (const [name, type] of ADDITIONS) {
    if (!have.has(name)) {
      db.exec(`ALTER TABLE asset ADD COLUMN ${name} ${type}`);
    }
  }
}

/**
 * 把 DB 行转成 AssetRow 对象。
 * @param {Object} row
 * @returns {Object}
 */
function rowToAsset(row) {
  if (!row) return null;
  const hasBox = row.alpha_w !== null && row.alpha_w !== undefined;
  return {
    id: row.id,
    relPath: row.rel_path,
    baseName: row.base_name,
    normName: row.norm_name,
    // ★ BUG-D 修复：format 大小写两路径归一（都转小写）★
    //   写路径（indexer）也归一；否则 fresh='png' vs cached='PNG'，
    //   同目录二次运行后 map.json 静默变化（QA 第三轮 BUG-D）。
    format: String(row.format || '').toLowerCase(),
    w: row.w === null ? 0 : row.w,
    h: row.h === null ? 0 : row.h,
    fileSize: row.file_size === null ? 0 : row.file_size,
    mtimeMs: row.mtime_ms === null ? 0 : row.mtime_ms,
    contentSha256: row.content_sha256,
    features: hasBox || row.phash ? {
      alphaRatio: row.alpha_ratio,
      alphaBox: hasBox
        ? { x: row.alpha_x, y: row.alpha_y, w: row.alpha_w, h: row.alpha_h }
        : null,
      phash: row.phash,
      dominantR: row.dominant_r,
      dominantG: row.dominant_g,
      dominantB: row.dominant_b,
      edgeDensity: row.edge_density,
      cornerSolidity: row.corner_solidity,
      cornerFill: row.corner_fill,
      midRowVariance: row.mid_row_variance,
      midColVariance: row.mid_col_variance,
      radialSymmetry: row.radial_symmetry,
      aspectRatio: row.aspect_ratio,
    } : null,
    grid9: row.grid9_verdict ? {
      verdict: row.grid9_verdict,
      confidence: row.grid9_confidence,
      evidence: row.grid9_evidence ? JSON.parse(row.grid9_evidence) : [],
      // ★ BUG-D 修复：suggestedGrid 落库，缓存命中不再静默丢建议值 ★
      //   （原实现硬编码 null：DB 无此列，增量路径上九宫格建议值全丢）
      suggestedGrid: row.grid9_suggested_grid || null,
    } : null,
    suggestedName: row.suggested_name || '',
  };
}

/**
 * 素材库。
 */
class AssetStore {
  /**
   * @param {Object} opts
   * @param {string} opts.dbPath SQLite 文件路径（':memory:' 亦可，测试用）
   * @param {string} [opts.assetRoot] 素材根目录（rel_path 相对它）
   */
  constructor(opts) {
    this.dbPath = opts.dbPath;
    this.assetRoot = opts.assetRoot || '';
    try {
      this.db = new DatabaseSync(opts.dbPath);
    } catch (err) {
      throw new AppError(CODES.INTERNAL, `打开素材库失败: ${opts.dbPath}`, { cause: err.message });
    }
    // WAL 提升并发读性能；确定性不受影响（B9 只比产物文件内容）
    this.db.exec('PRAGMA journal_mode = WAL;');
    // 逐条容错执行（旧 schema 缺列时索引建不了也不阻断打开，见 execDdlTolerant）
    execDdlTolerant(this.db, DDL);
    // ★ BUG-D 配套：旧库幂等增列（P0 时期生成的 assets.db 没有新列）★
    migrateAssetColumns(this.db);
    this.setMeta('schema_version', String(SCHEMA_VERSION));
  }

  /**
   * 打开素材库（静态工厂，与 types.js 的 AssetIndex.open 对齐）。
   * @param {Object} opts
   * @returns {AssetStore}
   */
  static open(opts) {
    return new AssetStore(opts);
  }

  /**
   * 写 meta。
   * @param {string} k
   * @param {string} v
   */
  setMeta(k, v) {
    this.db.prepare('INSERT INTO meta(k,v) VALUES(?,?) '
      + 'ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
  }

  /**
   * 读 meta。
   * @param {string} k
   * @param {string|null} [fallback=null]
   * @returns {string|null}
   */
  getMeta(k, fallback = null) {
    const row = this.db.prepare('SELECT v FROM meta WHERE k=?').get(k);
    return row ? row.v : fallback;
  }

  /**
   * 插入或更新一条素材。
   * @param {Object} row AssetRow
   */
  upsert(row) {
    const f = row.features || {};
    const box = f.alphaBox || {};
    const g = row.grid9 || {};
    const values = [
      row.id, row.relPath, row.baseName, row.normName, row.format,
      row.w, row.h, row.fileSize, row.mtimeMs, row.contentSha256,
      f.alphaRatio === undefined ? null : f.alphaRatio,
      box.x === undefined ? null : box.x,
      box.y === undefined ? null : box.y,
      box.w === undefined ? null : box.w,
      box.h === undefined ? null : box.h,
      f.phash === undefined ? null : f.phash,
      f.dominantR === undefined ? null : f.dominantR,
      f.dominantG === undefined ? null : f.dominantG,
      f.dominantB === undefined ? null : f.dominantB,
      f.edgeDensity === undefined ? null : f.edgeDensity,
      f.cornerSolidity === undefined ? null : f.cornerSolidity,
      f.cornerFill === undefined ? null : f.cornerFill,
      f.midRowVariance === undefined ? null : f.midRowVariance,
      f.midColVariance === undefined ? null : f.midColVariance,
      f.radialSymmetry === undefined ? null : f.radialSymmetry,
      f.aspectRatio === undefined ? null : f.aspectRatio,
      g.verdict || null,
      g.confidence === undefined ? null : g.confidence,
      g.evidence ? JSON.stringify(g.evidence) : null,
      g.suggestedGrid === undefined ? null : g.suggestedGrid,
      row.suggestedName || null,
      row.firstSeenRun || null,
      row.lastSeenRun || null,
    ];
    const cols = ASSET_COLUMNS.join(', ');
    const placeholders = ASSET_COLUMNS.map(() => '?').join(', ');
    this.db.prepare(
      `INSERT INTO asset(${cols}) VALUES(${placeholders}) `
      + 'ON CONFLICT(id) DO UPDATE SET '
      + 'rel_path=excluded.rel_path, base_name=excluded.base_name, norm_name=excluded.norm_name, '
      + 'format=excluded.format, w=excluded.w, h=excluded.h, file_size=excluded.file_size, '
      + 'mtime_ms=excluded.mtime_ms, content_sha256=excluded.content_sha256, '
      + 'alpha_ratio=excluded.alpha_ratio, alpha_x=excluded.alpha_x, alpha_y=excluded.alpha_y, '
      + 'alpha_w=excluded.alpha_w, alpha_h=excluded.alpha_h, phash=excluded.phash, '
      + 'dominant_r=excluded.dominant_r, dominant_g=excluded.dominant_g, dominant_b=excluded.dominant_b, '
      + 'edge_density=excluded.edge_density, corner_solidity=excluded.corner_solidity, '
      + 'corner_fill=excluded.corner_fill, mid_row_variance=excluded.mid_row_variance, '
      + 'mid_col_variance=excluded.mid_col_variance, radial_symmetry=excluded.radial_symmetry, '
      + 'aspect_ratio=excluded.aspect_ratio, grid9_verdict=excluded.grid9_verdict, '
      + 'grid9_confidence=excluded.grid9_confidence, grid9_evidence=excluded.grid9_evidence, '
      + 'grid9_suggested_grid=excluded.grid9_suggested_grid, '
      + 'suggested_name=excluded.suggested_name, last_seen_run=excluded.last_seen_run',
    ).run(...values);
  }

  /**
   * ★ 归一化名 -> 候选行数组 ★
   *
   * **返回类型是数组，这是刻意的**（K5 防御）。同名多图时返回全部，
   * 由调用方（channel1-name）做 ±2px 尺寸校验二次判别；
   * 仍歧义则全部返回并标 AMBIGUOUS 进确认队列，**绝不静默取第一个**。
   *
   * @param {string} normName
   * @returns {Object[]} AssetRow[]，按 (w,h,id) 稳定排序
   */
  byNormName(normName) {
    if (!normName) return [];
    const rows = this.db.prepare('SELECT * FROM asset WHERE norm_name=?').all(normName);
    return rows
      .map(rowToAsset)
      .sort((a, b) => (a.w - b.w) || (a.h - b.h)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * 按相对路径取行。
   * @param {string} relPath
   * @returns {Object|null}
   */
  byRelPath(relPath) {
    const row = this.db.prepare('SELECT * FROM asset WHERE rel_path=?').get(relPath);
    return rowToAsset(row);
  }

  /**
   * 按 id 取行。
   * @param {string} id
   * @returns {Object|null}
   */
  byId(id) {
    const row = this.db.prepare('SELECT * FROM asset WHERE id=?').get(id);
    return rowToAsset(row);
  }

  /**
   * 取出全部带特征的素材（Ch-2/Ch-3 兜底扫描用）。
   * @param {Object} [opts]
   * @param {boolean} [opts.withFeatures=true]
   * @returns {Object[]}
   */
  all(opts = {}) {
    const withFeatures = opts.withFeatures !== false;
    const sql = withFeatures
      ? 'SELECT * FROM asset WHERE phash IS NOT NULL ORDER BY id'
      : 'SELECT * FROM asset ORDER BY id';
    return this.db.prepare(sql).all().map(rowToAsset);
  }

  /**
   * 按尺寸容差取候选（Ch-2 的硬过滤）。
   * @param {{w:number,h:number}} size
   * @param {number} tol
   * @returns {Object[]}
   */
  bySize(size, tol) {
    if (!size) return [];
    const rows = this.db.prepare(
      'SELECT * FROM asset WHERE w BETWEEN ? AND ? AND h BETWEEN ? AND ? ORDER BY id',
    ).all(size.w - tol, size.w + tol, size.h - tol, size.h + tol);
    return rows.map(rowToAsset);
  }

  /**
   * 素材总数。
   * @returns {number}
   */
  count() {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM asset').get();
    return row ? row.n : 0;
  }

  /**
   * 写入映射缓存（R1-F6）。同时镜像到 slot_map 表，便于单查。
   * @param {Object} entry MapEntry
   */
  putSlot(entry) {
    this.db.prepare(
      'INSERT INTO slot_map(slot,asset_id,fingerprint,confirmed_by,confirmed_at) VALUES(?,?,?,?,?) '
      + 'ON CONFLICT(slot) DO UPDATE SET asset_id=excluded.asset_id, '
      + 'fingerprint=excluded.fingerprint, confirmed_by=excluded.confirmed_by, '
      + 'confirmed_at=excluded.confirmed_at',
    ).run(entry.slot, entry.assetId, entry.fingerprint, entry.confirmedBy || null, entry.confirmedAt || null);
  }

  /**
   * 读映射缓存。
   * @param {string} slot
   * @returns {Object|null} {slot, assetId, fingerprint, confirmedBy, confirmedAt}
   */
  getSlot(slot) {
    const row = this.db.prepare(
      'SELECT slot,asset_id,fingerprint,confirmed_by,confirmed_at FROM slot_map WHERE slot=?',
    ).get(slot);
    if (!row) return null;
    return {
      slot: row.slot,
      assetId: row.asset_id,
      fingerprint: row.fingerprint,
      confirmedBy: row.confirmed_by,
      confirmedAt: row.confirmed_at,
    };
  }

  /**
   * 清空 slot_map（map.json 覆盖时同步）。
   */
  clearSlots() {
    this.db.exec('DELETE FROM slot_map;');
  }

  /** 关闭连接。 */
  close() {
    try {
      this.db.close();
    } catch {
      // 已关闭或从未打开 —— 不是错误
    }
  }
}

module.exports = { AssetStore, SCHEMA_VERSION, ASSET_COLUMNS, rowToAsset };
