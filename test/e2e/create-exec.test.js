'use strict';
/**
 * test/e2e/create-exec.test.js —— CREATE 执行清单端到端（v0.3-D）
 *
 * ★ 本命令**不调用 Bridge** ★
 *   `create-exec` 只把 create_plan 翻译成执行清单（Bridge 命令序列 + 校验期望 +
 *   执行方自查）。本测试全程不联网、不连 Bridge、不写任何 FGUI 文件 —— 这也是
 *   能在 CI 里稳定跑的前提。
 *
 * fixture 说明：`create_plan.json` 与 `project_index.json` 都是**手写最小结构**
 *   （真实链路里由 `create-plan` / `project-index` 产出；字段与 exec-plan.js 的
 *   输入契约一致：page{pkg,name,size} / canvas / nodes[{tempId,tag,name,attrs,source}] /
 *   assets{toImport}）。
 *
 * 临时目录必须建在仓库内（`out/` 下），避免跨盘路径相对化问题。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { runCli, runCliJson } = require('./run-cli');

const ROOT = path.resolve(__dirname, '../..');
const TMP_BASE = path.join(ROOT, 'out', 'e2e-create-exec');

/** 最小可执行计划：页面 + 一个已有资源引用的图片节点（无 toImport / 无未决）。 */
function cleanPlan() {
  return {
    version: '0.1',
    mode: 'create',
    canvas: { w: 750, h: 1334, source: 'ir' },
    page: { name: 'MailPagePopup', pkg: 'Mail', size: [750, 1334] },
    nodes: [{
      tempId: 'N1',
      tag: 'image',
      name: 'img_bg',
      layer: 0,
      attrs: { xy: '0,0', size: '750,1334', src: 'q0bg' },
      source: { layerId: 'L002', name: '背景', bbox: { x: 0, y: 0, w: 750, h: 1334 } },
      confidence: 1,
      notes: [],
    }],
    components: [],
    assets: { reused: [{ layerId: 'L002', resourceId: 'q0bg', name: '背景.png' }], toImport: [] },
    deferred: { controllers: [], relations: [], listItems: [] },
    decisions: [],
    unresolved: [],
    summary: { nodes: 1, reused: 1, toImport: 0, deferred: 0, unresolved: 0 },
    readiness: { status: 'ready', blockers: [] },
  };
}

/** 不可执行：有 toImport → preflight 里 RESOURCE_MISSING。 */
function notExecutablePlan() {
  const p = cleanPlan();
  p.assets.toImport = [{
    layerId: 'L004', suggestedName: '未登记图.png', w: 120, h: 48, reason: '同包未找到匹配资源',
  }];
  p.summary.toImport = 1;
  p.readiness = { status: 'needs-human', blockers: [{ kind: 'toImport', count: 1 }] };
  return p;
}

function indexFixture() {
  return {
    version: '1.0',
    project: { name: 'MailPopup', packages: [{ name: 'Mail', id: 'mailpkg1' }] },
    resources: [{ pkg: 'Mail', pkgId: 'mailpkg1', type: 'image', id: 'q0bg', name: '背景.png', exported: 'true', width: 750, height: 1334 }],
    components: [],
  };
}

function setup(label, plan) {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_BASE, `${label}-`));
  const planPath = path.join(dir, 'create_plan.json');
  const idxPath = path.join(dir, 'project_index.json');
  fs.writeFileSync(planPath, `${JSON.stringify(plan || cleanPlan(), null, 2)}\n`, 'utf8');
  fs.writeFileSync(idxPath, `${JSON.stringify(indexFixture(), null, 2)}\n`, 'utf8');
  return { dir, planPath, idxPath, out: path.join(dir, 'out') };
}

const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');

function runExec(f, extra = []) {
  return runCliJson(['create-exec', '--plan', f.planPath, '--index', f.idxPath, '--out', f.out, ...extra]);
}

// ════════════════════════════════════════════════════════════════════════════
// ① 干净计划 → executable:true，退 0，两个产物都在
// ════════════════════════════════════════════════════════════════════════════

