'use strict';
/**
 * test/unit/gen-plan.test.js —— prepare 核心单测（M2-SPEC §8「gen-plan」五条）
 *
 * 五条要求逐条对应：
 *   ① 门禁四态（纯 INFERRED→4 / ambiguous+resolved∈candidates→过 /
 *      resolved∉candidates→4 / --skip-unconfirmed→skipped 且 gate.reasons 有记录）
 *      + 额外一条**一致性守卫**：isUnconfirmed 的条数必须等于
 *      planNeedsHuman 的 inferredCount+ambiguousCount（防两处判定漂移）
 *   ② slot/baseName 双名映射（目标态改名仍能解析到旧名节点）
 *   ③ ADD：资源已登记→resolved+正确 src / 未登记→blocked+note 含 package.xml /
 *      无 targetIr→blocked
 *   ④ id 分配不与现有 b00001~b00003 碰撞（下一个 b00004；嵌套 component→c00002）
 *   ⑤ REUSE 无 patch；零命中只进 warnings 不阻塞
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  buildGenPlan, isUnconfirmed, evaluateGate, createIdAllocator, sha256Hex,
  findExportedResource, listExportedImageNames, isExported, STATUS,
} = require('../../src/fgui/gen-plan');
const { planNeedsHuman } = require('../../src/diff/planner');
const { EXIT, AppError } = require('../../src/core/errors');

// ────────────────────────────────────────────────────────────────────────────
// 测试夹具（合成，非真实工程）
// ────────────────────────────────────────────────────────────────────────────

/** 目标组件 XML：b00001~b00003 + 一个嵌套 component（c00001）。 */
const TARGET_XML = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<component size="480,320" exported="true">',
  '  <displayList>',
  '    <image id="b00001" name="mail_bg" xy="0,0" size="480,320"/>',
  '    <image id="b00002" name="图层129" xy="552,92" size="32,32"/>',
  '    <text id="b00003" name="title" xy="24,20" size="200,36" text="邮件详情"/>',
  '    <component id="c00001" name="reward_cell" xy="100,240" size="96,96"/>',
  '  </displayList>',
  '</component>',
  '',
].join('\n');

const TARGET_FILE = 'assets/Mail/MailDetail.xml';

/** project_index 最小形态（字段与 cmd-project-index.js 产物一致）。 */
function projectIndexFixture(overrides = {}) {
  return {
    version: '1.0',
    project: { name: 'MailPopup', packages: [{ name: 'Mail', id: 'e5f6a7b8', relPath: 'assets/Mail' }] },
    resources: [
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0001', name: 'reward_icon', exported: true, width: 96, height: 96 },
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0002', name: '未导出图', exported: false, width: 10, height: 10 },
    ],
    components: [{ pkg: 'Mail', name: 'MailDetail', file: TARGET_FILE, size: [480, 320] }],
    ...overrides,
  };
}

/** 最小 Design IR。 */
function irFixture(layers) {
  return { version: '1.0', layers };
}

/** 调用 buildGenPlan 的便捷封装。 */
function run(diffs, opts = {}) {
  const changePlan = {
    version: '1.0',
    task: { name: 'MailDetail', targetPkg: 'Mail', basePkg: 'Mail' },
    diffs,
  };
  return buildGenPlan({
    changePlan,
    projectIndex: opts.projectIndex || projectIndexFixture(),
    baseIr: opts.baseIr || null,
    targetIr: opts.targetIr || null,
    targetContents: opts.targetContents || { [TARGET_FILE]: TARGET_XML },
    options: opts.options || {},
  });
}

// ════════════════════════════════════════════════════════════════════════════
// ① 门禁四态
// ════════════════════════════════════════════════════════════════════════════

test('① 门禁: 纯 INFERRED plan → 退出 4，gate 与 warnings 逐条列出阻塞项', () => {
  const { genPlan, exitCode } = run([
    { op: 'INFERRED', slot: '某个新按钮', node: 'L017', candidates: [] },
  ]);
  assert.equal(exitCode, EXIT.NEEDS_HUMAN);
  assert.equal(exitCode, 4);
  assert.equal(genPlan.gate.needsHuman, true);
  assert.equal(genPlan.gate.inferredCount, 1);
  assert.equal(genPlan.gate.ambiguousCount, 0);
  assert.ok(genPlan.gate.reasons.length >= 1, 'reasons 应记录原因');
  assert.equal(genPlan.entries.length, 0, '门禁拒绝时不应产出可执行条目');

  const w = genPlan.warnings.find((x) => x.code === 'NEEDS_HUMAN');
  assert.ok(w, '必须逐条列出阻塞条目');
  assert.equal(w.op, 'INFERRED');
  assert.equal(w.slot, '某个新按钮');
  assert.ok(w.msg.includes('INFERRED'), 'note 应说明补救方式');
  assert.ok(w.msg.includes('删除该条目') || w.msg.includes('改为确定 op'), '应给出两种补救');
});

test('① 门禁: ambiguous + resolved ∈ candidates → 放行（退出 0）', () => {
  const { genPlan, exitCode } = run([
    { op: 'MOVE', slot: 'title', node: 'L003', ambiguous: true, candidates: ['L003', 'L009'], resolved: 'L003' },
  ], { targetIr: irFixture([{ id: 'L003', bbox: { x: 24, y: 20, w: 200, h: 36 } }]) });
  assert.equal(exitCode, EXIT.OK);
  assert.equal(genPlan.gate.needsHuman, false);
  assert.equal(genPlan.entries.length, 1);
  assert.equal(genPlan.entries[0].status, STATUS.RESOLVED);
});

test('① 门禁: ambiguous + resolved ∉ candidates → 退出 4（防随手填值绕过）', () => {
  const { genPlan, exitCode } = run([
    { op: 'MOVE', slot: 'title', node: 'L003', ambiguous: true, candidates: ['L003', 'L009'], resolved: 'L999' },
  ]);
  assert.equal(exitCode, EXIT.NEEDS_HUMAN);
  assert.equal(genPlan.gate.needsHuman, true);
  assert.equal(genPlan.gate.ambiguousCount, 1);
  const w = genPlan.warnings.find((x) => x.code === 'NEEDS_HUMAN');
  assert.ok(w && w.candidates.includes('L003'), 'warnings 应列出候选供人选');
});

