'use strict';
/**
 * test/unit/gen-dryrun.test.js —— M2 第 4 步：dryrun 核心单测（contract-first）
 *
 * ★ 方法论 ★
 *   gen-dryrun 与 gen-plan 解耦，接口就是 **已冻结的 gen_plan.json 结构**（M2-SPEC §4）。
 *   因此本测试**手写** gen_plan JSON（不依赖 gen-plan.js），用第 1 步 golden 的同一份
 *   MailDetail.xml 原文做输入，覆盖：漂移 → 2、lint 失败 → 3（且不就地改调用方入参）、
 *   打补丁生效（MOVE + ADD）、diff 格式、确定性（两次运行逐字节一致）。
 *
 * 按审查者纪律：只加守住契约的用例。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { makeFguiProject } = require('../fixtures/make-fgui-project');
const { runDryrun, sha256, buildLintResources } = require('../../src/fgui/gen-dryrun');

const ROOT = path.resolve(__dirname, '../..');
const FIXTURE = path.join(ROOT, 'test/fixtures/fgui-project');
const FILE = 'assets/MailDetail/MailDetail.xml';

/** 保证 fixture 存在（缺就现造）。 */
function ensureFixture() {
  if (!fs.existsSync(path.join(FIXTURE, 'MailPopup.fairy'))) {
    makeFguiProject({ outDir: FIXTURE });
  }
  return FIXTURE;
}

/** 读 MailDetail.xml 原文。 */
function readTarget() {
  return fs.readFileSync(path.join(ensureFixture(), FILE), 'utf8');
}

/** 造一份覆盖 MOVE + ADD 的 gen_plan（target.sha256 按传入内容计算）。 */
function makeGenPlan(content, overrides = {}) {
  return {
    version: '1.0',
    task: { name: 'MailDetail', basePkg: 'Mail', targetPkg: 'Mail' },
    target: {
      component: 'MailDetail',
      pkg: 'MailDetail',
      pkgId: 'e5f6a7b8',
      file: FILE,
      sha256: sha256(content),
    },
    entries: [
      {
        op: 'MOVE',
        slot: 'reward_icon',
        node: 'L008',
        baseNode: 'L012',
        status: 'resolved',
        nodeId: 'b00001',
        patch: { attr: 'xy', value: '200,200' },
        note: '上游建议 relation：水平右移（M2 用绝对坐标）',
      },
      {
        op: 'ADD',
        slot: 'new_icon',
        status: 'resolved',
        patch: {
          tag: 'image',
          attrs: {
            id: 'b00004', name: 'new_icon', src: 'ui://e5f6a7b8/a7b8c9d0', xy: '24,260', size: '96,96',
          },
          after: 'b00003',
        },
        note: '资源已在 package.xml 登记',
      },
      {
        op: 'INFERRED',
        slot: 'maybe_badge',
        status: 'unresolved',
        note: '歧义，未确认',
      },
      {
        op: 'ADD',
        slot: 'blocked_add',
        status: 'blocked',
        note: '需先导入素材并登记 package.xml',
      },
    ],
    ...overrides,
  };
}

/** 取 diff 的正文行（排除 `---` / `+++` 头）。 */
function diffBodyLines(diff) {
  return diff.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++'));
}

// ────────────────────────────────────────────────────────────────────────────
test('dryrun: 漂移校验 —— 篡改一个字节 → exitCode 2，零打补丁', () => {
  const original = readTarget();
  const plan = makeGenPlan(original); // sha256 基于原文
  const tampered = original.replace('xy="24,24"', 'xy="25,25"'); // 改一个字节
  assert.notEqual(tampered, original);

  const { report, exitCode } = runDryrun({
    genPlan: plan,
    projectIndex: null,
    targetContents: { [FILE]: tampered },
  });

  assert.equal(exitCode, 2, '漂移应返回 USAGE(2)');
  assert.equal(report.ok, false);
  assert.equal(report.files[0].status, 'drift');
  assert.ok(report.files[0].drift, '应记录 drift 详情');
  assert.equal(report.files[0].changed, false);
  assert.ok(report.errors.some((e) => /重跑 prepare/.test(e)), '应有「重跑 prepare」提示');
});

