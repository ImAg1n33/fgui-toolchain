'use strict';
/**
 * test/e2e/create-plan.test.js —— CREATE 模式端到端（v0.3-B）
 *
 * ★ 这个测试的核心主张：CREATE 与 PATCH 的根本区别 ★
 *   PATCH（gen-xml）要求**已有目标组件 XML** 才能在存量文本上打补丁；
 *   CREATE **只吃 Design IR + 工程索引**，目标组件原本不存在 —— 这正是朋友的痛点
 *   （从零拼新界面）。因此本测试的输入目录里**没有任何 XML**，全程也不会产生对
 *   「已有组件 XML」的依赖；这条在第 ② 组断言里显式钉死。
 *
 * ★ fixture 说明 ★
 *   `design_ir.json` 是**手写的合成 IR**（CI 友好、不依赖 PSD 与 sharp）。
 *   真实链路里 `fgui-rb psd-ir --psd x.psd` 产出的是**同一结构**：
 *   顶层 { source: { psdPath, canvas }, layers: [...], slices, sliceNames }，
 *   每层 { id, name, normName, type, bbox{x,y,w,h}, text?, opacity, visible }。
 *
 * ★ 临时目录必须建在仓库内 ★（跨盘会让 toPosixRel / writeJson 的路径相对化失败）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { runCli, runCliJson } = require('./run-cli');

const ROOT = path.resolve(__dirname, '../..');
const TMP_BASE = path.join(ROOT, 'out', 'e2e-create-plan');

/** 合成 IR：顺序即 PSD 文档序（顶→底）。 */
function irFixture(canvas = { w: 750, h: 1334 }) {
  const L = (id, name, type, bbox, extra = {}) => ({
    id,
    name,
    normName: name.replace(/\s+/g, ''),
    type,
    bbox,
    depth: 0,
    parent: null,
    childCount: 0,
    opacity: extra.opacity === undefined ? 1 : extra.opacity,
    visible: extra.visible === undefined ? true : extra.visible,
    merged: false,
    slice: null,
    sliceName: extra.sliceName === undefined ? null : extra.sliceName,
    text: extra.text === undefined ? null : extra.text,
  });
  return {
    version: '1.0',
    source: { psdPath: 'psd/mail_popup.psd', canvas, dpr: 1 },
    // 顶 → 底
    layers: [
      L('L001', '标题', 'text', { x: 148, y: 92, w: 200, h: 36 }, {
        text: { value: '邮件详情', color: '#f5e6c8', fontSize: 26, align: 'left' },
      }),
      L('L002', '图标', 'raster', { x: 120, y: 200, w: 48, h: 48 }), // 固有 96x96 → 禁止拉伸
      L('L003', '按钮底', 'raster', { x: 100, y: 300, w: 200, h: 56 }, { sliceName: 'btn_bg' }),
      L('L004', '未匹配图', 'raster', { x: 400, y: 300, w: 120, h: 48 }), // 无资源 → toImport
      L('L005', '行1', 'raster', { x: 24, y: 400, w: 300, h: 60 }),
      L('L006', '行2', 'raster', { x: 24, y: 464, w: 300, h: 60 }),
      L('L007', '行3', 'raster', { x: 24, y: 528, w: 300, h: 60 }),
      L('L008', '背景', 'raster', { x: 0, y: 0, w: canvas.w, h: canvas.h }), // 覆盖画布 → img_bg
    ],
    slices: [],
    sliceNames: ['btn_bg'],
  };
}

/** 工程索引：只有包与资源，**没有 components[]（也就没有任何组件 XML）**。 */
function indexFixture() {
  return {
    version: '1.0',
    _comment: 'e2e 手写的最小索引：CREATE 模式只关心「同包已有什么图片资源」',
    project: { name: 'MailPopup', packages: [{ name: 'Mail', id: 'mtlga5qj' }] },
    resources: [
      { pkg: 'Mail', pkgId: 'mtlga5qj', type: 'image', id: 'q0abc', name: '按钮底.png', exported: 'true', width: 200, height: 56 },
      { pkg: 'Mail', pkgId: 'mtlga5qj', type: 'image', id: 'q0ico', name: '图标.png', exported: 'true', width: 96, height: 96 },
    ],
    components: [], // ★ 空：CREATE 不需要已有组件
  };
}

