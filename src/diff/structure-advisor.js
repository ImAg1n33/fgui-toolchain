'use strict';
/**
 * src/diff/structure-advisor.js —— 结构建议（只**建议**，不写死策略）
 *
 * 四类建议（PRD R3「结构建议」段）：
 *   1. 重复结构 → GList + 独立 Cell 组件（依据 STANDARDS §2「禁止在页面里平铺 N 份 cell」）
 *   2. 复用件   → 建议抽 common/PanelFrame 子组件
 *   3. 双态按钮 → 建议 Button mode="Check" 或 grayed 切换，而不是做两份
 *   4. 与存量 FGUI 工程相似度 → 命中则输出 REUSE_EXISTING_COMPONENT（P1 才有工程副本，本轮跳过）
 *
 * ★ 设计原则：只建议，不决策 ★（ARCHITECTURE §3.1）
 *   建议写进 ChangePlan 的 structureAdvice 数组，人可采纳也可忽略。
 *   任何一条建议都**不得**自动改变 diffs 里的 op —— 那是人的决定。
 *
 * 纯计算，不碰文件系统。
 */

const { OP } = require('./classifier');

/** 建议类型。 */
const ADVICE = Object.freeze({
  LIST: 'list',
  REUSE_COMPONENT: 'reuse_component',
  DUAL_STATE_BUTTON: 'dual_state_button',
  UNNAMED_SLOT: 'unnamed_slot',
});

/**
 * 找出一个父级下「同尺寸 + 等距」的兄弟节点簇。
 *
 * @param {Object[]} layers 目标态全部图层
 * @param {Object[]} candidates 已判为 ADD 的节点
 * @param {Object} cfg
 * @returns {Object[]} 找到的簇，每簇含 { items, gap, axis, cellSize }
 */
