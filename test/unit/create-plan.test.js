'use strict';
/**
 * test/unit/create-plan.test.js —— CREATE 模式纯函数单测（v0.3-B）
 *
 * 覆盖：命名清洗 / 背景识别 / 层级排序（IR 顶→底 → FGUI 底→顶）/ 资源复用与
 * 短 ID / 未匹配 → toImport / 图标禁止拉伸 / 九宫格建议 / 列表建议 / 重叠 → controller
 * 建议 / 页面名 / 画布解析 / 确定性。
 *
 * ★ fixture 说明 ★：用手写合成 IR（CI 友好、不依赖 PSD）。
 *   真实链路里 `psd-ir` 产出的 design_ir.json 是**同一结构**
 *   （top-level: source/layers/slices/sliceNames；layer: id/name/normName/type/bbox/text/opacity/visible）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCreatePlan, parseCanvas, sanitizeName, pickPageName,
  coversCanvas, detectBackgroundLayerId, collectLeavesBottomToTop, resolveTargetPkg,
  detectVerticalStacks, detectOverlapping, computeReadiness, DEFAULT_CANVAS,
} = require('../../src/create/plan-builder');
const { renderPlanMarkdown } = require('../../src/create/plan-markdown');
const { AppError } = require('../../src/core/errors');

// ────────────────────────────────────────────────────────────────────────────
// 合成 IR（**顺序即 PSD 文档序 = 顶→底**，背景在最后 = 最底）
// ────────────────────────────────────────────────────────────────────────────
function layer(id, name, type, bbox, extra = {}) {
  return {
    id,
    name,
    normName: name.replace(/\s+/g, ''),
    type,
    bbox,
    depth: 0,
    parent: null,
    childCount: 0,
    opacity: 1,
    visible: true,
    merged: false,
    slice: null,
    sliceName: extra.sliceName === undefined ? null : extra.sliceName,
    text: extra.text === undefined ? null : extra.text,
  };
}

function irFixture() {
  return {
    version: '1.0',
    source: { psdPath: 'test/fixtures/golden/state_A.psd', canvas: { w: 750, h: 1334 }, dpr: 1 },
    // 顶 → 底
    layers: [
      layer('L001', '标题', 'text', { x: 148, y: 92, w: 200, h: 36 }, {
        text: { value: '邮件详情', color: '#f5e6c8', fontSize: 26, align: 'left' },
      }),
      layer('L002', '图标', 'raster', { x: 120, y: 200, w: 48, h: 48 }),      // 固有 96x96 → 禁止拉伸
      layer('L003', '按钮底', 'raster', { x: 100, y: 300, w: 200, h: 56 }, { sliceName: 'btn_bg' }),
      layer('L004', '未匹配图', 'raster', { x: 400, y: 300, w: 120, h: 48 }), // 无资源 → toImport
      layer('L005', '行1', 'raster', { x: 24, y: 400, w: 300, h: 60 }),
      layer('L006', '行2', 'raster', { x: 24, y: 464, w: 300, h: 60 }),
      layer('L007', '行3', 'raster', { x: 24, y: 528, w: 300, h: 60 }),
      layer('L008', '背景', 'raster', { x: 0, y: 0, w: 750, h: 1334 }),      // 覆盖全画布 → img_bg
    ],
    slices: [{ groupName: 'P', layer: 'L003', name: 'btn_bg', rect: { x: 100, y: 300, w: 200, h: 56 }, type: 'image' }],
    sliceNames: ['btn_bg'],
  };
}

/** project_index 最小形态（字段与 cmd-project-index.js 产物一致）。 */
function indexFixture() {
  return {
    version: '1.0',
    project: { name: 'P', packages: [{ name: 'Mail', id: 'mtlga5qj' }] },
    resources: [
      // 按钮底：名字与图层名一致，尺寸与 bbox 一致 → 正常复用
      { pkg: 'Mail', pkgId: 'mtlga5qj', type: 'image', id: 'q0abc', name: '按钮底.png', exported: 'true', width: 200, height: 56, scale: null, scale9grid: null },
      // 图标：固有 96x96，与 bbox 48x48 不一致 → non-uniform-scale
      { pkg: 'Mail', pkgId: 'mtlga5qj', type: 'image', id: 'q0ico', name: '图标.png', exported: 'true', width: 96, height: 96, scale: null, scale9grid: null },
    ],
    components: [],
  };
}

const build = (over = {}) => buildCreatePlan({
  ir: over.ir || irFixture(),
  projectIndex: over.projectIndex || indexFixture(),
  canvas: over.canvas,
  pageName: over.pageName,
  pkg: over.pkg,
  normalizeOpts: over.normalizeOpts,
});

