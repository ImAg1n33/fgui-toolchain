'use strict';
/**
 * test/unit/asset-index-incremental.test.js —— BUG-D 回归：增量路径的 B9
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 回应什么 ★（QA 第三轮 BUG-D，P0 继承问题）
 *   同一输入、同一输出目录，**第二次运行**（命中 map-cache 增量路径）后
 *   map.json 静默变化：
 *     · `assets[].format`：`"png"` → `"PNG"`（store.js 读路径 toUpperCase，
 *       写路径是小写 —— 两路径不一致）；
 *     · `assets[].grid9.suggestedGrid`：`"18,0,84,36"` → `null`
 *       （store.js 硬编码 null，DB 无此列 —— 缓存命中即静默丢建议值）。
 *   为什么 QA 两轮 + 工程师自测都没发现：B9 证据只跑**全新目录**；
 *   增量场景（A4 零重算）只断言「命中缓存、零重算」，没断言「产物内容不变」。
 *
 * ★ 本文件补的正是这一角 ★：增量路径的 B9 —— 同目录重跑，产物必须不变。
 *   同时覆盖 store 层的 suggestedGrid 往返、format 归一、旧库迁移。
 * ════════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AssetStore } = require('../../src/assets/store');
const { buildIndex, buildMapJson } = require('../../src/assets/indexer');
const { loadConfig } = require('../../src/core/config');
const { nullLogger } = require('../../src/core/logger');
const { stringifyJson } = require('../../src/core/fs-json');
const { runCli } = require('../e2e/run-cli');
const { makeAssets } = require('../fixtures/make-assets');

const ROOT = path.resolve(__dirname, '../..');
const ASSETS = path.join(ROOT, 'test/fixtures/golden/assets');
const { config } = loadConfig({ rootDir: ROOT });

/** 确保合成切图存在（缺就现造，与 e2e 同款策略）。 */
function ensureAssets() {
  if (!fs.existsSync(path.join(ASSETS, 'panel_1.png'))) {
    makeAssets({ outDir: ASSETS });
  }
}

/**
 * 在同一 store 上连跑两次 buildIndex（第二次走增量缓存路径）。
 * @param {AssetStore} store
 * @returns {Promise<{first:string, second:string, firstAssets:Object[], secondAssets:Object[]}>}
 */
async function runTwice(store) {
  const r1 = await buildIndex({
    store, assetRoot: ASSETS, config, logger: nullLogger(),
    runId: 'r1', withFeatures: true, incremental: true,
  });
  const r2 = await buildIndex({
    store, assetRoot: ASSETS, config, logger: nullLogger(),
    runId: 'r2', withFeatures: true, incremental: true,
  });
  return {
    first: stringifyJson(buildMapJson(r1.assets, { decoder: r1.decoder })),
    second: stringifyJson(buildMapJson(r2.assets, { decoder: r2.decoder })),
    firstAssets: r1.assets,
    secondAssets: r2.assets,
    skipped: r2.skipped,
  };
}

