'use strict';
/**
 * test/e2e/p0-pipeline.test.js —— P0 全链路端到端
 *
 * 跑通：合成切图 + 合成两份 PSD（状态 A / 状态 B，模拟邮件弹窗）
 *   → assets.db + map.json + contact_sheet.html
 *   → design_ir.{A,B}.json + ir_overlay.{A,B}.html
 *   → change_plan.json + change_plan.md
 *
 * ★ 核心断言：
 *   ① 全部产物生成且非空
 *   ② **同一输入连跑 3 次，change_plan.json 与 design_ir.json 逐字节一致**（B9）
 *   ③ 每个 JSON 产物带 _comment，每条 diff 有可读 evidence
 *   ④ INFERRED 数量可控，且 defaultIfUnconfirmed 恒为 skip
 *   ⑤ 产物内零时间戳、无绝对路径
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { runCli, runCliJson } = require('./run-cli');
const { EXIT } = require('../../src/core/errors');
const { makeAssets } = require('../fixtures/make-assets');
const { makePsds } = require('../fixtures/make-psd');
const { makeFguiProject } = require('../fixtures/make-fgui-project');
const { readJson, writeJson } = require('../../src/core/fs-json');

const ROOT = path.resolve(__dirname, '../..');
const GOLDEN = path.join(ROOT, 'test/fixtures/golden');
/** M1 合成 FGUI 工程（只读基准；缺则现造）。 */
const FGUI_FIXTURE = path.join(ROOT, 'test/fixtures/fgui-project');

/**
 * 跑一遍完整流水线到指定输出目录。
 *
 * ★ 用子进程调用 CLI ★（理由见 run-cli.js 顶部注释）：
 *   既避免猴补 process.stdout.write 污染 node:test 报告，
 *   也顺带验证了 bin 入口与退出码真的可用。
 *
 * @param {string} outDir
 * @returns {Promise<{code:number, planCode:number, outputs:Object}>}
 */
async function runPipeline(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const assets = path.join(GOLDEN, 'assets');

  const idx = runCliJson([
    'asset-index', '--root', ROOT, '--assets', assets, '--out', outDir, '--run-id', 'e2e',
  ]);
  const irA = runCliJson([
    'psd-ir', '--root', ROOT, '--psd', path.join(GOLDEN, 'state_A.psd'),
    '--label', 'A', '--out', outDir,
  ]);
  const irB = runCliJson([
    'psd-ir', '--root', ROOT, '--psd', path.join(GOLDEN, 'state_B.psd'),
    '--label', 'B', '--out', outDir,
  ]);
  const plan = runCliJson([
    'diff-plan', '--root', ROOT,
    '--base', path.join(outDir, 'design_ir.A.json'),
    '--target', path.join(outDir, 'design_ir.B.json'),
    '--name', 'MailDetail', '--base-pkg', 'Mail', '--target-pkg', 'Mail',
    '--assets', assets, '--out', outDir,
  ]);

  const codes = [idx.code, irA.code, irB.code, plan.code];
  const bad = codes.find((c) => c !== EXIT.OK && c !== EXIT.NEEDS_HUMAN);
  return {
    code: bad === undefined ? EXIT.OK : bad,
    planCode: plan.code,
    outputs: { idx: idx.json, irA: irA.json, irB: irB.json, plan: plan.json },
  };
}

/**
 * 算文件 md5。
 * @param {string} p
 * @returns {string}
 */
function md5(p) {
  return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
}

/** 产物清单（run_meta 故意排除：B9 明确不比较它）。 */
const ARTIFACTS = [
  'design_ir.A.json', 'design_ir.B.json',
  'change_plan.json', 'change_plan.md',
  'map.json', 'contact_sheet.html',
  'ir_overlay.A.html', 'ir_overlay.B.html',
];

// ---------------------------------------------------------------------
// 准备 fixture（模块级，只做一次）
// ---------------------------------------------------------------------
let fixturesReady = false;
function ensureFixtures() {
  if (fixturesReady) return true;
  if (!fs.existsSync(path.join(GOLDEN, 'assets')) || !fs.existsSync(path.join(GOLDEN, 'state_A.psd'))) {
    return false;
  }
  fixturesReady = true;
  return true;
}

test('e2e: fixture 已生成（若缺请先跑 npm run fixtures）', (t) => {
  if (!ensureFixtures()) {
    // 现场生成一次
    makePsds({ outDir: GOLDEN });
    makeAssets({ outDir: path.join(GOLDEN, 'assets') }).then(() => {
      fixturesReady = true;
    });
  }
  assert.ok(fs.existsSync(path.join(GOLDEN, 'state_A.psd')), 'state_A.psd 应存在');
  assert.ok(fs.existsSync(path.join(GOLDEN, 'state_B.psd')), 'state_B.psd 应存在');
  assert.ok(fs.existsSync(path.join(GOLDEN, 'assets')), '合成切图目录应存在');
});