// ════════════════════════════════════════════════════════════════════════════
// 命名清洗 / 画布 / 页面名
// ════════════════════════════════════════════════════════════════════════════

test('命名清洗: 复用 normalizeName 后再压非法字符（空格/标点 → _）', () => {
  assert.equal(sanitizeName('图层 113.png'), '图层113', 'normalizeName 会去掉空格');
  assert.equal(sanitizeName('邮件-信件_slices/图层 113.png'), '邮件_信件_slices_图层113');
  assert.equal(sanitizeName('  '), 'node', '全空白 → 兜底 node');
  assert.equal(sanitizeName('reward_icon(1).png'), 'reward_icon', 'normalizeName 默认去副本后缀');
});

test('画布解析: 未传 → null（不是默认值）；显式值解析；非法格式抛 AppError', () => {
  // ★ P0：未传必须返回 null，才能与「用户真的传了 750x1334」区分开 ★
  assert.equal(parseCanvas(undefined), null);
  assert.equal(parseCanvas(''), null);
  assert.deepEqual(parseCanvas('1080x1920'), { w: 1080, h: 1920 });
  assert.deepEqual(parseCanvas('750X1334'), { w: 750, h: 1334 });
  assert.deepEqual(parseCanvas('750*1334'), { w: 750, h: 1334 });
  for (const bad of ['750', 'axb', '0x100', '-1x100']) {
    assert.throws(() => parseCanvas(bad), (e) => e instanceof AppError, `${bad} 应抛错`);
  }
});

test('★ P0 画布决策: 未传 --canvas → 用 IR 自带画布（source=ir）', () => {
  const ir = irFixture();
  ir.source.canvas = { w: 1080, h: 1920 };
  const plan = build({ ir });
  assert.deepEqual({ w: plan.canvas.w, h: plan.canvas.h }, { w: 1080, h: 1920 },
    '★ 缺省必须跟随 IR 画布，不能硬编码 750x1334');
  assert.equal(plan.canvas.source, 'ir');
  assert.equal(plan.canvas.mismatch, undefined);
  assert.deepEqual(plan.page.size, [1080, 1920]);
  assert.ok(!plan.warnings.some((w) => w.code === 'CANVAS_FALLBACK_DEFAULT'));
});

test('★ P0 画布决策: IR 与 CLI 不一致 → source=cli + mismatch + irCanvas + warning', () => {
  const ir = irFixture();
  ir.source.canvas = { w: 1080, h: 1920 };
  const plan = build({ ir, canvas: { w: 750, h: 1334 } });
  assert.deepEqual({ w: plan.canvas.w, h: plan.canvas.h }, { w: 750, h: 1334 }, 'CLI 显式值优先');
  assert.equal(plan.canvas.source, 'cli');
  assert.equal(plan.canvas.mismatch, true);
  assert.deepEqual(plan.canvas.irCanvas, { w: 1080, h: 1920 });
  const w = plan.warnings.find((x) => x.code === 'CANVAS_MISMATCH');
  assert.ok(w, '★ 不一致必须 warning');
  assert.ok(w.msg.includes('未做缩放换算'), 'warning 应说明没做缩放');
});

test('★ P0 画布决策: IR 无 canvas → 退回 750x1334 + source=default + warning', () => {
  const ir = irFixture();
  delete ir.source.canvas;
  const plan = build({ ir });
  assert.deepEqual({ w: plan.canvas.w, h: plan.canvas.h }, { w: 750, h: 1334 });
  assert.equal(plan.canvas.source, 'default');
  assert.ok(plan.warnings.some((w) => w.code === 'CANVAS_FALLBACK_DEFAULT'), '★ 退回默认必须告警');
});

test('画布决策: CLI 与 IR 一致时不设 mismatch（不制造假告警）', () => {
  const ir = irFixture(); // IR canvas 750x1334
  const plan = build({ ir, canvas: { w: 750, h: 1334 } });
  assert.equal(plan.canvas.source, 'cli');
  assert.equal(plan.canvas.mismatch, undefined);
  assert.ok(!plan.warnings.some((w) => w.code === 'CANVAS_MISMATCH'));
});

test('页面名: 显式 > IR psdPath 基名 > Page', () => {
  assert.equal(pickPageName(irFixture(), 'MailPagePopup'), 'MailPagePopup');
  assert.equal(pickPageName(irFixture()), 'state_A', '★ 页面名保留大小写（不走 normalizeName）');
  assert.equal(pickPageName({ layers: [], source: {} }), 'Page');
});

