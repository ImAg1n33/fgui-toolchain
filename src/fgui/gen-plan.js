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

  // ────────────────────────────────────────────────────────────────────────
  // ② 目标组件 + 节点索引（D2）
  // ────────────────────────────────────────────────────────────────────────
  const task = changePlan.task || {};
  const components = Array.isArray(projectIndex.components) ? projectIndex.components : [];
  const target = components.find((c) => c && c.pkg === task.targetPkg && c.name === task.name) || null;
  const file = target ? target.file : null;
  const content = file && typeof targetContents[file] === 'string' ? targetContents[file] : null;
  if (target && content === null) {
    warnings.push({
      code: 'TARGET_CONTENT_MISSING',
      msg: `目标文件 ${file} 的内容未随 targetContents 传入 —— 节点匹配将全部零命中（请检查 CLI 读取）`,
    });
  }
  const nodeIndex = buildNodeIndex(content);
  if (nodeIndex.parseError) {
    warnings.push({
      code: 'TARGET_PARSE_FAILED',
      msg: `目标组件 XML 解析失败：${nodeIndex.parseError} —— 节点匹配不可用`,
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // ③ op → 补丁指令（§5），blocked/skipped 永不静默
  // ────────────────────────────────────────────────────────────────────────
  const entries = keptDiffs.map((diff) => classifyDiff({
    diff,
    nodes: nodeIndex.nodes,
    baseIr,
    targetIr,
    targetPkg: task.targetPkg,
    pkgId: resolvePkgId(projectIndex, task.targetPkg),
    projectIndex,
    warnings,
  }));

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
 * @param {Object} a.ids id 分配器（block 3 注入）
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

  // ADD 单独分支（需要 id 分配 + 资源解析）
  if (op === 'ADD') return classifyAdd(a, entry);

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
    const patches = [{ attr: 'size', value: size }];
    // scale9grid 仅在策略**显式**给出 且 目标节点是 image 时设置（D4 / §5）
    const s9 = strategy.scale9grid && typeof strategy.scale9grid === 'object'
      ? strategy.scale9grid.scale9grid : null;
    if (s9) {
      const targetNode = nodes.find((n) => n.id === hit.nodeId);
      if (targetNode && targetNode.tag === 'image') {
        patches.push({ attr: 'scale9grid', value: String(s9) });
      } else {
        a.warnings.push({
          code: 'SCALE9GRID_SKIPPED', op, slot, node,
          msg: `策略给出 scale9grid='${s9}' 但目标节点不是 image`
            + `（tag=${targetNode ? targetNode.tag : '?'}）—— 已跳过该补丁`,
        });
      }
    }
    // ⚠ 多补丁时为数组形态（§4 只定义了单对象；此为本轮唯一的接口补充，已上报）
    entry.patch = patches.length === 1 ? patches[0] : patches;
    if (Array.isArray(entry.patch)) {
      entry.note = '本条目含多个属性补丁（size + scale9grid），patch 为数组形态';
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

  // 未知 op：不静默
  entry.status = STATUS.BLOCKED;
  entry.note = `未知 op '${op}' —— 照实记录但无法生成补丁，请人工核对 change_plan.json`;
  a.warnings.push({ code: 'UNKNOWN_OP', op, slot, node, msg: `未知 op '${op}'（slot='${slot}'）` });
  return entry;
}

/**
 * ADD 分类（block 3 实现：id 分配 + 资源解析 + 文本/颜色属性）。
 * @param {Object} a
 * @param {Object} entry
 * @returns {Object}
 */
function classifyAdd(a, entry) {
  entry.status = STATUS.BLOCKED;
  entry.note = 'ADD 处理待实现（内部占位）';
  return entry;
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
  buildNodeIndex,
  collectDisplayNodes,
  resolveNodeByName,
  baseNameOf,
  classifyDiff,
  summarize,
  GEN_PLAN_VERSION,
  STATUS,
};
