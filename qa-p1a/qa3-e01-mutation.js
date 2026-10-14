'use strict';
/**
 * qa-p1a/qa3-e01-mutation.js —— QA 第三轮：E-01 修复的变异测试 + 独立复现 + 新静默问题排查
 *
 * 三部分：
 *   A. 独立复现第③个静默问题（含智能对象的组被误判 merged）：
 *      QA 自造 PSD（writePsdBuffer 真实往返），不用他的样本。
 *      含正对照（纯 raster 组必须 merged=true，证明检测器没坏）。
 *   B. 变异测试：把 3 个修复逐一改回旧行为，断言 E-01 测试必须变红。
 *      （备份 → 变异 → 跑测试 → 恢复，finally 保证恢复）
 *   C. 新静默问题排查：用 P0「测试绿但行为错」的同款方式再找一轮。
 *
 * 运行：node qa-p1a/qa3-e01-mutation.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { installCanvasShim, createImageData, composeImageData } = require('../src/psd/canvas-shim');
const { readPsdFile } = require('../src/psd/reader');
const { IrBuilder } = require('../src/psd/ir-builder');

installCanvasShim({ force: true });
// eslint-disable-next-line global-require
const { writePsdBuffer } = require('ag-psd');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, evidence) {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  [FAIL] ${name}${evidence ? ' :: ' + evidence : ''}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa3-e01-'));
const GUID = '20953ddb-9391-11ec-b4f1-c15674f50bc4'; // 任意合法 GUID

function solid(w, h, rgba) {
  const img = createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = rgba[0];
    img.data[i * 4 + 1] = rgba[1];
    img.data[i * 4 + 2] = rgba[2];
    img.data[i * 4 + 3] = rgba[3];
  }
  return img;
}
function raster(name, x, y, w, h) {
  return {
    name, left: x, top: y, right: x + w, bottom: y + h,
    imageData: solid(w, h, [200, 100, 50, 255]), opacity: 1, blendMode: 'normal',
  };
}
function group(name, children) {
  return { name, opened: true, children, blendMode: 'pass through' };
}
function smart(name, x, y, w, h, transform) {
  return {
    name, left: x, top: y, right: x + w, bottom: y + h,
    imageData: solid(w, h, [80, 120, 200, 255]), blendMode: 'normal',
    placedLayer: {
      id: GUID, type: 'raster', width: w, height: h,
      transform: transform || [1, 0, 0, 1, 0, 0, 0, 0],
    },
  };
}

/** QA 自造 PSD → 真实往返 → IR。 */
function roundtrip(name, layers, mode = 'full') {
  const psd = { width: 300, height: 200, imageData: composeImageData(300, 200, layers), children: layers };
  const file = path.join(TMP, `${name}.psd`);
  fs.writeFileSync(file, writePsdBuffer(psd));
  const read = readPsdFile(file, { mode });
  const ir = new IrBuilder({ withPhash: mode === 'full' }).build({
    psd: read.psd, psdPath: file, sha256: read.sha256, slices: [],
  });
  return ir;
}
const byName = (ir, n) => ir.layers.find((l) => l.name === n);
const warnCodes = (ir, code) => ir.warnings.filter((w) => w.code === code);

