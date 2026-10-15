'use strict';
/**
 * src/fgui/gen-plan.js —— gen-xml prepare 核心（M2-SPEC §4/§5，D2/D7/D8）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 职责 ★
 *   读 change_plan（目标态差异）+ project_index（存量工程只读索引）
 *   + base/target Design IR → 产出 **gen_plan.json**（人可编辑的编辑脚本）。
 *
 * ★ 纯函数、零文件 I/O ★
 *   目标 XML 文件内容由调用方（CLI）读好后经 `targetContents` 传入；
 *   SHA-256 即对该字符串计算。这样本模块可完整单测（无临时目录、无 spawn）。
 *
 * ★ 三条不可违背的纪律 ★
 *   1. 门禁复用 `src/diff/planner.js` 的 `planNeedsHuman`（**不重写判定**）；
 *   2. 多节点命中**禁止猜**（不许取第一个）—— 交人编辑 gen_plan.json 的 nodeId；
 *   3. blocked / skipped **永不静默**（必须有 status + note）。
 * ════════════════════════════════════════════════════════════════════════════
 */

const crypto = require('crypto');
const { AppError, CODES, EXIT } = require('../core/errors');
// ⚠ 偏差说明：team-lead 消息说「退出码用 src/fgui/constants.js 里的 EXIT」，
//    但 constants.js 并不导出 EXIT（校验过 exports 列表）—— EXIT 定义在
//    src/core/errors.js。此处按实际契约从 core/errors 取。
const { ID_PREFIXES, ID_DIGITS } = require('./constants');
const { indexComponentXml } = require('./component-indexer');
const { planNeedsHuman } = require('../diff/planner');

/** 生成计划的产品版本号。 */
const GEN_PLAN_VERSION = '1.0';

/** block/skip 等非 resolved 状态集合（统计用）。 */
const STATUS = Object.freeze({
  RESOLVED: 'resolved',
  UNRESOLVED: 'unresolved',
  BLOCKED: 'blocked',
  SKIPPED: 'skipped',
});

/**
 * 计算内容的 SHA-256（防漂移，D8）。
 * @param {string} text
 * @returns {string} 十六进制
 */
function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 归一化 `planNeedsHuman` 的返回值。
 *
 * ★ 为什么要防御 ★：该函数的返回形状由 diff 模块定义，本模块只消费不拥有；
 * 若上游从 boolean 改成对象（或反之），归一化的代价远小于「在某处静默失效」。
 *
 * @param {Object} plan change_plan
 * @returns {{needsHuman:boolean, inferredCount:number, ambiguousCount:number, reasons:string[]}}
 */
function evaluateGate(plan) {
  let raw;
  try {
    raw = planNeedsHuman(plan);
  } catch (err) {
    throw new AppError(CODES.BAD_ARGUMENT, `planNeedsHuman 执行失败: ${err.message}`, { cause: err.message });
  }
  if (raw === true || raw === false) {
    return {
      needsHuman: raw === true,
      inferredCount: -1,
      ambiguousCount: -1,
      reasons: raw === true ? ['planNeedsHuman 返回 true（旧返回形状）'] : [],
    };
  }
  const info = raw && typeof raw === 'object' ? raw : {};
  return {
    needsHuman: info.needsHuman === true,
    inferredCount: Number.isFinite(info.inferredCount) ? info.inferredCount : -1,
    ambiguousCount: Number.isFinite(info.ambiguousCount) ? info.ambiguousCount : -1,
    reasons: Array.isArray(info.reasons) ? info.reasons : [],
  };
}

/**
 * 判定一个 diff 条目是否属于「未确认」（用于 skipUnconfirmed 丢弃与原因列举）。
 *
 * ★ 与 planner.planNeedsHuman 逐条对齐（planner.js:331-357）★
 *   门禁本身**只调用** planNeedsHuman，绝不重写；本函数只为「逐条列出原因 /
 *   逐条丢弃」提供同一判定的单条版本。为避免两处逻辑漂移，
 *   `test/unit/gen-plan.test.js` 有一条一致性测试：对一组样本断言
 *   `isUnconfirmed` 的条数 === `planNeedsHuman().inferredCount + ambiguousCount`。
 *
 * 语义（与上游逐字一致）：
 *   · op === 'INFERRED' → 未确认；
 *   · ambiguous === true 且 resolved 去空白后为空 → 未确认；
 *   · ambiguous === true 且 candidates 非空、resolved 不在其中 → 未确认；
 *   · candidates 缺失/为空时不因 resolved 值而判未确认（旧 plan 兼容）。
 *
 * @param {Object} diff
 * @returns {boolean}
 */