test('① 门禁: ambiguous + resolved 为空 → 退出 4', () => {
  const { exitCode } = run([
    { op: 'REUSE', slot: 'mail_bg', node: 'L001', ambiguous: true, candidates: ['L001', 'L002'] },
  ]);
  assert.equal(exitCode, EXIT.NEEDS_HUMAN);
});

test('① 门禁: --skip-unconfirmed → 退出 0，丢弃条目记入 skippedCount 且 warnings 保留原因', () => {
  const { genPlan, exitCode } = run([
    { op: 'INFERRED', slot: '推断项', node: 'L017' },
    { op: 'MOVE', slot: 'title', node: 'L003' },
  ], {
    targetIr: irFixture([{ id: 'L003', bbox: { x: 24, y: 20, w: 200, h: 36 } }]),
    options: { skipUnconfirmed: true },
  });
  assert.equal(exitCode, EXIT.OK);
  assert.equal(genPlan.gate.skippedCount, 1);
  assert.equal(genPlan.entries.length, 1, '未确认条目被丢弃');
  assert.equal(genPlan.entries[0].op, 'MOVE');
  assert.ok(genPlan.gate.reasons.length >= 1, 'gate.reasons 必须记录丢弃（不是静默）');
  const w = genPlan.warnings.find((x) => x.code === 'SKIPPED_UNCONFIRMED');
  assert.ok(w, '丢弃必须留下 warning 痕迹');
  assert.ok(w.msg.includes('推断项'), 'warning 应点名被丢弃的条目');
});