/** 建临时输入目录（仓库内）。 */
function setup(label) {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_BASE, `${label}-`));
  const irPath = path.join(dir, 'design_ir.json');
  const idxPath = path.join(dir, 'project_index.json');
  fs.writeFileSync(irPath, `${JSON.stringify(irFixture(), null, 2)}\n`, 'utf8');
  fs.writeFileSync(idxPath, `${JSON.stringify(indexFixture(), null, 2)}\n`, 'utf8');
  return { dir, irPath, idxPath, out: path.join(dir, 'out') };
}

/** 递归列出目录下所有文件（相对路径）。 */
function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).replace(/\\/g, '/'));
    }
  };
  walk(dir);
  return out.sort();
}

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

/** 跑一次 create-plan。 */
function runCreatePlan(f, extra = []) {
  return runCliJson([
    'create-plan',
    '--ir', f.irPath,
    '--index', f.idxPath,
    '--out', f.out,
    ...extra,
  ]);
}

// ════════════════════════════════════════════════════════════════════════════
// ① 退出码 0 + ② 全程无「目标组件 XML」
// ════════════════════════════════════════════════════════════════════════════

test('① 退出码 0，产物只有 create_plan.json / create_plan.md', () => {
  const f = setup('basic');
  const r = runCreatePlan(f);
  assert.equal(r.code, 0, `create-plan 应成功: ${r.stderr.slice(0, 500)}`);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.command, 'create-plan');
  assert.deepEqual(fs.readdirSync(f.out).sort(), ['create_plan.json', 'create_plan.md']);
});

test('② ★ 全程没有任何「目标组件 XML」参与（这就是 CREATE 与 PATCH 的区别）', () => {
  // ★ 主张：PATCH 需要「已有目标组件 XML」才能打补丁；CREATE 从零拼，不需要。
  //   本断言把这点钉死 —— 输入目录里 0 个 .xml、索引 components[] 为空、
  //   输出目录里也只有 json/md，**没有任何 XML 被读或写**。
  const f = setup('no-xml');
  const r = runCreatePlan(f);
  assert.equal(r.code, 0);

  const inputFiles = listFiles(f.dir).filter((p) => !p.startsWith('out/'));
  assert.deepEqual(inputFiles.sort(), ['design_ir.json', 'project_index.json'],
    '★ 输入只有 IR + 索引，没有任何组件 XML');
  assert.equal(inputFiles.filter((p) => p.endsWith('.xml')).length, 0);

  const outFiles = listFiles(f.out);
  assert.equal(outFiles.filter((p) => p.endsWith('.xml')).length, 0,
    '★ 输出不得产生/写入任何 XML（v1 不写 FGUI 文件）');

  // 索引里 components 为空 —— 证明没有「已有组件」这个前提
  assert.deepEqual(JSON.parse(fs.readFileSync(f.idxPath, 'utf8')).components, []);

  // create_plan 的结构里也没有 PATCH 特有的 target.file / sha256 字段
  const plan = JSON.parse(fs.readFileSync(path.join(f.out, 'create_plan.json'), 'utf8'));
  assert.equal(plan.mode, 'create');
  assert.equal(plan.target, undefined, 'CREATE 模式没有 target.file/sha256（那是 PATCH 的）');
});

// ════════════════════════════════════════════════════════════════════════════
// ③ 画布 / 命名 / 层级 / 背景最底
// ════════════════════════════════════════════════════════════════════════════