function isUnconfirmed(diff) {
  if (!diff || typeof diff !== 'object') return false;
  if (diff.op === 'INFERRED') return true;
  if (!diff.ambiguous) return false;
  const resolved = typeof diff.resolved === 'string' ? diff.resolved.trim() : '';
  if (!resolved) return true;
  if (Array.isArray(diff.candidates) && diff.candidates.length && !diff.candidates.includes(resolved)) {
    return true;
  }
  return false;
}

/**
 * 构造 gen_plan（prepare 核心）。
 *
 * @param {Object} args
 * @param {Object} args.changePlan change_plan.json（可人工编辑）
 * @param {Object} args.projectIndex project_index.json（存量工程只读索引）
 * @param {Object} [args.baseIr] 基准 Design IR
 * @param {Object} [args.targetIr] 目标 Design IR
 * @param {Object} [args.targetContents] `{ [relPath]: xmlString }`（CLI 读好传入）
 * @param {Object} [args.options]
 * @param {boolean} [args.options.skipUnconfirmed=false]
 * @returns {{genPlan:Object, exitCode:number}} exitCode ∈ {EXIT.OK, EXIT.NEEDS_HUMAN}
 */
function buildGenPlan(args = {}) {
  const changePlan = args.changePlan;
  const projectIndex = args.projectIndex;
  const baseIr = args.baseIr || null;
  const targetIr = args.targetIr || null;
  const targetContents = args.targetContents || {};
  const options = args.options || {};

  if (!changePlan || typeof changePlan !== 'object') {
    throw new AppError(CODES.BAD_ARGUMENT, 'buildGenPlan 需要 changePlan 对象');
  }
  if (!projectIndex || typeof projectIndex !== 'object') {
    throw new AppError(CODES.BAD_ARGUMENT, 'buildGenPlan 需要 projectIndex 对象');
  }

  const warnings = [];
  const diffs = Array.isArray(changePlan.diffs) ? changePlan.diffs : [];

  // ────────────────────────────────────────────────────────────────────────
  // ① 门禁（D7）：复用 planner.planNeedsHuman，绝不重写判定
  // ────────────────────────────────────────────────────────────────────────
  const gateInfo = evaluateGate(changePlan);
  const unconfirmed = diffs.filter(isUnconfirmed);
  const skipUnconfirmed = options.skipUnconfirmed === true;

  if (gateInfo.needsHuman && !skipUnconfirmed) {
    for (const d of unconfirmed) {
      warnings.push({
        code: 'NEEDS_HUMAN',
        op: d.op || null,
        slot: d.slot || null,
        node: d.node || null,
        candidates: Array.isArray(d.candidates) ? d.candidates : [],
        msg: d.op === 'INFERRED'
          ? `条目 ${d.op} slot='${d.slot}' 是 INFERRED（未确认推断）：`
            + '请删除该条目或改为确定 op 后重跑 prepare'
          : `条目 slot='${d.slot}' 存在歧义（candidates=${JSON.stringify(d.candidates || [])}）：`
            + '请在 change_plan.json 里为本条填 resolved（必须是 candidates 之一）后重跑 prepare',
      });
    }
    return {
      genPlan: buildEnvelope({
        changePlan, projectIndex, targetContents, gate: {
          needsHuman: true,
          inferredCount: gateInfo.inferredCount,
          ambiguousCount: gateInfo.ambiguousCount,
          reasons: gateInfo.reasons,
          skippedCount: 0,
        },
        entries: [],
        warnings,
        summary: emptySummary(),
        blockedEarly: true,
      }),
      exitCode: EXIT.NEEDS_HUMAN,
    };
  }

  // skipUnconfirmed：丢弃未确认条目并记录（honoring defaultIfUnconfirmed:'skip'）
  const keptDiffs = skipUnconfirmed ? diffs.filter((d) => !isUnconfirmed(d)) : diffs;
  const droppedByGate = skipUnconfirmed ? diffs.filter(isUnconfirmed) : [];
  for (const d of droppedByGate) {
    warnings.push({
      code: 'SKIPPED_UNCONFIRMED',
      op: d.op || null,
      slot: d.slot || null,
      node: d.node || null,
      candidates: Array.isArray(d.candidates) ? d.candidates : [],
      msg: `--skip-unconfirmed：丢弃未确认条目 slot='${d.slot}'（op=${d.op}）`,
    });
  }

  return {
    genPlan: buildEnvelope({
      changePlan, projectIndex, targetContents,
      gate: {
        needsHuman: false,
        inferredCount: gateInfo.inferredCount,
        ambiguousCount: gateInfo.ambiguousCount,
        reasons: gateInfo.reasons,
        skippedCount: droppedByGate.length,
      },
      entries: [], // ②③ 填充
      warnings,
      summary: emptySummary(),
    }),
    exitCode: EXIT.OK,
  };
}