// ════════════════════════════════════════════════════════════════════════════
// 背景识别 / 层级排序
// ════════════════════════════════════════════════════════════════════════════

test('背景识别: 覆盖全画布的最大层（并列取更靠底）；无覆盖层 → null', () => {
  const ir = irFixture();
  assert.equal(detectBackgroundLayerId(ir.layers, ir, DEFAULT_CANVAS), 'L008', '背景=覆盖画布的最底层');
  // 去掉背景 → null（不硬凑）
  const noBg = irFixture();
  noBg.layers = noBg.layers.filter((l) => l.id !== 'L008');
  assert.equal(detectBackgroundLayerId(noBg.layers, noBg, DEFAULT_CANVAS), null);
  // coversCanvas 细节
  assert.equal(coversCanvas({ x: 0, y: 0, w: 750, h: 1334 }, { w: 750, h: 1334 }), true);
  assert.equal(coversCanvas({ x: 10, y: 0, w: 750, h: 1334 }, { w: 750, h: 1334 }), false);
});

test('★ 层级排序: IR 是顶→底，输出必须反转成底→顶；group 不计入 nodes 但留痕', () => {
  const ir = irFixture();
  // 插一个 group 容器（顶→底顺序里放中间），验证被拍平且计数
  ir.layers.splice(2, 0, layer('L009', '容器组', 'group', { x: 0, y: 0, w: 10, h: 10 }));
  const { leaves, groupCount } = collectLeavesBottomToTop(ir.layers);
  assert.equal(groupCount, 1);
  assert.equal(leaves[0].id, 'L008', '★ 底→顶：背景第一个');
  assert.equal(leaves[leaves.length - 1].id, 'L001', '★ 最顶层最后');
  const plan = build({ ir });
  assert.equal(plan.nodes[0].name, 'img_bg');
  assert.equal(plan.nodes[0].layer, 0);
  assert.equal(plan.nodes[plan.nodes.length - 1].source.layerId, 'L001', '标题在最上（layer 最大）');
  // group 未映射的事实要显式记录，不静默
  assert.ok(plan.deferred.relations.some((d) => /group/.test(d.reason)), 'group 拍平必须有说明');
});

test('★ 背景强制 layer 0 且命名 img_bg（即使它在 IR 里不是最后一个）', () => {
  const ir = irFixture();
  // 把背景挪到 IR 开头（顶）——仍应被识别为背景并强制 layer 0
  const bg = ir.layers.pop();
  ir.layers.unshift(bg);
  const plan = build({ ir });
  assert.equal(plan.nodes[0].name, 'img_bg');
  assert.equal(plan.nodes[0].layer, 0);
  assert.equal(plan.nodes[0].attrs.xy, '0,0');
  assert.equal(plan.nodes[0].attrs.size, '750,1334');
});

// ════════════════════════════════════════════════════════════════════════════
// 资源复用 / 短 ID / toImport / 禁止拉伸
// ════════════════════════════════════════════════════════════════════════════

test('★ 资源复用: 命中 → src 为**短资源 ID**（不含 ui://），且进 assets.reused', () => {
  const plan = build();
  const btn = plan.nodes.find((n) => n.source.layerId === 'L003');
  assert.ok(btn, '应生成按钮底节点');
  assert.equal(btn.attrs.src, 'q0abc', '★ 短 ID（真实工程形态）');
  assert.ok(!String(btn.attrs.src).includes('ui://'), '★ 绝不拼 ui://');
  assert.equal(btn.attrs.size, '200,56', '尺寸与固有尺寸一致时不改');
  assert.ok(plan.assets.reused.some((r) => r.layerId === 'L003' && r.resourceId === 'q0abc'));
});

test('★ 未匹配资源 → toImport（带建议文件名与尺寸，绝不静默丢弃）', () => {
  const plan = build();
  const t = plan.assets.toImport.find((x) => x.layerId === 'L004');
  assert.ok(t, '未匹配图必须进 toImport');
  assert.equal(t.suggestedName, '未匹配图.png');
  assert.equal(t.w, 120);
  assert.equal(t.h, 48);
  assert.ok(t.reason.includes('同包未找到匹配资源'));
  const node = plan.nodes.find((n) => n.source.layerId === 'L004');
  assert.equal(node.attrs.src, undefined, '未匹配不得有 src');
  assert.ok(node.notes.some((x) => x.includes('toImport')), '节点也要说明');
});