function findRepeatedClusters(layers, candidates, cfg) {
  const minCount = cfg.minRepeatCount === undefined ? 3 : cfg.minRepeatCount;
  const sizeTol = cfg.sizeTolerancePx === undefined ? 2 : cfg.sizeTolerancePx;
  const groups = new Map();
  for (const l of candidates) {
    if (!l || l.type === 'group') continue;
    const key = l.parent || '__root__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }

  const clusters = [];
  for (const [parentKey, siblings] of [...groups.entries()].sort()) {
    if (siblings.length < minCount) continue;
    // 按 (x,y) 排序保证确定性
    const sorted = [...siblings].sort((a, b) => (a.bbox.x - b.bbox.x) || (a.bbox.y - b.bbox.y));
    // 以第一个节点为基准，检查其余节点是否同尺寸 + 等距（允许水平或垂直）
    const base = sorted[0];
    const sameSize = sorted.filter((s) => Math.abs(s.bbox.w - base.bbox.w) <= sizeTol
      && Math.abs(s.bbox.h - base.bbox.h) <= sizeTol);
    if (sameSize.length < minCount) continue;

    const sameRow = sameSize.every((s) => Math.abs(s.bbox.y - base.bbox.y) <= sizeTol);
    const sameCol = sameSize.every((s) => Math.abs(s.bbox.x - base.bbox.x) <= sizeTol);
    if (!sameRow && !sameCol) continue;

    // 间距一致性
    const gaps = [];
    for (let i = 1; i < sameSize.length; i++) {
      const a = sameSize[i - 1];
      const b = sameSize[i];
      gaps.push(sameRow ? b.bbox.x - (a.bbox.x + a.bbox.w) : b.bbox.y - (a.bbox.y + a.bbox.h));
    }
    const gap = gaps.length ? Math.min(...gaps) : 0;
    // 间距不一致就不认为是「等距重复结构」（只差 1px 的容差内算一致）
    const gapConsistent = gaps.every((g) => Math.abs(g - gap) <= 1);

    clusters.push({
      parent: parentKey === '__root__' ? null : parentKey,
      items: sameSize.map((s) => s.id),
      axis: sameRow ? 'flow_hz' : 'flow_vz',
      gap,
      gapConsistent,
      cellSize: { w: base.bbox.w, h: base.bbox.h },
    });
  }
  return clusters;
}

/**
 * 生成结构建议。
 *
 * @param {Object} args
 * @param {Object[]} args.targetLayers 目标态全部图层
 * @param {Object[]} args.diffs 已分类的 PlanDiff[]
 * @param {Object} [args.config] diff 配置
 * @returns {Object[]} structureAdvice
 */
function advise(args) {
  const cfg = args.config || {};
  const minCount = cfg.minRepeatCount === undefined ? 3 : cfg.minRepeatCount;
  const targetLayers = args.targetLayers || [];
  const diffs = args.diffs || [];
  const byId = new Map(targetLayers.map((l) => [l.id, l]));
  const advice = [];

  // ---- 1. 重复结构 -> GList + Cell ----
  const addedNodes = diffs.filter((d) => d.op === OP.ADD).map((d) => byId.get(d.node)).filter(Boolean);
  for (const cluster of findRepeatedClusters(targetLayers, addedNodes, { ...cfg, minCount })) {
    if (cluster.items.length < minCount || !cluster.gapConsistent) continue;
    const slotBase = cluster.items[0];
    advice.push({
      type: ADVICE.LIST,
      slot: slotBase ? (slotBase.normName || slotBase.name) : '',
      reason: `同一父级下有 ${cluster.items.length} 个 ${cluster.cellSize.w}x${cluster.cellSize.h} `
        + `${cluster.axis === 'flow_hz' ? '水平' : '垂直'}等距节点（间距均为 ${cluster.gap}px），`
        + '符合 STANDARDS §2「禁止在页面里平铺 N 份 cell」的典型形态',
      suggestion: {
        // ★ 注意拼写：上游就是 extention（不是 extension），见 fgui/constants.js
        extention: 'List',
        layout: cluster.axis,
        defaultItem: `${slotBase ? (slotBase.normName || 'Item') : 'Item'}Cell`,
        itemCount: cluster.items.length,
        itemSize: [cluster.cellSize.w, cluster.cellSize.h],
        gap: cluster.gap,
        nodeIds: cluster.items.slice().sort(),
      },
      _comment: '建议用 GList + 独立 Cell 组件承载重复结构，而不是在页面里平铺 N 份。'
        + '本条仅为建议，是否采纳由人决定。',
    });
  }

  // ---- 2. 复用件 -> 抽公共子组件 ----
  // 判据：多个 slice / 归一名在基准态与目标态**同时出现**且都是「框架类」名字
  const reusedSlices = diffs
    .filter((d) => d.op === OP.REUSE && d.fguiStrategy && d.fguiStrategy.type === 'reuse')
    .map((d) => (d.fguiStrategy.detail && d.fguiStrategy.detail.refName) || '')
    .filter(Boolean);
  const frameLike = reusedSlices.filter((n) => /bg|frame|panel|底|框|边|底框|背景/i.test(n));
  if (frameLike.length >= 3) {
    advice.push({
      type: ADVICE.REUSE_COMPONENT,
      slot: frameLike[0],
      reason: `有 ${frameLike.length} 个框架类素材（${frameLike.slice(0, 5).join('、')}）`
        + '在两态中反复出现，属于典型的「弹窗底 + 边框 + 装饰」复用件',
      suggestion: {
        package: 'Common',
        component: 'PanelFrame',
        members: frameLike.slice().sort(),
        note: '建议抽成 common/PanelFrame 子组件，多页面复用',
      },
      _comment: '仅建议；实际抽组件需要人确认素材是否真的可复用（透明叠层/遮挡关系会影响结果）。',
    });
  }

  // ---- 3. 双态按钮 ----
  // 判据：出现 grayed/grey/disabled/灰 关键字，或同一位置存在两个尺寸相近的按钮
  const btnLike = targetLayers.filter((l) => /btn|button|按钮|领取|claim/i.test(l.name || ''));
  const grayedLike = btnLike.filter((l) => /gray|grey|disabled|disable|灰/i.test(l.name || ''));
  if (grayedLike.length) {
    advice.push({
      type: ADVICE.DUAL_STATE_BUTTON,
      slot: grayedLike[0].normName || grayedLike[0].name,
      reason: `存在 ${grayedLike.length} 个带灰置语义命名的按钮节点`
        + `（${grayedLike.map((l) => l.name).join('、')}）`,
      suggestion: {
        extention: 'Button',
        mode: 'Check',
        states: ['normal', 'grayed'],
        note: '建议用 Button 双态/controller 切换，而不是做两份图；'
          + '「灰置条件由代码还是图控」需与小 Q 确认（PRD Q15）',
      },
      _comment: '双态按钮走 grayed / controller gear，而不是做两份资源。',
    });
  }

  // ---- 4. 无语义槽位名提醒 ----
  const unnamed = diffs.filter((d) => /^n\d+$|^img\d+$|^图层\d+$|^矩形\d+$/.test(d.slot || ''));
  if (unnamed.length) {
    advice.push({
      type: ADVICE.UNNAMED_SLOT,
      slot: unnamed[0].slot,
      reason: `有 ${unnamed.length} 个节点的槽位名仍是无语义的画师原始命名`
        + `（如 ${unnamed.slice(0, 3).map((d) => d.slot).join('、')}）`,
      suggestion: {
        note: 'PRD §8.3 要求 slot 必须业务语义化（禁止 n0/img1/图层129 这类名）。'
          + '请人工改名为 popup_bg / btn_close / reward_list 等语义名后再进 P1',
        affected: unnamed.map((d) => d.slot).slice(0, 20).sort(),
      },
      _comment: '语义命名是 STANDARDS 的硬约束，P1 生成 XML 前必须处理。',
    });
  }

  return advice;
}

/**
 * 收集 openQuestions（需要人回答的问题）。
 *
 * @param {Object} args
 * @param {Object[]} args.diffs
 * @param {Object[]} args.advice
 * @param {Object} args.baseIr
 * @param {Object} args.targetIr
 * @returns {string[]}
 */
function collectOpenQuestions(args) {
  const questions = [];
  const diffs = args.diffs || [];
  const advice = args.advice || [];

  // INFERRED 必须逐条问
  const inferred = diffs.filter((d) => d.op === OP.INFERRED);
  if (inferred.length) {
    questions.push(
      `有 ${inferred.length} 个节点因合并图层/证据不足被判为 INFERRED（默认 skip），`
      + `涉及：${inferred.slice(0, 8).map((d) => `${d.slot}(${d.node})`).join('、')}`
      + (inferred.length > 8 ? ' 等' : '')
      + '。请人工确认它们是新增还是已有素材的重复引用。',
    );
  }

  // 列表建议要问列数
  for (const a of advice) {
    if (a.type === ADVICE.LIST) {
      questions.push(
        `『${a.slot}』建议改为 ${a.suggestion.extention} + ${a.suggestion.layout}`
        + `（${a.suggestion.itemCount} 项 × ${a.suggestion.itemSize.join('x')}，间距 ${a.suggestion.gap}px），`
        + '是否符合策划预期的列数与间距？',
      );
    }
    if (a.type === ADVICE.DUAL_STATE_BUTTON) {
      questions.push('领取/确认按钮的灰置条件由代码控制还是图控？这决定是否生成 grayed 双态或 controller gear（PRD Q15）。');
    }
  }

  // 切片缺失要问（Q7）
  const baseSlices = (args.baseIr && args.baseIr.sliceNames) || [];
  const targetSlices = (args.targetIr && args.targetIr.sliceNames) || [];
  if (!baseSlices.length || !targetSlices.length) {
    questions.push(
      'PSD 内未检测到导出切片信息，L1 最强匹配通道不可用，只能靠归一名 + pHash。'
      + '若画师能在 Photoshop 中保留切片，匹配准确率会显著提升（PRD Q7，需小 Q 确认）。',
    );
  }

  // 合并组要问
  const mergedWarnings = [
    ...((args.baseIr && args.baseIr.warnings) || []),
    ...((args.targetIr && args.targetIr.warnings) || []),
  ].filter((w) => w.code === 'MERGED_LAYER_GROUP');
  if (mergedWarnings.length) {
    questions.push(
      `检测到 ${mergedWarnings.length} 个被合并的组（${mergedWarnings.map((w) => w.layer).join('、')}）。`
      + '这些组内图层信息不可恢复，需要画师提供未合并版本，或人工确认其素材对应关系。',
    );
  }

  return questions;
}

module.exports = { advise, collectOpenQuestions, findRepeatedClusters, ADVICE };