/** 空 summary。 */
function emptySummary() {
  return { total: 0, byOp: {}, byStatus: {} };
}

/**
 * 组装 gen_plan 外壳（§4 JSON 结构）。
 * @param {Object} a
 * @returns {Object}
 */
function buildEnvelope(a) {
  const changePlan = a.changePlan || {};
  const task = changePlan.task || {};
  const projectIndex = a.projectIndex || {};
  const components = Array.isArray(projectIndex.components) ? projectIndex.components : [];
  const target = components.find((c) => c.pkg === task.targetPkg && c.name === task.name) || null;
  const file = target ? target.file : null;
  const content = file && typeof a.targetContents[file] === 'string' ? a.targetContents[file] : null;

  return {
    version: GEN_PLAN_VERSION,
    _comment: '由 fgui-rb gen-xml prepare 生成。**本文件可人工编辑**：'
      + '歧义条目请填 nodeId（见 warnings/summary）；blocked 条目需先解决 note 所述前置条件'
      + '（如导入素材并登记 package.xml）后重跑 prepare。'
      + '本工具**永不自动修改** package.xml（PRD R4-F6）。',
    _entryNote: {
      op: 'MOVE|RESIZE|RESTYLE|REMOVE|ADD|REUSE',
      slot: '目标态图层名（change_plan 的 slot）',
      nodeId: '命中节点的 XML id —— 歧义时由人工填写',
      status: 'resolved|unresolved|blocked|skipped（blocked/skipped 必带 note，绝不静默）',
      patch: '补丁指令：{attr,value} | {attrs:{...}} | {tag,attrs,after}（见 M2-SPEC §4）',
      note: '人可读说明（blocked/skipped 必填）',
    },
    task: {
      name: task.name === undefined ? null : task.name,
      targetPkg: task.targetPkg === undefined ? null : task.targetPkg,
      basePkg: task.basePkg === undefined ? null : task.basePkg,
    },
    target: {
      // §4 样例：target.component 是组件**名**（字符串），不是对象
      component: target ? target.name : null,
      pkg: task.targetPkg === undefined ? null : task.targetPkg,
      pkgId: target && target.pkgId !== undefined && target.pkgId !== null
        ? String(target.pkgId)
        : resolvePkgId(a.projectIndex, task.targetPkg),
      file,
      sha256: content === null ? null : sha256Hex(content),
    },
    entries: a.entries || [],
    summary: a.summary || emptySummary(),
    gate: a.gate || { needsHuman: false, inferredCount: 0, ambiguousCount: 0, reasons: [], skippedCount: 0 },
    warnings: a.warnings || [],
  };
}

/**
 * 从 project_index 解析包 id（D9 的 `ui://<pkgId>/...` 需要）。
 *
 * ★ 形状事实（已核对 cmd-project-index.js:132/256）★
 *   project_index 顶层是 `project.packages[]`（**不是** `packages[]`），
 *   每项 `{name, id, relPath, ...}`；resources[] 每项自带 pkgId。
 *   故优先 project.packages，其次 resources，最后组件兜底。
 *
 * @param {Object} projectIndex
 * @param {string} pkgName
 * @returns {string|null}
 */
function resolvePkgId(projectIndex, pkgName) {
  const idx = projectIndex || {};
  const pkgLists = [
    idx.project && Array.isArray(idx.project.packages) ? idx.project.packages : [],
    Array.isArray(idx.packages) ? idx.packages : [],
  ];
  for (const list of pkgLists) {
    const hit = list.find((p) => p && p.name === pkgName && p.id !== undefined && p.id !== null);
    if (hit) return String(hit.id);
  }
  const res = Array.isArray(idx.resources) ? idx.resources : [];
  const rHit = res.find((r) => r && r.pkg === pkgName && r.pkgId !== undefined && r.pkgId !== null);
  if (rHit) return String(rHit.pkgId);
  const comps = Array.isArray(idx.components) ? idx.components : [];
  const cHit = comps.find((c) => c && c.pkg === pkgName && c.pkgId !== undefined && c.pkgId !== null);
  return cHit ? String(cHit.pkgId) : null;
}

module.exports = {
  buildGenPlan,
  // 内部件导出（测试与后续步骤复用）
  evaluateGate,
  isUnconfirmed,
  sha256Hex,
  resolvePkgId,
  GEN_PLAN_VERSION,
  STATUS,
};