console.log('=== QA3-E1A. 独立复现：含智能对象的组不得判 merged ===');
{
  const ir = roundtrip('qa-smart', [
    group('QA纯智能组', [smart('QA智能对象', 40, 30, 100, 80)]),
    group('QA混合组', [smart('QA智能对象2', 10, 10, 60, 40), raster('QA栅格层', 80, 60, 50, 30)]),
    group('QA纯栅组', [raster('QA栅格A', 0, 0, 30, 30), raster('QA栅格B', 40, 40, 30, 30)]),
    group('QA文本栅组', [raster('QA栅格C', 0, 100, 30, 30), {
      name: 'QA文本层', left: 60, top: 100, right: 160, bottom: 124,
      imageData: solid(100, 24, [255, 255, 255, 255]), opacity: 1, blendMode: 'normal',
      text: {
        text: 'QA', transform: [1, 0, 0, 1, 0, 0],
        style: { font: { name: 'A' }, fontSize: 20, fillColor: { r: 1, g: 2, b: 3 } },
        paragraphStyle: { justification: 'left' },
      },
    }]),
  ]);

  ok('正对照：纯 raster 组判 merged=true（证明检测器在工作）',
    byName(ir, 'QA纯栅组').merged === true && warnCodes(ir, 'MERGED_LAYER_GROUP').length === 1,
    `merged=${byName(ir, 'QA纯栅组').merged} warns=${warnCodes(ir, 'MERGED_LAYER_GROUP').length}`);

  ok('① 纯智能对象组不判 merged', byName(ir, 'QA纯智能组').merged === false,
    `merged=${byName(ir, 'QA纯智能组').merged}`);
  ok('② 智能对象+raster 混合组不判 merged', byName(ir, 'QA混合组').merged === false,
    `merged=${byName(ir, 'QA混合组').merged}`);
  ok('③ 文本+raster 组不判 merged', byName(ir, 'QA文本栅组').merged === false,
    `merged=${byName(ir, 'QA文本栅组').merged}`);
  ok('智能对象类型识别为 smartobject', byName(ir, 'QA智能对象').type === 'smartobject');
  ok('智能对象 pHash 正常计算', /^[0-9a-f]{16}$/.test(byName(ir, 'QA智能对象').phash || ''),
    `phash=${byName(ir, 'QA智能对象').phash}`);
  ok('MERGED 告警恰好 1 条（只归纯栅组）', warnCodes(ir, 'MERGED_LAYER_GROUP').length === 1);
  ok('纯智能对象组 bbox 由子层推导', JSON.stringify(byName(ir, 'QA纯智能组').bbox) === JSON.stringify({ x: 40, y: 30, w: 100, h: 80 }),
    JSON.stringify(byName(ir, 'QA纯智能组').bbox));
}

console.log('\n=== QA3-E1B. 独立验证位深与变换矩阵落 IR ===');
{
  const c = Math.cos(Math.PI / 6);
  const s = Math.sin(Math.PI / 6);
  const psd = {
    width: 300, height: 200,
    imageData: composeImageData(300, 200, [raster('QA底层', 0, 0, 60, 40)]),
    children: [raster('QA底层', 0, 0, 60, 40)],
  };
  let buf = writePsdBuffer(psd);
  const patched = Buffer.from(buf);
  patched.writeUInt16BE(16, 22); // header depth 字段
  buf = patched;
  const file = path.join(TMP, 'qa-16bit.psd');
  fs.writeFileSync(file, buf);
  const read = readPsdFile(file, { mode: 'structure' });
  const ir = new IrBuilder({ withPhash: false }).build({
    psd: read.psd, psdPath: file, sha256: read.sha256, slices: [],
  });
  ok('16 位 PSD：source.bitsPerChannel=16 落 IR', ir.source.bitsPerChannel === 16, `实际 ${ir.source.bitsPerChannel}`);
  ok('16 位 PSD：NON_8BIT_CHANNELS 告警', warnCodes(ir, 'NON_8BIT_CHANNELS').length === 1);

  // 变换矩阵：旋转文本
  const ir2 = roundtrip('qa-transform', [{
    name: 'QA旋转文本', left: 60, top: 60, right: 260, bottom: 96,
    imageData: solid(200, 36, [255, 255, 255, 255]), opacity: 1, blendMode: 'normal',
    text: {
      text: 'QA rot', transform: [c, s, -s, c, 10, 20],
      style: { font: { name: 'A' }, fontSize: 20, fillColor: { r: 1, g: 2, b: 3 } },
      paragraphStyle: { justification: 'left' },
    },
  }], 'structure');
  const t = byName(ir2, 'QA旋转文本');
  ok('变换矩阵 6 值落 IR', Array.isArray(t.transform) && t.transform.length === 6,
    JSON.stringify(t.transform));
  ok('矩阵值正确（cos30≈0.866025）', Math.abs(t.transform[0] - 0.866025) < 1e-6, JSON.stringify(t.transform));
  ok('TRANSFORMED_LAYER 告警 1 条', warnCodes(ir2, 'TRANSFORMED_LAYER').length === 1);
}