test('③ 画布 750x1334 + 命名前缀 + 层级底→顶 + 背景 img_bg 在最底', () => {
  const f = setup('shape');
  assert.equal(runCreatePlan(f).code, 0);
  const plan = JSON.parse(fs.readFileSync(path.join(f.out, 'create_plan.json'), 'utf8'));

  assert.deepEqual(plan.canvas.w ? { w: plan.canvas.w, h: plan.canvas.h } : null, { w: 750, h: 1334 });
  assert.equal(plan.canvas.source, 'ir', '★ 未传 --canvas → 跟随 IR 画布');
  assert.deepEqual(plan.page.size, [750, 1334]);
  assert.equal(plan.page.pkg, 'Mail');

  // 背景：layer 0 + img_bg + 全画布
  const bg = plan.nodes[0];
  assert.equal(bg.name, 'img_bg');
  assert.equal(bg.layer, 0);
  assert.equal(bg.attrs.xy, '0,0');
  assert.equal(bg.attrs.size, '750,1334');

  // 层级严格递增
  const layers = plan.nodes.map((n) => n.layer);
  assert.deepEqual(layers, [...layers].sort((a, b) => a - b));

  // 命名前缀
  for (const n of plan.nodes) {
    if (n.name === 'img_bg') continue;
    if (n.tag === 'image') assert.ok(n.name.startsWith('img_'), `${n.name} 应以 img_ 开头`);
    if (n.tag === 'text') assert.ok(n.name.startsWith('txt_'), `${n.name} 应以 txt_ 开头`);
  }
  // 最顶层是标题（IR 里第一个 = 顶）
  assert.equal(plan.nodes[plan.nodes.length - 1].source.layerId, 'L001');
  assert.equal(plan.nodes[plan.nodes.length - 1].tag, 'text');

  // --canvas 可覆盖
  const f2 = setup('canvas');
  assert.equal(runCreatePlan(f2, ['--canvas', '1080x1920']).code, 0);
  const plan2 = JSON.parse(fs.readFileSync(path.join(f2.out, 'create_plan.json'), 'utf8'));
  assert.deepEqual({ w: plan2.canvas.w, h: plan2.canvas.h }, { w: 1080, h: 1920 });
  assert.equal(plan2.canvas.source, 'cli');
  assert.equal(plan2.canvas.mismatch, true, '★ 与 IR 画布（750x1334）不一致必须标 mismatch');
  assert.deepEqual(plan2.canvas.irCanvas, { w: 750, h: 1334 });
  assert.deepEqual(plan2.page.size, [1080, 1920]);
});

// ════════════════════════════════════════════════════════════════════════════
// P0 画布：缺省必须跟随 IR（否则整页比例全错且不报错）
// ════════════════════════════════════════════════════════════════════════════

test('★ P0① IR 1080x1920、无 --canvas → 输出 1080x1920 + source=ir（改前会错成 750x1334）', () => {
  const f = setup('canvas-ir');
  const ir = irFixture();
  ir.source.canvas = { w: 1080, h: 1920 };
  // 背景也要跟着画布尺寸（否则背景覆盖判定会按旧尺寸）
  ir.layers[ir.layers.length - 1].bbox = { x: 0, y: 0, w: 1080, h: 1920 };
  fs.writeFileSync(f.irPath, `${JSON.stringify(ir, null, 2)}\n`, 'utf8');

  const r = runCreatePlan(f);
  assert.equal(r.code, 0);
  const plan = JSON.parse(fs.readFileSync(path.join(f.out, 'create_plan.json'), 'utf8'));
  assert.deepEqual({ w: plan.canvas.w, h: plan.canvas.h }, { w: 1080, h: 1920 },
    '★ 缺省必须用 IR 画布，不能硬编码 750x1334');
  assert.equal(plan.canvas.source, 'ir');
  assert.equal(plan.canvas.mismatch, undefined);
  assert.deepEqual(plan.page.size, [1080, 1920]);
  assert.equal(plan.nodes[0].name, 'img_bg');
  assert.equal(plan.nodes[0].attrs.size, '1080,1920');
  // stderr 不应有画布相关告警
  assert.ok(!/画布/.test(r.stderr), '跟随 IR 时不应有画布告警');
});

test('★ P0② IR 1080x1920 + --canvas 750x1334 → 输出 750x1334、mismatch=true、stderr 告警', () => {
  const f = setup('canvas-mismatch');
  const ir = irFixture();
  ir.source.canvas = { w: 1080, h: 1920 };
  fs.writeFileSync(f.irPath, `${JSON.stringify(ir, null, 2)}\n`, 'utf8');

  const r = runCreatePlan(f, ['--canvas', '750x1334']);
  assert.equal(r.code, 0, '不一致不阻断（只把问题摆明）');
  const plan = JSON.parse(fs.readFileSync(path.join(f.out, 'create_plan.json'), 'utf8'));
  assert.deepEqual({ w: plan.canvas.w, h: plan.canvas.h }, { w: 750, h: 1334 });
  assert.equal(plan.canvas.source, 'cli');
  assert.equal(plan.canvas.mismatch, true);
  assert.deepEqual(plan.canvas.irCanvas, { w: 1080, h: 1920 });
  assert.ok(/不一致/.test(r.stderr) && /未做缩放换算/.test(r.stderr),
    `★ stderr 必须写明不一致且未缩放，实际: ${r.stderr.slice(0, 300)}`);
});

