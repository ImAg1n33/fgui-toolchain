'use strict';
/**
 * src/create/plan-markdown.js —— create_plan.md 渲染（纯函数，确定性）
 *
 * 人可读报告的唯一目的：**让人知道哪些地方不该直接信机器**。
 * 故固定包含「待人工确认」一节 —— 汇总 toImport / unresolved / deferred / 估计值。
 */

/**
 * 渲染 create_plan.md。
 * @param {Object} plan buildCreatePlan 的返回值
 * @returns {string}
 */
function renderPlanMarkdown(plan) {
  const p = plan || {};
  const s = p.summary || { nodes: 0, reused: 0, toImport: 0, deferred: 0, unresolved: 0 };
  const lines = [];
  const push = (x) => lines.push(x);

  push(`# CREATE 计划：${(p.page && p.page.name) || '(未命名)'}`);
  push('');
  // ★ 画布来源必须醒目：坐标基准错了整页就错（外部审查 P0）★
  const cv = p.canvas || {};
  const srcText = { ir: '来自 Design IR', cli: '--canvas 显式指定', default: '⚠️ 默认值（IR 未提供画布）' }[cv.source]
    || '(未知)';
  const mismatch = cv.mismatch
    ? ` —— ⚠️ 与 IR 画布 ${cv.irCanvas ? `${cv.irCanvas.w}×${cv.irCanvas.h}` : '?'} 不一致，`
      + 'IR 坐标**未做缩放换算**，请确认'
    : '';
  push(`> **画布：${cv.w}×${cv.h}（${srcText}）**${mismatch}`);
  push('');
  // ★ 就绪度一行（外部审查：别把「计划生成成功」当成「可以构建」）★
  const rd = p.readiness || { status: '(未知)', blockers: [] };
  const rdText = {
    ready: '✅ ready —— 无待人工项，可交给 Executor',
    'needs-human': '⚠️ needs-human —— 需人工处理下列事项后才能构建',
    blocked: '⛔ blocked —— 存在结构性未决项，**不可**构建',
  }[rd.status] || rd.status;
  const blockerText = (rd.blockers || []).length
    ? `（${rd.blockers.map((b) => `${b.kind}=${b.count}`).join('，')}）`
    : '';
  push(`> **就绪度：${rdText}${blockerText}**`);
  push('');
  push(`- 模式：**CREATE**（只由 Design IR + 工程索引生成，不依赖任何已存在的组件 XML）`);
  push(`- 目标包：\`${(p.page && p.page.pkg) || '(未指定)'}\``);
  push(`- 节点数：${s.nodes}（复用资源 ${s.reused}，待导入 ${s.toImport}，未决 ${s.unresolved}）`);
  push('');

  push('## 节点（底 → 顶）');
  push('');
  push('| # | layer | tag | name | xy | size | src |');
  push('|---|---|---|---|---|---|---|');
  for (const n of p.nodes || []) {
    const a = n.attrs || {};
    push(`| ${n.tempId} | ${n.layer} | ${n.tag} | \`${n.name}\` | ${a.xy || ''} | ${a.size || ''} `
      + `| ${a.src ? `\`${a.src}\`` : '—'} |`);
  }
  push('');

  // ---- 已自动处理（可审计，不是问题）----
  const decisions = Array.isArray(p.decisions) ? p.decisions : [];
  if (decisions.length) {
    push('## 已自动处理');
    push('');
    for (const d of decisions) {
      if (d.kind === 'proportional-scale') {
        push(`- 图层 \`${d.layerId}\`：等比缩放 scale=${d.scale}（${d.from} → ${d.to}）`
          + `${d.aspectPreserved ? '' : '，**宽高比不一致，已居中并留白**'}`);
      } else if (d.kind === 'pkg-auto-selected') {
        push(`- 目标包：未指定 \`--pkg\`，索引里只有一个包 \`${d.pkg}\`，已自动采用`);
      } else {
        push(`- ${d.kind}：${JSON.stringify(d)}`);
      }
    }
    push('');
  }

  // ---- 待人工确认（测试 ⑧ 要求本节存在）----
  push('## 待人工确认');
  push('');
  const items = [];

  for (const t of (p.assets && p.assets.toImport) || []) {
    items.push(`- **需要导入素材**：图层 \`${t.layerId}\` → 建议文件名 \`${t.suggestedName}\``
      + `（${t.w}×${t.h}）；原因：${t.reason}。导入后需在 package.xml 登记，再重跑 create-plan。`);
  }
  for (const u of p.unresolved || []) {
    items.push(`- **未决（${u.reason}）**：图层 \`${u.layerId}\` —— ${u.hint}`);
  }
  for (const d of (p.deferred && p.deferred.listItems) || []) {
    items.push(`- **列表项建议**：\`${d.suggestion}\`（样本节点 ${d.sampleNode}）—— ${d.reason}`);
  }
  for (const d of (p.deferred && p.deferred.controllers) || []) {
    items.push(`- **Controller 建议**：\`${d.suggestion}\` —— ${d.reason}`);
  }
  for (const d of (p.deferred && p.deferred.relations) || []) {
    items.push(`- **Relations/结构建议**：\`${d.suggestion}\` —— ${d.reason}`);
  }
  for (const n of p.nodes || []) {
    if (n.estimated) {
      items.push(`- **估计值**：节点 ${n.tempId}（\`${n.name}\`）的 ${(n.estimatedFields || []).join('/')}`
        + ' 为估计值，需人工核对');
    }
  }
  if (!items.length) items.push('- （无：本次没有需要人工确认的项）');
  for (const it of items) push(it);
  push('');

  if ((p.warnings || []).length) {
    push('## 告警');
    push('');
    for (const w of p.warnings) push(`- \`${w.code}\`：${w.msg}`);
    push('');
  }

  push('## v1 明确不做');
  push('');
  push('- 不生成 controller / relations / gear（deferred 里只给建议）');
  push('- 不调用 Bridge、**不写任何 FGUI 文件**、不做视觉对比');
  push('- 不自动建列表项/按钮组件');
  push('');
  return lines.join('\n');
}

module.exports = { renderPlanMarkdown };