test('★ 等比缩放（宽高比相同）: bbox 48x48 / 固有 96x96 → size 48,48 + 记 decisions、**不进 unresolved**', () => {
  // team-lead 实跑数据：bbox 48×48 @ (340,700)、资源固有 96×96（宽高比同为 1:1）。
  // 第六轮审查：纯等比缩放是**已自动处理**，不该判 blocked。
  const idx = indexFixture();
  idx.resources.push({
    pkg: 'Mail', pkgId: 'mtlga5qj', type: 'image', id: 'q0ic2', name: '小图标.png',
    exported: 'true', width: 96, height: 96,
  });
  const ir = irFixture();
  ir.layers.splice(1, 0, layer('L020', '小图标', 'raster', { x: 340, y: 700, w: 48, h: 48 }));
  const plan = build({ ir, projectIndex: idx });
  const n = plan.nodes.find((x) => x.source.layerId === 'L020');
  assert.equal(n.attrs.size, '48,48', '★ 等比缩放 0.5 → 恰好铺满 bbox');
  assert.equal(n.attrs.xy, '340,700', '★ 居中后 xy 与 bbox 左上角一致（size == bbox）');
  const d = plan.decisions.find((x) => x.layerId === 'L020');
  assert.ok(d, '必须有 decision 记录（可审计）');
  assert.equal(d.kind, 'proportional-scale');
  assert.equal(d.scale, 0.5);
  assert.equal(d.from, '96x96');
  assert.equal(d.to, '48x48');
  assert.equal(d.aspectPreserved, true);
  assert.ok(!plan.unresolved.some((x) => x.layerId === 'L020'), '★ 宽高比相同 → 不进 unresolved');
});

test('★ 等比缩放（scale 截断为 1）: bbox 200x200 / 固有 96x96 → size 96,96 + 居中，仍不进 unresolved', () => {
  const idx = indexFixture();
  idx.resources.push({
    pkg: 'Mail', pkgId: 'mtlga5qj', type: 'image', id: 'q0ic3', name: '大框小图.png',
    exported: 'true', width: 96, height: 96,
  });
  const ir = irFixture();
  ir.layers.splice(1, 0, layer('L021', '大框小图', 'raster', { x: 340, y: 700, w: 200, h: 200 }));
  const plan = build({ ir, projectIndex: idx });
  const n = plan.nodes.find((x) => x.source.layerId === 'L021');
  assert.equal(n.attrs.size, '96,96', '★ scale 上限 1：绝不放大');
  assert.equal(n.attrs.xy, '392,752', '★ 在 bbox 内居中');
  const d = plan.decisions.find((x) => x.layerId === 'L021');
  assert.ok(d && d.scale === 1, 'decision 应记录 scale=1（截断）');
  assert.ok(!plan.unresolved.some((x) => x.layerId === 'L021'), '宽高比相同 → 不进 unresolved');
});

test('★ 宽高比不同: bbox 120x48 / 固有 96x96 → decisions + unresolved(aspect-mismatch-adjusted, needs-human)', () => {
  const idx = indexFixture();
  idx.resources.push({
    pkg: 'Mail', pkgId: 'mtlga5qj', type: 'image', id: 'q0ic4', name: '异形.png',
    exported: 'true', width: 96, height: 96,
  });
  const ir = irFixture();
  ir.layers.splice(1, 0, layer('L022', '异形', 'raster', { x: 100, y: 800, w: 120, h: 48 }));
  const plan = build({ ir, projectIndex: idx });
  const n = plan.nodes.find((x) => x.source.layerId === 'L022');
  // scale = min(120/96=1.25, 48/96=0.5, 1) = 0.5 → 48x48；x 居中 = 100+(120-48)/2 = 136
  assert.equal(n.attrs.size, '48,48');
  assert.equal(n.attrs.xy, '136,800');
  const d = plan.decisions.find((x) => x.layerId === 'L022');
  assert.ok(d && d.aspectPreserved === false, 'decision 要标明宽高比未保持');
  const u = plan.unresolved.find((x) => x.layerId === 'L022');
  assert.ok(u, '宽高比不同 → 仍需人工确认');
  assert.equal(u.reason, 'aspect-mismatch-adjusted');
  assert.equal(u.severity, 'needs-human', '★ 不再是 blocked');
});

