'use strict';
/**
 * src/cli/cmd-create-plan.js —— v0.3-B CREATE 模式：Design IR → create_plan
 *
 * usage:
 *   fgui-rb create-plan --ir <design_ir.json> --index <project_index.json> --out <dir>
 *                       [--canvas 750x1334] [--page-name X] [--pkg X]
 *
 * ★ 这是 CREATE 模式，不是 PATCH ★
 *   只吃 **Design IR + 工程索引**；**不接受也不需要** change_plan.json / gen_plan.json /
 *   任何已存在的目标组件 XML —— 朋友的痛点是「从零拼新界面」，那时目标组件根本不存在。
 *
 * 产物（确定性，无时间戳）：
 *   create_plan.json  编辑脚本（节点/资源复用/待导入/未决/deferred）
 *   create_plan.md    人可读报告（含「待人工确认」清单）
 *
 * 日志走 stderr、产物数据走 stdout（与全仓约定一致）。
 */

const fs = require('fs');
const path = require('path');
const { readJson, writeJson, ensureDir } = require('../core/fs-json');
const { flagStr } = require('./args');
const { AppError, CODES } = require('../core/errors');
const { buildCreatePlan, parseCanvas } = require('../create/plan-builder');
const { renderPlanMarkdown } = require('../create/plan-markdown');

/**
 * @param {Object} ctx CLI 上下文
 * @returns {Promise<number>} 退出码
 */
async function run(ctx) {
  const { flags, config, logger, rootDir } = ctx;

  const irFlag = flagStr(flags.ir);
  if (!irFlag) {
    throw new AppError(CODES.USAGE,
      'create-plan 需要 --ir <design_ir.json>（CREATE 模式只吃 IR，不需要 change_plan/gen_plan）');
  }
  const indexFlag = flagStr(flags.index);
  if (!indexFlag) {
    throw new AppError(CODES.USAGE,
      'create-plan 需要 --index <project_index.json>（资源复用需要工程索引；可先跑 project-index）');
  }

  const irPath = path.resolve(rootDir, irFlag);
  const indexPath = path.resolve(rootDir, indexFlag);
  for (const [p, what] of [[irPath, 'design_ir.json'], [indexPath, 'project_index.json']]) {
    if (!fs.existsSync(p)) {
      throw new AppError(CODES.FILE_NOT_FOUND, `${what} 不存在: ${p}`, { file: p });
    }
  }

  const ir = readJson(irPath);
  const projectIndex = readJson(indexPath);
  // ★ 未传 --canvas → null（交由 plan-builder 用 IR 自己的画布；不再硬编码默认值）★
  const cliCanvas = parseCanvas(flagStr(flags.canvas));
  const pageName = flagStr(flags['page-name']);
  const pkg = flagStr(flags.pkg);

  const plan = buildCreatePlan({
    ir,
    projectIndex,
    canvas: cliCanvas || undefined,
    pageName,
    pkg,
    normalizeOpts: config && config.normalize ? config.normalize : undefined,
  });

  const outDir = path.resolve(rootDir, flagStr(flags.out, config.paths.outDir || 'out'));
  ensureDir(outDir);
  const jsonPath = path.join(outDir, 'create_plan.json');
  const mdPath = path.join(outDir, 'create_plan.md');
  writeJson(jsonPath, plan); // 不做 root 相对化：plan 内无绝对路径
  fs.writeFileSync(mdPath, renderPlanMarkdown(plan), 'utf8');

  if (logger) {
    // ★ 画布来源/不一致必须在 stderr 明说（P0：坐标基准错了整页就错）★
    for (const w of plan.warnings) {
      if (w.code === 'CANVAS_FALLBACK_DEFAULT' || w.code === 'CANVAS_MISMATCH') {
        logger.warn(w.msg, { canvas: plan.canvas });
      }
    }
    logger.info('create_plan 已生成', {
      page: plan.page.name, pkg: plan.page.pkg, nodes: plan.summary.nodes,
      reused: plan.summary.reused, toImport: plan.summary.toImport,
      unresolved: plan.summary.unresolved,
      canvas: `${plan.canvas.w}x${plan.canvas.h}(${plan.canvas.source})`,
    });
    if (plan.assets.toImport.length) {
      logger.warn('有素材需要先导入并登记 package.xml（详见 create_plan.md 的「待人工确认」）', {
        count: plan.assets.toImport.length,
      });
    }
  }

  // stdout 只输出摘要 + 产物路径（纯 JSON，便于管道）
  process.stdout.write(`${JSON.stringify({
    command: 'create-plan',
    ok: true,
    outputs: {
      json: path.relative(rootDir, jsonPath).replace(/\\/g, '/'),
      markdown: path.relative(rootDir, mdPath).replace(/\\/g, '/'),
    },
    page: plan.page,
    canvas: plan.canvas,
    summary: plan.summary,
    // 让人一眼看到「哪些需要人工」——但完整清单在 md/json 里
    needsHuman: {
      toImport: plan.assets.toImport.length,
      unresolved: plan.unresolved.length,
      deferred: plan.deferred.controllers.length + plan.deferred.relations.length
        + plan.deferred.listItems.length,
    },
  }, null, 2)}\n`);

  return 0;
}

module.exports = { run };
