'use strict';
/**
 * src/diff/planner.js —— 组装 ChangePlan + openQuestions
 *
 * 把 matcher 的配对结果与 classifier 的分类结果组装成 ARCHITECTURE §3.4 的 ChangePlan：
 *   { version, task, sources, summary, diffs[], structureAdvice[], openQuestions[] }
 *
 * ★ 人可读是硬要求（PRD A10）★
 *   顶层 `_comment` + `_fieldNote` 逐字段说明 + 每条 diff 必带 evidence。
 *   文件**可手工编辑**后续跑 gen-xml（P1）。INFERRED 未确认前不会写入 XML。
 *
 * ★ 确定性（B9）★
 *   · diffs 按 (op, slot, node) 稳定排序
 *   · 浮点全部定点化
 *   · 路径 POSIX 相对化
 *   · **零时间戳**
 */

const { sortBy, toPosixRel } = require('../core/determinism');
const { matchLayers, LEVEL } = require('./matcher');
const {
  classifyPair, classifyUnmatchedTarget, classifyUnmatchedBase, summarize, OP, OP_LABEL,
} = require('./classifier');
const { advise, collectOpenQuestions } = require('./structure-advisor');

/** ChangePlan 版本。 */
const PLAN_VERSION = '1.0';

/**
 * 推断相对关系（MOVE 时优先用 relation）。
 *
 * 判据（保守、可解释）：
 *   若目标层与基准层的**父容器**一致，且相对父容器的偏移变了 -> 可用 relation
 *   否则退用 gearXY
 *
 * @param {Object} base
 * @param {Object} target
 * @returns {{usable:boolean, sidePair:string, describe:string}|null}
 */
function relationOf(base, target, parentBox) {
  if (!parentBox) return null;
  const baseOffX = base.bbox.x - parentBox.x;
  const baseOffY = base.bbox.y - parentBox.y;
  const tgtOffX = target.bbox.x - parentBox.x;
  const tgtOffY = target.bbox.y - parentBox.y;
  if (baseOffX === tgtOffX && baseOffY === tgtOffY) {
    return { usable: false, sidePair: '', describe: '相对父容器偏移未变（实为复用）' };
  }
  // 判断主要位移方向，给出对应的 sidePair 建议
  const dx = tgtOffX - baseOffX;
  const dy = tgtOffY - baseOffY;
  let sidePair = 'left-left';
  let describe;
  if (Math.abs(dx) >= Math.abs(dy)) {
    describe = dx === 0
      ? '水平方向偏移未变'
      : (dx > 0 ? `水平右移 ${dx}px` : `水平左移 ${-dx}px`);
    sidePair = dx > 0 ? 'left-left' : 'right-right';
  } else {
    describe = dy > 0 ? `垂直下移 ${dy}px` : `垂直上移 ${-dy}px`;
    sidePair = dy > 0 ? 'top-top' : 'bottom-bottom';
  }
  return { usable: true, sidePair, describe: `${describe}，相对父容器可表达为 relation` };
}

/**
 * 组装 ChangePlan。
 *
 * @param {Object} args
 * @param {Object} args.baseIr 基准态 Design IR
 * @param {Object} args.targetIr 目标态 Design IR
 * @param {Object} args.task { name, basePkg, targetPkg }
 * @param {Object} [args.config] fgui.config.json
 * @param {Object} [args.index] 素材库（可选，用于 L3 检索兜底与九宫格判定）
 * @param {Object} [args.grid9ByLayerId] layerId -> Grid9VerdictResult（可选）
 * @param {string} [args.rootDir] 相对化基准目录
 * @param {string} [args.fguiProject] 存量 FGUI 工程路径（可空）
 * @returns {Object} ChangePlan
 */