test('九宫格: 摆放 > 固有 且资源具备 9grid → 建议 scale9grid（无切格值不猜）', () => {
  const idx = indexFixture();
  idx.resources.push({
    pkg: 'Mail', pkgId: 'mtlga5qj', type: 'image', id: 'q0bg9', name: '底板.png',
    exported: 'true', width: 100, height: 100, scale: '9grid', scale9grid: '10,10,80,80',
  });
  const ir = irFixture();
  ir.layers.splice(3, 0, layer('L010', '底板', 'raster', { x: 0, y: 600, w: 300, h: 240 }));
  const plan = build({ ir, projectIndex: idx });
  const n = plan.nodes.find((x) => x.source.layerId === 'L010');
  assert.equal(n.attrs.size, '300,240', '9grid 可拉伸 → 保留摆放尺寸');
  assert.equal(n.attrs.scale9grid, '10,10,80,80', '资源自带切格值 → 直接写（非猜测）');
});

test('九宫格: 标为 9grid 但无切格值 → 保守用固有尺寸 + unresolved（不猜）', () => {
  const idx = indexFixture();
  idx.resources.push({
    pkg: 'Mail', pkgId: 'mtlga5qj', type: 'image', id: 'q0ng', name: '无格.png',
    exported: 'true', width: 100, height: 100, scale: '9grid', scale9grid: null,
  });
  const ir = irFixture();
  ir.layers.splice(3, 0, layer('L011', '无格', 'raster', { x: 0, y: 700, w: 300, h: 240 }));
  const plan = build({ ir, projectIndex: idx });
  const n = plan.nodes.find((x) => x.source.layerId === 'L011');
  assert.equal(n.attrs.size, '100,100', '无切格值不拉伸');
  assert.ok(plan.unresolved.some((u) => u.layerId === 'L011' && u.reason === 'scale9grid-values-missing'));
});

test('资源歧义: 同名两候选 → 不取第一个，进 unresolved(ambiguous-asset)', () => {
  const idx = indexFixture();
  idx.resources.push(
    { pkg: 'Mail', pkgId: 'mtlga5qj', type: 'image', id: 'q0d1', name: '行1.png', exported: 'true', width: 300, height: 60 },
    { pkg: 'Mail', pkgId: 'mtlga5qj', type: 'image', id: 'q0d2', name: '行1.jpg', exported: 'true', width: 300, height: 60 },
  );
  const plan = build({ projectIndex: idx });
  const u = plan.unresolved.find((x) => x.layerId === 'L005');
  assert.ok(u, '应记 unresolved');
  assert.equal(u.reason, 'ambiguous-asset');
  assert.ok(u.hint.includes('q0d1') && u.hint.includes('q0d2'), '候选要列全');
  const node = plan.nodes.find((n) => n.source.layerId === 'L005');
  assert.equal(node.attrs.src, undefined, '★ 歧义时绝不许取第一个');
});

// ════════════════════════════════════════════════════════════════════════════
// 文本属性 / 列表建议 / controller 建议
// ════════════════════════════════════════════════════════════════════════════

test('文本节点: text/color(6位)/fontsize + estimated 标记', () => {
  const plan = build();
  const t = plan.nodes.find((n) => n.tag === 'text');
  assert.equal(t.attrs.text, '邮件详情');
  assert.equal(t.attrs.color, '#f5e6c8');
  assert.equal(t.attrs.fontsize, 26);
  assert.equal(t.estimated, true, '★ 估计值必须标 estimated');
  assert.ok(t.estimatedFields.includes('fontsize'));
  assert.ok(t.notes.some((x) => x.includes('估计值')));
});

test('文本: 8 位色被拒绝写入（R-03 铁律）并留 warning', () => {
  const ir = irFixture();
  ir.layers[0].text.color = '#f5e6c8ff';
  const plan = build({ ir });
  const t = plan.nodes.find((n) => n.tag === 'text');
  assert.equal(t.attrs.color, undefined, '8 位色不得写入');
  assert.ok(plan.warnings.some((w) => w.code === 'TEXT_COLOR_REJECTED'));
});

test('★ 列表建议: 同尺寸 + 同列纵向堆叠（间距一致）→ deferred.listItems，不自动建组件', () => {
  const plan = build();
  assert.equal(plan.deferred.listItems.length, 1, '行1~行3 应被识别为一组');
  const s = plan.deferred.listItems[0];
  assert.ok(s.suggestion.startsWith('Comp/'), '建议 Comp 名');
  assert.ok(s.reason.includes('3 个'), 'reason 应说明数量');
  assert.equal(plan.components.length, 0, '★ v1 不自动建组件');
});

test('列表建议: 间距不一致时不识别（保守，不硬凑）', () => {
  const ir = irFixture();
  ir.layers.find((l) => l.id === 'L007').bbox.y = 700; // 打乱间距
  const plan = build({ ir });
  assert.equal(plan.deferred.listItems.length, 0);
});