// ────────────────────────────────────────────────────────────────────────────
test('dryrun: lint 门禁 —— 8 位色 patch → exitCode 3，报出 R-03，且不就地改调用方入参', () => {
  const original = readTarget();
  const plan = makeGenPlan(original);
  // 人改坏了：把 MOVE 换成给 title 节点塞 8 位色（R-03 硬约束必错）
  plan.entries = [{
    op: 'RESTYLE',
    slot: 'title',
    status: 'resolved',
    nodeId: 'b00002',
    patch: { attrs: { color: '#000000c8' } },
    note: '人为构造的非法 patch',
  }];

  const targetContents = { [FILE]: original };
  const planSnapshot = JSON.stringify(plan);

  const { report, exitCode } = runDryrun({ genPlan: plan, projectIndex: null, targetContents });

  assert.equal(exitCode, 3, 'lint error 应返回 LINT_BLOCKED(3)');
  assert.equal(report.ok, false);
  assert.equal(report.summary.status, 'failed', 'lint error → failed');
  const errs = report.files[0].lint.errors;
  assert.ok(errs.some((e) => e.rule === 'R-03'), '应报出 R-03 颜色规则错误');
  assert.equal(report.summary.lintErrors >= 1, true);

  // ★ BUG-C：per-file 的 lint error 必须同时出现在顶层 errors（含 file + rule/message）★
  assert.ok(report.errors.length >= 1, '顶层 errors 不应为空（BUG-C）');
  assert.ok(
    report.errors.some((m) => /R-03/.test(m) && new RegExp(FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(m)),
    `顶层 errors 应含 file + rule（实测：${JSON.stringify(report.errors)}）`,
  );

  // ★ 内存打补丁不得污染调用方 ★
  assert.equal(targetContents[FILE], original, '调用方 targetContents 字符串被篡改');
  assert.equal(Object.keys(targetContents).length, 1);
  assert.equal(JSON.stringify(plan), planSnapshot, '调用方 genPlan 被就地修改');
});

// ────────────────────────────────────────────────────────────────────────────
test('dryrun: 打补丁生效 —— MOVE + ADD 结果出现在 diff，且 resolved/非 resolved 各自归位', () => {
  const original = readTarget();
  const plan = makeGenPlan(original);

  const { report, exitCode } = runDryrun({
    genPlan: plan,
    projectIndex: null,
    targetContents: { [FILE]: original },
  });

  // ★ 三态契约（M2-SPEC §4.1①）：有 unresolved/blocked（=非 resolved）→ partial → 退出码 4 ★
  assert.equal(exitCode, 4, `含非 resolved 条目应为 partial(4)（lint errors=${JSON.stringify(report.files[0].lint.errors)}）`);
  assert.equal(report.ok, false, 'partial 时 ok 必须为 false（与退出码解耦的第二信号）');
  assert.equal(report.summary.status, 'partial');
  assert.equal(report.summary.blockedCount, 1, 'blocked 条目应计入 blockedCount');
  assert.equal(report.summary.entriesApplied, 2, '两条 resolved 条目应被应用');
  assert.equal(report.summary.entriesSkipped, 2, 'unresolved + blocked 应被跳过');

  const diff = report.files[0].diff;
  // MOVE：b00001 的 xy 由 24,24 → 200,200（出现在 -/+ 行）
  assert.ok(diff.includes('-    <image id="b00001" name="reward_icon" src="ui://e5f6a7b8/a7b8c9d0" xy="24,24" size="96,96"/>'), '缺 MOVE 删除行');
  assert.ok(diff.includes('+    <image id="b00001" name="reward_icon" src="ui://e5f6a7b8/a7b8c9d0" xy="200,200" size="96,96"/>'), '缺 MOVE 新增行');
  // ADD：新 image 以 4 空格缩进出现在 list 之后
  assert.ok(diff.includes('+    <image id="b00004" name="new_icon" src="ui://e5f6a7b8/a7b8c9d0" xy="24,260" size="96,96"/>'), '缺 ADD 新增行');

  // 跳过的条目可见（不静默）
  assert.equal(report.files[0].skippedEntries.length, 2);
  assert.ok(report.files[0].skippedEntries.some((s) => s.status === 'unresolved'));
  assert.ok(report.files[0].skippedEntries.some((s) => s.status === 'blocked'));

  // ADD 按 §9 追加到 displayList 末尾，且「忽略 after 锚点」被显式记录（非静默）
  assert.ok(
    report.files[0].notes.some((n) => /M2-SPEC §9/.test(n) && /after=b00003/.test(n)),
    'ADD 忽略 after 锚点必须显式记入 notes',
  );

  // --allow-partial：显式允许部分构建 → 退出码回到 0，但 ok 仍为 false、status 仍 partial
  const allowed = runDryrun({
    genPlan: plan,
    projectIndex: null,
    targetContents: { [FILE]: original },
    options: { allowPartial: true },
  });
  assert.equal(allowed.exitCode, 0, '--allow-partial 时 partial 不拦退出码');
  assert.equal(allowed.report.ok, false, '--allow-partial 不改变 ok（仍 partial）');
  assert.equal(allowed.report.summary.status, 'partial');
});

// ────────────────────────────────────────────────────────────────────────────
test('dryrun: unified diff 格式 —— 含 @@ hunk 头，-/+ 行成对出现', () => {
  const original = readTarget();
  const plan = makeGenPlan(original);

  const { report } = runDryrun({
    genPlan: plan,
    projectIndex: null,
    targetContents: { [FILE]: original },
  });

  const diff = report.files[0].diff;
  assert.match(diff, /@@ -\d+,\d+ \+\d+,\d+ @@/, '缺少 @@ hunk 头');
  assert.ok(diff.startsWith('--- a/'), '缺少 --- 头');
  assert.ok(diff.includes('+++ b/'), '缺少 +++ 头');

  const body = diffBodyLines(diff);
  const dels = body.filter((l) => l.startsWith('-'));
  const ins = body.filter((l) => l.startsWith('+'));
  assert.ok(dels.length >= 1, '缺少删除行');
  assert.ok(ins.length >= 1, '缺少新增行');
});

// ────────────────────────────────────────────────────────────────────────────
test('dryrun: 确定性 —— 同输入两次运行 JSON 逐字节一致，且无时间戳', () => {
  const original = readTarget();
  const r1 = runDryrun({ genPlan: makeGenPlan(original), projectIndex: null, targetContents: { [FILE]: original } });
  const r2 = runDryrun({ genPlan: makeGenPlan(original), projectIndex: null, targetContents: { [FILE]: original } });

  assert.equal(JSON.stringify(r1.report), JSON.stringify(r2.report), '报告非确定性');
  assert.equal(r1.exitCode, r2.exitCode);
  // 报告里不得出现时间戳形态（ISO 8601）
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(JSON.stringify(r1.report)), '报告含时间戳');
});

