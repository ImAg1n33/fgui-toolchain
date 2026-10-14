'use strict';
/**
 * test/bench/search-bench.js —— 检索延迟基准（PRD A3：Top-10 查询 < 200ms）
 *
 * 独立脚本，**不进 CI** —— 性能断言在 CI 上容易因机器抖动误报（ARCHITECTURE §8.4）。
 * 用法：
 *   node test/bench/search-bench.js [--assets <切图目录>] [--n 1000] [--repeat 50]
 *
 * 默认会先用合成 fixture 生成到目标规模（把同一张图复制成 N 份，
 * 以模拟「几百到几千张」的量级），再测 Top-10 查询延迟。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { AssetStore } = require('../../src/assets/store');
const { buildIndex } = require('../../src/assets/indexer');
const { searchAssets } = require('../../src/assets/search');
const { loadConfig } = require('../../src/core/config');
const { createLogger } = require('../../src/core/logger');

const ROOT = path.resolve(__dirname, '../..');
const { config } = loadConfig({ rootDir: ROOT });

/**
 * 解析 argv。
 * @param {string[]} argv
 * @returns {Object}
 */
function parse(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith('--')) { flags[k] = v; i++; } else flags[k] = true;
  }
  return flags;
}

/**
 * 造一份指定规模的切图集（复制同一批合成图 + 改尺寸以避免 id 冲突）。
 * @param {string} targetDir
 * @param {number} n 目标张数
 * @returns {{dir:string, count:number}}
 */
function makeScaledAssetSet(targetDir, n) {
  const src = path.join(ROOT, 'test/fixtures/golden/assets');
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  if (!fs.existsSync(src)) {
    throw new Error(`合成切图未生成，请先跑 npm run fixtures（缺 ${src}）`);
  }
  const files = fs.readdirSync(src).filter((f) => /\.(png|jpe?g)$/i.test(f));
  if (!files.length) throw new Error('合成切图目录为空');
  let i = 0;
  let copied = 0;
  while (copied < n) {
    const f = files[i % files.length];
    const round = Math.floor(i / files.length);
    const name = round === 0 ? f : `r${round}_${f}`;
    fs.copyFileSync(path.join(src, f), path.join(targetDir, name));
    copied++;
    i++;
  }
  return { dir: targetDir, count: copied };
}

/**
 * 主流程。
 */
async function main() {
  const flags = parse(process.argv.slice(2));
  const n = Number(flags.n || 1000);
  const repeat = Number(flags.repeat || 50);
  const logger = createLogger({ level: flags.quiet ? 'ERROR' : 'INFO', module: 'bench' });

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-bench-'));
  const assetDir = flags.assets
    ? path.resolve(ROOT, String(flags.assets))
    : makeScaledAssetSet(path.join(tmpRoot, 'assets'), n).dir;
  const dbPath = path.join(tmpRoot, 'bench.db');

  process.stdout.write(`fgui-rb 检索基准（PRD A3：Top-10 查询 < 200ms @ ${n} 张）\n`);
  process.stdout.write(`素材目录: ${assetDir}\n\n`);

  const store = AssetStore.open({ dbPath, assetRoot: assetDir });
  try {
    const t0 = Date.now();
    const built = await buildIndex({
      store, assetRoot: assetDir, config, logger, runId: 'bench',
      withFeatures: true, incremental: false,
    });
    process.stdout.write(`建索引: ${built.indexed} 张，耗时 ${Date.now() - t0}ms\n`);

    const all = store.all();
    process.stdout.write(`库内素材: ${store.count()} 张\n\n`);

    // ---- 预热 ----
    const sample = all[0];
    const query = {
      index: store,
      queryName: '不存在的名字XYZ',
      layerBox: { w: sample.w, h: sample.h },
      phash: sample.features ? sample.features.phash : null,
      topK: 10,
      config: config.search,
    };
    for (let i = 0; i < 5; i++) searchAssets(query);

    // ---- 测量 ----
    const samples = [];
    for (let i = 0; i < repeat; i++) {
      const a = process.hrtime.bigint();
      searchAssets(query);
      samples.push(Number(process.hrtime.bigint() - a) / 1e6);
    }
    samples.sort((x, y) => x - y);
    const p = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;

    process.stdout.write('查询延迟（Top-10，含 Ch-1/2/3 全跑）:\n');
    process.stdout.write(`  平均 ${avg.toFixed(3)}ms\n`);
    process.stdout.write(`  p50  ${p(0.5).toFixed(3)}ms\n`);
    process.stdout.write(`  p90  ${p(0.9).toFixed(3)}ms\n`);
    process.stdout.write(`  p99  ${p(0.99).toFixed(3)}ms\n`);
    process.stdout.write(`  max  ${samples[samples.length - 1].toFixed(3)}ms\n\n`);

    const verdict = p(0.99) < 200 ? '✅ 达标（p99 < 200ms）' : '❌ 未达标（p99 >= 200ms）';
    process.stdout.write(`A3 判定: ${verdict}\n`);

    // ---- Ch-1 快路径单独测（应远快于全跑）----
    const t1 = process.hrtime.bigint();
    for (let i = 0; i < repeat; i++) {
      searchAssets({ ...query, queryName: '图层249', layerBox: { w: 48, h: 48 } });
    }
    const ch1Ms = Number(process.hrtime.bigint() - t1) / 1e6 / repeat;
    process.stdout.write(`\nCh-1 命中短路路径平均: ${ch1Ms.toFixed(4)}ms（应显著快于全跑）\n`);

    process.exitCode = p(0.99) < 200 ? 0 : 1;
  } finally {
    store.close();
    if (!flags.assets) fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`bench 失败: ${err.stack || err}\n`);
  process.exitCode = 1;
});