test('controller 建议: 完全重叠的节点 ≥2 → deferred.controllers', () => {
  const ir = irFixture();
  ir.layers.splice(1, 0, layer('L012', '状态B', 'raster', { x: 120, y: 200, w: 48, h: 48 })); // 与 L002 重叠
  const plan = build({ ir });
  assert.ok(plan.deferred.controllers.length >= 1);
  assert.ok(plan.deferred.controllers[0].reason.includes('重叠'));
  assert.ok(plan.deferred.controllers[0].members.length >= 2);
});

test('deferred.relations: 恒有「绝对定位需人工加 Relations」建议', () => {
  const plan = build();
  assert.ok(plan.deferred.relations.some((d) => /Relations/.test(d.reason)));
});

// ════════════════════════════════════════════════════════════════════════════
// v0.3-C：readiness（把「计划生成成功」与「可以构建」分开）
// ════════════════════════════════════════════════════════════════════════════

test('★ readiness: 全干净 → ready（通用 Relations 建议带 advisory，不计入 blocker）', () => {
  const r = computeReadiness({
    unresolved: [],
    toImport: [],
    deferred: { controllers: [], relations: [{ advisory: true, suggestion: '适配归组' }], listItems: [] },
  });
  assert.equal(r.status, 'ready');
  assert.deepEqual(r.blockers, []);
});

test('★ readiness: 有 toImport → needs-human + blockers(kind=toImport, count)', () => {
  const r = computeReadiness({
    unresolved: [],
    toImport: [{ layerId: 'L1' }, { layerId: 'L2' }],
    deferred: { controllers: [], relations: [{ advisory: true }], listItems: [] },
  });
  assert.equal(r.status, 'needs-human');
  assert.deepEqual(r.blockers, [{ kind: 'toImport', count: 2 }]);
});

test('★ readiness: 有需处理的 deferred → needs-human（advisory 之外）', () => {
  const r = computeReadiness({
    unresolved: [],
    toImport: [],
    deferred: {
      controllers: [{ suggestion: 'ctrl' }],
      relations: [{ advisory: true }, { suggestion: 'PSD 分组未映射' }],
      listItems: [],
    },
  });
  assert.equal(r.status, 'needs-human');
  assert.deepEqual(r.blockers, [{ kind: 'deferred', count: 2 }], '控制器 1 + 非 advisory 关系 1');
});

test('★ readiness: severity=blocked 的 unresolved → blocked；blockers 按 kind 分档', () => {
  const r = computeReadiness({
    unresolved: [
      { layerId: 'L2', reason: 'ambiguous-asset', severity: 'blocked' },
      { layerId: 'L9', reason: 'aspect-mismatch-adjusted', severity: 'needs-human' },
    ],
    toImport: [{ layerId: 'L4' }],
    deferred: { controllers: [], relations: [{ advisory: true }], listItems: [{ suggestion: 'Comp/AItem' }] },
  });
  assert.equal(r.status, 'blocked');
  assert.deepEqual(r.blockers, [
    { kind: 'unresolved-blocked', count: 1 },
    { kind: 'unresolved-adjustable', count: 1 },
    { kind: 'toImport', count: 1 },
    { kind: 'deferred', count: 1 },
  ]);
});

test('★ readiness: 只有 severity=needs-human 的 unresolved → needs-human（不再一刀切 blocked）', () => {
  const r = computeReadiness({
    unresolved: [{ layerId: 'L9', reason: 'aspect-mismatch-adjusted', severity: 'needs-human' }],
    toImport: [],
    deferred: { controllers: [], relations: [{ advisory: true }], listItems: [] },
  });
  assert.equal(r.status, 'needs-human');
  assert.deepEqual(r.blockers, [{ kind: 'unresolved-adjustable', count: 1 }]);
});

// —— 画布门禁（第六轮审查任务 1）——

test('★ readiness: canvas.mismatch → needs-human + canvas-mismatch（坐标基准不符绝不 ready）', () => {
  const r = computeReadiness({
    unresolved: [], toImport: [], deferred: {},
    canvas: { w: 750, h: 1334, source: 'cli', mismatch: true, irCanvas: { w: 1080, h: 1920 } },
  });
  assert.equal(r.status, 'needs-human');
  assert.deepEqual(r.blockers, [{ kind: 'canvas-mismatch', count: 1 }]);
});

test('★ readiness: canvas.source="default" → needs-human + canvas-default', () => {
  const r = computeReadiness({
    unresolved: [], toImport: [], deferred: {},
    canvas: { w: 750, h: 1334, source: 'default' },
  });
  assert.equal(r.status, 'needs-human');
  assert.deepEqual(r.blockers, [{ kind: 'canvas-default', count: 1 }]);
});