function buildChangePlan(args) {
  const cfg = args.config || {};
  const baseIr = args.baseIr;
  const targetIr = args.targetIr;
  const rootDir = args.rootDir || process.cwd();

  const baseLayers = baseIr.layers || [];
  const targetLayers = targetIr.layers || [];
  // ★★ UPSTREAM-FIX-3：身份加作用域 ★★
  //   两侧 id 各自从 L001 独立编号必然碰撞。所有跨侧查表必须带作用域：
  //   - 按侧建 baseById / targetById；
  //   - merged/suspected 父链爬升按侧各自的表，归属表键为 `base:${id}` / `target:${id}`；
  //   - **绝不把两份图层放进同一张以局部 id 为键的 Map**（旧合并 byId 会
  //     让 base 的父链查到 target 的同名节点，merged 归属互相污染）。
  const baseById = new Map(baseLayers.map((l) => [l.id, l]));
  const targetById = new Map(targetLayers.map((l) => [l.id, l]));

  // 每个图层的 merged/suspected 归属（★ 按侧各自爬父链，跨侧查表会撞 id ★）。
  // ★ UPSTREAM-FIX-4 语义：merged（启发式强判定）与 suspectedMerged（弱信号）
  //   都只影响**未命中去向**（INFERRED / REMOVE 压置信度），不再影响匹配路径。
  const mergedGroupName = new Map(); // `${side}:${layerId}` -> 组名
  /**
   * 单侧父链爬升：找最近的 merged/suspected 祖先组。
   * @param {Object[]} layers 单侧图层
   * @param {Map<string,Object>} byIdSide 单侧查表
   * @param {string} side 'base' | 'target'
   */
  const collectMergedAncestors = (layers, byIdSide, side) => {
    for (const l of layers) {
      let cur = l;
      const seen = new Set();
      while (cur && cur.parent && !seen.has(cur.id)) {
        seen.add(cur.id);
        const p = byIdSide.get(cur.parent);
        if (!p) break;
        if (p.merged || p.suspectedMerged) {
          mergedGroupName.set(`${side}:${l.id}`, p.name);
          break;
        }
        cur = p;
      }
    }
  };
  collectMergedAncestors(baseLayers, baseById, 'base');
  collectMergedAncestors(targetLayers, targetById, 'target');

  // ---- 槽位名：优先用 slice 名，其次归一名，最后画师原名 ----
  const slotOf = (layer) => layer.sliceName || layer.normName || layer.name || layer.id;

  // ---- 九宫格判定来源 ----
  const grid9Of = (layerId) => {
    if (args.grid9ByLayerId && args.grid9ByLayerId[layerId]) return args.grid9ByLayerId[layerId];
    return null;
  };

  // ---- 父容器 bbox（供 relation 推断）：优先取目标态的同 id 父层 ----
  const parentBoxOf = (layer, side) => {
    const table = side === 'base' ? baseById : targetById;
    const p = layer.parent ? table.get(layer.parent) : null;
    if (p) return p.bbox;
    const canvas = (side === 'base' ? baseIr : targetIr).source;
    return canvas ? { x: 0, y: 0, w: canvas.canvas.w, h: canvas.canvas.h } : null;
  };

  // ---- 四级匹配 ----
  const matched = matchLayers({
    baseLayers,
    targetLayers,
    config: cfg.diff,
    index: args.index,
    searchConfig: cfg.search,
  });

  /** @type {Object[]} */
  const diffs = [];

  // ---- 已匹配的 pair -> 分类 ----
  for (const pair of matched.pairs) {
    const base = baseById.get(pair.baseId);
    const target = targetById.get(pair.targetId);
    if (!base || !target) continue;
    const parentBox = parentBoxOf(target, 'target');
    const diff = classifyPair(pair, base, target, {
      cfg: cfg.diff,
      slotOf,
      grid9Of,
      relationOf: (b, t) => relationOf(b, t, parentBox),
    });
    // ★ 显式记录配对的基准侧 id：两侧 id 可能相同，光看 node 无法分辨
    diff.baseNode = base.id;
    diffs.push(diff);
  }

  // ---- 未匹配的目标层 -> ADD / INFERRED ----
  for (const target of matched.unmatchedTarget) {
    const groupName = mergedGroupName.get(`target:${target.id}`);
    diffs.push(classifyUnmatchedTarget(target, {
      cfg: cfg.diff,
      slotOf,
      underMerged: !!groupName,
      groupName,
      grid9: grid9Of(target.id),
      candidates: [],
    }));
  }

  // ---- 未匹配的基准层 -> REMOVE ----
  for (const base of matched.unmatchedBase) {
    const groupName = mergedGroupName.get(`base:${base.id}`);
    const d = classifyUnmatchedBase(base, {
      cfg: cfg.diff, slotOf, underMerged: !!groupName, groupName,
    });
    d.baseNode = base.id;
    diffs.push(d);
  }

  // ---- 组节点本身也产出一条差异（组的增删对组件结构有影响）----
  for (const g of targetLayers.filter((l) => l.type === 'group')) {
    const baseGroup = baseLayers.find((b) => b.type === 'group' && b.normName === g.normName);
    if (!baseGroup) {
      diffs.push({
        op: OP.ADD,
        slot: slotOf(g),
        node: g.id,
        matchLevel: LEVEL.L4,
        confidence: 0.9,
        evidence: `组『${g.name}』在基准态中不存在（bbox 由子层并集推导：`
          + `${g.bbox.x},${g.bbox.y},${g.bbox.w}x${g.bbox.h}）—— 判定为新增容器节点`
          + (g.merged
            ? '；⚠ 该组已被画师合并（启发式），子层信息不可恢复'
            : (g.suspectedMerged ? '；⚠ 该组疑似被合并（启发式弱信号），请人工确认' : '')),
        fguiStrategy: { type: 'list', detail: { hint: '若子层为重复结构，参考 structureAdvice 改为 GList' } },
        candidates: [],
        defaultIfUnconfirmed: 'skip',
        grid9: null,
      });
    }
  }

  // ---- 结构建议 ----
  const advice = advise({ targetLayers, diffs, config: cfg.diff });

  // ---- 确定性排序：(op, slot, node) ----
  const opOrder = Object.values(OP);
  const sortedDiffs = sortBy(diffs,
    (d) => opOrder.indexOf(d.op),
    (d) => d.slot,
    (d) => d.node || '');

  // ---- summary ----
  const rawSummary = summarize(sortedDiffs);
  const summary = { total: rawSummary.total };
  for (const op of opOrder) summary[op] = rawSummary[op] || 0;
  summary.byMatchLevel = {
    L1: matched.stats.l1,
    L2: matched.stats.l2,
    L3: matched.stats.l3,
    L4: matched.stats.l4,
  };
  // ★ 统计口径 ★
  //   直接从最终 diffs 反算：confidence 恰等于 mergedConfidenceCap 的条目数。
  //   UPSTREAM-FIX-4 后这些条目只可能是：L3 弱证据命中疑似合并对象、
  //   疑似合并组内的 REMOVE（L1/L2 精确匹配不再封顶）。
  const cap = cfg.diff && cfg.diff.mergedConfidenceCap !== undefined
    ? cfg.diff.mergedConfidenceCap : 0.5;
  summary.mergedConfidenceCapped = sortedDiffs
    .filter((d) => Math.abs(d.confidence - cap) < 1e-9).length;

  const openQuestions = collectOpenQuestions({
    diffs: sortedDiffs,
    advice,
    baseIr,
    targetIr,
  });

  return {
    version: PLAN_VERSION,
    _comment: '由 fgui-rb diff-plan 生成。**本文件可手工编辑**，后续跑 gen-xml 会读取它。'
      + '每条 diff 的 evidence 字段写明了「为什么这么判」，可逐条复核或推翻。'
      + 'INFERRED 项未确认前不会写入 XML（默认 skip）—— 宁可少做一个节点让人补，也不要错一个。',
    _fieldNote: {
      op: 'REUSE 完全复用 | MOVE 位置调整 | RESIZE 尺寸调整 | RESTYLE 样式调整 '
        + '| ADD 新增 | REMOVE 移除 | INFERRED 待确认',
      slot: '语义槽位名。必须业务语义化（popup_bg/btn_close/reward_list），'
        + '禁止 n0/img1/图层129 这类无语义名（PRD §8.3）',
      node: '目标态 IR 的图层 id（L001 形式）。注意：baseNode 与两侧 id 可能相同（L001/L002…），'
        + '仅靠 node 无法分辨是哪一侧，故同时给出 baseNode',
      baseNode: '基准态 IR 的图层 id。与 node 配对使用',
      matchLevel: 'L1 slice名一致 | L2 归一名全等 | L3 pHash+尺寸+位置 | L4 均未命中',
      confidence: '0..1。L1/L2 精确匹配不封顶（匹配成功即证明未合并）；'
        + 'L3 弱证据命中疑似合并对象、以及疑似合并组内的 REMOVE，封顶 0.5',
      evidence: '人可读的判定依据 —— 复核与推翻的唯一依据，请认真读',
      fguiStrategy: '建议的 FGUI 处理方式；本轮只是建议，P1 才真正生成 XML',
      candidates: 'INFERRED 时的候选切图列表',
      defaultIfUnconfirmed: '未确认时怎么办。当前恒为 skip（PRD K4）',
    },
    _opLabel: OP_LABEL,
    _opLabelNote: 'op 的中文对照，仅供人读',
    task: {
      _comment: '本次差异分析的目标组件与包归属',
      name: (args.task && args.task.name) || 'Unnamed',
      basePkg: (args.task && args.task.basePkg) || 'Common',
      targetPkg: (args.task && args.task.targetPkg) || 'Common',
    },
    sources: {
      _comment: '输入来源。路径一律 POSIX 相对化（确定性要求）',
      psdBase: baseIr.source ? toPosixRel(rootDir, baseIr.source.psdPath) : '',
      psdTarget: targetIr.source ? toPosixRel(rootDir, targetIr.source.psdPath) : '',
      fguiProject: args.fguiProject ? toPosixRel(rootDir, args.fguiProject) : null,
    },
    summary,
    diffs: sortedDiffs,
    structureAdvice: advice,
    openQuestions,
  };
}