// ────────────────────────────────────────────────────────────────────────────
test('dryrun: D9 防静默降级 —— 资源注入表为空且有 ui:// 引用 → LINT_RESOURCES_EMPTY 告警（不改退出码）', () => {
  const content = readTarget(); // MailDetail.xml，含多处 ui:// 引用
  const plan = {
    version: '1.0',
    target: { file: FILE, sha256: sha256(content) },
    entries: [],
  };

  // (a) width/height 全 null（典型成因：project-index 带 --no-images 跑）→ 有告警
  const emptyRes = {
    resources: [
      { pkgId: 'e5f6a7b8', id: 'a7b8c9d0', name: 'reward_icon.png', width: null, height: null },
    ],
  };
  const a = runDryrun({ genPlan: plan, projectIndex: emptyRes, targetContents: { [FILE]: content } });
  assert.equal(a.exitCode, 0, '只告警不改退出码');
  const wTop = a.report.warnings.find((w) => w.code === 'LINT_RESOURCES_EMPTY');
  assert.ok(wTop, '顶层 report.warnings 应含 LINT_RESOURCES_EMPTY');
  assert.ok(wTop.uiRefCount >= 1, 'warning 应带 ui:// 引用条数');
  assert.ok(
    a.report.files[0].lint.warnings.some((w) => w.rule === 'LINT_RESOURCES_EMPTY'),
    'files[].lint.warnings 应含该告警（md 报告据此可见）',
  );

  // (b) resources 有尺寸 → 不出现该告警
  const fullRes = {
    resources: [
      { pkgId: 'e5f6a7b8', id: 'a7b8c9d0', name: 'reward_icon.png', width: 96, height: 96 },
    ],
  };
  const b = runDryrun({ genPlan: plan, projectIndex: fullRes, targetContents: { [FILE]: content } });
  assert.ok(!b.report.warnings.some((w) => w.code === 'LINT_RESOURCES_EMPTY'), '有资源时不应告警');
  assert.ok(!b.report.files[0].lint.warnings.some((w) => w.rule === 'LINT_RESOURCES_EMPTY'));

  // (c) 无 ui:// 引用的文本 + 空资源 → 也不告警（避免噪声）
  const noRef = ['<?xml version="1.0" encoding="utf-8"?>', '<component size="10,10">', '  <displayList>', '    <graph id="b00001" name="g" xy="0,0" size="10,10"/>', '  </displayList>', '</component>', ''].join('\n');
  const planNoRef = { version: '1.0', target: { file: FILE, sha256: sha256(noRef) }, entries: [] };
  const c = runDryrun({ genPlan: planNoRef, projectIndex: emptyRes, targetContents: { [FILE]: noRef } });
  assert.ok(!c.report.warnings.some((w) => w.code === 'LINT_RESOURCES_EMPTY'), '无 ui:// 引用时不应告警');
});

