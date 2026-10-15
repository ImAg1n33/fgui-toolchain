'use strict';
/**
 * test/e2e/gen-xml-pipeline.test.js —— M2 全链路 e2e（M2-SPEC §8「e2e」十条）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 两条环境事实（team-lead 实测 + 本文件固化）★
 *   1. **临时工程必须建在仓库内（D 盘）**，例如 `out/e2e-gen-xml/` 下。
 *      用 `os.tmpdir()`（C 盘）会让 `toPosixRel` 抛
 *      「两侧 Windows 路径不在同一个根（d: vs c:）」——**实测踩过**。
 *   2. **`project-index` 不得加 `--no-images`**：加了 width/height 全为 null，
 *      lint 的资源注入会变空表、R-05/R-10 静默降级。本文件有一条断言锁死这点。
 *
 * ★ 绝不写 `test/fixtures/fgui-project` 本身 ★（共享只读基准）
 *   每次都 `makeFguiProject({outDir})` 复制到临时目录后再打补丁。
 *
 * 十条逐条对应见各 test 标题的编号。
 * ════════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { runCli, runCliJson } = require('./run-cli');
const { makeFguiProject } = require('../fixtures/make-fgui-project');

const ROOT = path.resolve(__dirname, '../..');
/** 临时工程根（必须在仓库内 = D 盘，见文件头事实 1）。 */
const TMP_BASE = path.join(ROOT, 'out', 'e2e-gen-xml');

/** 目标组件相对路径（project-index 的 components[].file 值）。 */
const TARGET_REL = 'assets/MailDetail/MailDetail.xml';
/** 目标包名 / 组件名。 */
const PKG = 'MailDetail';
const COMP = 'MailDetail';

// ────────────────────────────────────────────────────────────────────────────
// 工具
// ────────────────────────────────────────────────────────────────────────────

/** 每个测试独立的临时目录（仓库内）。 */
function tmpDir(label) {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  return fs.mkdtempSync(path.join(TMP_BASE, `${label}-`));
}

/** sha256(内容)。 */
function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * 递归快照目录：relPath → sha256（用于「工程零改动」断言）。
 * @param {string} dir
 * @returns {object}
 */
