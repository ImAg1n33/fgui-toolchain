'use strict';
/**
 * src/cli/cmd-selftest.js —— 一键自检（黄金样本 e2e）
 *
 * usage:
 *   fgui-rb selftest [--out <产物目录>] [--keep]
 *
 * 流程（ARCHITECTURE T01 验收①）：
 *   1. 生成合成切图 + 合成两份 PSD（若不存在）
 *   2. asset-index  -> assets.db + map.json + contact_sheet.html
 *   3. psd-ir ×2     -> design_ir.{A,B}.json + ir_overlay.{A,B}.html
 *   4. diff-plan    -> change_plan.json + change_plan.md
 *
 * 全部在本机完成，**不依赖任何公司素材**，全程零网络。
 */

const fs = require('fs');
const path = require('path');
const { main } = require('./index');
const { EXIT } = require('../core/errors');

/**
 * 执行自检。
 * @param {Object} ctx
 * @returns {Promise<number>}
 */
async function run(ctx) {
  const { rootDir, logger } = ctx;
  const outDir = path.resolve(rootDir, String(ctx.flags.out || 'out/selftest'));

  logger.info('=== selftest 开始 ===', { out: outDir });
  process.stderr.write('\n');
  process.stderr.write('【离线声明】fgui-rb 全程本地处理：不联网、不上传素材、不调用任何外部模型。\n');
  process.stderr.write('\n');

  // ---- 1. fixture ----
  process.stderr.write('[1/4] 生成合成黄金样本...\n');
  // eslint-disable-next-line global-require
  const { makeAssets } = require('../../test/fixtures/make-assets');
  // eslint-disable-next-line global-require
  const { makePsds } = require('../../test/fixtures/make-psd');
  const goldenDir = path.resolve(rootDir, 'test/fixtures/golden');
  const assetsRes = await makeAssets({ outDir: path.join(goldenDir, 'assets') });
  const psdRes = makePsds({ outDir: goldenDir });
  process.stderr.write(`      切图 ${assetsRes.files.length} 张，PSD ${psdRes.files.length} 份\n\n`);

  // ---- 2. asset-index ----
  process.stderr.write('[2/4] 建索引...\n');
  const idxCode = await main([
    'asset-index',
    '--root', rootDir,
    '--assets', path.join(goldenDir, 'assets'),
    '--out', outDir,
    '--run-id', 'selftest',
  ]);
  if (idxCode !== EXIT.OK) return idxCode;

  // ---- 3. psd-ir ----
  process.stderr.write('\n[3/4] 解析两份 PSD...\n');
  const irCode = await main([
    'psd-ir',
    '--root', rootDir,
    '--psd', path.join(goldenDir, 'state_A.psd'),
    '--label', 'A',
    '--out', outDir,
  ]);
  if (irCode !== EXIT.OK) return irCode;
  const irCode2 = await main([
    'psd-ir',
    '--root', rootDir,
    '--psd', path.join(goldenDir, 'state_B.psd'),
    '--label', 'B',
    '--out', outDir,
  ]);
  if (irCode2 !== EXIT.OK) return irCode2;

  // ---- 4. diff-plan ----
  process.stderr.write('\n[4/4] 差异分析...\n');
  const planCode = await main([
    'diff-plan',
    '--root', rootDir,
    '--base', path.join(outDir, 'design_ir.A.json'),
    '--target', path.join(outDir, 'design_ir.B.json'),
    '--name', 'MailDetail',
    '--base-pkg', 'Mail',
    '--target-pkg', 'Mail',
    '--assets', path.join(goldenDir, 'assets'),
    '--out', outDir,
  ]);
  // planCode = 4 (NEEDS_HUMAN) 是**预期结果**，不算失败

  process.stderr.write('\n');
  process.stderr.write('=== selftest 完成 ===\n');
  process.stderr.write(`产物目录: ${outDir}\n`);
  for (const f of ['assets.db', 'map.json', 'contact_sheet.html',
    'design_ir.A.json', 'design_ir.B.json',
    'ir_overlay.A.html', 'ir_overlay.B.html',
    'change_plan.json', 'change_plan.md']) {
    const p = path.join(outDir, f);
    const ok = fs.existsSync(p);
    const size = ok ? fs.statSync(p).size : 0;
    process.stderr.write(`  ${ok ? '✓' : '✗'} ${f.padEnd(24)} ${ok ? `${size} bytes` : '缺失'}\n`);
  }
  process.stderr.write('\n');
  if (planCode === EXIT.NEEDS_HUMAN) {
    process.stderr.write('提示：退出码 4 = 存在未确认的 INFERRED（默认 skip），这是**预期行为**，\n');
    process.stderr.write('      需人工确认 change_plan.json 后才可进入 P1 gen-xml。\n');
  }
  process.stderr.write('\n下一步：打开 change_plan.md 与 ir_overlay.*.html 做人工核对。\n');

  return planCode === EXIT.NEEDS_HUMAN ? EXIT.OK : planCode;
}

module.exports = { run };