test('★ P0③ IR 无 canvas 字段 → 750x1334 + source=default + stderr 告警', () => {
  const f = setup('canvas-default');
  const ir = irFixture();
  delete ir.source.canvas;
  fs.writeFileSync(f.irPath, `${JSON.stringify(ir, null, 2)}\n`, 'utf8');

  const r = runCreatePlan(f);
  assert.equal(r.code, 0);
  const plan = JSON.parse(fs.readFileSync(path.join(f.out, 'create_plan.json'), 'utf8'));
  assert.deepEqual({ w: plan.canvas.w, h: plan.canvas.h }, { w: 750, h: 1334 });
  assert.equal(plan.canvas.source, 'default');
  assert.ok(/默认/.test(r.stderr), '★ 退回默认必须在 stderr 告警');
});

// ════════════════════════════════════════════════════════════════════════════
// ④ 复用短 ID / ⑤ toImport / ⑥ 禁止拉伸
// ════════════════════════════════════════════════════════════════════════════

test('④ 复用节点的 src 是**短资源 ID**（不含 ui://）', () => {
  const f = setup('reuse');
  assert.equal(runCreatePlan(f).code, 0);
  const plan = JSON.parse(fs.readFileSync(path.join(f.out, 'create_plan.json'), 'utf8'));

  const btn = plan.nodes.find((n) => n.source.layerId === 'L003');
  assert.equal(btn.attrs.src, 'q0abc', '★ 短 ID（真实工程形态）');
  assert.ok(!String(btn.attrs.src).includes('ui://'), '★ 绝不拼 ui://');
  assert.ok(plan.assets.reused.some((x) => x.resourceId === 'q0abc'));
});

test('⑤ 未匹配资源进 toImport，且带 reason 与建议尺寸', () => {
  const f = setup('import');
  assert.equal(runCreatePlan(f).code, 0);
  const plan = JSON.parse(fs.readFileSync(path.join(f.out, 'create_plan.json'), 'utf8'));

  const t = plan.assets.toImport.find((x) => x.layerId === 'L004');
  assert.ok(t, '未匹配图必须进 toImport');
  assert.equal(t.suggestedName, '未匹配图.png');
  assert.equal(t.w, 120);
  assert.equal(t.h, 48);
  assert.ok(t.reason.includes('同包未找到匹配资源'));

  // 背景也没有登记资源 → 同样进 toImport（不静默丢）
  assert.ok(plan.assets.toImport.some((x) => x.layerId === 'L008'));
});

test('⑥ 图标 bbox 48x48 vs 固有 96x96 → **等比缩放 0.5 并居中**（不放大、不偏移）', () => {
  const f = setup('nostretch');
  assert.equal(runCreatePlan(f).code, 0);
  const plan = JSON.parse(fs.readFileSync(path.join(f.out, 'create_plan.json'), 'utf8'));

  const icon = plan.nodes.find((n) => n.source.layerId === 'L002');
  // 等比缩到刚好装下：scale = min(48/96, 48/96, 1) = 0.5 → 48×48，铺满 bbox
  assert.equal(icon.attrs.size, '48,48', '★ 等比缩放 0.5，恰好铺满 bbox（不放大）');
  assert.equal(icon.attrs.xy, '120,200', '★ 居中：size==bbox 时 xy 与 bbox 左上一致（不偏移）');
  const u = plan.unresolved.find((x) => x.layerId === 'L002');
  assert.ok(u, '必须记 unresolved');
  assert.equal(u.reason, 'non-uniform-scale');
  assert.ok(u.hint.includes('0.5'), `hint 应给出实际 scale，实际：${u.hint}`);
  assert.ok(u.hint.includes('48,48'), 'hint 应给出最终 size');
});

// ════════════════════════════════════════════════════════════════════════════
// ⑦ B9 确定性 / ⑧ md「待人工确认」
// ════════════════════════════════════════════════════════════════════════════

