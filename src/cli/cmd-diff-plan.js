'use strict';
/**
 * src/cli/cmd-diff-plan.js —— R3 差异分析 -> change_plan.json
 *
 * usage:
 *   fgui-rb diff-plan --base <design_ir.A.json> --target <design_ir.B.json>
 *                     [--name MailDetail] [--base-pkg Mail] [--target-pkg Mail]
 *                     [--out <产物目录>] [--db <assets.db>] [--assets <切图目录>]
 *
 * 产出：
 *   change_plan.json      ★ 人可读可改（PRD A10），每条 diff 带 evidence
 *   change_plan.md        人工修正清单的可读版（R4-F7 的 P0 预览）
 *   run_meta.json
 *
 * 退出码：4 (NEEDS_HUMAN) —— 存在未确认的 INFERRED **或未确认的歧义匹配**
 * （同名多候选，需在 change_plan.json 里填 resolved 放行），产物已生成但不可进下一步。
 * 这是刻意的：让脚本能自动判断「这份 plan 能不能直接喂给 gen-xml」。
 */

const fs = require('fs');
const path = require('path');
const { readJson, writeJson, writeText, ensureDir } = require('../core/fs-json');
const { buildChangePlan, renderPlanMarkdown, planNeedsHuman } = require('../diff/planner');
const { AssetStore } = require('../assets/store');
const { OP } = require('../diff/classifier');
const { flagStr } = require('./args');
const { resolveNow } = require('../core/config');
const { AppError, CODES, EXIT } = require('../core/errors');

/**
 * 执行差异分析。
 * @param {Object} ctx
 * @returns {Promise<number>}
 */