test('① 一致性守卫: isUnconfirmed 条数 === planNeedsHuman 的 inferredCount+ambiguousCount', () => {
  // ★ 防漂移：门禁用 planNeedsHuman（不重写），逐条分类用 isUnconfirmed。
  //   两者若语义不一致，skipUnconfirmed 会把「未阻塞的条目」误丢。
  const cases = [
    // 空 candidates + 有 resolved：planner 不阻塞 → isUnconfirmed 也必须 false
    { op: 'MOVE', slot: 'a', ambiguous: true, resolved: 'x', candidates: [] },
    // 有 candidates 且 resolved 在内：不阻塞
    { op: 'MOVE', slot: 'b', ambiguous: true, resolved: 'y', candidates: ['y', 'z'] },
    // 有 candidates 但 resolved 不在：阻塞
    { op: 'MOVE', slot: 'c', ambiguous: true, resolved: 'w', candidates: ['y', 'z'] },
    // 空 resolved：阻塞
    { op: 'MOVE', slot: 'd', ambiguous: true, resolved: '   ', candidates: ['y'] },
    // INFERRED：阻塞
    { op: 'INFERRED', slot: 'e' },
    // 正常条目：不阻塞
    { op: 'MOVE', slot: 'f', node: 'L1' },
    // ambiguous 但有空格包裹的合法 resolved：不阻塞（trim 语义）
    { op: 'MOVE', slot: 'g', ambiguous: true, resolved: ' y ', candidates: ['y'] },
  ];
  for (const c of cases) {
    const plan = { diffs: [c] };
    const g = planNeedsHuman(plan);
    const mine = isUnconfirmed(c) ? 1 : 0;
    assert.equal(mine, (g.inferredCount + g.ambiguousCount),
      `条目 ${JSON.stringify(c)} 的 isUnconfirmed(${mine}) 与 planner 判定(${g.inferredCount + g.ambiguousCount}) 不一致`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ② 双名映射（slot / baseName）
// ════════════════════════════════════════════════════════════════════════════

test('② 双名映射: 目标态改名（slot=新名）仍能解析到 XML 里的旧名节点', () => {
  const { genPlan, exitCode } = run([
    // slot 是新名（XML 里没有），baseNode 指向 base-ir 里名为 '图层129' 的层
    { op: 'MOVE', slot: 'btn_close', node: 'L008', baseNode: 'L012' },
  ], {
    baseIr: irFixture([{ id: 'L012', name: '图层129' }]),
    targetIr: irFixture([{ id: 'L008', bbox: { x: 592, y: 72, w: 32, h: 32 } }]),
  });
  assert.equal(exitCode, EXIT.OK);
  const e = genPlan.entries[0];
  assert.equal(e.status, STATUS.RESOLVED, `应命中旧名节点，note=${e.note}`);
  assert.equal(e.nodeId, 'b00002', '命中 XML 里名为 图层129 的节点');
  assert.deepEqual(e.patch, { attr: 'xy', value: '592,72' });
});

test('② 双名映射: 多节点同名命中 → unresolved（禁止猜），note 列候选', () => {
  const xml = TARGET_XML.replace(
    '    <image id="b00002" name="图层129" xy="552,92" size="32,32"/>',
    '    <image id="b00002" name="dupe" xy="1,1" size="4,4"/>\n    <image id="b00005" name="dupe" xy="2,2" size="4,4"/>',
  );
  const { genPlan } = run([
    { op: 'MOVE', slot: 'dupe', node: 'L008' },
  ], {
    targetIr: irFixture([{ id: 'L008', bbox: { x: 1, y: 1, w: 4, h: 4 } }]),
    targetContents: { [TARGET_FILE]: xml },
  });
  const e = genPlan.entries[0];
  assert.equal(e.status, STATUS.UNRESOLVED);
  assert.equal(e.nodeId, null, '★ 多命中绝不许取第一个');
  assert.ok(e.note.includes('b00002') && e.note.includes('b00005'), 'note 应列出全部候选 nodeId');
  assert.ok(e.note.includes('nodeId'), 'note 应告诉人怎么补救');
});

test('② 双名映射: 零命中 → unresolved（不阻塞退出码）', () => {
  const { genPlan, exitCode } = run([{ op: 'MOVE', slot: '不存在的名字', node: 'L008' }]);
  assert.equal(exitCode, EXIT.OK, '零命中不阻塞（人补 nodeId 后重跑）');
  assert.equal(genPlan.entries[0].status, STATUS.UNRESOLVED);
});

// ════════════════════════════════════════════════════════════════════════════
// ③ ADD
// ════════════════════════════════════════════════════════════════════════════

test('③ ADD: 资源已登记且 exported → resolved + 正确 src（斜杠风格 + pkgId）', () => {
  const { genPlan } = run([
    { op: 'ADD', slot: 'reward_icon', node: 'L017' },
  ], {
    targetIr: irFixture([{ id: 'L017', type: 'raster', bbox: { x: 260, y: 380, w: 96, h: 96 } }]),
  });
  const e = genPlan.entries[0];
  assert.equal(e.status, STATUS.RESOLVED, `note=${e.note}`);
  assert.equal(e.patch.tag, 'image');
  assert.equal(e.patch.attrs.src, 'ui://e5f6a7b8/r0001', '★ ui:// 用斜杠风格 + 包 id');
  assert.equal(e.patch.attrs.xy, '260,380');
  assert.equal(e.patch.attrs.size, '96,96');
  assert.equal(e.patch.after, null, 'ADD 追加末尾');
  assert.ok(e.patch.attrs.id, '应分配 id');
});

test('③ ADD: 资源未登记 → blocked，note 含 package.xml 字样', () => {
  const { genPlan } = run([
    { op: 'ADD', slot: '没登记的图', node: 'L017' },
  ], {
    targetIr: irFixture([{ id: 'L017', type: 'raster', bbox: { x: 0, y: 0, w: 10, h: 10 } }]),
  });
  const e = genPlan.entries[0];
  assert.equal(e.status, STATUS.BLOCKED);
  assert.ok(e.note.includes('package.xml'), '★ note 必须含 package.xml（本工具永不自动改它）');
  assert.ok(genPlan.warnings.some((w) => w.code === 'ADD_RESOURCE_NOT_REGISTERED'));
});

test('③ ADD: 资源名带扩展名（真实 fixture 形态）→ 归一化后仍能匹配，不误报 blocked', () => {
  // ★ 真实合成工程实测：resources[].name 是 'reward_icon.png'（带扩展名），
  //   而 XML 节点名/slot 是 'reward_icon'（不带）。严格相等会把**已登记**的
  //   资源误判为未登记 → 假 blocked（比漏判更伤：让人去导入已有素材）。
  const idx = projectIndexFixture({
    resources: [
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0001', name: 'reward_icon.png', exported: true, width: 96, height: 96 },
    ],
  });
  const { genPlan } = run([{ op: 'ADD', slot: 'reward_icon', node: 'L017' }], {
    projectIndex: idx,
    targetIr: irFixture([{ id: 'L017', type: 'raster', bbox: { x: 0, y: 0, w: 96, h: 96 } }]),
  });
  const e = genPlan.entries[0];
  assert.equal(e.status, STATUS.RESOLVED, `带扩展名的资源名应能匹配，note=${e.note}`);
  assert.equal(e.patch.attrs.src, 'ui://e5f6a7b8/r0001');
});

test('③ ADD: 大小写差异的资源名归一化匹配（popup_bg.PNG ↔ popup_bg）', () => {
  const idx = projectIndexFixture({
    resources: [
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0009', name: 'popup_bg.PNG', exported: true },
    ],
  });
  const { genPlan } = run([{ op: 'ADD', slot: 'popup_bg', node: 'L017' }], {
    projectIndex: idx,
    targetIr: irFixture([{ id: 'L017', type: 'raster', bbox: { x: 0, y: 0, w: 10, h: 10 } }]),
  });
  assert.equal(genPlan.entries[0].status, STATUS.RESOLVED);
});

test('③ ADD: K5 铁律 —— 绝不做前缀/子串匹配（reward ≠ reward_icon2）', () => {
  const idx = projectIndexFixture({
    resources: [
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0001', name: 'reward_icon.png', exported: true },
    ],
  });
  const { genPlan } = run([{ op: 'ADD', slot: 'reward', node: 'L017' }], {
    projectIndex: idx,
    targetIr: irFixture([{ id: 'L017', type: 'raster', bbox: { x: 0, y: 0, w: 10, h: 10 } }]),
  });
  assert.equal(genPlan.entries[0].status, STATUS.BLOCKED,
    '★ reward 不是 reward_icon.png 的归一化全等名 —— 必须 blocked，绝不能前缀匹配');
});

test('③ ADD: blocked 时 note 列出目标包已导出图片名（可操作信息，非匹配）', () => {
  const idx = projectIndexFixture();
  const { genPlan } = run([{ op: 'ADD', slot: '完全没登记的图', node: 'L017' }], {
    projectIndex: idx,
    targetIr: irFixture([{ id: 'L017', type: 'raster', bbox: { x: 0, y: 0, w: 10, h: 10 } }]),
  });
  const e = genPlan.entries[0];
  assert.equal(e.status, STATUS.BLOCKED);
  assert.ok(e.note.includes('reward_icon.png') || e.note.includes('reward_icon'),
    'note 应列出目标包内已导出的图片名，让小 Q 知道「已有什么」');
  assert.ok(e.note.includes('package.xml'));
});

// ════════════════════════════════════════════════════════════════════════════
// ③-b 资源匹配三条纪律（防「静默绑错资源」）
// ════════════════════════════════════════════════════════════════════════════

test('③-b-1 归一化兜底唯一命中才绑定（reward_icon ↔ reward_icon.png）', () => {
  const idx = projectIndexFixture({
    resources: [
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0001', name: 'reward_icon.png', exported: true },
    ],
  });
  const hit = findExportedResource(idx, 'Mail', ['reward_icon']);
  assert.equal(hit.status, 'normalized', '应走归一化兜底');
  assert.ok(hit.match && hit.match.id === 'r0001', '唯一候选必须绑定');
  // 候选统一用 `name#id` 标签（便于人工定位；P1-2 起）
  assert.deepEqual(hit.candidates, ['reward_icon.png#r0001']);
});

test('③-b-2 ★ 归一化后 ≥2 候选 → 不猜，返回 ambiguous 且不绑定（ADD 转 blocked）', () => {
  // 两个资源归一化后同名：`reward_icon.png` 与 `reward_icon.jpg`（真实现象：
  // 同一素材的两种格式都登记了）。取任何一个都可能是错的资源。
  const idx = projectIndexFixture({
    resources: [
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0001', name: 'reward_icon.png', exported: true },
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0002', name: 'reward_icon.jpg', exported: true },
    ],
  });
  const hit = findExportedResource(idx, 'Mail', ['reward_icon']);
  assert.equal(hit.status, 'ambiguous');
  assert.equal(hit.match, null, '★ 多候选绝不许绑定（静默绑错资源）');
  assert.equal(hit.candidates.length, 2);

  // 经 buildGenPlan：ADD 必须 blocked，note 点名候选 + 说明不猜
  const { genPlan } = run([{ op: 'ADD', slot: 'reward_icon', node: 'L017' }], {
    projectIndex: idx,
    targetIr: irFixture([{ id: 'L017', type: 'raster', bbox: { x: 0, y: 0, w: 10, h: 10 } }]),
  });
  const e = genPlan.entries[0];
  assert.equal(e.status, STATUS.BLOCKED);
  assert.ok(e.note.includes('reward_icon.png') && e.note.includes('reward_icon.jpg'),
    'note 应列出全部候选');
  assert.ok(e.note.includes('禁止自动取第一个') || e.note.includes('不猜'),
    'note 应说明为什么不猜');
  assert.ok(genPlan.warnings.some((w) => w.code === 'ADD_RESOURCE_AMBIGUOUS'));
});

test('③-b-3 精确匹配优先：存在同名精确资源时不走归一化候选', () => {
  // slot='reward_icon' 精确命中 id 为 r0009 的资源（name 就叫 reward_icon，无扩展名），
  // 同时还有 reward_icon.png（r0001）。精确优先 → 必须绑 r0009。
  const idx = projectIndexFixture({
    resources: [
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0001', name: 'reward_icon.png', exported: true },
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0009', name: 'reward_icon', exported: true },
    ],
  });
  const hit = findExportedResource(idx, 'Mail', ['reward_icon']);
  assert.equal(hit.status, 'exact', '应精确命中');
  assert.equal(hit.match.id, 'r0009', '★ 精确优先于归一化候选（否则会绑错资源）');
});

test('③-b-4 副本资源不被归一化吞掉（stripCopySuffix=false）', () => {
  // `reward_icon(1).png` 是画师副本，是**另一个**资源条目；
  // 归一化若剥副本后缀，slot='reward_icon' 会把它与正本混同（可能 ≥2 候选或绑错）。
  const idx = projectIndexFixture({
    resources: [
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0001', name: 'reward_icon.png', exported: true },
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0008', name: 'reward_icon(1).png', exported: true },
    ],
  });
  const hit = findExportedResource(idx, 'Mail', ['reward_icon']);
  assert.equal(hit.status, 'normalized', '副本不应与正本归一化为同一名');
  assert.equal(hit.match.id, 'r0001', '★ 必须绑正本，绝不能被副本(1)干扰');
});

// ════════════════════════════════════════════════════════════════════════════
// ③-c P1-2：精确分支唯一性 + 类型限定
// ════════════════════════════════════════════════════════════════════════════

test('★ P1-2-B: slot 与资源名**完全相等**且同名两个 → ambiguous（精确分支不得取第一个）', () => {
  // 原实现：精确分支用 find() 静默取第一个（归一化分支才有唯一性守卫）。
  // 把 src/fgui/gen-plan.js 的「按 name 精确唯一」改回 find() → 本测试必红。
  const idx = projectIndexFixture({
    resources: [
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'aaaa0001', name: 'reward_icon', exported: true },
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'aaaa0002', name: 'reward_icon', exported: true },
    ],
  });
  const hit = findExportedResource(idx, 'Mail', ['reward_icon']);
  assert.equal(hit.status, 'ambiguous', '★ 精确同名多候选必须 ambiguous');
  assert.equal(hit.match, null, '★ 绝不取第一个');
  assert.deepEqual(hit.candidates, ['reward_icon#aaaa0001', 'reward_icon#aaaa0002'],
    '候选必须列全（name#id）');

  const { genPlan } = run([{ op: 'ADD', slot: 'reward_icon', node: 'L017' }], {
    projectIndex: idx,
    targetIr: irFixture([{ id: 'L017', type: 'raster', bbox: { x: 0, y: 0, w: 10, h: 10 } }]),
  });
  const e = genPlan.entries[0];
  assert.equal(e.status, STATUS.BLOCKED);
  assert.equal(e.patch, null);
  assert.ok(genPlan.warnings.some((w) => w.code === 'ADD_RESOURCE_AMBIGUOUS'));
  assert.ok(e.note.includes('aaaa0001') && e.note.includes('aaaa0002'), 'note 应列出两个候选 id');
});

test('★ P1-2-A: 同名 component + image → 必须绑到 image（原来会绑 component）', () => {
  // 原实现 inPkg 未过滤 type → 精确分支可能绑到同名 component，生成指向非图片的 src。
  const idx = projectIndexFixture({
    resources: [
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'component', id: 'cccc0001', name: 'reward_icon', exported: true },
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'aaaa0001', name: 'reward_icon', exported: true },
    ],
  });
  const hit = findExportedResource(idx, 'Mail', ['reward_icon'], undefined, { type: 'image' });
  assert.equal(hit.status, 'exact');
  assert.equal(hit.match.id, 'aaaa0001', '★ 必须绑图片资源（id 前缀 aaaa），不得绑 component');
  assert.equal(hit.match.type, 'image');

  const { genPlan } = run([{ op: 'ADD', slot: 'reward_icon', node: 'L017' }], {
    projectIndex: idx,
    targetIr: irFixture([{ id: 'L017', type: 'raster', bbox: { x: 0, y: 0, w: 10, h: 10 } }]),
  });
  assert.equal(genPlan.entries[0].status, STATUS.RESOLVED);
  assert.equal(genPlan.entries[0].patch.attrs.src, 'ui://e5f6a7b8/aaaa0001');
});

