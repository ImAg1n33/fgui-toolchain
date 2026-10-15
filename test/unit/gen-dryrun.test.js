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
const { runDryrun, sha256 } = require('../../src/fgui/gen-dryrun');

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
  const errs = report.files[0].lint.errors;
  assert.ok(errs.some((e) => e.rule === 'R-03'), '应报出 R-03 颜色规则错误');
  assert.equal(report.summary.lintErrors >= 1, true);

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

  assert.equal(exitCode, 0, `预期 lint clean（实际 errors=${JSON.stringify(report.files[0].lint.errors)}）`);
  assert.equal(report.ok, true);
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
