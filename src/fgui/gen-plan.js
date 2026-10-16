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
const path = require('path');
const { AppError, CODES, EXIT } = require('../core/errors');
const { round6, toPosixRel } = require('../core/determinism');
// ⚠ 偏差说明：team-lead 消息说「退出码用 src/fgui/constants.js 里的 EXIT」，
//    但 constants.js 并不导出 EXIT（校验过 exports 列表）—— EXIT 定义在
//    src/core/errors.js。此处按实际契约从 core/errors 取。
const { ID_PREFIXES, ID_DIGITS } = require('./constants');
const { indexComponentXml } = require('./component-indexer');
const { normalizeName } = require('../core/normalize');
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
 * @param {boolean} [args.options.skipUnconfirmed=false] 丢弃未确认条目而非阻塞
 * @param {string} [args.options.projectRoot] FGUI 工程根（绝对路径）——
 *        给出后 `target.file` 输出**工程根相对**路径（M2-SPEC §4）；
 *        不给则沿用 index 原值（保持旧行为，不破坏既有调用方）。
 * @param {string} [args.options.rootDir] CLI rootDir —— index 里的 `file`
 *        是相对它的；缺省 `process.cwd()`。CLI 应显式传入以避免依赖 cwd。
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
        changePlan, projectIndex, targetContents,
        projectRoot: options.projectRoot, rootDir: options.rootDir,
        gate: {
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

  // ────────────────────────────────────────────────────────────────────────
  // ② 目标组件 + 节点索引（D2）
  // ────────────────────────────────────────────────────────────────────────
  const task = changePlan.task || {};
  const components = Array.isArray(projectIndex.components) ? projectIndex.components : [];
  const target = components.find((c) => c && c.pkg === task.targetPkg && c.name === task.name) || null;
  const file = target ? target.file : null;
  const content = file && typeof targetContents[file] === 'string' ? targetContents[file] : null;
  if (!target) {
    // 目标组件找不到：不是「静默跳过」，而是明确告警（后续节点匹配必然全零命中）
    warnings.push({
      code: 'TARGET_COMPONENT_NOT_FOUND',
      msg: `project_index.components 里找不到 pkg='${task.targetPkg}' name='${task.name}' 的目标组件`
        + ' —— 节点匹配将全部零命中，请核对 --index 与 change_plan.task',
    });
  } else if (content === null) {
    warnings.push({
      code: 'TARGET_CONTENT_MISSING',
      msg: `目标文件 ${file} 的内容未随 targetContents 传入 —— 节点匹配将全部零命中（请检查 CLI 读取）`,
    });
  }
  const nodeIndex = file === null ? { nodes: [], parseError: null } : buildNodeIndex(content);
  if (nodeIndex.parseError) {
    warnings.push({
      code: 'TARGET_PARSE_FAILED',
      msg: `目标组件 XML 解析失败：${nodeIndex.parseError} —— 节点匹配不可用`,
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // ③ op → 补丁指令（§5），blocked/skipped 永不静默
  // ────────────────────────────────────────────────────────────────────────
  // id 分配器：per 目标文件、per 前缀（ADD 按 entries 顺序依次分配，不碰撞）
  const ids = createIdAllocator(nodeIndex.nodes);
  const entries = keptDiffs.map((diff) => classifyDiff({
    diff,
    nodes: nodeIndex.nodes,
    baseIr,
    targetIr,
    targetPkg: task.targetPkg,
    pkgId: resolvePkgId(projectIndex, task.targetPkg),
    projectIndex,
    ids,
    // 资源名归一化选项（默认与 fgui.config.json 的 normalize 段一致）
    normOpts: options.normalize,
    warnings,
  }));

  return {
    genPlan: buildEnvelope({
      changePlan, projectIndex, targetContents,
      projectRoot: options.projectRoot, rootDir: options.rootDir,
      gate: {
        needsHuman: false,
        inferredCount: gateInfo.inferredCount,
        ambiguousCount: gateInfo.ambiguousCount,
        reasons: gateInfo.reasons,
        skippedCount: droppedByGate.length,
      },
      entries,
      warnings,
      summary: summarize(entries),
    }),
    exitCode: EXIT.OK,
  };
}

/**
 * summary 统计（§4：total/byOp/byStatus）。
 * @param {Object[]} entries
 * @returns {{total:number, byOp:Object, byStatus:Object}}
 */
function summarize(entries) {
  const byOp = {};
  const byStatus = {};
  for (const e of entries || []) {
    const op = e.op === undefined || e.op === null ? 'UNKNOWN' : String(e.op);
    const st = e.status === undefined || e.status === null ? 'unknown' : String(e.status);
    byOp[op] = (byOp[op] || 0) + 1;
    byStatus[st] = (byStatus[st] || 0) + 1;
  }
  return { total: (entries || []).length, byOp, byStatus };
}

/**
 * 收集节点树里所有带 id 的显示对象（递归，保持文档序）。
 * @param {Object[]} nodes
 * @param {Object[]} [out]
 * @returns {Object[]}
 */
function collectDisplayNodes(nodes, out) {
  const acc = out || [];
  for (const n of nodes || []) {
    if (!n) continue;
    if (n.id) acc.push(n);
    if (Array.isArray(n.children)) collectDisplayNodes(n.children, acc);
  }
  return acc;
}

/**
 * 从目标 XML 内容建节点索引（D2 的匹配基础）。
 *
 * 节点树来自 `indexComponentXml`（M1 已有的纯函数，入参是字符串）——
 * gen-plan 不自己再做一套 XML 解析，避免与 xml-parse 两处实现漂移。
 *
 * @param {string|null} xmlText
 * @returns {{nodes:Object[], parseError:string|null}}
 */
function buildNodeIndex(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) {
    return { nodes: [], parseError: '目标文件内容为空或不可读' };
  }
  const idx = indexComponentXml(xmlText);
  if (!idx || !idx.ok || !idx.root) {
    return { nodes: [], parseError: (idx && idx.error) || '组件 XML 解析失败' };
  }
  return { nodes: collectDisplayNodes([idx.root]), parseError: null };
}

/**
 * 双名映射（D2）：候选名 = [slot, baseName]，**多命中禁止猜**。
 *
 * ★ 为什么双名 ★
 *   change_plan 的 slot 是**目标态**图层名；存量 XML 里节点名是**基准态**名字。
 *   画师改名后单靠 slot 找不到（真实 grounding：MOVE 的 slot='btn_close'，
 *   而节点名是 '图层129'）。故同时用 baseNode → base-ir 的 name 作第二候选。
 *
 * @param {Object[]} nodes
 * @param {string[]} names
 * @returns {{status:string, nodeId:string|null, candidates:string[], hitNames:string[], reason?:string}}
 */
function resolveNodeByName(nodes, names) {
  const wanted = [...new Set((names || []).filter((n) => typeof n === 'string' && n.trim()))];
  if (!wanted.length) {
    return { status: STATUS.UNRESOLVED, nodeId: null, candidates: [], hitNames: [], reason: 'no_candidate_name' };
  }
  const hits = (nodes || []).filter((n) => n.name && wanted.includes(n.name));
  const ids = hits.map((n) => n.id);
  if (hits.length === 1) {
    return { status: STATUS.RESOLVED, nodeId: ids[0], candidates: ids, hitNames: [hits[0].name] };
  }
  if (hits.length === 0) {
    return { status: STATUS.UNRESOLVED, nodeId: null, candidates: [], hitNames: [], reason: 'zero_match' };
  }
  // ★ 多命中 → 不猜（绝不许取第一个）★
  return {
    status: STATUS.UNRESOLVED, nodeId: null, candidates: ids,
    hitNames: hits.map((n) => n.name), reason: 'multi_match',
  };
}

/**
 * 取基准态名（baseNode → base-ir 的 name）。
 * @param {Object|null} baseIr
 * @param {string|null|undefined} baseNode
 * @returns {string|null}
 */
function baseNameOf(baseIr, baseNode) {
  if (!baseIr || !baseNode || !Array.isArray(baseIr.layers)) return null;
  const hit = baseIr.layers.find((l) => l && l.id === baseNode);
  return hit && typeof hit.name === 'string' && hit.name.trim() ? hit.name : null;
}

/**
 * 按 id 取 target-ir 图层。
 * @param {Object|null} targetIr
 * @param {string|null|undefined} node
 * @returns {Object|null}
 */
function irLayerOf(targetIr, node) {
  if (!targetIr || !node || !Array.isArray(targetIr.layers)) return null;
  return targetIr.layers.find((l) => l && l.id === node) || null;
}

/** bbox → "x,y"（无 bbox 返 null）。 */
function bboxToXy(bbox) {
  return bbox ? `${bbox.x},${bbox.y}` : null;
}
/** bbox → "w,h"（无 bbox 返 null）。 */
function bboxToSize(bbox) {
  return bbox ? `${bbox.w},${bbox.h}` : null;
}

/** M2 已知的 op 集合（其余一律 blocked，不静默）。 */
const KNOWN_OPS = Object.freeze(['REUSE', 'MOVE', 'RESIZE', 'RESTYLE', 'ADD', 'REMOVE', 'INFERRED']);

/**
 * 处理一个 diff 条目 → gen_plan entry（§4 形态）。
 *
 * @param {Object} a
 * @param {Object} a.diff
 * @param {Object[]} a.nodes 目标组件显示对象
 * @param {Object|null} a.baseIr
 * @param {Object|null} a.targetIr
 * @param {string} a.targetPkg
 * @param {string|null} a.pkgId
 * @param {Object} a.projectIndex
 * @param {Object} a.ids id 分配器
 * @param {Object[]} a.warnings 收集器
 * @returns {Object} entry
 */
function classifyDiff(a) {
  const { diff, nodes, baseIr, targetIr } = a;
  const op = diff.op || null;
  const slot = diff.slot === undefined ? null : diff.slot;
  const node = diff.node === undefined ? null : diff.node;
  const baseNode = diff.baseNode === undefined ? null : diff.baseNode;
  const baseName = baseNameOf(baseIr, baseNode);

  const entry = {
    op, slot, node, baseNode,
    status: STATUS.UNRESOLVED,
    nodeId: null,
    patch: null,
    note: '',
  };

  // ★ 未知 op 先拦：连节点都无从匹配，必须立刻 blocked（不静默）★
  if (!KNOWN_OPS.includes(op)) {
    entry.status = STATUS.BLOCKED;
    entry.note = `未知 op ${JSON.stringify(op)} —— 照实记录但无法生成补丁，请人工核对 change_plan.json`;
    a.warnings.push({
      code: 'UNKNOWN_OP', op, slot, node,
      msg: `未知 op ${JSON.stringify(op)}（slot='${slot}'）—— 已 blocked`,
    });
    return entry;
  }

  // ADD 单独分支（需要 id 分配 + 资源解析）
  if (op === 'ADD') return classifyAdd(a, entry);

  // INFERRED 正常已被门禁拦下；此处仅 --skip-unconfirmed 路径可达的兜底
  if (op === 'INFERRED') {
    entry.status = STATUS.SKIPPED;
    entry.note = 'INFERRED 未确认条目（门禁路径外的兜底）—— 已 skipped';
    return entry;
  }

  // ---- 其余 op 统一走「双名/单名映射」----
  // §5：REMOVE 的候选名只有 [slot]（基准态名），其余用 [slot, baseName]
  const names = op === 'REMOVE' ? [slot] : [slot, baseName];
  const hit = resolveNodeByName(nodes, names);
  entry.status = hit.status;
  entry.nodeId = hit.nodeId;

  if (hit.status !== STATUS.RESOLVED) {
    const wanted = JSON.stringify(names.filter(Boolean));
    entry.note = hit.reason === 'multi_match'
      ? `多节点同名命中（candidates=${JSON.stringify(hit.candidates)}）：禁止自动取第一个 —— `
        + '请在 gen_plan.json 里为本条填 nodeId 后重跑'
      : `未在目标组件里找到名为 ${wanted} 的节点：工程可能与基准态不同步，请人工核对`;
    if (op === 'REUSE' && hit.reason === 'zero_match') {
      // §5：REUSE 零命中只 warning，不阻塞
      a.warnings.push({
        code: 'REUSE_ZERO_MATCH', op, slot, node, candidates: hit.candidates,
        msg: `REUSE 条目 slot='${slot}' 在目标组件零命中 —— 工程可能与基准态不同步（不阻塞，仅提示）`,
      });
    }
    return entry;
  }

  // ---- 已命中：按 op 出补丁 ----
  const irLayer = irLayerOf(targetIr, node);
  const strategy = diff.fguiStrategy && typeof diff.fguiStrategy === 'object' ? diff.fguiStrategy : {};

  if (op === 'REUSE') {
    entry.patch = null;
    entry.note = '复用已有节点，无补丁（仅确认存在）';
    return entry;
  }

  if (op === 'MOVE') {
    const xy = bboxToXy(irLayer && irLayer.bbox);
    if (!xy) {
      entry.status = STATUS.BLOCKED;
      entry.note = '缺少 --target-ir（或该 node 在 target-ir 里找不到 bbox）—— '
        + '无法计算目标坐标，请提供后重跑';
      return entry;
    }
    entry.patch = { attr: 'xy', value: xy };
    const rel = strategy.relation || diff.relation;
    if (rel) {
      entry.note = `上游建议 relation=${JSON.stringify(rel)}（M2 用绝对坐标；gear 联动留 M3+）`;
    }
    return entry;
  }

  if (op === 'RESIZE') {
    const gear = strategy.gearSize && typeof strategy.gearSize === 'object' ? strategy.gearSize : null;
    const size = (gear && Number.isFinite(gear.width) && Number.isFinite(gear.height))
      ? `${gear.width},${gear.height}`
      : bboxToSize(irLayer && irLayer.bbox);
    if (!size) {
      entry.status = STATUS.BLOCKED;
      entry.note = '策略未给 gearSize 且缺少 --target-ir bbox —— 无法确定目标尺寸，请提供后重跑';
      return entry;
    }
    const patches = { size };
    // scale9grid 仅在策略**显式**给出 且 目标节点是 image 时设置（D4 / §5）
    const s9 = strategy.scale9grid && typeof strategy.scale9grid === 'object'
      ? strategy.scale9grid.scale9grid : null;
    let s9Applied = false;
    if (s9) {
      const targetNode = nodes.find((n) => n.id === hit.nodeId);
      if (targetNode && targetNode.tag === 'image') {
        patches.scale9grid = String(s9);
        s9Applied = true;
      } else {
        a.warnings.push({
          code: 'SCALE9GRID_SKIPPED', op, slot, node,
          msg: `策略给出 scale9grid='${s9}' 但目标节点不是 image`
            + `（tag=${targetNode ? targetNode.tag : '?'}）—— 已跳过该补丁`,
        });
      }
    }
    // ★ patch 形态与第 4 步（gen-dryrun）冻结的三种形态一一对应，绝不产出第四种 ★
    //   · 只有 size            → { attr:'size', value }（§4 定义）
    //   · size + scale9grid    → { attrs:{ size, scale9grid } }（多属性形态）
    //   —— 刻意**不**用数组：gen-dryrun 的 patch 分发只识别
    //      {tag,attrs,after} / {attrs} / {attr,value} 三种，数组会直接抛错。
    if (s9Applied) {
      entry.patch = { attrs: patches };
      entry.note = '含多属性补丁（size + scale9grid），patch 形态为 { attrs }';
    } else {
      entry.patch = { attr: 'size', value: size };
    }
    return entry;
  }

  if (op === 'RESTYLE') {
    const colorStrategy = strategy.color && typeof strategy.color === 'object' ? strategy.color : {};
    const attrs = {};
    if (typeof colorStrategy.color === 'string' && colorStrategy.color.trim()) {
      attrs.color = colorStrategy.color.trim();
    }
    if (colorStrategy.alpha !== undefined && colorStrategy.alpha !== null) {
      attrs.alpha = String(colorStrategy.alpha);
    }
    if (!Object.keys(attrs).length) {
      entry.status = STATUS.SKIPPED;
      entry.note = '策略未给出 color/alpha —— 无可设置的属性，跳过（不猜）';
      a.warnings.push({
        code: 'RESTYLE_NO_ATTRS', op, slot, node,
        msg: `RESTYLE 条目 slot='${slot}' 的策略既无 color 也无 alpha，已 skipped`,
      });
      return entry;
    }
    entry.patch = { attrs };
    return entry;
  }

  if (op === 'REMOVE') {
    const conf = typeof diff.confidence === 'number' ? diff.confidence : 1;
    if (conf < 0.5) {
      entry.status = STATUS.SKIPPED;
      entry.note = `confidence=${conf} < 0.5（多为 merged 组内条目）—— 低置信度需人工确认，宁可不动不误删`;
      a.warnings.push({
        code: 'REMOVE_LOW_CONFIDENCE', op, slot, node,
        msg: `REMOVE 条目 slot='${slot}' confidence=${conf} < 0.5，已 skipped（避免误删）`,
      });
      return entry;
    }
    entry.patch = { attr: 'visible', value: 'false' };
    entry.note = '不删节点，置 visible=false（D5 / classifier stash 策略）';
    return entry;
  }

  // 理论上不可达（KNOWN_OPS 已全部处理）—— 留作防御，绝不静默返回半成品
  entry.status = STATUS.BLOCKED;
  entry.note = `内部缺陷：op '${op}' 已知但未被任何分支处理（请上报 gen-plan 实现）`;
  a.warnings.push({ code: 'OP_UNHANDLED', op, slot, node, msg: `op '${op}' 未被分支处理（内部缺陷）` });
  return entry;
}

/**
 * 构造 id 分配器（per 目标文件、per 前缀）。
 *
 * 规则（M2-SPEC §2「id 分配规则」）：
 *   · 扫现有 id 匹配 `/^[bc]\d{5}$/`，取该前缀最大值 +1，5 位补零；
 *   · 嵌套 `<component>` 用 'c'，其余用 'b'；
 *   · 超 99999 → AppError（不静默回绕）。
 *
 * @param {Object[]} nodes 目标组件显示对象
 * @returns {{next:(prefix?:string)=>string, snapshot:()=>Object}}
 */
function createIdAllocator(nodes) {
  const prefixes = ID_PREFIXES.length ? [...ID_PREFIXES] : ['b', 'c'];
  const cls = prefixes.join('');
  const re = new RegExp(`^([${cls}])(\\d{${ID_DIGITS}})$`);
  const maxByPrefix = {};
  for (const p of prefixes) maxByPrefix[p] = 0;
  for (const n of nodes || []) {
    if (!n || !n.id) continue;
    const m = re.exec(String(n.id));
    if (m) maxByPrefix[m[1]] = Math.max(maxByPrefix[m[1]], parseInt(m[2], 10));
  }
  const MAX = Math.pow(10, ID_DIGITS) - 1;
  return {
    /**
     * @param {string} [prefix='b']
     * @returns {string} 新 id
     */
    next(prefix) {
      const p = prefixes.includes(prefix) ? prefix : prefixes[0];
      maxByPrefix[p] = (maxByPrefix[p] || 0) + 1;
      if (maxByPrefix[p] > MAX) {
        throw new AppError(CODES.INTERNAL,
          `id 序列耗尽：前缀 '${p}' 已超过 ${MAX}（${ID_DIGITS} 位上限）—— 组件过大，需拆分`);
      }
      return `${p}${String(maxByPrefix[p]).padStart(ID_DIGITS, '0')}`;
    },
    snapshot() {
      return { ...maxByPrefix };
    },
  };
}

/** IR type → 节点 tag（D3）。smartobject 无对应 tag（blocked）。 */
const ADD_TAG_BY_TYPE = Object.freeze({ text: 'text', group: 'group', raster: 'image' });

/**
 * 资源名匹配用的归一化默认值。
 *
 * ★ 为什么需要它（真实 fixture 实测发现）★
 *   `project_index.resources[].name` 在真实合成工程里**带扩展名**
 *   （`reward_icon.png`），而 XML 节点名 / change_plan 的 slot 是
 *   `reward_icon`（不带）。若只做严格字符串相等，会把**已登记**的资源
 *   误判为「未登记」→ 提示小 Q 去导入他已有的素材（假 blocked 比漏判更伤）。
 *   故补一层「归一化后全等」匹配 —— 复用 P0 的 `normalizeName`
 *   （去扩展名/大小写/副本后缀/繁简），**仍是全等**，不违反 K5（禁前缀/子串）。
 *   与 fgui.config.json 的 normalize 段同默认值；`options.normalize` 可覆盖。
 */
const DEFAULT_NORM_OPTS = Object.freeze({
  // ★ stripCopySuffix 刻意 **false** ★
  //   package.xml 里 `reward_icon.png` 与 `reward_icon(1).png` 是**两个不同的
  //   资源条目**（画师副本），各自有独立 id。若归一化时剥掉副本后缀，
  //   slot='reward_icon' 会同时命中两者 —— 进而「静默绑到其中一个」。
  //   资源解析必须**只去扩展名/大小写/繁简**，绝不能把副本当成同一个资源。
  stripCopySuffix: false, stripExtension: true, useVariants: true,
});

/**
 * 判定资源是否「已导出」。
 *
 * ★ BUG-A 修复（QA A5 独立发现，P1）★
 *   `package.xml` 的 `exported` 经 package-indexer 产出后**永远是字符串**
 *   （package-indexer.js:92：`exported: String(exported)` → "true"/"false"/null）。
 *   本模块原实现用**真值判断**（`r.exported`），而 `Boolean("false") === true` ——
 *   于是 `exported="false"` 的资源被当成已导出**静默绑定**，生成
 *   `src="ui://pkgId/id"` 写进 XML → 运行时引用不存在的资源 → 贴图丢失且无报错。
 *   本仓库的正确口径见 `lint-rules.js:433`（`v !== 'true'` 才报错）；
 *   **此处三处口径必须保持一致**，后人不要改回真值判断。
 *   布尔 `true` 也接受（防御手工构造的 index / 单测 fixture）。
 *
 * @param {*} v `exported` 字段值
 * @returns {boolean}
 */
function isExported(v) {
  return v === true || v === 'true';
}

/** 资源匹配结果状态。 */
const RESOURCE_MATCH = Object.freeze({
  EXACT: 'exact',           // 按 id 或 name 精确全等，**且唯一**命中
  NORMALIZED: 'normalized', // 归一化后**唯一**全等命中
  AMBIGUOUS: 'ambiguous',   // 多候选（精确或归一）—— 不猜，交人
  TYPE_MISMATCH: 'type_mismatch', // 名字/id 对得上、也已导出，但**类型不是图片**
  NOT_EXPORTED: 'not_exported', // 名字/id 对得上，但 exported 不是 true —— 不绑定
  NONE: 'none',             // 未登记
});

/**
 * 在目标包的资源里匹配图片（D3）。
 *
 * ★ 五条纪律（防「静默绑错资源」；P1-2 修复后）★
 *   0. **类型限定**：图片 ADD 只允许匹配 `type === 'image'` 的资源 ——
 *      否则会同名绑到 component 等**非图片**资源，生成指向错误东西的 `src`；
 *   1. **按 id 精确唯一**：恰好 1 条才 resolve，>1 条（理论不该发生）交人；
 *   2. **按 name 精确唯一**：恰好 1 条才 resolve，**>1 条 → ambiguous（绝不取第一个）**；
 *   3. **归一化兜底唯一**：去扩展名/大小写/繁简后全等，只在一个候选时绑定；
 *   4. **未命中要能区分原因**：类型不符 / 未导出 / 未登记 —— 三者给用户的行动不同。
 *   全程**不做前缀/子串匹配**（K5）。
 *
 * @param {Object} projectIndex
 * @param {string} targetPkg
 * @param {string[]} keys 候选名（slot / normName / baseName）
 * @param {Object} [normOpts] 透传 normalizeName
 * @param {Object} [opts]
 * @param {string} [opts.type='image'] 要求的资源类型（ADD 的图片场景恒为 image）
 * @returns {{match:Object|null, status:string, candidates:string[]}}
 */
function findExportedResource(projectIndex, targetPkg, keys, normOpts, opts) {
  const res = Array.isArray(projectIndex && projectIndex.resources) ? projectIndex.resources : [];
  const nopts = normOpts && typeof normOpts === 'object' ? normOpts : DEFAULT_NORM_OPTS;
  const wantType = (opts && opts.type) || 'image';
  const wanted = keys.filter((k) => typeof k === 'string' && k.trim());
  if (!wanted.length) return { match: null, status: RESOURCE_MATCH.NONE, candidates: [] };

  const allInPkg = res.filter((r) => r && r.pkg === targetPkg);
  // ★ 类型限定：图片只能匹配图片（否则会绑到同名 component 等）★
  const inPkg = allInPkg.filter((r) => isExported(r.exported) && r.type === wantType);

  const label = (r) => `${r.name}#${r.id}`;
  const ambiguousOf = (hits) => ({
    match: null, status: RESOURCE_MATCH.AMBIGUOUS, candidates: hits.map(label),
  });

  // ① 按 id 精确 —— 必须唯一
  const byId = inPkg.filter((r) => wanted.includes(String(r.id)));
  if (byId.length === 1) {
    return { match: byId[0], status: RESOURCE_MATCH.EXACT, candidates: [label(byId[0])] };
  }
  if (byId.length > 1) return ambiguousOf(byId); // id 理论上唯一；守门，绝不取第一个

  // ② 按 name 精确 —— 必须唯一（P1-2 问题 B：原实现 find() 静默取第一个）
  const byName = inPkg.filter((r) => wanted.includes(r.name));
  if (byName.length === 1) {
    return { match: byName[0], status: RESOURCE_MATCH.EXACT, candidates: [label(byName[0])] };
  }
  if (byName.length > 1) return ambiguousOf(byName); // ★ 不猜：同名多资源一律交人

  // ③ 归一化后全等 —— 必须唯一
  const wantedNorm = new Set(wanted.map((k) => normalizeName(k, nopts)));
  const normHits = inPkg.filter((r) => r.name && wantedNorm.has(normalizeName(String(r.name), nopts)));
  if (normHits.length === 1) {
    return { match: normHits[0], status: RESOURCE_MATCH.NORMALIZED, candidates: [label(normHits[0])] };
  }
  if (normHits.length > 1) return ambiguousOf(normHits);

  // ④ 未命中 —— 区分原因（类型不符 / 未导出 / 未登记），三者行动不同
  const nameOrIdLike = (r) => wanted.includes(r.name) || wanted.includes(String(r.id))
    || (r.name && wantedNorm.has(normalizeName(String(r.name), nopts)));
  const matched = allInPkg.filter(nameOrIdLike);
  // ④-a 名字对得上、已导出，但类型不是图片（P1-2 问题 A 的可操作信号）
  const wrongType = matched.filter((r) => isExported(r.exported) && r.type !== wantType);
  if (wrongType.length) {
    return {
      match: null,
      status: RESOURCE_MATCH.TYPE_MISMATCH,
      candidates: wrongType.map((r) => `${r.name}(type=${r.type === undefined ? '??' : r.type})`),
    };
  }
  // ④-b 名字对得上但未导出
  const notExported = matched.filter((r) => !isExported(r.exported));
  if (notExported.length) {
    return {
      match: null, status: RESOURCE_MATCH.NOT_EXPORTED, candidates: notExported.map((r) => String(r.name || r.id)),
    };
  }
  return { match: null, status: RESOURCE_MATCH.NONE, candidates: [] };
}

/**
 * 列出目标包内已导出的图片名（供 blocked 时给出可操作信息，不参与匹配）。
 * @param {Object} projectIndex
 * @param {string} targetPkg
 * @param {number} [limit=8]
 * @returns {string[]}
 */
function listExportedImageNames(projectIndex, targetPkg, limit) {
  const res = Array.isArray(projectIndex && projectIndex.resources) ? projectIndex.resources : [];
  const max = Number.isFinite(limit) ? limit : 8;
  const names = res
    // ★ BUG-A：同 isExported（勿改回真值判断）★
    .filter((r) => r && r.pkg === targetPkg && isExported(r.exported) && r.type === 'image' && r.name)
    .map((r) => String(r.name));
  const shown = names.slice(0, max);
  return names.length > max ? [...shown, `…(共 ${names.length} 个)`] : shown;
}

/**
 * ADD 分类（§5 / D3）：target-ir 必需 + 资源已登记 + id 分配。
 *
 * blocked 情形（永不静默，note 必须可读且区分行动）：
 *   · 无 --target-ir（或 node 不在 target-ir）→ 无 bbox/type/text 可依；
 *   · type=smartobject → 无对应节点类型；
 *   · image 资源**未登记** → 先导入素材并登记 package.xml（`ADD_RESOURCE_NOT_REGISTERED`）；
 *   · image 资源**已登记但未 exported** → 去 package.xml 标成导出（`ADD_RESOURCE_NOT_EXPORTED`，BUG-A）；
 *   · image 资源**同名但类型不是图片** → 确认素材类型/导入正确图片（`ADD_RESOURCE_TYPE_MISMATCH`，P1-2）；
 *   · image 资源**多候选**（精确或归一后同名/id 相撞）→ 不猜（`ADD_RESOURCE_AMBIGUOUS`，P1-2）；
 *   · **包 id 无法确定** → 不降级生成无效 `ui://`（`PKGID_MISSING`）。
 * 本工具**永不自动修改** package.xml（PRD R4-F6）。
 *
 * @param {Object} a
 * @param {Object} entry
 * @returns {Object}
 */
function classifyAdd(a, entry) {
  const { diff, targetIr, projectIndex, targetPkg, ids, warnings } = a;
  const layer = irLayerOf(targetIr, entry.node);
  if (!layer) {
    entry.status = STATUS.BLOCKED;
    entry.note = 'ADD 需要 --target-ir（且该条目的 node 必须能在 target-ir 里找到）'
      + ' —— 否则拿不到 type/bbox/text，无法生成节点';
    warnings.push({
      code: 'ADD_NO_TARGET_IR', op: 'ADD', slot: entry.slot, node: entry.node,
      msg: `ADD 条目 slot='${entry.slot}' 缺少 target-ir 数据，已 blocked`,
    });
    return entry;
  }

  const type = layer.type;
  if (type === 'smartobject') {
    entry.status = STATUS.BLOCKED;
    entry.note = '智能对象（smartobject）没有对应的 FGUI 节点类型 —— 需人工决定展开方式，已 blocked';
    warnings.push({
      code: 'ADD_SMARTOBJECT', op: 'ADD', slot: entry.slot, node: entry.node,
      msg: `ADD 条目 slot='${entry.slot}' 的 IR 类型是 smartobject，无法自动生成，已 blocked`,
    });
    return entry;
  }
  const tag = ADD_TAG_BY_TYPE[type];
  if (!tag) {
    entry.status = STATUS.BLOCKED;
    entry.note = `IR 类型 '${type}' 无法映射到 FGUI 节点 —— 已 blocked，请人工确认`;
    warnings.push({
      code: 'ADD_UNKNOWN_TYPE', op: 'ADD', slot: entry.slot, node: entry.node,
      msg: `ADD 条目 slot='${entry.slot}' 的 IR 类型 '${type}' 无对应节点，已 blocked`,
    });
    return entry;
  }

  // ---- 图片资源解析（仅 image）----
  const attrs = {};
  if (tag === 'image') {
    const keys = [entry.slot, diff.normName, diff.baseName].filter((k) => typeof k === 'string' && k);
    // ADD 的是图片 → 只允许匹配 type==='image' 的资源（P1-2 问题 A）
    const hit = findExportedResource(projectIndex, targetPkg, keys, a.normOpts, { type: 'image' });
    if (!hit.match) {
      // ★ blocked 也要可操作：列出目标包内已导出的图片名（纯信息，不参与匹配）★
      const available = listExportedImageNames(projectIndex, targetPkg);
      const keysText = JSON.stringify(keys.filter(Boolean));
      // ★ 三种失败必须分开（给用户的行动不同，且都不许静默）★
      //   ambiguous    → 工程里有多个同名资源，不猜
      //   not_exported → 已登记但 exported≠"true"（画师刻意不发布）→ 去 package.xml 标成导出
      //   none         → 未登记 → 先导入素材
      const status = hit.status;
      const candText = hit.candidates.length ? `（${hit.candidates.join(', ')}）` : '';
      entry.status = STATUS.BLOCKED;
      if (status === RESOURCE_MATCH.AMBIGUOUS) {
        entry.note = `图片资源 ${keysText} 在目标包 package.xml 里命中 ${hit.candidates.length} 个候选`
          + `${candText} —— 多个资源同名/id 相撞，**禁止自动取第一个**`
          + '（否则会静默绑到错误的资源）。请把 change_plan 的 slot 改成与目标资源名完全一致后重跑 prepare';
      } else if (status === RESOURCE_MATCH.TYPE_MISMATCH) {
        entry.note = `图片资源 ${keysText} 在目标包 package.xml 里有同名条目，但**类型不是图片**${candText}`
          + ' —— ADD 的是图片节点，不能引用非图片资源。'
          + '请确认素材类型是否正确，或导入正确的图片资源后重跑 prepare';
      } else if (status === RESOURCE_MATCH.NOT_EXPORTED) {
        entry.note = `图片资源 ${keysText} 已登记在目标包 package.xml 中${candText}，但 **exported 不是 "true"**`
          + '（画师刻意未导出）—— 本工具不会引用未导出的资源。'
          + '请先把该资源在 package.xml 里标成导出（exported="true"）后重跑 prepare'
          + '（本工具**永不自动修改** package.xml，PRD R4-F6）';
      } else {
        entry.note = `图片资源 ${keysText} 未在目标包 package.xml 中登记`
          + ' —— 需先导入素材并登记 package.xml（本工具**永不自动修改** package.xml，PRD R4-F6），'
          + '登记后重跑 prepare'
          + (available.length
            ? `。目标包内已导出的图片：${available.join(', ')}（如目标资源已在此列，请把 change_plan 的 slot 改成与资源名一致）`
            : '。目标包内当前**没有任何**已导出的图片资源');
      }
      warnings.push({
        code: status === RESOURCE_MATCH.AMBIGUOUS ? 'ADD_RESOURCE_AMBIGUOUS'
          : status === RESOURCE_MATCH.TYPE_MISMATCH ? 'ADD_RESOURCE_TYPE_MISMATCH'
            : status === RESOURCE_MATCH.NOT_EXPORTED ? 'ADD_RESOURCE_NOT_EXPORTED'
              : 'ADD_RESOURCE_NOT_REGISTERED',
        op: 'ADD', slot: entry.slot, node: entry.node,
        msg: status === RESOURCE_MATCH.AMBIGUOUS
          ? `ADD 条目 slot='${entry.slot}' 命中多个同名资源${candText}—— 不猜，已 blocked`
          : status === RESOURCE_MATCH.TYPE_MISMATCH
            ? `ADD 条目 slot='${entry.slot}' 的同名资源不是图片类型${candText}，已 blocked`
            : status === RESOURCE_MATCH.NOT_EXPORTED
              ? `ADD 条目 slot='${entry.slot}' 的资源未 exported（package.xml 里 exported≠"true"），已 blocked`
              : `ADD 条目 slot='${entry.slot}' 的资源未登记（需先登记 package.xml），已 blocked`,
      });
      return entry;
    }
    const res = hit.match;
    const pkgId = a.pkgId;
    // ★ 包 id 无法确定时**不许降级生成**（外部审查 P1，team-lead 已采纳）★
    //   原来按包名降级生成 `ui://<pkgName>/<id>` —— 那等于**生成一个大概率无效的
    //   引用**（与 BUG-A 同性质：静默生成无效内容）。且 ui:// 的真实写法
    //   （斜杠风格 vs Bridge 拼接风格）尚未与真实工程对账，生成什么都只能算猜。
    //   故改为 blocked：不构造 src，条目不可执行，PKGID_MISSING 保留说明原因。
    if (!pkgId) {
      entry.status = STATUS.BLOCKED;
      entry.note = `目标包 '${targetPkg}' 的包 id 无法确定（package.xml 里取不到 pkgId）`
        + ' —— 缺包 id 无法构造合法的 ui:// 引用，**不降级猜测生成**。'
        + '请确认 package.xml 中包 id 的落盘位置（Q3 缺口，需真实工程副本对账）后重跑 prepare';
      warnings.push({
        code: 'PKGID_MISSING', op: 'ADD', slot: entry.slot, node: entry.node,
        msg: `ADD 条目 slot='${entry.slot}' 因目标包 '${targetPkg}' 缺 pkgId 被 blocked`
          + '（不降级生成 ui:// 引用，避免生成无效引用）',
      });
      return entry;
    }
    attrs.src = `ui://${pkgId}/${res.id}`;
  }

  // ---- 属性：id / name / xy / size / text / color / alpha ----
  attrs.id = ids.next(tag === 'component' ? 'c' : 'b');
  attrs.name = entry.slot;
  const xy = bboxToXy(layer.bbox);
  const size = bboxToSize(layer.bbox);
  if (xy) attrs.xy = xy;
  if (size) attrs.size = size;

  const notes = [];
  if (layer.type === 'text' && layer.text && typeof layer.text === 'object') {
    if (typeof layer.text.value === 'string') attrs.text = layer.text.value;
    const color = layer.text.color;
    if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
      attrs.color = color;
    } else if (color !== undefined && color !== null) {
      // ★ R-03 铁律：绝不写 8 位/非法色（运行时只取后 6 位 → 静默错色）★
      warnings.push({
        code: 'ADD_COLOR_REJECTED', op: 'ADD', slot: entry.slot, node: entry.node,
        msg: `IR text.color=${JSON.stringify(color)} 非 6 位 #RRGGBB —— 已拒绝写入该属性（R-03 铁律）`,
      });
    }
  }
  // QA 前瞻纪律：opacity < 1 必须映射为 alpha（否则半透明被静默写丢）
  const opacity = layer.opacity;
  if (typeof opacity === 'number' && Number.isFinite(opacity) && opacity < 1) {
    attrs.alpha = String(round6(opacity)); // §8.5：浮点统一 round6 定点化
    if (opacity <= 0) notes.push('opacity<=0（图层不可见）');
  }

  const strategy = diff.fguiStrategy && typeof diff.fguiStrategy === 'object' ? diff.fguiStrategy : {};
  if (strategy.button !== undefined) {
    notes.push(`策略提示按钮类型=${JSON.stringify(strategy.button)}（不自动猜控件类型，`
      + '可在 gen_plan.json 改 patch.tag 或加 extention 属性后重跑 dryrun）');
  }
  notes.push('z-order：ADD 追加到 displayList 末尾（after=null），不推断层级');

  entry.status = STATUS.RESOLVED;
  entry.patch = { tag, attrs, after: null };
  entry.note = notes.join('；');
  return entry;
}

/**
 * 把目标文件路径相对化到 **FGUI 工程根**（M2-SPEC §4：`assets/MailDetail/MailDetail.xml`）。
 *
 * ★ 为什么需要这一步 ★（team-lead 实测 + 本轮修正）
 *   `project_index.components[].file` 是**相对 CLI rootDir** 的，实测形如
 *   `out/<tmp>/project/assets/MailDetail/MailDetail.xml`。直接沿用它既不符合
 *   §4 的字段语义，又把临时目录路径写进了**人可读、可编辑**的 gen_plan.json。
 *
 * ★ 相对化失败时不许猜 ★
 *   文件不在工程根下（跨盘、`outside-root/` 降级形态等）→ 保留 index 原值，
 *   并显式 warning（`TARGET_FILE_NOT_UNDER_PROJECT_ROOT`，note 同时给出
 *   「工程根」与「index 原始路径」两条信息）交给人工判断，绝不静默。
 *
 * 相对化**复用** `core/determinism.toPosixRel`（不自己拼字符串）。
 *
 * @param {string|null} file index 里的路径（绝对或相对 CLI rootDir）
 * @param {string|null|undefined} projectRoot FGUI 工程根（绝对路径）
 * @param {string|undefined} rootDir CLI rootDir（用于把相对 file 变绝对；缺省 process.cwd()）
 * @param {Object[]} warnings 收集器
 * @returns {string|null}
 */
function relativizeTargetFile(file, projectRoot, rootDir, warnings) {
  if (!file) return file;
  if (!projectRoot) return file; // 未给工程根 → 原样（调用方未启用该能力）
  const base = rootDir || process.cwd();
  const abs = path.isAbsolute(file) ? file : path.resolve(base, file);

  let rel = null;
  try {
    rel = toPosixRel(projectRoot, abs);
  } catch (err) {
    rel = null; // 两侧不在同一根（Windows 跨盘等）
  }
  // 判定「不在工程根下」：空、绝对路径、带盘符、或以 .. 开头
  const outside = !rel || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith('..');
  if (outside) {
    warnings.push({
      code: 'TARGET_FILE_NOT_UNDER_PROJECT_ROOT',
      msg: `目标文件不在 FGUI 工程根下 —— 已保留 index 原值，不做猜测：`
        + `工程根=${projectRoot}；index 原始路径=${file}`
        + '（若这是预期的「工程外引用」，请人工核对 gen_plan.json 的 target.file）',
    });
    return file;
  }
  return rel;
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
  // ★ target.file 输出到「FGUI 工程根相对」；失败时保留原值 + 显式 warning（不猜）★
  const targetFile = relativizeTargetFile(file, a.projectRoot, a.rootDir, a.warnings || []);

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
      // ★ target.file = 工程根相对路径（§4）；内容查找仍用 index 原始键（file）★
      file: targetFile,
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
  buildNodeIndex,
  collectDisplayNodes,
  resolveNodeByName,
  baseNameOf,
  classifyDiff,
  classifyAdd,
  createIdAllocator,
  findExportedResource,
  listExportedImageNames,
  relativizeTargetFile,
  isExported,
  RESOURCE_MATCH,
  summarize,
  GEN_PLAN_VERSION,
  DEFAULT_NORM_OPTS,
  STATUS,
};