async function run(ctx) {
  const { flags, config, logger, rootDir } = ctx;
  const outDir = path.resolve(rootDir, flagStr(flags.out, config.paths.outDir || 'out'));

  const basePath = flags.base ? path.resolve(rootDir, flagStr(flags.base)) : null;
  const targetPath = flags.target ? path.resolve(rootDir, flagStr(flags.target)) : null;
  if (!basePath || !targetPath) {
    throw new AppError(CODES.USAGE,
      '需要 --base <design_ir.A.json> --target <design_ir.B.json>\n'
      + '提示：先用 `fgui-rb psd-ir --psd state_A.psd --label A --psd state_B.psd --label B` 生成 IR。');
  }

  const baseIr = readJson(basePath);
  const targetIr = readJson(targetPath);
  if (!baseIr || !baseIr.layers) {
    throw new AppError(CODES.USAGE, `基准 IR 无效或缺少 layers 字段: ${basePath}`);
  }
  if (!targetIr || !targetIr.layers) {
    throw new AppError(CODES.USAGE, `目标 IR 无效或缺少 layers 字段: ${targetPath}`);
  }

  ensureDir(outDir);

  // ---- 可选：接素材库做 L3 检索兜底与九宫格判定 ----
  const dbPath = flags.db ? path.resolve(rootDir, flagStr(flags.db)) : path.join(outDir, 'assets.db');
  const assetRoot = path.resolve(rootDir, flagStr(flags.assets, 'assets'));
  let store = null;
  let grid9ByLayerId = {};
  if (fs.existsSync(dbPath)) {
    store = AssetStore.open({ dbPath, assetRoot });
    // 用图层名/归一名去查切图的九宫格判定（RESIZE 时需要它来决定能不能切九宫格）
    const { normalizeName } = require('../core/normalize');
    for (const layer of targetIr.layers) {
      if (layer.type === 'group') continue;
      const norm = normalizeName(layer.name || '', config.normalize || {});
      const rows = store.byNormName(norm);
      if (rows.length) {
        // 取尺寸最接近的那张的九宫格判定
        const best = rows.slice().sort((a, b) => {
          const da = Math.abs(a.w - layer.bbox.w) + Math.abs(a.h - layer.bbox.h);
          const db2 = Math.abs(b.w - layer.bbox.w) + Math.abs(b.h - layer.bbox.h);
          return da - db2 || (a.id < b.id ? -1 : 1);
        })[0];
        if (best.grid9) {
          grid9ByLayerId[layer.id] = {
            verdict: best.grid9.verdict,
            confidence: best.grid9.confidence,
            evidence: best.grid9.evidence || [],
            suggestedGrid: best.grid9.suggestedGrid || null,
            source: `切图 ${best.relPath}`,
          };
        }
      }
    }
    logger.info('已接入素材库', { db: path.basename(dbPath), grid9Mapped: Object.keys(grid9ByLayerId).length });
  } else {
    logger.warn('未找到素材库，RESIZE 将一律走 gearSize（不切九宫格）', { db: dbPath });
  }

  try {
    const plan = buildChangePlan({
      baseIr,
      targetIr,
      task: {
        name: flags.name ? flagStr(flags.name, 'Unnamed') : 'Unnamed',
        basePkg: flags['base-pkg'] ? flagStr(flags['base-pkg'], 'Common') : 'Common',
        targetPkg: flags['target-pkg'] ? flagStr(flags['target-pkg'], 'Common') : 'Common',
      },
      config,
      index: store,
      grid9ByLayerId,
      rootDir,
      fguiProject: flags['fgui-project'] ? flagStr(flags['fgui-project']) : null,
    });

    const planPath = path.join(outDir, 'change_plan.json');
    writeJson(planPath, plan, { root: rootDir });
    const mdPath = path.join(outDir, 'change_plan.md');
    writeText(mdPath, renderPlanMarkdown(plan));

    writeJson(path.join(outDir, 'run_meta.json'), {
      _comment: '本次运行的元信息。★ 唯一允许包含真实时间戳的产物，B9 比较范围不含本文件。',
      command: 'diff-plan',
      inputs: { base: basePath.replace(/\\/g, '/'), target: targetPath.replace(/\\/g, '/') },
      hasAssetStore: !!store,
      grid9MappedLayers: Object.keys(grid9ByLayerId).length,
      generatedAt: resolveNow(ctx.now).iso,
      // ★ --now 注入点：传固定值可让 run_meta.json 也可复现（原为 new Date()，是空壳 flag）
    });

    // ★ UPSTREAM-FIX-7：需要人工确认的有两类 —— 未确认的 INFERRED **和**
    //   未确认的歧义匹配（同名多候选）。旧实现只看 INFERRED，歧义会静默绕过确认，
    //   而 gen-xml 会直接消费这个判定（素材可能取错却无人复核）。
    const human = planNeedsHuman(plan);
    const inferred = plan.diffs.filter((d) => d.op === OP.INFERRED);
    process.stdout.write(JSON.stringify({
      command: 'diff-plan',
      ok: true,
      outputs: {
        changePlan: path.relative(outDir, planPath).replace(/\\/g, '/'),
        markdown: path.relative(outDir, mdPath).replace(/\\/g, '/'),
      },
      summary: plan.summary,
      inferredCount: inferred.length,
      ambiguousCount: human.ambiguousCount,
      needsHuman: human.needsHuman,
      exitCodeMeaning: human.needsHuman
        ? `退出码 ${EXIT.NEEDS_HUMAN}：${human.reasons.join('；')}。`
          + '需人工确认后才可进入 P1 gen-xml'
          + (human.ambiguousCount ? '（歧义条目：在 change_plan.json 里把 resolved 设为候选 id 即可放行）' : '')
        : '无未确认 INFERRED / 歧义匹配，可进入 P1 gen-xml',
      structureAdvice: plan.structureAdvice.map((a) => ({ type: a.type, slot: a.slot, reason: a.reason })),
      openQuestions: plan.openQuestions,
    }, null, 2) + '\n');

    // ★ 退出码 4：产物已生成，但不可进下一步（§8.1）
    return human.needsHuman ? EXIT.NEEDS_HUMAN : EXIT.OK;
  } finally {
    if (store) store.close();
  }
}

module.exports = { run };
