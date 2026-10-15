'use strict';
/**
 * test/unit/gen-plan-seam.test.js —— M2 接缝测试：**真实 buildGenPlan 产出 → runDryrun**
 *
 * ★ 为什么单独有这个文件（它是 P0 缺陷的止血）★
 *   gen-plan 与 gen-dryrun 各自单测都全绿，但把两者**真正接起来**才暴露了
 *   「REUSE 条目 patch=null → applyEntry 抛错 → dryrun 退出 2、一个补丁都应用不了」。
 *   根因正是：两边各自**手写 JSON** 测各自的假设，谁都没用对方的真实产出。
 *   故本文件**绝不手写 gen_plan**：一律走真实 `buildGenPlan()`，再喂 `runDryrun()`。
 *
 * 覆盖：§5 的全部 6 个 op（REUSE/MOVE/RESIZE+scale9grid/RESTYLE/ADD/REMOVE）
 *       + 一条 blocked + 一条 skipped → 断言 exitCode===0 且无 error。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { makeFguiProject } = require('../fixtures/make-fgui-project');
const { buildGenPlan } = require('../../src/fgui/gen-plan');
const { runDryrun } = require('../../src/fgui/gen-dryrun');

const ROOT = path.resolve(__dirname, '../..');
const FIXTURE = path.join(ROOT, 'test/fixtures/fgui-project');
const FILE = 'assets/MailDetail/MailDetail.xml';

/** 保证 fixture 存在（读共享只读基准；缺则现造）。 */
function ensureFixture() {
  if (!fs.existsSync(path.join(FIXTURE, 'MailPopup.fairy'))) {
    makeFguiProject({ outDir: FIXTURE });
  }
  return FIXTURE;
}

/** 目标组件内容（真实 fixture 原文）。 */
function readTarget() {
  return fs.readFileSync(path.join(ensureFixture(), FILE), 'utf8');
}

/** 目标包 MailDetail 的 project_index（真实形态：components + resources）。 */
function makeProjectIndex() {
  return {
    project: { packages: [{ name: 'MailDetail', id: 'e5f6a7b8' }] },
    components: [
      { pkg: 'MailDetail', name: 'MailDetail', file: FILE, pkgId: 'e5f6a7b8' },
    ],
    resources: [
      { pkg: 'MailDetail', pkgId: 'e5f6a7b8', type: 'image', id: 'a7b8c9d0', name: 'reward_icon.png', exported: true, width: 96, height: 96 },
      { pkg: 'MailDetail', pkgId: 'e5f6a7b8', type: 'image', id: 'b8c9d0e1', name: 'ghost.png', exported: true, width: 64, height: 64 },
    ],
  };
}

/** 目标 IR（提供 bbox/type，供 MOVE/RESIZE/ADD 取结构化数据）。 */
function makeTargetIr() {
  return {
    layers: [
      { id: 'L011', type: 'raster', bbox: { x: 200, y: 200, w: 96, h: 96 } }, // MOVE reward_icon
      { id: 'L012', type: 'raster', bbox: { x: 24, y: 24, w: 128, h: 128 } }, // RESIZE reward_icon
      { id: 'L014', type: 'raster', bbox: { x: 24, y: 260, w: 96, h: 96 } }, // ADD reward_icon
      { id: 'L900', type: 'smartobject', bbox: { x: 0, y: 0, w: 10, h: 10 } }, // ADD blocked（智能对象）
    ],
  };
}

/** 一条覆盖 6 op + blocked + skipped 的 change_plan（slot 命中 fixture 节点名）。 */
function makeChangePlan() {
  return {
    version: '1.0',
    task: { name: 'MailDetail', basePkg: 'MailDetail', targetPkg: 'MailDetail' },
    diffs: [
      { op: 'REUSE', slot: 'frame', node: 'L010' }, // patch=null（P0 的关键路径）
      { op: 'MOVE', slot: 'reward_icon', node: 'L011' },
      {
        op: 'RESIZE',
        slot: 'reward_icon',
        node: 'L012',
        fguiStrategy: { scale9grid: { scale9grid: '16,16,64,64' } },
      },
      {
        op: 'RESTYLE',
        slot: 'title',
        node: 'L013',
        fguiStrategy: { color: { color: '#ff0000', alpha: 0.5 } },
      },
      { op: 'ADD', slot: 'reward_icon', node: 'L014' },
      { op: 'REMOVE', slot: 'rewards', confidence: 0.9 }, // resolved → visible=false
      { op: 'ADD', slot: 'ghost', node: 'L900' }, // blocked（smartobject）
      { op: 'REMOVE', slot: 'title', confidence: 0.3 }, // skipped（低置信度）
    ],
  };
}

test('seam: 真实 buildGenPlan → runDryrun，6 个 op + blocked + skipped 全跑通（exitCode 0、无 error）', () => {
  const content = readTarget();
  const projectIndex = makeProjectIndex();
  const targetIr = makeTargetIr();

  const built = buildGenPlan({
    changePlan: makeChangePlan(),
    projectIndex,
    baseIr: { layers: [] },
    targetIr,
    targetContents: { [FILE]: content },
  });

  // 前置：prepare 自身必须通过门禁
  assert.equal(built.exitCode, 0, 'prepare 应通过（无 INFERRED/歧义）');
  assert.equal(built.genPlan.gate.needsHuman, false);

  const byOp = {};
  for (const e of built.genPlan.entries) byOp[e.op] = e;
  // 6 个 op 都在，且状态符合预期
  assert.deepEqual(
    Object.keys(byOp).sort(),
    ['ADD', 'MOVE', 'REMOVE', 'RESIZE', 'RESTYLE', 'REUSE'].sort(),
    '应覆盖 §5 的全部 6 个 op',
  );
  assert.equal(byOp.REUSE.status, 'resolved');
  assert.equal(byOp.REUSE.patch, null, 'REUSE 契约：resolved + patch=null');

  // ★ 关键：把真实产出直接喂 dryrun ★
  const { report, exitCode } = runDryrun({
    genPlan: built.genPlan,
    projectIndex,
    targetContents: { [FILE]: content },
  });

  assert.equal(exitCode, 0, `dryrun 必须 exitCode 0；errors=${JSON.stringify(report.errors)}`);
  assert.deepEqual(report.errors, [], 'dryrun 不应有 error');
  assert.equal(report.files[0].lint.errors.length, 0, `lint 不应有 error：${JSON.stringify(report.files[0].lint.errors)}`);

  // 账目：5 应用（MOVE/RESIZE/RESTYLE/ADD/REMOVE）+ 1 空操作（REUSE）+ 2 跳过（blocked+skipped）
  assert.equal(report.summary.entriesApplied, 5, 'MOVE/RESIZE/RESTYLE/ADD/REMOVE 应被应用');
  assert.equal(report.summary.entriesNoop, 1, 'REUSE 应记为「已处理空操作」，而非 applied/skipped');
  assert.equal(report.summary.entriesSkipped, 2, 'blocked + skipped 应计入 skipped');

  // no-op 必须可见且**不**进 skippedEntries
  assert.ok(
    report.files[0].notes.some((n) => /no-op/.test(n) && /REUSE/.test(n)),
    'REUSE 空操作应在 notes 中可见',
  );
  assert.ok(
    !report.files[0].skippedEntries.some((s) => s.op === 'REUSE'),
    'REUSE 不得被当作 skipped',
  );

  // 补丁确实生效：ADD 的新 image 出现在 diff
  assert.ok(
    report.files[0].diff.includes('+    <image id="b00004"'),
    'ADD 的新节点应出现在 diff',
  );
});