test('① 干净计划 → 退 0，产物齐全，stdout 有 executable:true', () => {
  const f = setup('clean');
  const r = runExec(f);
  assert.equal(r.code, 0, `应成功: ${r.stderr.slice(0, 400)}`);
  assert.equal(r.json.command, 'create-exec');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.executable, true, '★ stdout 必须给出 executable:true');
  assert.equal(r.json.preflight.ok, true);
  assert.ok(r.json.summary.steps >= 1, '应有步骤');
  assert.deepEqual(fs.readdirSync(f.out).sort(), ['create_exec.json', 'create_exec.md']);

  const exec = JSON.parse(fs.readFileSync(path.join(f.out, 'create_exec.json'), 'utf8'));
  assert.equal(exec.executable, true);
  assert.ok(Array.isArray(exec.steps) && exec.steps.length >= 1);
  assert.ok(Array.isArray(exec.runtimeChecks) && exec.runtimeChecks.length >= 1, '要有执行方自查项');
  // 步骤里应出现 Bridge 命令名（而非我们自造的动作）
  assert.ok(exec.steps.some((s) => s.op === 'create_component' || s.op === 'insert_object'));

  // ★ 明确没有 Bridge 调用痕迹：产物里不应出现网络/调度字段
  const text = fs.readFileSync(path.join(f.out, 'create_exec.json'), 'utf8');
  assert.ok(!/localhost|127\.0\.0\.1|http:\/\/|fetch\(|WebSocket/i.test(text),
    '★ 清单里不得出现任何 Bridge 连接信息（本命令不调度）');
});

// ════════════════════════════════════════════════════════════════════════════
// ② 不可执行 → 默认 0 但 executable:false；--strict → 4
// ════════════════════════════════════════════════════════════════════════════

test('② 有 toImport 的 plan → 默认退 0 + executable:false；--strict 退 4', () => {
  const f = setup('not-exec', notExecutablePlan());
  const r = runExec(f);
  assert.equal(r.code, 0, '默认仍退 0（清单确实生成了）');
  assert.equal(r.json.executable, false, '★ 但必须明说不可执行');
  assert.equal(r.json.preflight.ok, false);
  assert.ok(Array.isArray(r.json.preflight.failures) && r.json.preflight.failures.length >= 1,
    'preflight 必须给出失败项');
  assert.ok(r.json.preflight.failures.some((x) => x.code === 'RESOURCE_MISSING' || /素材/.test(String(x.detail))),
    `失败项应点明素材缺失，实际 ${JSON.stringify(r.json.preflight.failures)}`);

  const strict = runExec(f, ['--strict']);
  assert.equal(strict.code, 4, `★ --strict 不可执行应退 4，实际 ${strict.code}`);
  // 严格模式下产物照样落盘（可 review）
  assert.ok(fs.existsSync(path.join(f.out, 'create_exec.md')));
});

// ════════════════════════════════════════════════════════════════════════════
// ③ 参数 / 文件错误 → 退 2
// ════════════════════════════════════════════════════════════════════════════

test('③ 缺 --plan → 退 2 且错误明确；plan 文件不存在 → 退 2；缺 --index → 退 2', () => {
  const f = setup('errors');

  const noPlan = runCli(['create-exec', '--index', f.idxPath, '--out', f.out]);
  assert.equal(noPlan.code, 2, `缺 --plan 应退 2，实际 ${noPlan.code}`);
  assert.ok(/--plan/.test(noPlan.stderr + noPlan.stdout), '错误信息应提到 --plan');

  const missing = runCli(['create-exec', '--plan', path.join(f.dir, 'nope.json'), '--index', f.idxPath, '--out', f.out]);
  assert.equal(missing.code, 2, `文件不存在应退 2，实际 ${missing.code}`);
  assert.ok(/不存在/.test(missing.stderr + missing.stdout), '错误信息应说明文件不存在');

  const noIdx = runCli(['create-exec', '--plan', f.planPath, '--out', f.out]);
  assert.equal(noIdx.code, 2, `缺 --index 应退 2，实际 ${noIdx.code}`);
  assert.ok(/--index/.test(noIdx.stderr + noIdx.stdout));
});

// ════════════════════════════════════════════════════════════════════════════
// ④ B9 确定性
// ════════════════════════════════════════════════════════════════════════════