test('★ P1-2-A2: 同名只有非图片类型 → blocked + ADD_RESOURCE_TYPE_MISMATCH（不静默落到 NONE）', () => {
  const idx = projectIndexFixture({
    resources: [
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'component', id: 'cccc0001', name: 'reward_icon', exported: true },
    ],
  });
  const hit = findExportedResource(idx, 'Mail', ['reward_icon'], undefined, { type: 'image' });
  assert.equal(hit.status, 'type_mismatch', '★ 同名但类型不符要给出区分性状态');
  assert.equal(hit.match, null);
  assert.ok(hit.candidates.some((c) => c.includes('type=component')), '候选应带类型信息');

  const { genPlan } = run([{ op: 'ADD', slot: 'reward_icon', node: 'L017' }], {
    projectIndex: idx,
    targetIr: irFixture([{ id: 'L017', type: 'raster', bbox: { x: 0, y: 0, w: 10, h: 10 } }]),
  });
  const e = genPlan.entries[0];
  assert.equal(e.status, STATUS.BLOCKED);
  assert.equal(e.patch, null);
  assert.ok(e.note.includes('类型'), 'note 应说明类型不符');
  assert.ok(genPlan.warnings.some((w) => w.code === 'ADD_RESOURCE_TYPE_MISMATCH'),
    '★ 必须用独立的 ADD_RESOURCE_TYPE_MISMATCH（与「未登记」区分）');
});