// ────────────────────────────────────────────────────────────────────────────
test('dryrun: REUSE（resolved + patch:null）是空操作，不抛错、不改字节、不计 applied/skipped', () => {
  const content = readTarget();
  const base = { version: '1.0', target: { file: FILE, sha256: sha256(content) } };

  // (a) 显式 patch: null
  const p1 = { ...base, entries: [{ op: 'REUSE', slot: 'frame', status: 'resolved', nodeId: 'c00001', patch: null }] };
  const r1 = runDryrun({ genPlan: p1, projectIndex: null, targetContents: { [FILE]: content } });
  assert.equal(r1.exitCode, 0, 'REUSE 不得把退出码抬成 2');
  assert.deepEqual(r1.report.errors, [], 'REUSE 不得记 error');
  assert.equal(r1.report.files[0].changed, false, '空操作不应改字节');
  assert.equal(r1.report.files[0].diff, '', '空操作不应产生 diff');
  assert.equal(r1.report.summary.entriesNoop, 1);
  assert.equal(r1.report.summary.entriesApplied, 0);
  assert.equal(r1.report.summary.entriesSkipped, 0, '空操作不是 skipped');
  assert.ok(r1.report.files[0].notes.some((n) => /no-op/.test(n)), 'notes 应可见该空操作');

  // (b) 缺 patch 键（契约要求同时容忍 null 与缺键）
  const p2 = { ...base, entries: [{ op: 'REUSE', slot: 'frame', status: 'resolved', nodeId: 'c00001' }] };
  const r2 = runDryrun({ genPlan: p2, projectIndex: null, targetContents: { [FILE]: content } });
  assert.equal(r2.exitCode, 0);
  assert.equal(r2.report.summary.entriesNoop, 1);
  assert.deepEqual(r2.report.errors, []);
});

// ────────────────────────────────────────────────────────────────────────────
test('buildLintResources: 带 type、按 URL 全量 + 仅目标包本地表（R-11 作用域）', () => {
  const projectIndex = {
    resources: [
      {
        pkg: 'MailDetail', pkgId: 'e5f6a7b8', id: 'a7b8c9d0', name: 'reward_icon.png', type: 'image', width: 96, height: 96,
      },
      {
        pkg: 'MailDetail', pkgId: 'e5f6a7b8', id: 'f6a7b8c9', name: 'MailDetail', type: 'component', width: null, height: null,
      },
      {
        pkg: 'Common', pkgId: 'a1b2c3d4', id: 'abc01', name: 'common_img.png', type: 'image', width: 10, height: 10,
      },
    ],
  };
  const table = buildLintResources(projectIndex, { targetPkg: 'MailDetail' });

  // 本地表：只有目标包（MailDetail）
  assert.equal(table.localById.get('a7b8c9d0').type, 'image');
  assert.equal(table.localById.get('a7b8c9d0').w, 96);
  assert.equal(table.localById.get('f6a7b8c9').type, 'component');
  assert.equal(table.localById.get('f6a7b8c9').w, undefined, '无尺寸条目不得伪造 w');
  // ★ 跨包不泄漏：Common 的 abc01 不在本包短 ID 表里
  assert.equal(table.get('abc01'), undefined, '短 ID 查找绝不能命中别的包');
  assert.equal(table.localById.has('abc01'), false);

  // 全量表：ui:// 精确查找跨包可用（R-05/R-10 依赖）
  assert.equal(table.get('ui://a1b2c3d4/abc01').type, 'image');
  assert.equal(table.get('ui://e5f6a7b8/a7b8c9d0').w, 96);
  // ui:// 形态只查全量表（不落到本地短 ID 表）
  assert.equal(table.get('ui://unknown/pkg'), undefined);

  // D9 计量：带有限 w/h 的条目数（Mail 的图 + Common 的图 = 2）
  assert.equal(table.measuredCount, 2);
});