function snapshotDir(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full).replace(/\\/g, '/')] = sha256(fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

/** 读 JSON。 */
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 写 JSON。 */
function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * 建「工程 + 索引 + change_plan + IR」，返回全部路径。
 * @param {string} label
 * @param {object} [opts]
 * @param {object[]} [opts.diffs] 覆盖默认 change_plan.diffs
 * @param {boolean} [opts.writePlan=true]
 * @returns {{dir:string, proj:string, out:string, indexPath:string, planPath:string,
 *            baseIrPath:string, targetIrPath:string, targetAbs:string}}
 */
function setup(label, opts = {}) {
  const dir = tmpDir(label);
  const proj = path.join(dir, 'project');
  const out = path.join(dir, 'out');
  fs.mkdirSync(out, { recursive: true });
  makeFguiProject({ outDir: proj });

  // ---- ② project-index CLI（**不加 --no-images**，见文件头事实 2）----
  const idx = runCli(['project-index', '--project', proj, '--out', out]);
  assert.equal(idx.code, 0, `project-index 应成功: ${idx.stderr.slice(0, 400)}`);
  const indexPath = path.join(out, 'project_index.json');
  assert.ok(fs.existsSync(indexPath), 'project_index.json 应存在');

  // ---- ③ 手写 change_plan + 迷你 IR ----
  const planPath = path.join(dir, 'change_plan.json');
  if (opts.writePlan !== false) {
    writeJson(planPath, {
      version: '1.0',
      task: { name: COMP, targetPkg: PKG, basePkg: PKG },
      diffs: opts.diffs || defaultDiffs(),
    });
  }
  const baseIrPath = path.join(dir, 'design_ir.A.json');
  writeJson(baseIrPath, { version: '1.0', layers: [{ id: 'L012', name: '旧名图层' }] });
  const targetIrPath = path.join(dir, 'design_ir.B.json');
  writeJson(targetIrPath, { version: '1.0', layers: targetLayers() });

  return {
    dir, proj, out, indexPath, planPath, baseIrPath, targetIrPath,
    targetAbs: path.join(proj, TARGET_REL),
  };
}

/** 默认 change_plan：6 个确定性 op（不含 INFERRED，故无需 --skip-unconfirmed）。 */
function defaultDiffs() {
  return [
    { op: 'MOVE', slot: 'title', node: 'L003' },
    { op: 'RESIZE', slot: 'frame', node: 'L001' },
    { op: 'RESTYLE', slot: 'title', node: 'L003', fguiStrategy: { color: { color: '#ffd278', alpha: '0.8' } } },
    { op: 'ADD', slot: 'reward_icon', node: 'L017' },
    { op: 'REMOVE', slot: 'rewards', node: 'L020', confidence: 0.9 },
    { op: 'REUSE', slot: 'frame', node: 'L001' },
  ];
}

/** 迷你 target IR（bbox 来源）。 */
function targetLayers() {
  return [
    { id: 'L001', type: 'raster', bbox: { x: 0, y: 0, w: 480, h: 360 } },   // frame
    { id: 'L003', type: 'text', bbox: { x: 140, y: 60, w: 200, h: 36 },      // title
      text: { value: '邮件详情', color: '#ffffff', fontSize: 24, align: 'left' } },
    { id: 'L017', type: 'raster', bbox: { x: 260, y: 380, w: 96, h: 96 } },  // 新增 reward_icon
    { id: 'L020', type: 'group', bbox: { x: 24, y: 140, w: 312, h: 96 } },   // rewards
  ];
}

/** 跑 prepare。 */
function runPrepare(f, extra = []) {
  return runCli([
    'gen-xml', 'prepare',
    '--plan', f.planPath, '--project', f.proj, '--index', f.indexPath,
    '--base-ir', f.baseIrPath, '--target-ir', f.targetIrPath, '--out', f.out,
    ...extra,
  ]);
}

/** 跑 dryrun。 */
function runDryrunCli(f) {
  return runCliJson([
    'gen-xml', 'dryrun',
    '--gen-plan', path.join(f.out, 'gen_plan.json'),
    '--project', f.proj, '--index', f.indexPath, '--out', f.out,
  ]);
}

/** 跑 apply。 */
function runApply(f, extra = []) {
  return runCli([
    'gen-xml', 'apply',
    '--gen-plan', path.join(f.out, 'gen_plan.json'),
    '--project', f.proj, '--index', f.indexPath, '--out', f.out,
    ...extra,
  ]);
}

/** 期望的最终 MailDetail.xml（apply 成功后的 golden）。
 *
 * ★ 新属性写入顺序是 **字母序**（xml-patcher 既定行为，team-lead 已裁定不改：
 *   字母序与插入序都满足 B9 确定性）—— 故 `alpha` 在 `color` 之前，golden 按现实写。
 */
function expectedGolden() {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<component size="560,360" extention="Button" exported="true">',
    '  <displayList>',
    '    <component id="c00001" name="frame" src="ui://a1b2c3d4/e4f5a6b7" xy="0,0" size="480,360"/>',
    '    <image id="b00001" name="reward_icon" src="ui://e5f6a7b8/a7b8c9d0" xy="24,24" size="96,96"/>',
    '    <text id="b00002" name="title" xy="140,60" size="200,36" text="邮件详情" alpha="0.8" color="#ffd278"/>',
    '    <list id="b00003" name="rewards" xy="24,140" size="312,96" defaultItem="RewardCell" visible="false"/>',
    '    <image id="b00004" name="reward_icon" src="ui://e5f6a7b8/a7b8c9d0" xy="260,380" size="96,96"/>',
    '  </displayList>',
    '</component>',
    '',
  ].join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// ①②③④ prepare
// ════════════════════════════════════════════════════════════════════════════

test('①②③ 前置: 临时工程在仓库内 + project-index 带图（width 非 null）', () => {
  const f = setup('prep');
  // ① 临时目录在仓库内（D 盘）——否则 toPosixRel 会抛 cross-root
  assert.ok(f.dir.startsWith(ROOT), `tmp 必须在仓库内: ${f.dir}`);
  // ★ fixture 本体绝不被写
  const fixtureDir = path.join(ROOT, 'test/fixtures/fgui-project');
  const before = snapshotDir(fixtureDir);
  const f2 = setup('prep2');
  assert.deepEqual(snapshotDir(fixtureDir), before, '★ 共享只读基准 test/fixtures/fgui-project 绝不可被写');

  // ② project-index 不加 --no-images → resources 带 width/height（否则 lint 资源注入空表）
  const index = readJson(f.indexPath);
  assert.equal(index.project.packages.length, 2, '两个包');
  const imgs = index.resources.filter((r) => r.type === 'image');
  assert.ok(imgs.length >= 4, `应有图片资源，实际 ${imgs.length}`);
  assert.ok(imgs.every((r) => r.width !== null && r.height !== null),
    '★ 未加 --no-images 时 width/height 必须非 null（否则 R-05/R-10 静默降级）');
  // ② 组件无节点树 → e2e 与 gen-plan 都靠 indexComponentXml 自行解析
  const comp = index.components.find((c) => c.name === COMP);
  assert.ok(comp, '应有 MailDetail 组件');
  assert.equal(comp.root, undefined, 'components[] 不含 root（须自行解析 XML）');
  assert.ok(fs.existsSync(f2.proj));
});

test('④ prepare → gen_plan.json 结构 + 退出码 0 + gate', () => {
  const f = setup('prep4');
  const r = runPrepare(f);
  assert.equal(r.code, 0, `prepare 应成功: ${r.stderr.slice(0, 500)}`);
  const gp = readJson(path.join(f.out, 'gen_plan.json'));

  assert.equal(gp.version, '1.0');
  assert.ok(gp._comment && gp._comment.includes('人工编辑'), '应有人可读说明');
  assert.ok(gp._entryNote, '应有逐字段说明');
  assert.deepEqual(gp.task, { name: COMP, targetPkg: PKG, basePkg: PKG });
  assert.equal(gp.target.component, COMP);
  // ⚠ 与 §4 的偏差（已上报 team-lead）：§4 要求 `assets/MailDetail/MailDetail.xml`
  //   （工程根相对），但 CLI 目前调用 buildGenPlan 时**未传 options.projectRoot**，
  //   故走 CLI 时仍是「相对 CLI rootDir」的路径（本项目已实现该能力并由单测锁定，
  //   CLI 侧另一位工程师负责接线）。此处断言两种形态都满足的强条件，
  //   等 CLI 传入 projectRoot 后可收紧为严格等值。
  assert.ok(gp.target.file.endsWith('assets/MailDetail/MailDetail.xml'),
    `target.file 应以工程内路径结尾，实际 ${gp.target.file}`);
  assert.equal(gp.target.sha256, sha256(fs.readFileSync(f.targetAbs, 'utf8')),
    'target.sha256 应是目标文件内容的 SHA-256');
  assert.ok(gp.target.pkgId, 'target.pkgId 应解析到（真实工程有 8 位包 id）');

  assert.equal(gp.gate.needsHuman, false);
  assert.equal(gp.gate.inferredCount, 0);
  assert.equal(gp.gate.ambiguousCount, 0);

  // 6 个 op 全部 resolved
  assert.equal(gp.entries.length, 6);
  assert.ok(gp.entries.every((e) => e.status === 'resolved'),
    `全部应 resolved，实际 ${JSON.stringify(gp.entries.map((e) => [e.op, e.status]))}`);
  assert.deepEqual(gp.summary.byOp, { MOVE: 1, RESIZE: 1, RESTYLE: 1, ADD: 1, REMOVE: 1, REUSE: 1 });
  assert.equal(gp.summary.byStatus.resolved, 6);
  assert.equal(gp.warnings.filter((w) => w.code === 'ADD_RESOURCE_NOT_REGISTERED').length, 0,
    '资源已登记，不应有 blocked');
});

// ════════════════════════════════════════════════════════════════════════════
// ⑤ dryrun：退出 0 + 工程零改动
// ════════════════════════════════════════════════════════════════════════════

test('⑤ dryrun → 退出码 0 + 工程目录字节快照前后相等（零写入）', () => {
  const f = setup('dry5');
  assert.equal(runPrepare(f).code, 0);

  const before = snapshotDir(f.proj);
  const r = runDryrunCli(f);
  assert.equal(r.code, 0, `dryrun 应成功: ${r.stderr.slice(0, 500)}`);
  const rep = r.json; // CLI stdout 是精简摘要；完整 diff/lint 在 dryrun_report.json
  assert.equal(rep.ok, true);
  assert.equal(rep.summary.entriesApplied, 5, '5 个有补丁的条目被应用');
  assert.equal(rep.summary.entriesNoop, 1, 'REUSE 记 no-op（不记 error）');
  assert.equal(rep.summary.entriesSkipped, 0);
  assert.equal(rep.summary.lintErrors, 0, 'lint 应 clean');

  // 完整报告（含 unified diff）落盘在 --out 下
  const full = readJson(path.join(f.out, 'dryrun_report.json'));
  assert.ok(full.files[0].diff.includes('+'), '应有 unified diff');
  assert.ok(full.files[0].diff.includes('b00004'), 'diff 应含新增节点');
  assert.deepEqual(full.files[0].lint.errors, [], 'dryrun 的 lint 应零 error');
  assert.equal(full.summary.lintErrors, 0);

  // ★ 工程目录零写入（逐文件哈希比对）
  assert.deepEqual(snapshotDir(f.proj), before, '★ dryrun 必须对工程目录零写入');
});

// ════════════════════════════════════════════════════════════════════════════
// ⑥ apply --yes：golden 逐字节 + .bak + lint clean
// ════════════════════════════════════════════════════════════════════════════

test('⑥ apply --yes → golden 字符串相等 + .bak 字节等于原文 + 退出码 0', () => {
  const f = setup('apply6');
  assert.equal(runPrepare(f).code, 0);
  const original = fs.readFileSync(f.targetAbs, 'utf8');

  const before = snapshotDir(f.proj);
  const r = runApply(f, ['--yes', '--now', '2026-10-15T10:20:30.123Z']);
  assert.equal(r.code, 0, `apply 应成功: ${r.stderr.slice(0, 500)}`);

  const after = fs.readFileSync(f.targetAbs, 'utf8');
  assert.equal(after, expectedGolden(), '★ 最终 XML 必须逐字节等于预期 golden');

  // .bak 存在且等于原文
  const bak = path.join(f.proj, `${TARGET_REL}.bak.20261015T102030123Z`);
  assert.ok(fs.existsSync(bak), `应产生 .bak（注入 --now 决定名字）：${bak}`);
  assert.equal(fs.readFileSync(bak, 'utf8'), original, '.bak 必须逐字节等于改动前的原文');

  // 只有目标文件变化（其余文件零改动）
  const changedFiles = Object.keys(snapshotDir(f.proj))
    .filter((k) => before[k] !== snapshotDir(f.proj)[k])
    .filter((k) => !k.includes('.bak.'));
  assert.deepEqual(changedFiles, [TARGET_REL], `只有目标组件应被改动，实际 ${JSON.stringify(changedFiles)}`);

  // 报告：applied + lint clean
  const repPath = path.join(f.out, 'apply_report.json');
  assert.ok(fs.existsSync(repPath), '应有 apply_report.json');
  const rep = readJson(repPath);
  const fileRec = (rep.files || [])[0];
  assert.ok(fileRec, '报告应有文件记录');
  assert.equal(fileRec.applied !== false, true);
  if (fileRec.lint) assert.equal(fileRec.lint.errors, 0, 'lint 必须 clean');
});

// ════════════════════════════════════════════════════════════════════════════
// ⑦⑧⑨ 三个变异
// ════════════════════════════════════════════════════════════════════════════

test('⑦ 变异 A: apply 前篡改目标文件一个字节 → 退出码 2（防漂移）', () => {
  const f = setup('mutA');
  assert.equal(runPrepare(f).code, 0);

  // 篡改：改一个字符（保持长度，只有内容变）
  const text = fs.readFileSync(f.targetAbs, 'utf8');
  fs.writeFileSync(f.targetAbs, text.replace('邮件详情', '邮件详惰'), 'utf8');

  const before = snapshotDir(f.proj);
  const dry = runCli(['gen-xml', 'dryrun',
    '--gen-plan', path.join(f.out, 'gen_plan.json'),
    '--project', f.proj, '--index', f.indexPath, '--out', f.out]);
  assert.equal(dry.code, 2, `漂移应退出 2，实际 ${dry.code}: ${dry.stderr.slice(0, 300)}`);
  assert.deepEqual(snapshotDir(f.proj), before, '漂移时不得写盘');

  const ap = runApply(f, ['--yes']);
  assert.equal(ap.code, 2, `apply 遇漂移也应退出 2，实际 ${ap.code}`);
});

test('⑧ 变异 B: apply 无 --yes → 退出码 4，且不写盘', () => {
  const f = setup('mutB');
  assert.equal(runPrepare(f).code, 0);
  const before = snapshotDir(f.proj);

  const ap = runApply(f); // 故意不加 --yes
  assert.equal(ap.code, 4, `缺 --yes 应退出 4（NEEDS_HUMAN），实际 ${ap.code}`);
  assert.ok(/--yes/.test(ap.stderr) || /--yes/.test(ap.stdout), '应提示加 --yes');
  assert.deepEqual(snapshotDir(f.proj), before, '★ 无 --yes 时不得写盘');

  // 正对照：加 --yes 即成功（证明 4 来自缺 --yes，而非其他原因）
  const ok = runApply(f, ['--yes']);
  assert.equal(ok.code, 0, `加 --yes 应成功: ${ok.stderr.slice(0, 300)}`);
});

test('⑨ 变异 C: 人改 gen_plan.json 把 color 设成 8 位 → dryrun 退出 3 且工程零改动', () => {
  const f = setup('mutC');
  assert.equal(runPrepare(f).code, 0);

  const gpPath = path.join(f.out, 'gen_plan.json');
  const gp = readJson(gpPath);
  const restyle = gp.entries.find((e) => e.op === 'RESTYLE');
  assert.ok(restyle && restyle.patch.attrs, '应有 RESTYLE 的 attrs 补丁');
  restyle.patch.attrs.color = '#ffd278cc'; // ★ 8 位色（R-03 必拦）
  writeJson(gpPath, gp);

  const before = snapshotDir(f.proj);
  const r = runDryrunCli(f);
  assert.equal(r.code, 3, `8 位色应退出 3（LINT_BLOCKED），实际 ${r.code}: ${r.stderr.slice(0, 400)}`);
  // lint error 明细在落盘的完整报告里（CLI stdout 是精简摘要）
  const full = readJson(path.join(f.out, 'dryrun_report.json'));
  const lintErrs = (full.files || []).flatMap((x) => (x.lint ? x.lint.errors : []));
  assert.ok(lintErrs.some((e) => e.rule === 'R-03'),
    `报告应含 R-03 error，实际 ${JSON.stringify(lintErrs.map((e) => e.rule))}`);
  assert.ok(!full.ok, '报告 ok 应为 false');
  assert.deepEqual(snapshotDir(f.proj), before, '★ lint 阻断时工程必须零改动');
});

// ════════════════════════════════════════════════════════════════════════════
// ⑩ B9：prepare + dryrun 各跑两遍，产物 md5 一致
// ════════════════════════════════════════════════════════════════════════════

test('⑩ B9: prepare + dryrun 各两遍，gen_plan.json / dryrun_report.json 逐字节一致', () => {
  const f = setup('b9');
  const gp1 = path.join(f.dir, 'out1');
  const gp2 = path.join(f.dir, 'out2');
  fs.mkdirSync(gp1, { recursive: true });
  fs.mkdirSync(gp2, { recursive: true });

  // 两遍 prepare（同一输入，两个 out 目录）
  for (const out of [gp1, gp2]) {
    const r = runCli(['gen-xml', 'prepare', '--plan', f.planPath, '--project', f.proj,
      '--index', f.indexPath, '--base-ir', f.baseIrPath, '--target-ir', f.targetIrPath, '--out', out]);
    assert.equal(r.code, 0, `prepare 应成功: ${r.stderr.slice(0, 300)}`);
  }
  const a1 = fs.readFileSync(path.join(gp1, 'gen_plan.json'));
  const a2 = fs.readFileSync(path.join(gp2, 'gen_plan.json'));
  assert.equal(sha256(a1), sha256(a2), '★ gen_plan.json 两遍必须逐字节一致（B9）');

  // 两遍 dryrun
  for (const out of [gp1, gp2]) {
    const r = runCli(['gen-xml', 'dryrun', '--gen-plan', path.join(out, 'gen_plan.json'),
      '--project', f.proj, '--index', f.indexPath, '--out', out]);
    assert.equal(r.code, 0, `dryrun 应成功: ${r.stderr.slice(0, 300)}`);
  }
  const b1 = fs.readFileSync(path.join(gp1, 'dryrun_report.json'));
  const b2 = fs.readFileSync(path.join(gp2, 'dryrun_report.json'));
  assert.equal(sha256(b1), sha256(b2), '★ dryrun_report.json 两遍必须逐字节一致（B9）');

  // 报告内不含 ISO 时间戳（B9 的产物纪律）
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(b1.toString('utf8')),
    'dryrun_report.json 内不应出现时间戳');
});