test('★ P1-2 正例保留: reward_icon ↔ reward_icon.png 命中；图层249 与 图层249(1) 并存不混', () => {
  // 正例 1：去扩展名归一化仍能唯一命中
  const a = projectIndexFixture({
    resources: [
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0001', name: 'reward_icon.png', exported: true },
    ],
  });
  const h1 = findExportedResource(a, 'Mail', ['reward_icon']);
  assert.equal(h1.status, 'normalized');
  assert.equal(h1.match.id, 'r0001');

  // 正例 2：中文名 + 副本后缀并存（stripCopySuffix=false）→ 仍唯一命中正本
  const b = projectIndexFixture({
    resources: [
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0007', name: '图层249.png', exported: true },
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0008', name: '图层249(1).png', exported: true },
    ],
  });
  const h2 = findExportedResource(b, 'Mail', ['图层249']);
  assert.equal(h2.status, 'normalized', '副本不并入正本 → 仍唯一命中');
  assert.equal(h2.match.id, 'r0007', '绑正本');
});

test('③ ADD: exported=false 的资源 → blocked，且用 NOT_EXPORTED 专属 code（不是「未登记」）', () => {
  const { genPlan } = run([
    { op: 'ADD', slot: '未导出图', node: 'L017' },
  ], {
    targetIr: irFixture([{ id: 'L017', type: 'raster', bbox: { x: 0, y: 0, w: 10, h: 10 } }]),
  });
  assert.equal(genPlan.entries[0].status, STATUS.BLOCKED);
  assert.ok(genPlan.entries[0].note.includes('exported'));
  // ★ 与「未登记」区分：行动不同（标成导出 vs 导入素材）
  assert.ok(genPlan.warnings.some((w) => w.code === 'ADD_RESOURCE_NOT_EXPORTED'),
    '未导出的资源应报 ADD_RESOURCE_NOT_EXPORTED');
  assert.ok(!genPlan.warnings.some((w) => w.code === 'ADD_RESOURCE_NOT_REGISTERED'),
    '不应误报为「未登记」（资源其实登记了）');
});

test('③ ADD: 无 target-ir → blocked（且不发生 id 分配）', () => {
  const { genPlan } = run([{ op: 'ADD', slot: 'reward_icon', node: 'L017' }]);
  const e = genPlan.entries[0];
  assert.equal(e.status, STATUS.BLOCKED);
  assert.ok(e.note.includes('target-ir'), 'note 应指明缺 target-ir');
  assert.ok(genPlan.warnings.some((w) => w.code === 'ADD_NO_TARGET_IR'));
});

test('③ ADD: text 类型 → text/color 6 位/alpha（opacity<1 必须映射为 alpha）', () => {
  const { genPlan } = run([
    { op: 'ADD', slot: 'subtitle', node: 'L020' },
  ], {
    targetIr: irFixture([{
      id: 'L020', type: 'text', bbox: { x: 24, y: 60, w: 200, h: 24 }, opacity: 0.5,
      text: { value: '有效期：7天', color: '#b4bed2', fontSize: 18, align: 'left' },
    }]),
  });
  const e = genPlan.entries[0];
  assert.equal(e.status, STATUS.RESOLVED);
  assert.equal(e.patch.tag, 'text');
  assert.equal(e.patch.attrs.text, '有效期：7天');
  assert.equal(e.patch.attrs.color, '#b4bed2');
  assert.equal(e.patch.attrs.alpha, '0.5', '★ opacity<1 必须写 alpha（否则半透明静默写丢）');
  assert.equal(e.patch.attrs.xy, '24,60');
});

test('③ ADD: smartobject → blocked（有 note，不静默）', () => {
  const { genPlan } = run([{ op: 'ADD', slot: '智能图', node: 'L030' }], {
    targetIr: irFixture([{ id: 'L030', type: 'smartobject', bbox: { x: 0, y: 0, w: 10, h: 10 } }]),
  });
  assert.equal(genPlan.entries[0].status, STATUS.BLOCKED);
  assert.ok(genPlan.warnings.some((w) => w.code === 'ADD_SMARTOBJECT'));
});

test('② ADD: pkgId 缺失 → **blocked**（不降级生成无效 ui://），PKGID_MISSING 保留', () => {
  // ★ 行为变更（外部审查 P1，team-lead 采纳）：原实现按包名降级生成
  //   `ui://<pkgName>/<id>` —— 那等于生成一个大概率无效的引用（与 BUG-A 同性质：
  //   静默生成无效内容）。现改为 blocked，条目不可执行。
  const idx = projectIndexFixture({
    project: { name: 'MailPopup', packages: [{ name: 'Mail', id: null, relPath: 'assets/Mail' }] },
    resources: [{ pkg: 'Mail', pkgId: null, type: 'image', id: 'r0001', name: 'reward_icon', exported: true }],
  });
  const { genPlan } = run([{ op: 'ADD', slot: 'reward_icon', node: 'L017' }], {
    projectIndex: idx,
    targetIr: irFixture([{ id: 'L017', type: 'raster', bbox: { x: 0, y: 0, w: 10, h: 10 } }]),
  });
  const e = genPlan.entries[0];
  assert.equal(e.status, STATUS.BLOCKED, '★ 缺包 id 时必须 blocked（不得降级生成 src）');
  assert.equal(e.patch, null, '★ 不得产出 patch（否则会写出无效 ui:// 引用）');
  assert.ok(e.note.includes('包 id'), 'note 应点明「包 id 无法确定」');
  assert.ok(e.note.includes('不降级') || e.note.includes('无法构造合法'), 'note 应说明为何不降级');
  const w = genPlan.warnings.find((x) => x.code === 'PKGID_MISSING');
  assert.ok(w, '★ PKGID_MISSING 告警保留（说明被阻塞的原因）');
  assert.ok(/blocked/.test(w.msg), 'warning 应说明已 blocked');
});

