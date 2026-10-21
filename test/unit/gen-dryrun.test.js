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
test('buildLintResources: 带 type（R-11 需要），且无尺寸的登记项（component）不被丢弃', () => {
  const map = buildLintResources({
    resources: [
      {
        pkgId: 'e5f6a7b8', id: 'a7b8c9d0', name: 'reward_icon.png', type: 'image', width: 96, height: 96,
      },
      {
        pkgId: 'e5f6a7b8', id: 'f6a7b8c9', name: 'MailDetail', type: 'component', width: null, height: null,
      },
    ],
  });
  // 图片：带尺寸 + type
  assert.equal(map.a7b8c9d0.type, 'image');
  assert.equal(map.a7b8c9d0.w, 96);
  assert.equal(map.a7b8c9d0.h, 96);
  // 组件：无尺寸但**仍登记**（否则 R-11 只会说"未登记"，说不出"不是图片"）
  assert.equal(map.f6a7b8c9.type, 'component');
  assert.equal(map.f6a7b8c9.w, undefined, '无尺寸条目不得伪造 w');
});
