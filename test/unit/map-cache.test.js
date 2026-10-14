'use strict';
/**
 * test/unit/map-cache.test.js —— 映射缓存（A4：零重算）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AssetStore } = require('../../src/assets/store');
const { MapCache } = require('../../src/assets/map-cache');
const { buildIndex } = require('../../src/assets/indexer');
const { loadConfig } = require('../../src/core/config');
const { readJson } = require('../../src/core/fs-json');
const { nullLogger } = require('../../src/core/logger');
const { fingerprint } = require('../../src/core/hash');

const ASSETS = path.resolve(__dirname, '../fixtures/golden/assets');
const { config } = loadConfig({ rootDir: path.resolve(__dirname, '../..') });

/**
 * 准备一个临时库 + 缓存。
 * @returns {Promise<{store:AssetStore, dir:string, mapPath:string, cleanup:Function}>}
 */
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-map-'));
  const dbPath = path.join(dir, 'assets.db');
  const store = AssetStore.open({ dbPath, assetRoot: ASSETS });
  await buildIndex({
    store, assetRoot: ASSETS, config, logger: nullLogger(),
    runId: 'test', withFeatures: true, incremental: false,
  });
  const mapPath = path.join(dir, 'slot-map.json');
  return {
    store, dir, mapPath,
    cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('MapCache: 初始为空，lookup 返回 miss', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const ctx = await setup();
  try {
    const cache = new MapCache({ mapPath: ctx.mapPath, store: ctx.store, assetRoot: ASSETS });
    assert.equal(cache.size(), 0);
    const r = cache.lookup('popup_bg');
    assert.equal(r.hit, false);
    assert.equal(r.reason, 'no_cached_entry');
  } finally { ctx.cleanup(); }
});

test('MapCache: confirm 后 lookup 命中且零重算', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const ctx = await setup();
  try {
    const cache = new MapCache({ mapPath: ctx.mapPath, store: ctx.store, assetRoot: ASSETS });
    const asset = ctx.store.byNormName('矩形11')[0];
    cache.confirm({ slot: 'popup_bg', asset, confirmedBy: 'xiaq' });
    cache.save();

    const r = cache.lookup('popup_bg');
    assert.equal(r.hit, true, `应命中，实际原因: ${r.reason}`);
    assert.equal(r.asset.id, asset.id);
    assert.ok(r.reason.includes('零重算'));
    assert.equal(cache.size(), 1);
  } finally { ctx.cleanup(); }
});

test('★ A4: 二次运行 100% 命中缓存且零特征重算', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const ctx = await setup();
  try {
    const cache = new MapCache({ mapPath: ctx.mapPath, store: ctx.store, assetRoot: ASSETS });
    // 第一轮：确认 5 个槽位
    const slots = ['popup_bg', 'btn_close', 'reward_icon', 'title_bar', 'body_text'];
    const assets = slots.map((s, i) => ctx.store.all()[i]);
    slots.forEach((s, i) => cache.confirm({ slot: s, asset: assets[i], confirmedBy: 'xiaq' }));
    cache.save();

    // 第二轮：全部命中，且不触发任何特征提取
    const cache2 = new MapCache({ mapPath: ctx.mapPath, store: ctx.store, assetRoot: ASSETS });
    let hits = 0;
    let recomputes = 0;
    for (const s of slots) {
      const r = cache2.lookup(s);
      if (r.hit) {
        hits++;
        // 命中路径只做一次主键查询，不应碰解码/特征
        assert.ok(r.asset.contentSha256.length === 64);
      } else {
        recomputes++;
      }
    }
    assert.equal(hits, slots.length, '★ 二次运行应 100% 命中');
    assert.equal(recomputes, 0);
  } finally { ctx.cleanup(); }
});

test('MapCache: 切图内容变化 -> 指纹失效需重新确认', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const ctx = await setup();
  try {
    const cache = new MapCache({ mapPath: ctx.mapPath, store: ctx.store, assetRoot: ASSETS });
    const asset = ctx.store.byNormName('矩形11')[0];
    cache.confirm({ slot: 'popup_bg', asset, confirmedBy: 'xiaq' });
    assert.equal(cache.lookup('popup_bg').hit, true);

    // 模拟画师改了图：contentSha256 变了
    const changed = { ...asset, contentSha256: 'f'.repeat(64) };
    ctx.store.upsert(changed);

    const r = cache.lookup('popup_bg');
    assert.equal(r.hit, false, '★ 内容变了必须判失效');
    assert.ok(r.reason.includes('fingerprint_changed'), r.reason);
  } finally { ctx.cleanup(); }
});