// ════════════════════════════════════════════════════════════════════════════
// 附加：INFERRED 门禁（第 3 条要求「ops 全覆盖含 INFERRED」）
// ════════════════════════════════════════════════════════════════════════════

test('附加: 含 INFERRED 的 plan → prepare 退出 4；--skip-unconfirmed → 0 且记 skipped', () => {
  const withInferred = [
    ...defaultDiffs(),
    { op: 'INFERRED', slot: '某个未确认按钮', node: 'L099' },
  ];
  const f = setup('gate', { diffs: withInferred });

  // 默认：门禁拒绝，退出 4
  const r1 = runCli(['gen-xml', 'prepare', '--plan', f.planPath, '--project', f.proj,
    '--index', f.indexPath, '--target-ir', f.targetIrPath, '--out', f.out]);
  assert.equal(r1.code, 4, `含 INFERRED 应退出 4，实际 ${r1.code}`);
  const gp = readJson(path.join(f.out, 'gen_plan.json'));
  assert.equal(gp.gate.needsHuman, true);
  assert.ok(gp.gate.reasons.length >= 1, 'gate.reasons 应记录原因');
  assert.equal(gp.entries.length, 0, '门禁拒绝时不产出可执行条目');
  assert.ok(gp.warnings.some((w) => w.code === 'NEEDS_HUMAN'), 'warnings 应逐条列出阻塞项');

  // --skip-unconfirmed：放行，INFERRED 被丢弃并记录
  const out2 = path.join(f.dir, 'out-skip');
  fs.mkdirSync(out2, { recursive: true });
  const r2 = runCli(['gen-xml', 'prepare', '--plan', f.planPath, '--project', f.proj,
    '--index', f.indexPath, '--target-ir', f.targetIrPath, '--skip-unconfirmed', '--out', out2]);
  assert.equal(r2.code, 0, `--skip-unconfirmed 应退出 0: ${r2.stderr.slice(0, 300)}`);
  const gp2 = readJson(path.join(out2, 'gen_plan.json'));
  assert.equal(gp2.gate.skippedCount, 1, '丢弃数应记入 skippedCount');
  assert.equal(gp2.entries.length, 6, 'INFERRED 被丢弃，剩 6 条');
  assert.ok(gp2.warnings.some((w) => w.code === 'SKIPPED_UNCONFIRMED'), '丢弃必须留痕');
});

// ════════════════════════════════════════════════════════════════════════════
// 附加：CLI 参数错误 → 退出 2
// ════════════════════════════════════════════════════════════════════════════

test('附加: prepare 缺 --plan → 退出 2；未知 phase → 退出 2 且打印用法', () => {
  const f = setup('usage');
  const noPlan = runCli(['gen-xml', 'prepare', '--project', f.proj, '--index', f.indexPath, '--out', f.out]);
  assert.equal(noPlan.code, 2, `缺 --plan 应退出 2，实际 ${noPlan.code}`);

  const badPhase = runCli(['gen-xml', 'teleport', '--out', f.out]);
  assert.equal(badPhase.code, 2, `未知 phase 应退出 2，实际 ${badPhase.code}`);
  assert.ok(/prepare|dryrun|apply/.test(badPhase.stdout + badPhase.stderr), '应打印用法');
});