// ════════════════════════════════════════════════════════════════════════════
// R-11 作用域（P0）：短 ID 只在**目标包**内查找；R-04 增加包存在性 warning
// ════════════════════════════════════════════════════════════════════════════
const { lintComponentXml } = require('../../src/fgui/lint-rules');

/** 造最小组件 XML（displayList 内若干行）。 */
function wrap(lines) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<component size="480,320" exported="true">',
    '  <displayList>',
    ...lines,
    '  </displayList>',
    '</component>',
    '',
  ].join('\n');
}

/** 两包工程索引：MailDetail 有 img（q0jse 只是**名字**）、Common 有 component id=abc02。 */
const TWO_PKG_INDEX = {
  project: {
    packages: [{ name: 'MailDetail', id: 'e5f6a7b8' }, { name: 'Common', id: 'a1b2c3d4' }],
  },
  resources: [
    {
      pkg: 'MailDetail', pkgId: 'e5f6a7b8', id: 'q0jsh', name: 'q0jse', type: 'image', width: 100, height: 50,
    },
    {
      pkg: 'Common', pkgId: 'a1b2c3d4', id: 'q0jse', name: 'common_comp', type: 'component', width: null, height: null,
    },
    {
      pkg: 'Common', pkgId: 'a1b2c3d4', id: 'abc01', name: 'common_img.png', type: 'image', width: 100, height: 50,
    },
    {
      pkg: 'MailDetail', pkgId: 'e5f6a7b8', id: 'mail_bg', name: 'mail_bg', type: 'image', width: 480, height: 320,
    },
  ],
};

/** lint 一段 XML，注入"目标包=MailDetail"的资源表。 */
function lintForMail(xml) {
  const table = buildLintResources(TWO_PKG_INDEX, { targetPkg: 'MailDetail' });
  return lintComponentXml(xml, {
    resources: table,
    packages: TWO_PKG_INDEX.project.packages,
  });
}

const byRuleId = (r, id) => [...r.errors, ...r.warnings].filter((i) => i.rule === id);

test('★ P0-1 跨包短 ID（本包没有、别的包有）→ 必须报「未登记」', () => {
  // MailDetail 组件引用只有 Common 才有的短 ID abc01
  const r = lintForMail(wrap([
    '    <image id="b00001" name="x" src="abc01" xy="0,0" size="10,10"/>',
  ]));
  const issues = byRuleId(r, 'R-11');
  assert.equal(issues.length, 1, '跨包短 ID 不得被当成"已登记"（改前 0 报）');
  assert.ok(issues[0].message.includes('没有') || issues[0].message.includes('未登记'));
});

test('★ P0-2 name/id 撞键 → 报「未登记」，且**不得**说成"不是图片"', () => {
  // src="q0jse"：MailDetail 里 q0jse 只是某资源的 **name**；Common 里 q0jse 是 component 的 **id**
  const r = lintForMail(wrap([
    '    <image id="b00001" name="x" src="q0jse" xy="0,0" size="10,10"/>',
  ]));
  const issues = byRuleId(r, 'R-11');
  assert.equal(issues.length, 1);
  assert.ok(issues[0].message.includes('没有') || issues[0].message.includes('未登记'),
    `本包内没有 id=q0jse，应报未登记；实际：${issues[0].message}`);
  assert.ok(!issues[0].message.includes('不是图片'),
    '不得把别的包 component 当成引用目标（改前会误报"不是图片"）');
});