test('readiness: canvas.source="ir" / "cli" 且无 mismatch → 干净（不加 blocker）', () => {
  for (const canvas of [{ w: 750, h: 1334, source: 'ir' }, { w: 750, h: 1334, source: 'cli' }]) {
    const r = computeReadiness({ unresolved: [], toImport: [], deferred: {}, canvas });
    assert.equal(r.status, 'ready', JSON.stringify(canvas));
    assert.deepEqual(r.blockers, []);
  }
});

// —— 目标包门禁（第六轮审查任务 3）——

test('★ resolveTargetPkg: 无包 / 指定不存在 / 多包未指定 / 单包自动选中', () => {
  // 索引里没有包 → blocked
  const none = { decisions: [] };
  const r1 = resolveTargetPkg({ pkgNames: [], requested: undefined, decisions: none.decisions });
  assert.equal(r1.pkg, null);
  assert.deepEqual(r1.blockers, [{ kind: 'no-target-package', count: 1 }]);

  // 指定 --pkg 但不存在 → blocked
  const r2 = resolveTargetPkg({ pkgNames: ['A', 'B'], requested: 'Nope', decisions: [] });
  assert.equal(r2.pkg, 'Nope');
  assert.deepEqual(r2.blockers, [{ kind: 'pkg-not-found', count: 1 }]);

  // 未指定 + 多包 → needs-human（不猜）
  const r3 = resolveTargetPkg({ pkgNames: ['A', 'B'], requested: undefined, decisions: [] });
  assert.equal(r3.pkg, null, '★ 多包时绝不静默挑第一个');
  assert.deepEqual(r3.blockers, [{ kind: 'pkg-ambiguous', count: 2 }]);

  // 未指定 + 单包 → 自动采用 + decision
  const d4 = [];
  const r4 = resolveTargetPkg({ pkgNames: ['Only'], requested: undefined, decisions: d4 });
  assert.equal(r4.pkg, 'Only');
  assert.deepEqual(r4.blockers, []);
  assert.deepEqual(d4, [{ kind: 'pkg-auto-selected', pkg: 'Only' }]);

  // 指定且存在 → 直接用，无 blocker
  const r5 = resolveTargetPkg({ pkgNames: ['A', 'B'], requested: 'B', decisions: [] });
  assert.equal(r5.pkg, 'B');
  assert.deepEqual(r5.blockers, []);
});

test('★ readiness: 包门禁的三档（无包/不存在 → blocked；多包 → needs-human）', () => {
  const base = { unresolved: [], toImport: [], deferred: {}, canvas: { source: 'ir', w: 1, h: 1 } };
  assert.equal(computeReadiness({ ...base, pkgGate: { blockers: [{ kind: 'no-target-package', count: 1 }] } }).status,
    'blocked');
  assert.equal(computeReadiness({ ...base, pkgGate: { blockers: [{ kind: 'pkg-not-found', count: 1 }] } }).status,
    'blocked');
  assert.equal(computeReadiness({ ...base, pkgGate: { blockers: [{ kind: 'pkg-ambiguous', count: 3 }] } }).status,
    'needs-human');
});

test('readiness 已写入 create_plan；默认 fixture 的图标是「等比缩放」→ 不进 unresolved', () => {
  const plan = build();
  assert.ok(plan.readiness, '必须有 readiness');
  // 默认 fixture：图标 48×48 vs 固有 96×96（同为 1:1）→ 已自动处理
  assert.ok(plan.decisions.some((d) => d.kind === 'proportional-scale' && d.layerId === 'L002'));
  assert.ok(!plan.unresolved.some((u) => u.layerId === 'L002'), '等比缩放不再算未决');
  // 仍有 toImport（未登记图/行图/背景）+ listItems → needs-human
  assert.equal(plan.readiness.status, 'needs-human');
  assert.ok(plan.readiness.blockers.some((b) => b.kind === 'toImport'));
  assert.ok(plan.readiness.blockers.some((b) => b.kind === 'deferred'));
  assert.ok(!plan.readiness.blockers.some((b) => b.kind === 'unresolved-blocked'));
});

// ════════════════════════════════════════════════════════════════════════════
// 外壳 / 统计 / 确定性 / md
// ════════════════════════════════════════════════════════════════════════════