// ════════════════════════════════════════════════════════════════════════════
// ① BUG-A：exported 判定（字符串 "false" 不许当真值）
// ════════════════════════════════════════════════════════════════════════════

test('★ BUG-A: exported="false" 的资源不得被绑定 → not_exported + blocked', () => {
  // 根因：package-indexer 产出的 exported **永远是字符串**（"true"/"false"/null），
  //   原实现用真值判断 → Boolean("false") === true → 未导出的资源被静默绑定。
  const idx = projectIndexFixture({
    resources: [
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0001', name: 'reward_icon.png', exported: 'false' },
    ],
  });
  const hit = findExportedResource(idx, 'Mail', ['reward_icon']);
  assert.equal(hit.status, 'not_exported', '★ 字符串 "false" 必须判为未导出');
  assert.equal(hit.match, null, '★ 绝不绑定未导出的资源（否则贴图丢失且无报错）');
  assert.deepEqual(hit.candidates, ['reward_icon.png'], '应报出「对得上但未导出」的候选');

  const { genPlan } = run([{ op: 'ADD', slot: 'reward_icon', node: 'L017' }], {
    projectIndex: idx,
    targetIr: irFixture([{ id: 'L017', type: 'raster', bbox: { x: 0, y: 0, w: 10, h: 10 } }]),
  });
  const e = genPlan.entries[0];
  assert.equal(e.status, STATUS.BLOCKED);
  assert.equal(e.patch, null);
  assert.ok(/exported/.test(e.note), '★ note 必须含 exported 字样（区分于「未登记」）');
  assert.ok(e.note.includes('标成导出'), 'note 应给出行动：去 package.xml 标成导出');
  assert.ok(genPlan.warnings.some((w) => w.code === 'ADD_RESOURCE_NOT_EXPORTED'),
    '★ 必须用独立的 ADD_RESOURCE_NOT_EXPORTED（与「未登记」的 code 分开）');
});

test('★ BUG-A: exported="true" 仍正常解析；exported=null 视同未导出', () => {
  const ok = projectIndexFixture({
    resources: [
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0001', name: 'reward_icon.png', exported: 'true' },
    ],
  });
  assert.equal(findExportedResource(ok, 'Mail', ['reward_icon']).status, 'normalized',
    '字符串 "true" 必须视为已导出');
  const p = run([{ op: 'ADD', slot: 'reward_icon', node: 'L017' }], {
    projectIndex: ok,
    targetIr: irFixture([{ id: 'L017', type: 'raster', bbox: { x: 0, y: 0, w: 10, h: 10 } }]),
  });
  assert.equal(p.genPlan.entries[0].status, STATUS.RESOLVED);
  assert.equal(p.genPlan.entries[0].patch.attrs.src, 'ui://e5f6a7b8/r0001');

  const nul = projectIndexFixture({
    resources: [
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0001', name: 'reward_icon.png', exported: null },
    ],
  });
  assert.equal(findExportedResource(nul, 'Mail', ['reward_icon']).status, 'not_exported',
    'exported=null 视同未导出');
});

test('★ BUG-A 反向验证: 真值判断会放行 "false"（证明 isExported 是必需的）', () => {
  // 这条测试是「测试能真失败」的证明：
  //   若把 isExported 改回真值判断（`r.exported`），上面两条会立刻变红。
  //   这里额外把陷阱本身钉死 —— 后人读到这里就知道为什么不能用真值。
  assert.equal(Boolean('false'), true, '★ 陷阱：Boolean("false") === true（真值判断会放行未导出资源）');
  assert.equal(isExported('false'), false, 'isExported 必须拒绝字符串 "false"');
  assert.equal(isExported('true'), true);
  assert.equal(isExported(true), true, '布尔 true 也接受（防御手工构造的 index）');
  assert.equal(isExported(null), false);
  assert.equal(isExported(undefined), false);
  assert.equal(isExported(''), false);
  assert.equal(isExported(1), false, '数字 1 不是合法表示（index 只产出字符串/布尔）');
  // 端到端口径：字符串 "false" 的资源绝不可出现在「已导出」列表里
  const idx = projectIndexFixture({
    resources: [
      { pkg: 'Mail', pkgId: 'e5f6a7b8', type: 'image', id: 'r0001', name: 'hidden.png', exported: 'false' },
    ],
  });
  assert.deepEqual(listExportedImageNames(idx, 'Mail'), [],
    '★ 未导出的资源不得出现在「已导出图片」列表（否则 note 会误导人）');
});

// ════════════════════════════════════════════════════════════════════════════
// ④ id 分配
// ════════════════════════════════════════════════════════════════════════════

test('④ id 分配: 不与现有 b00001~b00003 碰撞（下一个 b00004）', () => {
  const alloc = createIdAllocator(
    require('../../src/fgui/gen-plan').buildNodeIndex(TARGET_XML).nodes,
  );
  assert.deepEqual(alloc.snapshot(), { b: 3, c: 1 });
  assert.equal(alloc.next('b'), 'b00004');
  assert.equal(alloc.next('b'), 'b00005');
});

test('④ id 分配: 嵌套 component → c 前缀（c00002）', () => {
  const alloc = createIdAllocator(
    require('../../src/fgui/gen-plan').buildNodeIndex(TARGET_XML).nodes,
  );
  assert.equal(alloc.next('c'), 'c00002', '现有 c00001 → 下一个 c00002');
});

test('④ id 分配: 多个 ADD 连续分配不碰撞（走完整 buildGenPlan）', () => {
  const { genPlan } = run([
    { op: 'ADD', slot: 'reward_icon', node: 'L017' },
    { op: 'ADD', slot: 'reward_icon', node: 'L018' },
  ], {
    targetIr: irFixture([
      { id: 'L017', type: 'raster', bbox: { x: 0, y: 0, w: 10, h: 10 } },
      { id: 'L018', type: 'raster', bbox: { x: 20, y: 0, w: 10, h: 10 } },
    ]),
  });
  assert.equal(genPlan.entries[0].patch.attrs.id, 'b00004');
  assert.equal(genPlan.entries[1].patch.attrs.id, 'b00005');
});