/**
 * 生成给人看的 Markdown 修正清单（P1 R4-F7 的 P0 预览版）。
 *
 * @param {Object} plan ChangePlan
 * @returns {string}
 */
function renderPlanMarkdown(plan) {
  const lines = [];
  lines.push(`# ${plan.task.name} 差异分析结果`);
  lines.push('');
  lines.push('> 本文件由 fgui-rb 自动生成，可直接编辑。');
  lines.push('> INFERRED 项默认 skip，未确认前不会写入 FGUI 工程。');
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push('| 差异类型 | 数量 | 含义 |');
  lines.push('|---|---|---|');
  for (const op of Object.values(OP)) {
    lines.push(`| ${op} | ${plan.summary[op] || 0} | ${plan._opLabel[op]} |`);
  }
  lines.push(`| **合计** | **${plan.summary.total}** | |`);
  lines.push('');
  lines.push(`匹配级别分布：L1(slice)=${plan.summary.byMatchLevel.L1}、`
    + `L2(归一名)=${plan.summary.byMatchLevel.L2}、`
    + `L3(pHash)=${plan.summary.byMatchLevel.L3}、`
    + `L4(未命中)=${plan.summary.byMatchLevel.L4}`);
  if (plan.summary.mergedConfidenceCapped) {
    lines.push('');
    lines.push(`⚠ 有 ${plan.summary.mergedConfidenceCapped} 个匹配因位于合并组内，置信度被封顶 0.5。`);
  }
  lines.push('');
  lines.push('## 逐条差异');
  lines.push('');
  for (const d of plan.diffs) {
    lines.push(`### \`${d.op}\` \`${d.slot}\`（${d.node || '-'}）`);
    lines.push('');
    lines.push(`- **匹配级别**：${d.matchLevel}　**置信度**：${d.confidence}　`
      + `**未确认时**：${d.defaultIfUnconfirmed}`);
    lines.push(`- **判定依据**：${d.evidence}`);
    if (d.fguiStrategy) {
      lines.push(`- **建议处理**：\`${d.fguiStrategy.type}\` `
        + `${d.fguiStrategy.detail ? JSON.stringify(d.fguiStrategy.detail) : ''}`);
    }
    if (d.candidates && d.candidates.length) {
      lines.push(`- **候选**：${d.candidates.join('、')}`);
    }
    lines.push('');
  }
  if (plan.structureAdvice.length) {
    lines.push('## 结构建议');
    lines.push('');
    for (const a of plan.structureAdvice) {
      lines.push(`- **[${a.type}]** \`${a.slot}\`：${a.reason}`);
      if (a.suggestion) lines.push(`  - 建议：\`${JSON.stringify(a.suggestion)}\``);
    }
    lines.push('');
  }
  if (plan.openQuestions.length) {
    lines.push('## 需要确认的问题');
    lines.push('');
    plan.openQuestions.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { buildChangePlan, renderPlanMarkdown, relationOf, PLAN_VERSION };