test('⑦ 两次运行 create_plan.json / .md md5 一致（B9）', () => {
  const f = setup('b9');
  const out1 = path.join(f.dir, 'o1');
  const out2 = path.join(f.dir, 'o2');
  const r1 = runCli(['create-plan', '--ir', f.irPath, '--index', f.idxPath, '--out', out1]);
  const r2 = runCli(['create-plan', '--ir', f.irPath, '--index', f.idxPath, '--out', out2]);
  assert.equal(r1.code, 0);
  assert.equal(r2.code, 0);

  for (const name of ['create_plan.json', 'create_plan.md']) {
    const a = md5(fs.readFileSync(path.join(out1, name)));
    const b = md5(fs.readFileSync(path.join(out2, name)));
    assert.equal(a, b, `★ ${name} 两次运行必须逐字节一致（B9）`);
  }
  // 产物内不得出现时间戳
  const md = fs.readFileSync(path.join(out1, 'create_plan.md'), 'utf8');
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(md), 'md 不得含时间戳');
});

test('⑧ create_plan.md 含「待人工确认」清单（toImport / unresolved / deferred / 估计值）', () => {
  const f = setup('md');
  assert.equal(runCreatePlan(f).code, 0);
  const md = fs.readFileSync(path.join(f.out, 'create_plan.md'), 'utf8');

  assert.ok(md.includes('# CREATE 计划'), 'md 有标题');
  assert.ok(md.includes('## 待人工确认'), '★ 必须有「待人工确认」节');
  assert.ok(md.includes('需要导入素材'), '列出待导入素材');
  assert.ok(md.includes('non-uniform-scale'), '列出未决项');
  assert.ok(md.includes('列表项建议'), '列出列表建议');
  assert.ok(md.includes('估计值'), '列出估计值');
  assert.ok(md.includes('v1 明确不做'), '明确声明 v1 边界');
});

// ════════════════════════════════════════════════════════════════════════════
// v0.3-C readiness + --strict
// ════════════════════════════════════════════════════════════════════════════

/** 干净计划的 fixture：资源全命中、无未决、无列表/重叠 → readiness=ready。 */
function setupClean(label) {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_BASE, `${label}-`));
  const irPath = path.join(dir, 'design_ir.json');
  const idxPath = path.join(dir, 'project_index.json');
  const ir = {
    version: '1.0',
    source: { psdPath: 'psd/clean.psd', canvas: { w: 750, h: 1334 } },
    layers: [
      // 顶→底：一个图标（尺寸与固有完全一致）+ 背景（有登记资源）
      { id: 'L001', name: '徽章', normName: '徽章', type: 'raster', bbox: { x: 100, y: 100, w: 48, h: 48 }, opacity: 1, visible: true },
      { id: 'L002', name: '背景', normName: '背景', type: 'raster', bbox: { x: 0, y: 0, w: 750, h: 1334 }, opacity: 1, visible: true },
    ],
    slices: [], sliceNames: [],
  };
  const idx = {
    version: '1.0',
    project: { name: 'P', packages: [{ name: 'Mail', id: 'm' }] },
    resources: [
      { pkg: 'Mail', pkgId: 'm', type: 'image', id: 'q0badge', name: '徽章.png', exported: 'true', width: 48, height: 48 },
      { pkg: 'Mail', pkgId: 'm', type: 'image', id: 'q0bg', name: '背景.png', exported: 'true', width: 750, height: 1334 },
    ],
    components: [],
  };
  fs.writeFileSync(irPath, `${JSON.stringify(ir, null, 2)}\n`, 'utf8');
  fs.writeFileSync(idxPath, `${JSON.stringify(idx, null, 2)}\n`, 'utf8');
  return { dir, irPath, idxPath, out: path.join(dir, 'out') };
}

test('★ readiness①: 干净计划 → ready；默认退 0；--strict 也退 0', () => {
  const f = setupClean('rd-ready');
  const r = runCreatePlan(f);
  assert.equal(r.code, 0);
  const plan = JSON.parse(fs.readFileSync(path.join(f.out, 'create_plan.json'), 'utf8'));
  assert.equal(plan.readiness.status, 'ready', `blockers=${JSON.stringify(plan.readiness.blockers)}`);
  assert.deepEqual(plan.readiness.blockers, []);
  assert.equal(r.json.readiness.status, 'ready');

  const strict = runCreatePlan(f, ['--strict']);
  assert.equal(strict.code, 0, '★ ready 时 --strict 也必须退 0');
});