test('④ B9：同一输入两遍，create_exec.json / .md 的 md5 一致', () => {
  const f = setup('b9');
  const out1 = path.join(f.dir, 'o1');
  const out2 = path.join(f.dir, 'o2');
  assert.equal(runCli(['create-exec', '--plan', f.planPath, '--index', f.idxPath, '--out', out1]).code, 0);
  assert.equal(runCli(['create-exec', '--plan', f.planPath, '--index', f.idxPath, '--out', out2]).code, 0);

  for (const name of ['create_exec.json', 'create_exec.md']) {
    assert.equal(md5(path.join(out1, name)), md5(path.join(out2, name)),
      `★ ${name} 两次运行必须逐字节一致（B9）`);
  }
  // md 不得含时间戳/绝对路径
  const md = fs.readFileSync(path.join(out1, 'create_exec.md'), 'utf8');
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(md), 'md 不得含时间戳');
  // ⚠ 盘符匹配必须带前置边界：否则 `ui://mailpkg1...` 里的 `i:/` 会被误判成盘符
  assert.ok(!/(^|[\s`("'])[A-Za-z]:[\\/]/m.test(md),
    `★ md 不得含 Windows 绝对路径（跨机器不可复现）: ${(md.match(/(^|[\s`("'])[A-Za-z]:[\\/]/) || [])[0]}`);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑤ md 内容：unsupported 原因 / 5 个必需区块
// ════════════════════════════════════════════════════════════════════════════

test('⑤ md 含 5 个必需区块，且 unsupported 的原因可见', () => {
  const f = setup('md-not-exec', notExecutablePlan());
  assert.equal(runExec(f).code, 0);
  const md = fs.readFileSync(path.join(f.out, 'create_exec.md'), 'utf8');

  // ① 顶部可执行/不可执行 + 首条原因
  assert.ok(/CREATE 执行清单：⛔ 不可执行/.test(md), '顶部必须写明不可执行');
  assert.ok(/RESOURCE_MISSING|素材/.test(md.split('\n')[0]), '顶部应带首条 preflight 原因');
  // ② 步骤表
  assert.ok(md.includes('## 步骤'), '有步骤表');
  assert.ok(/\| # \| op \| 目标 \| 关键参数 \| 来源 \|/.test(md), '表头齐全');
  // ③ 不能构建的部分（unsupported/invalidSteps）
  assert.ok(md.includes('## 不能构建的部分'), '有「不能构建」区块');
  // ④ verify 期望（节点数 + name/xy/size）
  assert.ok(md.includes('## 校验期望'), '有校验期望');
  assert.ok(/节点数：\*\*1\*\*/.test(md), '校验期望给出节点数');
  assert.ok(/\| name \| xy \| size \|/.test(md), 'verify 表头齐全');
  // ⑤ runtimeChecks
  assert.ok(/执行方自查/.test(md), '末尾有执行方自查');
  assert.ok(/Bridge 端口可达|target 工程已打开|目标工程已打开/.test(md), '自查项要具体');
  // 不假装调用 Bridge
  assert.ok(/不连接 Bridge|不调用 Bridge|未调用 Bridge/.test(md), '必须声明不调度');
});

test('⑤-b unsupported 条目逐条列出原因（构造一个无法翻译的节点）', () => {
  const plan = cleanPlan();
  // 塞一个 smartobject/未知 tag，让 exec-plan 记为 unsupported（原因必须透传到 md）
  plan.nodes.push({
    tempId: 'N2',
    tag: 'smartobject',
    name: 'img_智能',
    layer: 1,
    attrs: { xy: '10,10', size: '50,50' },
    source: { layerId: 'L009', name: '智能对象', bbox: { x: 10, y: 10, w: 50, h: 50 } },
    confidence: 1,
    notes: [],
  });
  plan.summary.nodes = 2;
  const f = setup('md-unsupported', plan);
  assert.equal(runExec(f).code, 0);
  const md = fs.readFileSync(path.join(f.out, 'create_exec.md'), 'utf8');
  assert.ok(md.includes('## 不能构建的部分'));
  assert.ok(/unsupported|invalidStep/.test(md), `应列出无法翻译的条目，实际片段：${md.slice(0, 400)}`);
});