test('④ id 分配: 5 位上限耗尽 → 抛 AppError（不静默回绕）', () => {
  const alloc = createIdAllocator([{ id: 'b99999' }]);
  assert.throws(() => alloc.next('b'), (err) => {
    assert.ok(err instanceof AppError);
    assert.ok(err.message.includes('耗尽') || err.message.includes('超过'));
    return true;
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ⑤ REUSE 与 summary / 外壳
// ════════════════════════════════════════════════════════════════════════════

test('⑤ REUSE: 有 patch=null；零命中只进 warnings 不阻塞', () => {
  const { genPlan, exitCode } = run([
    { op: 'REUSE', slot: 'mail_bg', node: 'L001' },
    { op: 'REUSE', slot: '工程里没有的', node: 'L002' },
  ]);
  assert.equal(exitCode, EXIT.OK, 'REUSE 零命中不阻塞');
  assert.equal(genPlan.entries[0].status, STATUS.RESOLVED);
  assert.equal(genPlan.entries[0].patch, null, 'REUSE 无补丁');
  assert.equal(genPlan.entries[1].status, STATUS.UNRESOLVED);
  const w = genPlan.warnings.find((x) => x.code === 'REUSE_ZERO_MATCH');
  assert.ok(w, '零命中必须留下 warning（§5）');
});

test('⑤ summary: total/byOp/byStatus 与 entries 一致', () => {
  const { genPlan } = run([
    { op: 'MOVE', slot: 'mail_bg', node: 'L001' },
    { op: 'REUSE', slot: 'title', node: 'L003' },
    { op: 'REMOVE', slot: '图层129', node: 'L005', confidence: 0.2 },
  ], { targetIr: irFixture([{ id: 'L001', bbox: { x: 1, y: 2, w: 3, h: 4 } }]) });
  assert.equal(genPlan.summary.total, 3);
  assert.deepEqual(genPlan.summary.byOp, { MOVE: 1, REUSE: 1, REMOVE: 1 });
  assert.equal(genPlan.summary.byStatus[STATUS.RESOLVED], 2);
  assert.equal(genPlan.summary.byStatus[STATUS.SKIPPED], 1);
  assert.equal(
    Object.values(genPlan.summary.byStatus).reduce((a, b) => a + b, 0),
    genPlan.summary.total, 'byStatus 之和应等于 total',
  );
});

test('⑤ 外壳: version/_comment/_entryNote/task/target{component,pkg,pkgId,file,sha256}', () => {
  const { genPlan } = run([{ op: 'REUSE', slot: 'mail_bg', node: 'L001' }]);
  assert.equal(genPlan.version, '1.0');
  assert.ok(genPlan._comment.includes('可人工编辑'));
  assert.ok(genPlan._entryNote && genPlan._entryNote.status.includes('blocked'));
  assert.deepEqual(genPlan.task, { name: 'MailDetail', targetPkg: 'Mail', basePkg: 'Mail' });
  assert.equal(genPlan.target.component, 'MailDetail');
  assert.equal(genPlan.target.pkg, 'Mail');
  assert.equal(genPlan.target.pkgId, 'e5f6a7b8');
  assert.equal(genPlan.target.file, TARGET_FILE);
  assert.equal(genPlan.target.sha256, sha256Hex(TARGET_XML));
  assert.equal(genPlan.target.sha256.length, 64);
});

test('⑤ patch 形态: 与 gen-dryrun 冻结的三种形态严格对应（绝不产出第四种）', () => {
  const ir = irFixture([
    { id: 'L010', type: 'raster', bbox: { x: 8, y: 8, w: 464, h: 304 } },
    { id: 'L011', type: 'raster', bbox: { x: 0, y: 0, w: 100, h: 50 } },
    { id: 'L012', type: 'text', bbox: { x: 1, y: 1, w: 10, h: 10 }, text: { value: 'x', color: '#ffffff' } },
  ]);
  const { genPlan } = run([
    // 只有 size → { attr, value }（§4 定义）
    { op: 'RESIZE', slot: '图层129', node: 'L011' },
    // size + scale9grid → { attrs }（多属性形态；gen-dryrun 已支持）
    { op: 'RESIZE', slot: 'mail_bg', node: 'L010', fguiStrategy: { scale9grid: { scale9grid: '10,10,444,284' } } },
    // RESTYLE → { attrs }
    { op: 'RESTYLE', slot: 'title', node: 'L012', fguiStrategy: { color: { color: '#ff0000', alpha: '0.5' } } },
    // MOVE → { attr, value }
    { op: 'MOVE', slot: 'mail_bg', node: 'L011' },
    // ADD → { tag, attrs, after }
    { op: 'ADD', slot: 'reward_icon', node: 'L010' },
  ], {
    targetIr: ir,
    targetContents: {
      [TARGET_FILE]: TARGET_XML.replace(
        '    <image id="b00002" name="图层129" xy="552,92" size="32,32"/>',
        '    <image id="b00002" name="图层129" xy="552,92" size="32,32"/>\n'
        + '    <image id="b00006" name="mail_frame" xy="8,8" size="464,304"/>',
      ),
    },
  });

  const allowed = (p) => {
    if (!p || typeof p !== 'object') return p === null;
    if (Array.isArray(p)) return false; // ★ 数组形态会打崩 gen-dryrun，禁止
    if (typeof p.attr === 'string' && typeof p.value === 'string') return true;
    if (p.attrs && typeof p.attrs === 'object' && !Array.isArray(p.attrs)) return true;
    if (typeof p.tag === 'string' && p.attrs) return true;
    return false;
  };
  for (const e of genPlan.entries) {
    assert.ok(allowed(e.patch),
      `entry ${e.op}/${e.slot} 的 patch 形态不在冻结集合内: ${JSON.stringify(e.patch)}`);
  }

  const resizeMulti = genPlan.entries.find((e) => e.op === 'RESIZE' && e.slot === 'mail_bg');
  assert.equal(resizeMulti.status, STATUS.RESOLVED);
  assert.deepEqual(resizeMulti.patch, { attrs: { size: '464,304', scale9grid: '10,10,444,284' } },
    'RESIZE+scale9grid 用 { attrs } 而非数组');

  const resizeSingle = genPlan.entries.find((e) => e.op === 'RESIZE' && e.slot === '图层129');
  assert.deepEqual(resizeSingle.patch, { attr: 'size', value: '100,50' }, '无 scale9grid 时用 §4 定义的单属性形态');
});

test('⑤ 外壳: 目标组件找不到 → file/sha256 为 null 且不崩 + 明确告警', () => {
  const idx = projectIndexFixture({ components: [] });
  const { genPlan, exitCode } = run([{ op: 'REUSE', slot: 'x', node: 'L1' }], { projectIndex: idx });
  assert.equal(exitCode, EXIT.OK);
  assert.equal(genPlan.target.component, null);
  assert.equal(genPlan.target.file, null);
  assert.equal(genPlan.target.sha256, null);
  assert.ok(genPlan.warnings.some((w) => w.code === 'TARGET_COMPONENT_NOT_FOUND'),
    '★ 目标找不到必须明确告警，不是静默零命中');
});

test('⑤ 外壳: 未知 op 不静默（blocked + warning）', () => {
  const { genPlan } = run([{ op: 'TELEPORT', slot: 'x', node: 'L1' }]);
  const e = genPlan.entries[0];
  assert.equal(e.status, STATUS.BLOCKED);
  assert.ok(e.note.includes('TELEPORT'));
  assert.ok(genPlan.warnings.some((w) => w.code === 'UNKNOWN_OP'));
});

// ════════════════════════════════════════════════════════════════════════════
// A3-0：target.file 改为「FGUI 工程根相对」（M2-SPEC §4）
// ════════════════════════════════════════════════════════════════════════════

const REPO = path.resolve(__dirname, '../..');

test('A3-0 正常: index 的 file 相对 CLI rootDir → target.file 输出工程根相对路径', () => {
  // index 产物：`file` 相对 **CLI rootDir**（实测形如
  // `out/<tmp>/project/assets/MailDetail/MailDetail.xml`），不该写进人可读产物
  const projectRoot = path.join(REPO, 'out', 'tmp', 'project');
  const idx = projectIndexFixture({
    components: [{
      pkg: 'Mail', name: 'MailDetail',
      file: 'out/tmp/project/assets/MailDetail/MailDetail.xml',
    }],
  });
  const { genPlan } = run([{ op: 'REUSE', slot: 'mail_bg', node: 'L001' }], {
    projectIndex: idx,
    options: { projectRoot, rootDir: REPO },
  });
  assert.equal(genPlan.target.file, 'assets/MailDetail/MailDetail.xml',
    '★ §4：target.file 必须是工程根相对路径');
  assert.equal(path.isAbsolute(genPlan.target.file), false);
  assert.ok(!genPlan.warnings.some((w) => w.code === 'TARGET_FILE_NOT_UNDER_PROJECT_ROOT'));
});

test('A3-0 正常: file 已是工程根相对时保持不变（幂等）', () => {
  const idx = projectIndexFixture(); // file = 'assets/Mail/MailDetail.xml'
  const { genPlan } = run([{ op: 'REUSE', slot: 'mail_bg', node: 'L001' }], {
    projectIndex: idx,
    options: { projectRoot: REPO, rootDir: REPO },
  });
  assert.equal(genPlan.target.file, TARGET_FILE);
});

test('A3-0 异常: 文件不在工程根下 → 保留原值 + 显式 warning（不猜、不抛错）', () => {
  const projectRoot = path.join(REPO, 'out', 'tmp', 'project');
  const idx = projectIndexFixture({
    components: [{ pkg: 'Mail', name: 'MailDetail', file: 'outside-root/some/other.xml' }],
  });
  const { genPlan, exitCode } = run([{ op: 'REUSE', slot: 'mail_bg', node: 'L001' }], {
    projectIndex: idx,
    options: { projectRoot, rootDir: REPO },
  });
  assert.equal(exitCode, EXIT.OK, '不抛错');
  assert.equal(genPlan.target.file, 'outside-root/some/other.xml',
    '★ 不在工程根下时不猜，保留 index 原值');
  const w = genPlan.warnings.find((x) => x.code === 'TARGET_FILE_NOT_UNDER_PROJECT_ROOT');
  assert.ok(w, '★ 必须显式告警，绝不静默');
  assert.ok(w.msg.includes(projectRoot), 'warning 应给出「工程根」');
  assert.ok(w.msg.includes('outside-root/some/other.xml'), 'warning 应给出「index 原始路径」');
});

test('A3-0 兼容: 未给 projectRoot → 沿用 index 原值（不破坏既有调用方）', () => {
  const { genPlan } = run([{ op: 'REUSE', slot: 'mail_bg', node: 'L001' }]);
  assert.equal(genPlan.target.file, TARGET_FILE);
  assert.ok(!genPlan.warnings.some((w) => w.code === 'TARGET_FILE_NOT_UNDER_PROJECT_ROOT'));
});

// ════════════════════════════════════════════════════════════════════════════
// 边界与防御
// ════════════════════════════════════════════════════════════════════════════

test('防御: 缺 changePlan / projectIndex → 抛 AppError(BAD_ARGUMENT)', () => {
  assert.throws(() => buildGenPlan({}), (err) => {
    assert.ok(err instanceof AppError);
    return true;
  });
  assert.throws(() => buildGenPlan({ changePlan: {} }), (err) => err instanceof AppError);
});

test('确定性: 同一输入两次运行 genPlan 深等（B9）', () => {
  const diffs = [
    { op: 'MOVE', slot: 'mail_bg', node: 'L001' },
    { op: 'ADD', slot: 'reward_icon', node: 'L017' },
  ];
  const opts = { targetIr: irFixture([
    { id: 'L001', bbox: { x: 1, y: 2, w: 3, h: 4 } },
    { id: 'L017', type: 'raster', bbox: { x: 0, y: 0, w: 10, h: 10 } },
  ]) };
  const a = run(diffs, opts).genPlan;
  const b = run(diffs, opts).genPlan;
  assert.deepEqual(a, b);
});

test('evaluateGate: 直接消费 planner 的三态（防返回形状漂移）', () => {
  const g = evaluateGate({ diffs: [{ op: 'INFERRED' }, { op: 'MOVE', slot: 'x' }] });
  assert.equal(g.needsHuman, true);
  assert.equal(g.inferredCount, 1);
  assert.equal(g.ambiguousCount, 0);
  assert.ok(Array.isArray(g.reasons) && typeof g.reasons[0] === 'string', 'reasons 是字符串数组');
});