test('外壳: version/mode/canvas/page/nodes/components/assets/deferred/unresolved/summary', () => {
  const plan = build({ canvas: { w: 1080, h: 1920 }, pageName: 'MailPagePopup', pkg: 'Mail' });
  assert.equal(plan.version, '0.1');
  assert.equal(plan.mode, 'create');
  assert.deepEqual({ w: plan.canvas.w, h: plan.canvas.h }, { w: 1080, h: 1920 });
  assert.equal(plan.canvas.source, 'cli', '显式 --canvas → source=cli');
  assert.deepEqual(plan.page, { name: 'MailPagePopup', pkg: 'Mail', size: [1080, 1920] });
  assert.ok(Array.isArray(plan.nodes) && plan.nodes.length === 8);
  assert.deepEqual(plan.components, []);
  assert.ok(plan.assets && Array.isArray(plan.assets.reused) && Array.isArray(plan.assets.toImport));
  assert.ok(plan.deferred && Array.isArray(plan.deferred.controllers));
  assert.ok(Array.isArray(plan.unresolved));
  assert.equal(plan.summary.nodes, 8);
  assert.equal(plan.summary.reused, 2, '按钮底 + 图标（图标也复用了资源）');
  // 无资源的图层全部进 toImport：未匹配图 / 行1 / 行2 / 行3 / 背景 = 5
  // （背景没有登记资源时也必须进待导入 —— 不静默丢）
  assert.equal(plan.summary.toImport, 5);
  assert.equal(plan.summary.unresolved, 0, '图标的纯等比缩放属「已自动处理」，不进 unresolved');
  assert.ok(plan.decisions.some((d) => d.kind === 'proportional-scale'), '但必须留在 decisions 里可审计');
  assert.equal(
    plan.summary.deferred,
    plan.deferred.controllers.length + plan.deferred.relations.length + plan.deferred.listItems.length,
  );
  assert.equal(
    plan.summary.nodes,
    plan.nodes.length,
  );
});

test('节点结构: tempId/tag/name/layer/attrs/source/confidence/notes 齐全', () => {
  const plan = build();
  for (const n of plan.nodes) {
    assert.ok(/^N\d+$/.test(n.tempId));
    assert.ok(['image', 'text'].includes(n.tag));
    assert.ok(typeof n.name === 'string' && n.name.length > 0);
    assert.ok(Number.isInteger(n.layer) && n.layer >= 0);
    assert.ok(/^-?\d+,-?\d+$/.test(n.attrs.xy));
    assert.ok(/^\d+,\d+$/.test(n.attrs.size));
    assert.ok(n.source && n.source.layerId);
    assert.ok(typeof n.confidence === 'number');
    assert.ok(Array.isArray(n.notes));
  }
  // 层级必须严格递增（底→顶，背景 0）
  const layers = plan.nodes.map((n) => n.layer);
  assert.deepEqual(layers, [...layers].sort((a, b) => a - b), '按 layer 升序');
});

test('★ 确定性（B9）: 同一输入两次 build → JSON 逐字节一致', () => {
  const a = JSON.stringify(build());
  const b = JSON.stringify(build());
  assert.equal(a, b);
  // md 也要一致
  assert.equal(renderPlanMarkdown(build()), renderPlanMarkdown(build()));
});

test('md: 含「已自动处理」与「待人工确认」两节（决策/问题分栏）', () => {
  const md = renderPlanMarkdown(build());
  assert.ok(md.includes('待人工确认'), '★ 必须有该节');
  assert.ok(md.includes('好') || md.includes('## 已自动处理'), '★ 决策要单独成节（可审计）');
  assert.ok(md.includes('等比缩放'), 'decisions 里要有等比缩放记录');
  assert.ok(md.includes('需要导入素材'));
  assert.ok(md.includes('列表项建议'));
  assert.ok(md.includes('估计值'));
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(md), 'md 不得含时间戳（B9）');
});

test('防御: 非 IR 对象抛 AppError', () => {
  for (const bad of [null, {}, { layers: 'x' }]) {
    assert.throws(() => buildCreatePlan({ ir: bad }), (e) => e instanceof AppError);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 纯 helper 直测
// ────────────────────────────────────────────────────────────────────────────

test('helper: detectVerticalStacks / detectOverlapping 的边界', () => {
  assert.deepEqual(detectVerticalStacks([]), []);
  assert.deepEqual(detectVerticalStacks([{ tag: 'image', tempId: 'N1', attrs: { xy: '0,0', size: '10,10' } }]), [],
    '单个节点不成栈');
  assert.deepEqual(detectOverlapping([{ tempId: 'N1', attrs: { xy: '0,0', size: '1,1' } }]), [],
    '单个节点不算重叠');
});