test('★ 正例：目标包内确有该短 ID 的图 → 0 报', () => {
  const r = lintForMail(wrap([
    '    <image id="b00001" name="x" src="mail_bg" xy="0,0" size="10,10"/>',
  ]));
  assert.deepEqual(byRuleId(r, 'R-11'), []);
});

test('★ 目标包内短 ID 指向 component → 仍报「不是图片」', () => {
  const index = {
    project: { packages: [{ name: 'MailDetail', id: 'e5f6a7b8' }] },
    resources: [
      { pkg: 'MailDetail', pkgId: 'e5f6a7b8', id: 'f6a7b8c9', name: 'MailDetail', type: 'component', width: null, height: null },
    ],
  };
  const table = buildLintResources(index, { targetPkg: 'MailDetail' });
  const r = lintComponentXml(wrap([
    '    <image id="b00001" name="x" src="f6a7b8c9" xy="0,0" size="10,10"/>',
  ]), { resources: table, packages: index.project.packages });
  const issues = byRuleId(r, 'R-11');
  assert.equal(issues.length, 1);
  assert.ok(issues[0].message.includes('不是图片'));
});

test('★ 回归：跨包 ui:// 仍能被 R-05 精确命中（byUrl 全量表未被拆坏）', () => {
  // Common 的图 100x50；scale9grid 中心矩形 210 宽 → 越界，证明 R-05 命中了跨包资源
  const r = lintForMail(wrap([
    '    <image id="b00001" name="x" src="ui://a1b2c3d4/abc01" scale9grid="10,10,210,20" xy="0,0" size="10,10"/>',
  ]));
  assert.deepEqual(byRuleId(r, 'R-04'), [], '跨包 ui:// 的包 id 合法（R-04 通过）');
  const r05 = byRuleId(r, 'R-05');
  assert.equal(r05.length, 1, 'R-05 应命中 byUrl 里的跨包资源并报越界');
  assert.ok(/越界/.test(r05[0].message));
});

test('★ localById 为空（目标包无资源信息）但 byUrl 非空 → R-11 跳过（不产生噪声）', () => {
  // 目标包设为不存在的包 → 本地表为空
  const table = buildLintResources(TWO_PKG_INDEX, { targetPkg: 'NoSuchPkg' });
  assert.equal(table.localById.size, 0);
  assert.ok(table.byUrl.size > 0, '全量表仍有内容');
  const r = lintComponentXml(wrap([
    '    <image id="b00001" name="x" src="abc01" xy="0,0" size="10,10"/>',
  ]), { resources: table });
  assert.deepEqual(byRuleId(r, 'R-11'), [], '目标包无资源信息时 R-11 必须跳过');
});