test('★ e2e: 全链路跑通，全部产物生成且非空', async (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-e2e-'));
  try {
    const res = await runPipeline(dir);
    assert.notEqual(res.code, EXIT.INTERNAL, `流水线不应异常退出（code=${res.code}）`);
    assert.equal(res.code, EXIT.OK, `应返回 OK 或 NEEDS_HUMAN，实际 ${res.code}`);

    for (const name of ARTIFACTS) {
      const p = path.join(dir, name);
      assert.ok(fs.existsSync(p), `★ 缺产物 ${name}`);
      assert.ok(fs.statSync(p).size > 0, `产物 ${name} 不应为空`);
    }
    // assets.db 也应存在
    assert.ok(fs.existsSync(path.join(dir, 'assets.db')), 'assets.db 应存在');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ B9: 同一输入连跑 3 次，产物逐字节一致（md5 对比）', async (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  // 三个独立输出目录，输入完全相同
  const dirs = [];
  const hashes = [];
  try {
    for (let i = 0; i < 3; i++) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), `fgui-det-${i}-`));
      dirs.push(d);
      const res = await runPipeline(d);
      assert.ok(res.code === EXIT.OK || res.code === EXIT.NEEDS_HUMAN,
        `第 ${i + 1} 次运行退出码 ${res.code}`);
      const h = {};
      for (const name of ARTIFACTS) {
        const p = path.join(d, name);
        assert.ok(fs.existsSync(p), `第 ${i + 1} 次缺产物 ${name}`);
        h[name] = md5(p);
      }
      hashes.push(h);
    }

    // ---- 逐字节对比 ----
    const diffs = [];
    for (const name of ARTIFACTS) {
      const [a, b, c] = hashes.map((h) => h[name]);
      if (a !== b || b !== c) {
        diffs.push(`${name}: ${a} / ${b} / ${c}`);
      }
    }
    assert.equal(diffs.length, 0,
      `★ B9 失败：以下产物 3 次运行 md5 不一致：\n${diffs.join('\n')}`);

    // ---- 打印证据（写进实现报告）----
    process.stderr.write('\n[B9 确定性证据] 同一输入连跑 3 次，各产物 md5：\n');
    for (const name of ARTIFACTS) {
      process.stderr.write(`  ${name.padEnd(22)} ${hashes[0][name]}\n`);
    }
    process.stderr.write('  三次全部一致 ✅\n\n');
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('B9: 产物内零时间戳、零绝对路径', async (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-ts-'));
  try {
    await runPipeline(dir);
    for (const name of ['design_ir.A.json', 'design_ir.B.json', 'change_plan.json', 'map.json', 'slot-map.json']) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, 'utf8');
      assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text),
        `★ ${name} 内不应有 ISO 时间戳`);
      // Windows 绝对路径
      assert.ok(!/[A-Za-z]:\\\\/.test(text) && !text.includes('D:\\'),
        `★ ${name} 内不应有 Windows 绝对路径`);
      // POSIX 绝对路径（根目录）
      assert.ok(!/"[^"]*\/UItool\//.test(text), `★ ${name} 内不应有绝对路径`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ A10: 每个 JSON 产物带 _comment 与逐字段说明', async (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-cm-'));
  try {
    await runPipeline(dir);
    for (const name of ['design_ir.A.json', 'design_ir.B.json', 'change_plan.json', 'map.json']) {
      const obj = readJson(path.join(dir, name));
      assert.ok(obj._comment, `★ ${name} 应有顶层 _comment`);
      assert.ok(String(obj._comment).length > 20, `${name} 的 _comment 应写清含义`);
    }
    const ir = readJson(path.join(dir, 'design_ir.A.json'));
    assert.ok(ir._bboxNote, 'IR 应有 _bboxNote 说明组 bbox 来源');
    assert.ok(ir._layerFieldNote, 'IR 应有逐字段说明');
    const plan = readJson(path.join(dir, 'change_plan.json'));
    assert.ok(plan._fieldNote, 'ChangePlan 应有逐字段说明');
    assert.ok(plan._opLabel, 'ChangePlan 应有 op 中文对照');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 每条 diff 都有可读的 evidence（写清为什么这么判）', async (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-ev-'));
  try {
    await runPipeline(dir);
    const plan = readJson(path.join(dir, 'change_plan.json'));
    assert.ok(plan.diffs.length > 0, '应有差异条目');
    for (const d of plan.diffs) {
      assert.ok(typeof d.evidence === 'string' && d.evidence.length > 20,
        `★ diff ${d.op}/${d.slot} 的 evidence 缺失或过短：${JSON.stringify(d.evidence)}`);
      // evidence 应包含具体依据（尺寸/名字/slice/pHash 之一）
      assert.ok(/(\d+x\d+|slice|归一名|pHash|汉明|merged|位置|尺寸|文本|颜色)/.test(d.evidence),
        `diff ${d.op}/${d.slot} 的 evidence 未写清具体依据：${d.evidence}`);
      assert.ok(d.slot, `diff ${d.op} 应有 slot`);
      assert.ok(d.matchLevel, `diff ${d.op} 应有 matchLevel`);
      assert.ok(typeof d.confidence === 'number', `diff ${d.op} 应有数值 confidence`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ INFERRED 全部 defaultIfUnconfirmed=skip（PRD K4）', async (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-inf-'));
  try {
    const res = await runPipeline(dir);
    const plan = readJson(path.join(dir, 'change_plan.json'));
    const inferred = plan.diffs.filter((d) => d.op === 'INFERRED');
    for (const d of inferred) {
      assert.equal(d.defaultIfUnconfirmed, 'skip',
        `★ INFERRED 项 ${d.slot} 的默认动作必须是 skip（宁可少做，不要错做）`);
      assert.ok(d.confidence <= 0.5, `INFERRED 置信度应 <= 0.5，实得 ${d.confidence}`);
      assert.ok(d.evidence.includes('skip'), 'evidence 应写明「默认 skip」的理由');
    }
    // 有 INFERRED 时退出码必须是 NEEDS_HUMAN(4)
    if (inferred.length > 0) {
      assert.equal(res.planCode, EXIT.NEEDS_HUMAN,
        '★ 存在未确认 INFERRED 时退出码应为 4（NEEDS_HUMAN）');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ merged 启发式：精确匹配不再受限，仅弱证据/未命中保守联动（UPSTREAM-FIX-3/4）', async (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-mg-'));
  try {
    await runPipeline(dir);
    const plan = readJson(path.join(dir, 'change_plan.json'));
    const irA = readJson(path.join(dir, 'design_ir.A.json'));
    const irB = readJson(path.join(dir, 'design_ir.B.json'));

    /**
     * 收集某份 IR 里位于 merged/suspected 组内的图层 id（按本侧父链爬升）。
     * @param {Object} ir
     * @returns {Set<string>}
     */
    const underMergedIn = (ir) => {
      const byId = new Map(ir.layers.map((l) => [l.id, l]));
      const flagged = new Set(ir.layers.filter((l) => l.merged || l.suspectedMerged).map((l) => l.id));
      const out = new Set();
      for (const l of ir.layers) {
        let cur = l;
        const seen = new Set();
        while (cur && cur.parent && !seen.has(cur.id)) {
          seen.add(cur.id);
          if (flagged.has(cur.parent)) { out.add(l.id); break; }
          cur = byId.get(cur.parent);
        }
      }
      return out;
    };

    const underA = underMergedIn(irA);
    const underB = underMergedIn(irB);
    const CAP = 0.5;
    let checkedPrecise = 0; // L1/L2 精确匹配（不封顶）
    let checkedWeak = 0;    // L3 / REMOVE（封顶）

    for (const d of plan.diffs) {
      // ★ 注意：两侧图层 id 会重复（L001/L002…），REMOVE 的 node 指的是**基准态**，
      //   其余 op 的 node 指的是**目标态**。查表必须选对一侧，否则会张冠李戴。
      const underTarget = d.op === 'REMOVE' ? false : underB.has(d.node);
      const underBase = underA.has(d.baseNode || '') || (d.op === 'REMOVE' && underA.has(d.node));
      if (!underTarget && !underBase) continue;

      if (d.matchLevel === 'L1' || d.matchLevel === 'L2') {
        // ★ UPSTREAM-FIX-4：精确匹配（slice 名一致 / 归一名全等）本身就是
        //   「没被合并」的证据 —— 不得封顶，且应拿到各级正常置信度
        assert.ok(d.confidence > CAP,
          `★ 疑似合并组内的 L1/L2 精确匹配 ${d.op}/${d.slot}(${d.node}) 不应封顶，实得 ${d.confidence}`);
        checkedPrecise++;
      } else if (d.matchLevel === 'L3' || d.op === 'REMOVE') {
        // L3 是视觉相似弱证据、REMOVE 是「疑似合并藏起来」的保守路径 → 封顶
        assert.ok(d.confidence <= CAP,
          `★ 疑似合并组内的 ${d.op}/${d.slot}(${d.node}) 置信度应 <= ${CAP}，实得 ${d.confidence}`);
        checkedWeak++;
      }
      // INFERRED 的置信度上界由「INFERRED 全部 skip」用例覆盖（confidence=min(l4Confidence,cap)）
    }
    assert.ok(checkedPrecise > 0, '★ 黄金样本中应存在疑似合并组内的 L1/L2 精确匹配（旧语义下它们被禁用）');
    assert.ok(checkedWeak > 0, '★ 黄金样本中应存在疑似合并组内的 L3/REMOVE 保守路径');
    assert.ok(plan.openQuestions.some((q) => q.includes('被合并')),
      '★ 合并组必须进人工确认队列（漏报 = 后面必猜错）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ UPSTREAM-FIX-7: 歧义匹配（同名多候选）必须触发 NEEDS_HUMAN 退出码 4', async (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-amb-'));
  try {
    // 造两份最小 IR：基准 1 个『图标』，目标 2 个同名同尺寸『图标』 → L2 歧义。
    // 关键：几何完全一致（会被判 REUSE），旧逻辑下 needsHuman 只看 INFERRED
    // → 歧义静默绕过确认 → gen-xml 会引用可能与画师意图不符的那一个。
    const mkLayer = (id, name, x) => ({
      id,
      name,
      normName: name,
      parent: null,
      type: 'raster',
      bbox: { x, y: 0, w: 64, h: 64 },
      bboxSource: 'own',
      rotation: 0,
      opacity: 1,
      visible: true,
      blend: 'normal',
      merged: false,
      suspectedMerged: false,
      childCount: 0,
      sliceName: null,
      phash: null,
      text: null,
    });
    const ir = (layers) => ({
      version: '1.0',
      source: { psdPath: 'x.psd', psdSha256: 'x'.repeat(64), canvas: { w: 200, h: 200 }, dpr: 1 },
      layers,
      warnings: [],
      slices: [],
      sliceNames: [],
    });
    const basePath = path.join(dir, 'design_ir.A.json');
    const targetPath = path.join(dir, 'design_ir.B.json');
    writeJson(basePath, ir([mkLayer('L001', '图标', 0)]));
    writeJson(targetPath, ir([mkLayer('L001', '图标', 0), mkLayer('L002', '图标', 80)]));

    const res = runCliJson([
      'diff-plan', '--root', ROOT,
      '--base', basePath, '--target', targetPath,
      '--name', 'AmbiguousCase', '--base-pkg', 'Common', '--target-pkg', 'Common',
      '--out', dir,
    ]);
    assert.equal(res.code, EXIT.NEEDS_HUMAN,
      `★ 歧义匹配必须让退出码为 4（NEEDS_HUMAN），实得 ${res.code}`);
    assert.equal(res.json.needsHuman, true, '★ stdout 的 needsHuman 必须为 true');
    assert.equal(res.json.ambiguousCount, 1, '应统计到 1 条未确认歧义');

    const plan = readJson(path.join(dir, 'change_plan.json'));
    const amb = plan.diffs.filter((d) => d.ambiguous);
    assert.equal(amb.length, 1, 'plan 里应有 1 条 ambiguous 条目');
    assert.equal(amb[0].candidates.length, 2, '★ 必须保留全部候选供人工选择');
    assert.equal(amb[0].resolved, null, '未确认时 resolved 为 null');
    assert.ok(amb[0].evidence.includes('resolved'), 'evidence 应教人怎么放行');

    // ---- 放行路径：人工填 resolved 后不再阻断 ----
    const { planNeedsHuman } = require('../../src/diff/planner');
    amb[0].resolved = 'L002';
    assert.equal(planNeedsHuman(plan).needsHuman, false,
      '★ 人工选定候选后必须放行（不能做成「有歧义就永远进不了 gen-xml」）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 差异类型覆盖：两态之间的增/删/改都被识别', async (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-cov-'));
  try {
    await runPipeline(dir);
    const plan = readJson(path.join(dir, 'change_plan.json'));
    // 合成样本刻意包含：L1 命中(REUSE 家族)、位置调整(MOVE)、尺寸调整(RESIZE)、新增(ADD/INFERRED)、移除(REMOVE)
    const ops = new Set(plan.diffs.map((d) => d.op));
    assert.ok(ops.has('RESIZE'), '应识别出尺寸调整（弹窗底框 480x320 -> 560x360）');
    assert.ok(ops.has('MOVE') || ops.has('RESIZE'), '应识别出位置或尺寸变化');
    assert.ok(ops.has('ADD') || ops.has('INFERRED'), '应识别出新增节点（奖励物品 / 领取按钮）');
    // 四级匹配都应至少命中一级
    assert.ok(plan.summary.byMatchLevel.L1 >= 1, 'L1（slice 名）通道应被使用');
    assert.ok(plan.summary.byMatchLevel.L2 >= 1, 'L2（归一名）通道应被使用');
    assert.ok(plan.summary.total > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('产物: contact_sheet.html 内嵌全部缩略图且零外部引用', async (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-cs-'));
  try {
    await runPipeline(dir);
    const html = fs.readFileSync(path.join(dir, 'contact_sheet.html'), 'utf8');
    assert.ok(html.includes('data:image/png;base64,'), '★ 缩略图应内嵌为 data: URI');
    // 零外部引用（K1 禁网）
    assert.ok(!/<script[^>]+src=/.test(html), '★ 不得有外部 script');
    assert.ok(!/<link[^>]+href=/.test(html), '★ 不得有外部 link');
    assert.ok(!/https?:\/\//.test(html.replace(/xmlns="[^"]*"/g, '')),
      '★ 产物 HTML 内不得出现任何 http(s) 引用');
    assert.ok(html.includes('离线产物'), '应带离线声明');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('产物: ir_overlay.html 含 bbox 叠加与 merged 标注', async (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-ov-'));
  try {
    await runPipeline(dir);
    const html = fs.readFileSync(path.join(dir, 'ir_overlay.B.html'), 'utf8');
    assert.ok(html.includes('<svg'), '应有 SVG 叠加层');
    assert.ok(html.includes('<rect'), '应有 bbox 矩形');
    assert.ok(html.includes('MERGED'), '★ 合并组应在校验图上标出');
    assert.ok(html.includes('data:image/png;base64,'), '应有内联合成图底图');
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html), '除 SVG 命名空间外不应有外部引用');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('产物: change_plan.md 是人可读的中文清单', async (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-md-'));
  try {
    await runPipeline(dir);
    const md = fs.readFileSync(path.join(dir, 'change_plan.md'), 'utf8');
    assert.ok(md.includes('差异分析结果'));
    assert.ok(md.includes('汇总'));
    assert.ok(md.includes('逐条差异'));
    assert.ok(/判定依据/.test(md), '每条差异应写明判定依据');
    assert.ok(md.includes('INFERRED'), '应列出 INFERRED 及其处理');
    assert.ok(md.includes('需要确认的问题') || md.includes('openQuestions'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --help 输出离线声明与命令表，退出码为 0', () => {
  const res = runCli(['--help']);
  assert.equal(res.code, EXIT.OK, '★ 显式 --help 应返回 0');
  assert.ok(res.stderr.includes('不联网'), '★ CLI 必须显式打印「本工具不联网」声明（PRD K1）');
  for (const cmd of ['asset-index', 'asset-search', 'psd-ir', 'diff-plan', 'selftest', 'gen-xml']) {
    assert.ok(res.stderr.includes(cmd), `帮助应列出 ${cmd}`);
  }
});

test('CLI: 无参数返回 USAGE(2)（区分「求助」与「误用」）', () => {
  assert.equal(runCli([]).code, EXIT.USAGE);
});

test('CLI: 未知命令返回 USAGE(2)', () => {
  const res = runCli(['不存在的命令']);
  assert.equal(res.code, EXIT.USAGE);
  assert.ok(res.stderr.includes('未知命令'));
});

test('★ CLI: 日志走 stderr、产物走 stdout（ARCHITECTURE §8.2）', (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-stream-'));
  try {
    const res = runCli([
      'asset-index', '--root', ROOT, '--assets', path.join(GOLDEN, 'assets'),
      '--out', dir, '--run-id', 'stream',
    ]);
    assert.equal(res.code, EXIT.OK);
    // stdout 必须是干净 JSON —— 能直接 `> report.json`
    assert.doesNotThrow(() => JSON.parse(res.stdout),
      '★ stdout 必须是纯 JSON，不应混入日志');
    // 日志与离线声明在 stderr
    assert.ok(res.stderr.includes('不联网') || res.stderr.includes('离线'), '离线声明应走 stderr');
    assert.ok(/\[\d{4}-\d{2}-\d{2}T/.test(res.stderr), '结构化日志应带 ISO 时间戳且走 stderr');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: gen-xml 目标文件解析 —— 主解析走工程根，命中即不触发兜底告警', (t) => {
  const { resolveTargetPath, buildAllowedTargets } = require('../../src/cli/cmd-gen-xml');
  const rel = 'assets/MailDetail/MailDetail.xml';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-targetpath-'));
  try {
    fs.mkdirSync(path.join(dir, 'assets/MailDetail'), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '<?xml version="1.0" encoding="utf-8"?>\n<component/>\n');

    // 白名单（登记集合）：本用例的目标文件是「已登记」的那一个
    const allowed = buildAllowedTargets({ components: [{ file: rel }] }, dir, ROOT);

    // (a) 主解析：工程根相对 → 直接命中，且不告警
    const warned = [];
    const logger = {
      warn: (m, d) => warned.push(`${m} ${JSON.stringify(d || {})}`), info: () => {}, error: () => {},
    };
    const abs = resolveTargetPath(dir, ROOT, rel, logger, allowed);
    assert.equal(abs, path.resolve(dir, rel), '主解析必须是 path.resolve(projectRoot, target.file)');
    assert.deepEqual(warned, [], '工程根命中时不得触发兜底告警');

    // (b) 兜底：工程根拼不到 → 退化 rootDir（**仍须落在工程根内**），且必须告警
    const fallbackRel = 'test/fixtures/fgui-project/assets/MailDetail/MailDetail.xml';
    if (!fs.existsSync(path.join(ROOT, fallbackRel))) return t.skip('fixture 未生成');
    const warned2 = [];
    const logger2 = {
      warn: (m) => warned2.push(String(m)), info: () => {}, error: () => {},
    };
    const allowedFallback = buildAllowedTargets({ components: [{ file: fallbackRel }] }, FGUI_FIXTURE, ROOT);
    const abs2 = resolveTargetPath(FGUI_FIXTURE, ROOT, fallbackRel, logger2, allowedFallback);
    assert.equal(abs2, path.resolve(ROOT, fallbackRel));
    assert.ok(warned2.some((w) => /rootDir/.test(w)), '兜底命中必须 stderr 告警');

    // (c) outside-root/ 形态直接拒绝，不猜
    assert.throws(
      () => resolveTargetPath(dir, ROOT, 'outside-root/MailDetail.xml', logger),
      (err) => err.code === 'USAGE' && err.exitCode === EXIT.USAGE,
    );

    // ---- P0-A / P0-1 路径逃逸防护 ----

    // (d) `..` 逃逸 → 拒绝
    const outsideDir = path.join(dir, '..', 'escape-out');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'victim.xml'), '<component/>\n');
    assert.throws(
      () => resolveTargetPath(dir, ROOT, '../escape-out/victim.xml', logger, allowed),
      (err) => err.code === 'USAGE',
      '`..` 逃逸必须被拒绝',
    );

    // (e) 绝对路径（指向工程根之外的真实文件）→ 拒绝（形态约束 ⓪ 直接拦下）
    assert.throws(
      () => resolveTargetPath(dir, ROOT, path.join(ROOT, 'package.json'), logger, allowed),
      (err) => err.code === 'USAGE' && /相对路径/.test(err.message),
      '绝对路径必须被拒绝且提示"必须是相对路径"',
    );
    // (e2) 带盘符形态（仅 Windows 有意义；POSIX 下路径不含盘符，跳过）
    if (process.platform === 'win32') {
      assert.throws(
        () => resolveTargetPath(dir, ROOT, 'C:\\Windows\\win.ini', logger, allowed),
        (err) => err.code === 'USAGE' && /相对路径/.test(err.message),
        '带盘符绝对路径必须被拒绝',
      );
    }

    // (f) 工程根之内但**未在 index 登记**的文件 → 拒绝（不能「文件存在就允许写」）
    fs.mkdirSync(path.join(dir, 'assets/Other'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets/Other/Other.xml'), '<component/>\n');
    assert.equal(resolveTargetPath(dir, ROOT, rel, logger, allowed), path.resolve(dir, rel), '已登记文件应放行（正对照）');
    assert.throws(
      () => resolveTargetPath(dir, ROOT, 'assets/Other/Other.xml', logger, allowed),
      (err) => err.code === 'USAGE' && /登记/.test(err.message),
      '未登记组件必须被拒绝',
    );

    // (h) ★ P0-1：**空索引**（components 为空）→ 白名单为空即默认拒绝 ★
    //     （改前：`allowedTargets.size` 前提让整条检查被短路 → 未登记文件被改写）
    const emptyAllowed = buildAllowedTargets({ components: [] }, dir, ROOT);
    assert.equal(emptyAllowed.size, 0);
    assert.throws(
      () => resolveTargetPath(dir, ROOT, 'assets/Other/Other.xml', logger, emptyAllowed),
      (err) => err.code === 'USAGE' && /没有任何已登记组件/.test(err.message),
      '空索引必须默认拒绝（P0-1）',
    );
    // 连"已登记"的文件在空索引下也必须拒绝 —— 白名单为空即无任何可写目标
    assert.throws(
      () => resolveTargetPath(dir, ROOT, rel, logger, emptyAllowed),
      (err) => err.code === 'USAGE' && /没有任何已登记组件/.test(err.message),
      '空索引下即使是工程内文件也必须拒绝',
    );
    // 完全不传白名单 → 同样默认拒绝（守卫「没名单就拒绝」）
    assert.throws(
      () => resolveTargetPath(dir, ROOT, rel, logger),
      (err) => err.code === 'USAGE' && /没有任何已登记组件/.test(err.message),
      '未提供白名单必须默认拒绝',
    );

    // (g) 软链逃逸：工程根内的软链指向外部 → realpath 校验应拒绝
    let symlinkReady = false;
    try {
      const linkPath = path.join(dir, 'link-out');
      fs.symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      symlinkReady = true;
    } catch {
      symlinkReady = false; // Windows 需开发者模式/管理员权限 —— 条件跳过（下方注明）
    }
    if (symlinkReady) {
      assert.throws(
        () => resolveTargetPath(dir, ROOT, 'link-out/victim.xml', logger, allowed),
        (err) => err.code === 'USAGE',
        '软链逃逸必须被 realpath 校验拒绝',
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: gen-xml 三态退出码 —— 有 blocked 的 plan → 4；加 --allow-partial → 0 且 ok=false', () => {
  if (!fs.existsSync(path.join(FGUI_FIXTURE, 'MailPopup.fairy'))) {
    makeFguiProject({ outDir: FGUI_FIXTURE });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-partial-'));
  try {
    const idx = runCliJson([
      'project-index', '--root', ROOT, '--project', FGUI_FIXTURE,
      '--out', dir, '--no-images',
    ]);
    assert.equal(idx.code, EXIT.OK);

    // REUSE（resolved）+ 一条 slot 零命中（unresolved）→ 非全部 resolved → partial
    const planPath = path.join(dir, 'change_plan.json');
    writeJson(planPath, {
      version: '1.0',
      task: { name: 'MailDetail', basePkg: 'MailDetail', targetPkg: 'MailDetail' },
      diffs: [
        { op: 'REUSE', slot: 'frame', node: 'L010' },
        { op: 'MOVE', slot: 'no_such_layer_xyz', node: 'L999' },
      ],
    });
    const base = ['gen-xml', 'prepare', '--root', ROOT, '--plan', planPath,
      '--project', FGUI_FIXTURE, '--index', path.join(dir, 'project_index.json'), '--out', dir];

    const strict = runCliJson(base);
    assert.equal(strict.code, EXIT.NEEDS_HUMAN, 'partial 默认应拦成 4（不是成功）');
    assert.equal(strict.json.ok, false);
    assert.equal(strict.json.summary.status, 'partial');
    assert.ok(strict.json.summary.byStatus.unresolved >= 1, '零命中的 MOVE 应记为 unresolved');
    assert.equal(typeof strict.json.summary.blockedCount, 'number', 'prepare summary 应带 blockedCount');
    assert.ok(/partial/.test(strict.stderr), 'stderr 应有 partial 告警');

    const allowed = runCliJson([...base, '--allow-partial']);
    assert.equal(allowed.code, EXIT.OK, '--allow-partial 时放行退出码');
    assert.equal(allowed.json.ok, false, '--allow-partial 不改变 ok（仍 partial）');
    assert.equal(allowed.json.status, 'partial');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: gen-xml prepare 产出的 target.file 严格等于「工程根相对」路径', () => {
  // 关键场景：索引在 **--root=仓库根** 下生成（file 相对 rootDir），
  // 而 --project 指向子目录里的 FGUI 工程 —— 此时 target.file 必须被相对化成工程根相对。
  if (!fs.existsSync(path.join(FGUI_FIXTURE, 'MailPopup.fairy'))) {
    makeFguiProject({ outDir: FGUI_FIXTURE });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-targetfile-'));
  try {
    const idx = runCliJson([
      'project-index', '--root', ROOT, '--project', FGUI_FIXTURE,
      '--out', dir, '--no-images',
    ]);
    assert.equal(idx.code, EXIT.OK, 'project-index 应成功');

    const planPath = path.join(dir, 'change_plan.json');
    writeJson(planPath, {
      version: '1.0',
      task: { name: 'MailDetail', basePkg: 'MailDetail', targetPkg: 'MailDetail' },
      diffs: [{ op: 'REUSE', slot: 'frame', node: 'L010' }],
    });

    const prep = runCliJson([
      'gen-xml', 'prepare', '--root', ROOT,
      '--plan', planPath,
      '--project', FGUI_FIXTURE,
      '--index', path.join(dir, 'project_index.json'),
      '--out', dir,
    ]);
    assert.equal(prep.code, EXIT.OK, `prepare 应成功：${JSON.stringify(prep.json)}`);

    const gp = readJson(path.join(dir, 'gen_plan.json'));
    // ★ 严格等值，不用 endsWith —— 否则「相对 CLI rootDir」的旧形态也能蒙混过关 ★
    assert.equal(
      gp.target.file,
      'assets/MailDetail/MailDetail.xml',
      `target.file 必须严格等于工程根相对路径（实测：${JSON.stringify(gp.target.file)}）`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: gen-xml 三阶段分发（usage 分支）', () => {
  // 无阶段参数 → 打印用法 + EXIT.USAGE；stdout 仍是纯 JSON
  const r1 = runCliJson(['gen-xml']);
  assert.equal(r1.code, EXIT.USAGE);
  assert.equal(r1.json.command, 'gen-xml');
  assert.equal(r1.json.ok, false);
  assert.ok(/prepare \| dryrun \| apply/.test(r1.stderr), '用法应打印到 stderr');

  // prepare 缺 --plan → EXIT.USAGE；stdout 仍是纯 JSON
  const r2 = runCliJson(['gen-xml', 'prepare']);
  assert.equal(r2.code, EXIT.USAGE);
  assert.equal(r2.json.ok, false);
  assert.ok(/--plan/.test(r2.json.error), '错误信息应指明缺 --plan');

  // dryrun 缺 --gen-plan → EXIT.USAGE；stdout 仍是纯 JSON
  const r3 = runCliJson(['gen-xml', 'dryrun']);
  assert.equal(r3.code, EXIT.USAGE);
  assert.equal(r3.json.ok, false);
  assert.ok(/--gen-plan/.test(r3.json.error), '错误信息应指明缺 --gen-plan');
});

test('CLI: psd-ir 支持多份一次解析（R2-F7）', (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-multi-'));
  try {
    const res = runCliJson([
      'psd-ir', '--root', ROOT,
      '--psd', path.join(GOLDEN, 'state_A.psd'),
      '--psd', path.join(GOLDEN, 'state_B.psd'),
      '--out', dir,
    ]);
    assert.equal(res.code, EXIT.OK);
    assert.ok(fs.existsSync(path.join(dir, 'design_ir.A.json')));
    assert.ok(fs.existsSync(path.join(dir, 'design_ir.B.json')));
    assert.equal(res.json.results.length, 2);
    assert.deepEqual(res.json.results.map((r) => r.label), ['A', 'B']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: asset-search 支持人工确认写缓存（R1-F6 / A4）', (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-srch-'));
  const common = [
    '--root', ROOT, '--db', path.join(dir, 'assets.db'),
    '--assets', path.join(GOLDEN, 'assets'), '--out', dir,
  ];
  try {
    // 先建索引
    assert.equal(runCli(['asset-index', '--root', ROOT,
      '--assets', path.join(GOLDEN, 'assets'), '--out', dir, '--run-id', 'srch']).code, EXIT.OK);

    // 检索拿到 assetId（带图层尺寸，走 Ch-1 精确同名 + ±2px 尺寸校验）
    const found = runCliJson(['asset-search', ...common,
      '--query', '矩形11', '--w', '180', '--h', '90']);
    assert.equal(found.code, EXIT.OK);
    assert.ok(found.json.hits.length >= 1);
    assert.equal(found.json.certainty, 'exact_name', '★ 归一名全等 + 尺寸符应判「同名确定」');
    assert.equal(found.json.needsConfirm, false);

    // 人工确认写缓存
    const cf = runCliJson(['asset-search', ...common,
      '--slot', 'popup_bg', '--confirm', found.json.hits[0].assetId, '--by', 'xiaq']);
    assert.equal(cf.code, EXIT.OK);
    assert.ok(fs.existsSync(path.join(dir, 'slot-map.json')), '应生成 slot-map.json');

    // 再查同一槽位 -> 命中缓存且零重算（A4）
    const again = runCliJson(['asset-search', ...common, '--slot', 'popup_bg', '--query', '矩形11']);
    assert.equal(again.json.zeroRecompute, true, '★ 二次运行应命中缓存且零重算');
    assert.equal(again.json.certainty, 'confirmed_by_human');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ CLI: diff-plan 有未确认 INFERRED 时退出码为 4（NEEDS_HUMAN）', async (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-code-'));
  try {
    const res = await runPipeline(dir);
    const plan = readJson(path.join(dir, 'change_plan.json'));
    const inferred = plan.diffs.filter((d) => d.op === 'INFERRED');
    // 产物已生成（不因「需人工确认」而不产出）
    assert.ok(fs.existsSync(path.join(dir, 'change_plan.json')));
    if (inferred.length > 0) {
      assert.equal(res.planCode, EXIT.NEEDS_HUMAN,
        '★ 存在未确认 INFERRED 时进程退出码应为 4，让脚本能自动判断能否进 P1');
    } else {
      assert.equal(res.planCode, EXIT.OK);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ======================================================================
// ★ `--now` 曾是空壳 flag（QA 发现）—— 现在必须真正生效
// ======================================================================
test('★ --now 注入真实生效（run_meta.json 的 generatedAt 可复现）', (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  const assets = path.join(GOLDEN, 'assets');
  const withNow = (dir, iso) => {
    runCli(['asset-index', '--root', ROOT, '--assets', assets, '--out', dir,
      '--run-id', 'now', '--now', iso]);
    return JSON.parse(fs.readFileSync(path.join(dir, 'run_meta.json'), 'utf8'));
  };
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-now1-'));
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-now2-'));
  try {
    const a = withNow(d1, '2020-01-02T03:04:05.678Z');
    const b = withNow(d2, '2031-11-12T13:14:15.999Z');
    assert.equal(a.generatedAt, '2020-01-02T03:04:05.678Z',
      `★ --now 未生效，generatedAt=${a.generatedAt}`);
    assert.equal(b.generatedAt, '2031-11-12T13:14:15.999Z',
      `★ --now 未生效，generatedAt=${b.generatedAt}`);
    assert.notEqual(a.generatedAt, b.generatedAt);
  } finally {
    fs.rmSync(d1, { recursive: true, force: true });
    fs.rmSync(d2, { recursive: true, force: true });
  }
});

test('★ --now 非法值应报错（不静默回退到真实时间）', (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-badnow-'));
  try {
    const res = runCli(['asset-index', '--root', ROOT,
      '--assets', path.join(GOLDEN, 'assets'), '--out', dir, '--now', '不是时间']);
    assert.notEqual(res.code, 0, '非法 --now 必须返回非零退出码');
    assert.ok(res.stderr.includes('now') || res.stderr.includes('时间'),
      '错误信息应点明是 --now 的问题');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ --now 缺失时 run_meta 仍有真实时间（向后兼容）', (t) => {
  if (!ensureFixtures()) return t.skip('fixture 未生成');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-nonow-'));
  try {
    runCli(['asset-index', '--root', ROOT, '--assets', path.join(GOLDEN, 'assets'),
      '--out', dir, '--run-id', 'nonow']);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'run_meta.json'), 'utf8'));
    assert.match(meta.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      '不传 --now 时应记录真实时间');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ npm test 入口本身可用（BUG#6：目录参数写法会让 Node v24 报 2 个失败）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const script = pkg.scripts.test;
  assert.ok(script.includes('--test'), 'test 脚本应调用 node --test');
  // ★ 必须是 glob 而不是目录参数：Node v24 把目录当 2 个测试项 -> fail 2
  assert.ok(!/\s--test\s+test\/unit\s/.test(script),
    `★ test 脚本不能直接用目录参数（Node v24 会报 2 个失败）：${script}`);
  assert.ok(/["']test\/\*\*\/\*\.test\.js["']/.test(script),
    `test 脚本应使用 glob：${script}`);
});