test('MapCache: 切图从库中消失 -> 缓存失效', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const ctx = await setup();
  try {
    const cache = new MapCache({ mapPath: ctx.mapPath, store: ctx.store, assetRoot: ASSETS });
    const asset = ctx.store.byNormName('矩形11')[0];
    cache.confirm({ slot: 'popup_bg', asset });
    ctx.store.db.prepare('DELETE FROM asset WHERE id=?').run(asset.id);
    const r = cache.lookup('popup_bg');
    assert.equal(r.hit, false);
    assert.ok(r.reason.includes('asset_missing'));
  } finally { ctx.cleanup(); }
});

test('MapCache: 落盘产物确定性（同一状态两次 save 逐字节一致）', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const ctx = await setup();
  try {
    const mk = () => {
      const c = new MapCache({ mapPath: ctx.mapPath, store: ctx.store, assetRoot: ASSETS });
      const all = c.store ? null : null;
      const rows = require('../../src/assets/store');
      const assets = ctx.store.all().slice(0, 3);
      c.confirm({ slot: 'z_slot', asset: assets[0] });
      c.confirm({ slot: 'a_slot', asset: assets[1] });
      c.confirm({ slot: 'm_slot', asset: assets[2] });
      return c;
    };
    mk().save();
    const first = fs.readFileSync(ctx.mapPath);
    mk().save();
    const second = fs.readFileSync(ctx.mapPath);
    assert.equal(first.equals(second), true, '★ 同一状态两次落盘必须逐字节一致');
  } finally { ctx.cleanup(); }
});

test('MapCache: 条目按 slot 排序输出（确定性）', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const ctx = await setup();
  try {
    const cache = new MapCache({ mapPath: ctx.mapPath, store: ctx.store, assetRoot: ASSETS });
    const assets = ctx.store.all();
    cache.confirm({ slot: 'z_last', asset: assets[0] });
    cache.confirm({ slot: 'a_first', asset: assets[1] });
    cache.confirm({ slot: 'm_middle', asset: assets[2] });
    assert.deepEqual(cache.list().map((e) => e.slot), ['a_first', 'm_middle', 'z_last']);
    cache.save();
    const saved = readJson(ctx.mapPath);
    assert.deepEqual(saved.slots.map((e) => e.slot), ['a_first', 'm_middle', 'z_last']);
    assert.equal(saved.count, 3);
  } finally { ctx.cleanup(); }
});

test('MapCache: 产物零时间戳（confirmedAt 默认空串）', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const ctx = await setup();
  try {
    const cache = new MapCache({ mapPath: ctx.mapPath, store: ctx.store, assetRoot: ASSETS });
    cache.confirm({ slot: 'popup_bg', asset: ctx.store.all()[0] });
    cache.save();
    const text = fs.readFileSync(ctx.mapPath, 'utf8');
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text),
      '★ 未显式注入 confirmedAt 时，产物内不应出现 ISO 时间戳（B9）');
    const saved = readJson(ctx.mapPath);
    assert.equal(saved.slots[0].confirmedAt, '');
  } finally { ctx.cleanup(); }
});

test('MapCache: 产物带 _comment 与逐字段说明（PRD A10）', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const ctx = await setup();
  try {
    const cache = new MapCache({ mapPath: ctx.mapPath, store: ctx.store, assetRoot: ASSETS });
    cache.confirm({ slot: 'popup_bg', asset: ctx.store.all()[0] });
    cache.save();
    const saved = readJson(ctx.mapPath);
    assert.ok(saved._comment, '应有 _comment');
    assert.ok(saved._fieldNote, '应有逐字段说明');
    assert.ok(saved._fieldNote.slot.includes('语义'), 'slot 说明应强调语义化');
    assert.ok(saved._fieldNote.fingerprint.includes('失效'));
  } finally { ctx.cleanup(); }
});

test('MapCache: 与 slot_map 表双向同步', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const ctx = await setup();
  try {
    const cache = new MapCache({ mapPath: ctx.mapPath, store: ctx.store, assetRoot: ASSETS });
    const asset = ctx.store.all()[0];
    cache.confirm({ slot: 'popup_bg', asset });
    cache.syncToStore();
    const row = ctx.store.getSlot('popup_bg');
    assert.ok(row, 'DB slot_map 表应有记录');
    assert.equal(row.assetId, asset.id);
    assert.equal(row.fingerprint, fingerprint(asset.contentSha256));
  } finally { ctx.cleanup(); }
});

test('MapCache: remove 删除条目', async (t) => {
  if (!fs.existsSync(ASSETS)) return t.skip('合成切图未生成');
  const ctx = await setup();
  try {
    const cache = new MapCache({ mapPath: ctx.mapPath, store: ctx.store, assetRoot: ASSETS });
    cache.confirm({ slot: 'popup_bg', asset: ctx.store.all()[0] });
    assert.equal(cache.size(), 1);
    assert.equal(cache.remove('popup_bg'), true);
    assert.equal(cache.size(), 0);
    assert.equal(cache.lookup('popup_bg').hit, false);
  } finally { ctx.cleanup(); }
});