test('★ BUG-D: 同目录二次运行（增量缓存）map.json 与首次逐字节一致', async (t) => {
  ensureAssets();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-inc-'));
  const store = AssetStore.open({ dbPath: path.join(dir, 'assets.db'), assetRoot: ASSETS });
  try {
    const { first, second, skipped } = await runTwice(store);
    assert.ok(skipped > 0, `第二次运行应命中增量缓存（skipped>0），实际 ${skipped}`);
    assert.equal(first, second,
      '★ 增量路径 B9：二次运行的 map.json 必须与首次逐字节一致'
      + '（BUG-D：format 大小写 / suggestedGrid 丢失会在这里现形）');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ BUG-D: 九宫格建议值在增量路径上不丢失（suggestedGrid 非 null）', async (t) => {
  ensureAssets();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-inc-'));
  const store = AssetStore.open({ dbPath: path.join(dir, 'assets.db'), assetRoot: ASSETS });
  try {
    const { firstAssets, secondAssets } = await runTwice(store);

    // 找一个第一次运行就带建议值的素材（胶囊 → SINGLE_AXIS_ONLY → r,0,w-2r,h）
    const withGrid = (list) => list.filter((a) => a.grid9 && a.grid9.suggestedGrid);
    const firstGrid = withGrid(firstAssets);
    const secondGrid = withGrid(secondAssets);
    assert.ok(firstGrid.length > 0, 'fixture 应含带建议值的素材（胶囊类），否则本测试空转');
    assert.equal(secondGrid.length, firstGrid.length,
      '★ 二次运行后带建议值的素材数量必须一致（BUG-D：缓存命中即全丢）');

    // 逐素材对账建议值字符串
    const byPath = (list) => new Map(list.map((a) => [a.relPath, a.grid9.suggestedGrid]));
    const m1 = byPath(firstGrid);
    const m2 = byPath(secondGrid);
    for (const [rel, grid] of m1) {
      assert.equal(m2.get(rel), grid, `${rel} 的 suggestedGrid 在二次运行后变了`);
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ BUG-D: format 大小写两路径归一（二次运行后仍全小写）', async (t) => {
  ensureAssets();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-inc-'));
  const store = AssetStore.open({ dbPath: path.join(dir, 'assets.db'), assetRoot: ASSETS });
  try {
    const { secondAssets } = await runTwice(store);
    for (const a of secondAssets) {
      assert.equal(a.format, a.format.toLowerCase(),
        `${a.relPath} 的 format 应全小写（两路径归一），实际 ${a.format}`);
      assert.ok(a.format.length > 0, 'format 不应为空');
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-D store 层: suggestedGrid 与 format 的 upsert→读回往返', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-store-'));
  const store = AssetStore.open({ dbPath: path.join(dir, 'a.db'), assetRoot: ASSETS });
  try {
    store.upsert({
      id: 'x1', relPath: 'a.png', baseName: 'a', normName: 'a',
      format: 'png', w: 10, h: 10, fileSize: 100, mtimeMs: 1,
      contentSha256: 'f'.repeat(64),
      features: { phash: '0'.repeat(16), alphaRatio: 1 },
      grid9: {
        verdict: 'SINGLE_AXIS_ONLY', confidence: 0.8,
        evidence: ['e1'], suggestedGrid: '18,0,84,36',
      },
      suggestedName: '', firstSeenRun: 'r1', lastSeenRun: 'r1',
    });
    const back = store.byRelPath('a.png');
    assert.equal(back.grid9.suggestedGrid, '18,0,84,36',
      '★ suggestedGrid 必须落库（BUG-D：原实现硬编码 null）');
    assert.equal(back.grid9.verdict, 'SINGLE_AXIS_ONLY');
    assert.deepEqual(back.grid9.evidence, ['e1']);

    // format 大小写归一：写 'PNG' 读回 'png'
    store.upsert({ ...back, format: 'PNG' });
    assert.equal(store.byRelPath('a.png').format, 'png', 'format 读回应归一为小写');

    // 无 suggestedGrid 的素材（NEVER）读回应是 null 而非字符串 "null"
    store.upsert({
      ...back, id: 'x2', relPath: 'b.png',
      grid9: { verdict: 'NEVER', confidence: 0.9, evidence: [], suggestedGrid: null },
    });
    assert.equal(store.byRelPath('b.png').grid9.suggestedGrid, null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-D 迁移: P0 时期旧 schema 的 assets.db 能被幂等增列', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-mig-'));
  const dbPath = path.join(dir, 'old.db');
  // 造一个「P0 旧 schema」库：完整复刻 P0 的列，唯独不含本轮新增的
  // grid9_suggested_grid（这正是用户机器上会出现的形态）。
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE asset (
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
      suggested_name  TEXT,
      first_seen_run  TEXT,
      last_seen_run   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_norm  ON asset(norm_name);
    CREATE INDEX IF NOT EXISTS idx_size  ON asset(w, h);
    CREATE INDEX IF NOT EXISTS idx_phash ON asset(phash);
    CREATE INDEX IF NOT EXISTS idx_run   ON asset(last_seen_run);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS slot_map (
      slot TEXT PRIMARY KEY, asset_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      confirmed_by TEXT, confirmed_at TEXT
    );`);
  old.close();

  // 新代码打开旧库：迁移必须补列且不抛错
  const store = AssetStore.open({ dbPath, assetRoot: ASSETS });
  try {
    const cols = store.db.prepare('PRAGMA table_info(asset)').all().map((c) => c.name);
    assert.ok(cols.includes('grid9_suggested_grid'), '迁移应补上 grid9_suggested_grid 列');
    // 补列后 upsert 全列必须能跑通（否则旧库用户二次运行直接报错）
    store.upsert({
      id: 'm1', relPath: 'm.png', baseName: 'm', normName: 'm', format: 'png',
      w: 8, h: 8, fileSize: 10, mtimeMs: 1, contentSha256: 'a'.repeat(64),
      features: null,
      grid9: { verdict: 'CAN_9GRID', confidence: 0.75, evidence: [], suggestedGrid: null },
      suggestedName: '', firstSeenRun: 'r', lastSeenRun: 'r',
    });
    assert.equal(store.byRelPath('m.png').grid9.verdict, 'CAN_9GRID');
    // 幂等：再开一次不重复加列、不抛错
    const store2 = AssetStore.open({ dbPath, assetRoot: ASSETS });
    store2.close();
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ BUG-D CLI 级: asset-index 同目录跑两次，map.json 逐字节一致', async (t) => {
  ensureAssets();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-cli-inc-'));
  try {
    const args = [
      'asset-index', '--root', ROOT, '--assets', ASSETS, '--out', out, '--run-id', 'fixed',
    ];
    const r1 = runCli(args);
    assert.equal(r1.code, 0, `首次运行应成功: ${r1.stderr.slice(0, 300)}`);
    const map1 = fs.readFileSync(path.join(out, 'map.json'));

    const r2 = runCli(args);
    assert.equal(r2.code, 0, `二次运行应成功: ${r2.stderr.slice(0, 300)}`);
    const map2 = fs.readFileSync(path.join(out, 'map.json'));

    assert.ok(map1.equals(map2),
      '★ CLI 级增量 B9：同目录二次运行 map.json 必须逐字节一致（BUG-D 的端到端形态）');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