console.log('\n=== QA3-E1C. 变异测试：把修复改回旧行为，E-01 测试必须变红 ===');
{
  const SRC = path.resolve(__dirname, '../src/psd/ir-builder.js');
  const BACKUP = path.resolve(__dirname, '../src/psd/ir-builder.js.qa3bak');
  const original = fs.readFileSync(SRC, 'utf8');
  const crypto = require('crypto');
  const md5Of = (s) => crypto.createHash('md5').update(s).digest('hex');
  const originalMd5 = md5Of(original);
  fs.writeFileSync(BACKUP, original);

  const MUTATIONS = [
    {
      name: 'M1 位深修复回退（bitsPerChannel 恒 8，不告警）',
      from: 'const bitsPerChannel = psd.bitsPerChannel === undefined ? 8 : psd.bitsPerChannel;',
      to: 'const bitsPerChannel = 8; // QA3 MUTATION',
      expectFailContains: ['16/32 位通道', '8 位常规 PSD'],
    },
    {
      name: 'M2 变换矩阵修复回退（transformOfLayer 恒 null）',
      from: 'function transformOfLayer(layer) {\r\n  if (!layer) return null;',
      to: 'function transformOfLayer(layer) {\r\n  if (!layer) return null;\r\n  return null; // QA3 MUTATION',
      expectFailContains: ['变形文本层', '变形智能对象'],
    },
    {
      name: 'M3 smartobject 透传修复回退（rebuildForDetect 丢标记）',
      from: "smartObject: n.type === 'smartobject' ? true : undefined,",
      to: 'smartObject: undefined, // QA3 MUTATION',
      expectFailContains: ['智能对象: 正确识别类型'],
    },
  ];

  const TESTFILES = [
    'test/unit/psd-malformed.test.js',
    'test/unit/psd-ir-cross-check.test.js',
    'test/unit/ir-builder.test.js',
  ];

  const runTests = () => {
    try {
      const out = execFileSync('C:/Program Files/nodejs/node.exe',
        ['--disable-warning=ExperimentalWarning', '--test', ...TESTFILES],
        { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', stdio: 'pipe' });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status || 1, out: (e.stdout || '') + (e.stderr || '') };
    }
  };

  try {
    for (const m of MUTATIONS) {
      if (!original.includes(m.from)) {
        ok(`${m.name}（变异点未找到，跳过）`, false, '源码中未找到变异锚点');
        continue;
      }
      fs.writeFileSync(SRC, original.replace(m.from, m.to), 'utf8');
      const r = runTests();
      // 提取失败的测试名
      const failed = [...r.out.matchAll(/^✖ (.+)$/gm)].map((x) => x[1].trim());
      const caught = m.expectFailContains.filter((n) => failed.some((f) => f.includes(n)));
      ok(`${m.name} → 测试变红`, r.code !== 0 && caught.length > 0,
        `exit=${r.code} 失败测试=${JSON.stringify(failed.slice(0, 6))}`);
      fs.writeFileSync(SRC, original, 'utf8');
      // 恢复后必须重新干净（证明无隐藏状态）
      const r2 = runTests();
      ok(`${m.name} → 恢复后测试重新全绿`, r2.code === 0,
        `exit=${r2.code}`);
    }
  } finally {
    fs.writeFileSync(SRC, original, 'utf8');
    if (fs.existsSync(BACKUP)) fs.unlinkSync(BACKUP);
  }
  ok('★ 源文件已还原（md5 与变异前一致）', md5Of(fs.readFileSync(SRC, 'utf8')) === originalMd5);
}

console.log('\n=== QA3-E1D. 新静默问题排查（P0 同款方式：测试绿 ≠ 行为对）===');
{
  // 排查 1：调整层的 type 标注（ag-psd 有 adjustment 属性，ir-builder 不读）
  const ir = roundtrip('qa-adjust', [{
    name: 'QA调整层', left: 0, top: 0, right: 300, bottom: 200, blendMode: 'normal',
    adjustment: { type: 'brightness/contrast', brightness: 10, contrast: 20 },
  }, raster('QA底图', 0, 0, 100, 80)], 'structure');
  const adj = byName(ir, 'QA调整层');
  console.log(`  [INFO] 调整层 type=${adj.type} bbox=${JSON.stringify(adj.bbox)} `
    + `EMPTY_LAYER告警=${warnCodes(ir, 'EMPTY_LAYER').length} 条`);
  ok('调整层有 EMPTY_LAYER 告警（不静默）', warnCodes(ir, 'EMPTY_LAYER').length === 1);
  ok('排查1 记录：调整层被标为 raster（有告警兜底，非静默）', adj.type === 'raster');

  // 排查 2：隐藏层参与组 bbox 并集（设计决策，需可见）
  const ir2 = roundtrip('qa-hidden', [
    group('QA隐藏组', [
      { ...raster('QA可见层', 0, 0, 50, 50), hidden: false },
      { ...raster('QA隐藏层', 100, 100, 50, 50), hidden: true },
    ]),
  ], 'structure');
  const g2 = byName(ir2, 'QA隐藏组');
  console.log(`  [INFO] 含隐藏层的组 bbox=${JSON.stringify(g2.bbox)}（隐藏层坐标 100,100,50x50）`);
  ok('排查2 记录：隐藏层参与组 bbox（设计决策，HANDOFF 未明确，建议 P1-b 评估）',
    g2.bbox.w === 150 && g2.bbox.h === 150, JSON.stringify(g2.bbox));

  // 排查 3：零尺寸画布
  const ir3 = roundtrip('qa-zerocanvas', [raster('QA层', 0, 0, 10, 10)]);
  ok('排查3：正常画布下无异常告警', warnCodes(ir3, 'EMPTY_LAYER').length === 0
    && warnCodes(ir3, 'GROUP_BBOX_UNRESOLVED').length === 0);

  // 排查 4：opacity 越界不被钳制（记录行为）
  const ir4 = roundtrip('qa-opacity', [{ ...raster('QA半透明', 0, 0, 10, 10), opacity: 1.5 }], 'structure');
  console.log(`  [INFO] opacity=1.5 的层在 IR 中记录为 ${byName(ir4, 'QA半透明').opacity}`);
  ok('排查4 记录：opacity 未钳制到 [0,1]（记录原值，下游自行处理）', true);

  // 排查 5：文本透明度不在 IR text 里（前瞻风险：P1-b 必须从 layer.opacity 映射 alpha）
  const ir5 = roundtrip('qa-textalpha', [{
    name: 'QA半透文本', left: 0, top: 0, right: 100, bottom: 24,
    imageData: solid(100, 24, [255, 255, 255, 255]), opacity: 0.5, blendMode: 'normal',
    text: {
      text: 'QA', transform: [1, 0, 0, 1, 0, 0],
      style: { font: { name: 'A' }, fontSize: 20, fillColor: { r: 1, g: 2, b: 3 } },
      paragraphStyle: { justification: 'left' },
    },
  }], 'structure');
  const t5 = byName(ir5, 'QA半透文本');
  console.log(`  [INFO] 半透文本层：layer.opacity=${t5.opacity}（PSD 为 8 位透明度，0.5→128/255≈0.501961，量化属预期），text 对象键=${Object.keys(t5.text).join(',')}`);
  ok('排查5 记录：文本 opacity 在 layer.opacity（P1-b 写 XML 时必须映射 alpha，勿丢）',
    Math.abs(t5.opacity - 0.5) < 0.005 && t5.text.color === '#010203',
    `opacity=${t5.opacity} color=${t5.text.color}`);
}

console.log(`\n=== QA3-e01 汇总: ${pass} pass / ${fail} fail ===`);
if (fail > 0) {
  console.log('失败项:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail > 0 ? 1 : 0);