test('★ readiness②: 有 toImport 但无 unresolved → needs-human；默认 0；--strict 退 4', () => {
  // 在「干净」fixture 上加一张未登记资源的图 → 只有 toImport，没有 unresolved
  const f = setupClean('rd-import');
  const ir = JSON.parse(fs.readFileSync(f.irPath, 'utf8'));
  ir.layers.unshift({
    id: 'L003', name: '未登记图', normName: '未登记图', type: 'raster',
    bbox: { x: 300, y: 600, w: 120, h: 48 }, opacity: 1, visible: true,
  });
  fs.writeFileSync(f.irPath, `${JSON.stringify(ir, null, 2)}\n`, 'utf8');

  const r = runCreatePlan(f);
  assert.equal(r.code, 0, '默认仍退 0（计划确实生成了）');
  const plan = JSON.parse(fs.readFileSync(path.join(f.out, 'create_plan.json'), 'utf8'));
  assert.equal(plan.readiness.status, 'needs-human',
    `unresolved 应为 0，实际 blockers=${JSON.stringify(plan.readiness.blockers)}`);
  assert.ok(plan.readiness.blockers.some((b) => b.kind === 'toImport' && b.count > 0));
  assert.ok(!plan.readiness.blockers.some((b) => b.kind === 'unresolved'));

  const strict = runCreatePlan(f, ['--strict']);
  assert.equal(strict.code, 4, `★ --strict 非 ready 应退 4，实际 ${strict.code}`);
});

test('★ readiness③: 有 unresolved → blocked；--strict 退 4', () => {
  const f = setup('rd-blocked'); // 默认 fixture：图标 48x48 vs 固有 96x96 → non-uniform-scale
  const r = runCreatePlan(f);
  assert.equal(r.code, 0);
  const plan = JSON.parse(fs.readFileSync(path.join(f.out, 'create_plan.json'), 'utf8'));
  assert.equal(plan.readiness.status, 'blocked');
  assert.ok(plan.readiness.blockers.some((b) => b.kind === 'unresolved'));

  const strict = runCreatePlan(f, ['--strict']);
  assert.equal(strict.code, 4);
});

test('★ readiness④: blockers 的 kind/count 与实际计数一致', () => {
  const f = setup('rd-counts');
  assert.equal(runCreatePlan(f).code, 0);
  const plan = JSON.parse(fs.readFileSync(path.join(f.out, 'create_plan.json'), 'utf8'));
  const byKind = Object.fromEntries(plan.readiness.blockers.map((b) => [b.kind, b.count]));

  assert.equal(byKind.unresolved, plan.unresolved.length);
  assert.equal(byKind.toImport, plan.assets.toImport.length);
  // deferred 只数「需处理的」：controllers + listItems + 非 advisory 的 relations
  const actionable = plan.deferred.controllers.length
    + plan.deferred.listItems.length
    + plan.deferred.relations.filter((r) => r.advisory !== true).length;
  assert.equal(byKind.deferred, actionable);
  // 通用 Relations 建议必须带 advisory（否则 ready 永远不可能出现）
  assert.ok(plan.deferred.relations.some((r) => r.advisory === true));

  // md 顶部要有就绪度一行
  const md = fs.readFileSync(path.join(f.out, 'create_plan.md'), 'utf8');
  assert.ok(/就绪度/.test(md), 'md 顶部应说明就绪度');
  assert.ok(/blocked/.test(md));
});

// ════════════════════════════════════════════════════════════════════════════
// 参数防御
// ════════════════════════════════════════════════════════════════════════════

test('参数: 缺 --ir / 缺 --index → 退出 2（USAGE）', () => {
  const f = setup('usage');
  const noIr = runCli(['create-plan', '--index', f.idxPath, '--out', f.out]);
  assert.equal(noIr.code, 2, `缺 --ir 应退出 2，实际 ${noIr.code}`);
  assert.ok(/--ir/.test(noIr.stderr));

  const noIdx = runCli(['create-plan', '--ir', f.irPath, '--out', f.out]);
  assert.equal(noIdx.code, 2, `缺 --index 应退出 2，实际 ${noIdx.code}`);
  assert.ok(/--index/.test(noIdx.stderr));
});