test('★ R-04: 包 id 不在索引包清单里 → warning（不是 error）', () => {
  const r = lintForMail(wrap([
    '    <loader id="b00001" name="x" url="ui://deadbeef/item" xy="0,0" size="10,10"/>',
  ]));
  const issues = byRuleId(r, 'R-04');
  assert.equal(issues.length, 1, '不存在的包 id 应报一条');
  assert.equal(issues[0].severity, 'warning', '必须是 warning（索引可能不完整，不误伤）');
  assert.ok(issues[0].message.includes('deadbeef'));
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH 兼容缺口：R-05 / R-10 通过统一解析入口拿到真实工程的引用形态
// ════════════════════════════════════════════════════════════════════════════
//
// 改前：`firstUiRef` 只认 `^ui://` → `<image src="q0jse">`（短 ID）拿到 null；
//       concat `ui://mailpkg1item001` 因 lookupResource 的 tail 拆分也命不中
//       → R-05/R-10 **静默跳过**（九宫格保护在真实工程形态下失效）。

/** 单包工程索引：一张 100x50 的图，id='q0jse'，name='bg.png'。 */
const ONE_IMG_INDEX = {
  project: { packages: [{ name: 'Mail', id: 'mailpkg1' }] },
  resources: [{
    pkg: 'Mail', pkgId: 'mailpkg1', id: 'q0jse', name: 'bg.png', type: 'image', width: 100, height: 50,
  }],
};

const lintWithMail = (xml, idx = ONE_IMG_INDEX) => lintComponentXml(xml, {
  resources: buildLintResources(idx, { targetPkg: 'Mail' }),
  packages: idx.project.packages,
});

test('★ 短 ID + scale9grid → R-05 能拿到尺寸并报越界（改前 ref=null 直接跳过）', () => {
  const r = lintWithMail(wrap([
    '    <image id="b00001" name="bg" src="q0jse" scale9grid="10,10,200,20" xy="0,0" size="100,50"/>',
  ]));
  const r05 = byRuleId(r, 'R-05');
  assert.equal(r05.length, 1, '短 ID 引用的图必须能拿到尺寸（否则静默跳过）');
  assert.ok(/越界/.test(r05[0].message));
  assert.equal(r05[0].severity, 'error');
});

test('★ concat ui://（真实工程写法）+ scale9grid → 能解析到资源并报越界', () => {
  const idx = {
    project: { packages: [{ name: 'Mail', id: 'mailpkg1' }] },
    resources: [{
      pkg: 'Mail', pkgId: 'mailpkg1', id: 'item001', name: 'card.png', type: 'image', width: 100, height: 50,
    }],
  };
  const r = lintWithMail(
    wrap(['    <image id="b00001" name="card" src="ui://mailpkg1item001" scale9grid="10,10,200,20" xy="0,0" size="100,50"/>']),
    idx,
  );
  const r05 = byRuleId(r, 'R-05');
  assert.equal(r05.length, 1, 'concat 引用必须被归一化后命中（改前 tail 拆分命不中）');
  assert.ok(/越界/.test(r05[0].message));
});

test('★ slash ui:// + scale9grid → 同样能解析（两种风格并存）', () => {
  const idx = {
    project: { packages: [{ name: 'Mail', id: 'mailpkg1' }] },
    resources: [{
      pkg: 'Mail', pkgId: 'mailpkg1', id: 'item001', name: 'card.png', type: 'image', width: 100, height: 50,
    }],
  };
  const r = lintWithMail(
    wrap(['    <image id="b00001" name="card" src="ui://mailpkg1/item001" scale9grid="10,10,200,20" xy="0,0" size="100,50"/>']),
    idx,
  );
  assert.equal(byRuleId(r, 'R-05').length, 1);
});

test('★ 引用指向未知资源 → 可见 warning（不是 error，不静默跳过）', () => {
  const r = lintWithMail(wrap([
    '    <image id="b00001" name="bg" src="ui://mailpkg1/not_exist" scale9grid="1,1,2,2" xy="0,0" size="100,50"/>',
  ]));
  const r05 = byRuleId(r, 'R-05');
  assert.equal(r05.length, 1, '未知资源必须产生可见告警，不得静默跳过');
  assert.equal(r05[0].severity, 'warning', '索引不完整时不误伤 → warning');
  assert.ok(/无法对账/.test(r05[0].message));
  assert.ok(/not_exist/.test(r05[0].message), '告警应点名未知的引用');
});

test('★ R-11 回归：统一解析入口后，跨包短 ID 仍报「未登记」', () => {
  const idx = {
    project: { packages: [{ name: 'Mail', id: 'mailpkg1' }, { name: 'Common', id: 'commpkg1' }] },
    resources: [
      // 目标包 Mail 必须有资源，R-11 才具备"判断能力"（否则整条规则跳过，不产生噪声）
      {
        pkg: 'Mail', pkgId: 'mailpkg1', id: 'mail_bg', name: 'mail_bg.png', type: 'image', width: 10, height: 10,
      },
      {
        pkg: 'Common', pkgId: 'commpkg1', id: 'abc01', name: 'other.png', type: 'image', width: 10, height: 10,
      },
    ],
  };
  const r = lintWithMail(wrap(['    <image id="b00001" name="x" src="abc01" xy="0,0" size="10,10"/>']), idx);
  const r11 = byRuleId(r, 'R-11');
  assert.equal(r11.length, 1, '跨包短 ID 必须仍报未登记（作用域未被重构破坏）');
  assert.ok(/没有|未登记/.test(r11[0].message));
});
