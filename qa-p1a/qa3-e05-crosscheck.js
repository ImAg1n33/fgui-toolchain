'use strict';
/**
 * qa-p1a/qa3-e05-crosscheck.js —— QA 第三轮：E-05 交叉验证独立性核查
 *
 * 1. reference-ir.js 零 src/ 依赖（grep require）
 * 2. 算法独立性判断（结构对比：递归+reduce vs 单遍迭代；深度上限 100 vs 256）
 * 3. 变异测试：工程师的七种 + QA 追加的四种（name/depth/transform/文档级告警）
 * 4. 「同名兄弟撞 key」修复充分性：构造同名兄弟/空名/含 # 与 / 的层名，
 *    验证 key 不撞；并用旧式 key（不带序号）证明「假一致」确实会发生过
 * 5. 边界记录：定义性风险（两边同错）与 100~256 层深度区间不可对账
 *
 * 运行：node qa-p1a/qa3-e05-crosscheck.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const {
  referenceBuildIr, referenceBuildIrBuggy, irToComparable, crossCheck, REF_MAX_DEPTH,
} = require('../test/unit/helpers/reference-ir');
const { IrBuilder, MAX_GROUP_DEPTH } = require('../src/psd/ir-builder');

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

console.log('=== QA3-X1. reference-ir.js 零 src/ 依赖 ===');
{
  const src = fs.readFileSync(path.resolve(__dirname, '../test/unit/helpers/reference-ir.js'), 'utf8');
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  console.log(`  [INFO] reference-ir.js 的 require: ${JSON.stringify(requires)}`);
  ok('零 require（完全不 import 任何模块）', requires.length === 0, JSON.stringify(requires));
  ok('不出现 src/ 字样引用', !/require\(.*src/.test(src) && !/from ['"].*src/.test(src));

  // 被测实现的深度上限确实不同（证明不是同参复制）
  ok('参考深度上限=100 ≠ 被测 256', REF_MAX_DEPTH === 100 && MAX_GROUP_DEPTH === 256,
    `ref=${REF_MAX_DEPTH} impl=${MAX_GROUP_DEPTH}`);
}

console.log('\n=== QA3-X2. 算法独立性（结构对比）===');
{
  const refSrc = fs.readFileSync(path.resolve(__dirname, '../test/unit/helpers/reference-ir.js'), 'utf8');
  const implSrc = fs.readFileSync(path.resolve(__dirname, '../src/psd/ir-builder.js'), 'utf8');
  // 参考实现用 reduce 建组 bbox；被测用 for + 手动 min/max 比较
  ok('参考实现用 reduce 风格建组 bbox', /children\.reduce\(/.test(refSrc));
  ok('被测实现用 for+手动 min/max 建组 bbox（非 reduce）',
    /for \(const child of list\)/.test(implSrc) && /if \(x < minX\)/.test(implSrc) && !/children\.reduce/.test(implSrc));
  // 参考实现递归建树；被测单遍 walk + flat
  ok('参考实现递归 walk', /const walk = \(siblings/.test(refSrc));
  // 类型判定顺序：参考 children→text→smartobject；被测 isGroup→isTextLayer→smartObject/placedLayer
  ok('参考实现类型判定独立书写（refType 函数存在）', /function refType/.test(refSrc));
  // 参考实现不 import merged-detect / grid9 / normalize 等 src 模块（零 require 已证）
  ok('参考实现不复用被测的 merged-detect', !/detectMerged/.test(refSrc));
  console.log('  [INFO] 结论：算法结构不同（递归+reduce vs 迭代+min/max），但共享同一份文字定义');
  console.log('  [INFO] （ARCHITECTURE §3.3）——定义性风险固有存在，见 QA3-X6 边界记录');
}

console.log('\n=== QA3-X3. 交叉对账基线 + 工程师七种变异回归 ===');
{
  const { installCanvasShim } = require('../src/psd/canvas-shim');
  const { readPsdFile, extractSlices } = require('../src/psd/reader');
  const { makePsds } = require('../test/fixtures/make-psd');
  installCanvasShim({ force: true });
  const GOLDEN = path.resolve(__dirname, '../test/fixtures/golden');
  if (!fs.existsSync(path.join(GOLDEN, 'state_A.psd'))) makePsds({ outDir: GOLDEN });
  const read = readPsdFile(path.join(GOLDEN, 'state_A.psd'), { mode: 'structure' });
  const ir = new IrBuilder({ withPhash: false }).build({
    psd: read.psd, psdPath: 'state_A.psd', sha256: read.sha256, slices: extractSlices(read.psd),
  });
  const ref = referenceBuildIr(read.psd);
  const opts = { skipLayerWarnCodes: ['MERGED_LAYER_GROUP'] };
  ok('未变异对账干净', crossCheck(ref, irToComparable(ir), opts).mismatches.length === 0);

  // 工程师的七种变异逐一回归（证明 npm test 里那组不是恒真）
  // 注意：dropWarning 不在黄金 A 上验 —— 黄金 A 的告警全是 MERGED_LAYER_GROUP，
  // 而带切片树上 MERGED 对账被显式跳过（skipLayerWarnCodes），丢它不可见是**设计行为**。
  // 工程师自己的『反向-2c』也只在无切片树上验 dropWarning —— QA 在 QA3-X3b 独立复核。
  const mutateIr = (irObj, kind) => {
    const clone = JSON.parse(JSON.stringify(irObj));
    const group = clone.layers.find((l) => l.type === 'group' && l.childCount > 0);
    const leaf = clone.layers.find((l) => l.type !== 'group');
    switch (kind) {
      case 'bbox': group.bbox.x += 7; break;
      case 'bboxLeaf': leaf.bbox.w += 3; break;
      case 'parent': leaf.parent = group.id; break;
      case 'type': group.type = 'raster'; break;
      case 'childCount': group.childCount += 1; break;
      case 'dropWarning': clone.warnings.shift(); break;
      case 'dropLayer': clone.layers = clone.layers.filter((l) => l.id !== leaf.id); break;
      default: throw new Error(`unknown ${kind}`);
    }
    return clone;
  };
  for (const kind of ['bbox', 'bboxLeaf', 'parent', 'type', 'childCount', 'dropLayer']) {
    const m = mutateIr(ir, kind);
    const { mismatches } = crossCheck(ref, irToComparable(m), opts);
    ok(`工程师变异 ${kind} 被抓到`, mismatches.length > 0, '未抓到 → 对账器恒真');
  }
  // 记录覆盖边界：黄金 A 的告警集合全是 MERGED → 带切片树上告警维度实际空转
  const goldenCodes = [...new Set(ir.warnings.map((w) => w.code))];
  ok('覆盖边界记录：黄金 A 告警仅 MERGED_LAYER_GROUP（带切片树上该维度被跳过）',
    goldenCodes.length === 1 && goldenCodes[0] === 'MERGED_LAYER_GROUP', JSON.stringify(goldenCodes));

  // ---- QA 追加变异（工程师没做的四种）----
  const extra = [
    ['name（改层名→key 变→集合不一致）', (c) => { c.layers[1].name = 'QA改名'; }],
    ['depth（深度+1）', (c) => { c.layers[1].depth += 1; }],
    ['transform（给叶子塞变换矩阵）', (c) => {
      const leaf = c.layers.find((l) => l.type !== 'group' && l.transform === null);
      leaf.transform = [2, 0, 0, 2, 5, 5];
    }],
    ['文档级告警（删 NO_SLICE，无切片树上验）', (c) => {
      c.warnings = c.warnings.filter((w) => w.code !== 'NO_SLICE');
    }],
  ];
  // name/depth/transform 在黄金样本 A 上验
  for (const [label, fn] of extra.slice(0, 3)) {
    const clone = JSON.parse(JSON.stringify(ir));
    fn(clone);
    const { mismatches } = crossCheck(ref, irToComparable(clone), opts);
    ok(`QA 追加变异 ${label} 被抓到`, mismatches.length > 0, '未抓到');
  }
  // 文档级告警在无切片树上验（黄金样本有切片，无 NO_SLICE）
  {
    const treePsd = { width: 100, height: 100, children: [{ name: 'QA叶', left: 0, top: 0, right: 10, bottom: 10 }] };
    const ir2 = new IrBuilder({ withPhash: false }).build({ psd: treePsd, psdPath: 'x.psd', sha256: 'x', slices: [] });
    const ref2 = referenceBuildIr(treePsd);
    ok('无切片树未变异干净', crossCheck(ref2, irToComparable(ir2)).mismatches.length === 0);
    const clone = JSON.parse(JSON.stringify(ir2));
    extra[3][1](clone);
    const { mismatches } = crossCheck(ref2, irToComparable(clone));
    ok('QA 追加变异 文档级告警（删 NO_SLICE）被抓到', mismatches.length > 0, '未抓到');
  }

  // QA3-X3b：dropWarning 在 QA 自造无切片树上必须被抓（工程师 2c 的独立复核）
  {
    const g = (name, children) => ({ name, children, blendMode: 'pass through' });
    const r = (name, x, y, w, h) => ({ name, left: x, top: y, right: x + w, bottom: y + h, blendMode: 'normal' });
    const treePsd = {
      width: 100, height: 100,
      children: [
        g('QA空组', []),
        g('QA全栅组', [r('QA块1', 0, 0, 10, 10)]),
        { name: 'QA文本', left: 0, top: 50, right: 40, bottom: 70, blendMode: 'normal', text: { text: 'hi', transform: [1, 0, 0, 1, 0, 0], style: { font: { name: 'A' }, fontSize: 20, fillColor: { r: 1, g: 2, b: 3 } }, paragraphStyle: { justification: 'left' } } },
      ],
    };
    const ir3 = new IrBuilder({ withPhash: false }).build({ psd: treePsd, psdPath: 'x.psd', sha256: 'x', slices: [] });
    const ref3 = referenceBuildIr(treePsd);
    ok('QA 无切片树未变异干净', crossCheck(ref3, irToComparable(ir3)).mismatches.length === 0);
    const clone = JSON.parse(JSON.stringify(ir3));
    clone.warnings.shift();
    const { mismatches } = crossCheck(ref3, irToComparable(clone));
    ok('QA 独立复核：dropWarning 在无切片树上被抓到', mismatches.length > 0 && mismatches.some((m) => m.includes('告警码')),
      JSON.stringify(mismatches.slice(0, 2)));
  }

  // buggy 参考版与真实 IR 对账必须不一致（证明对账器能区分对错）
  const buggy = referenceBuildIrBuggy(read.psd);
  const { mismatches: bm } = crossCheck(buggy, irToComparable(ir), opts);
  ok('BUG#1 模拟版与真实 IR 对账报不一致', bm.length > 0 && bm.some((m) => m.includes('bbox')));
}

console.log('\n=== QA3-X4. 「同名兄弟撞 key」修复充分性 ===');
{
  const g = (name, children) => ({ name, children, blendMode: 'pass through' });
  const r = (name, x, y, w, h) => ({ name, left: x, top: y, right: x + w, bottom: y + h, blendMode: 'normal' });

  // 树 1：三个同名兄弟（工程师说黄金 B 的 3 个图层249 曾撞 key）
  const psd1 = { width: 100, height: 100, children: [g('QA同名组', [r('图层249', 0, 0, 10, 10), r('图层249', 20, 0, 10, 10), r('图层249', 40, 0, 10, 10)])] };
  const ref1 = referenceBuildIr(psd1);
  const keys1 = ref1.layers.map((l) => l.key);
  ok('三个同名兄弟 key 互异', new Set(keys1).size === keys1.length, JSON.stringify(keys1));

  // 旧式 key（不带 #序号）会撞 —— 证明修复确实有必要（不是多余的）
  const oldStyleKeys = ref1.layers.map((l) => {
    // 模拟旧实现：父路径/名字（无序号）
    const parentPath = l.parentKey ? l.parentKey.replace(/#\d+$/, '') : '';
    return `${parentPath}/${l.name}`;
  });
  ok('旧式 key（无序号）确实会撞 key', new Set(oldStyleKeys).size < oldStyleKeys.length,
    JSON.stringify(oldStyleKeys));

  // 树 2：空名层（PSD 里可能存在未命名层）
  const psd2 = { width: 100, height: 100, children: [r('', 0, 0, 10, 10), r('', 20, 0, 10, 10)] };
  const ref2 = referenceBuildIr(psd2);
  const keys2 = ref2.layers.map((l) => l.key);
  ok('空名层 key 不撞', new Set(keys2).size === keys2.length, JSON.stringify(keys2));

  // 树 3：层名含 # 与 /（潜在 key 注入）
  const psd3 = {
    width: 100, height: 100,
    children: [
      g('a', [r('b/c', 0, 0, 10, 10)]), // 兄弟名叫 a/b 形式
      g('a/b', [r('x', 0, 0, 10, 10)]), // 与上层组合可能撞 key
      r('#0', 0, 0, 10, 10),
      r('x#0', 0, 0, 10, 10),
    ],
  };
  const ref3 = referenceBuildIr(psd3);
  const keys3 = ref3.layers.map((l) => l.key);
  ok('含 # 与 / 的层名 key 不撞', new Set(keys3).size === keys3.length, JSON.stringify(keys3));

  // 端到端：这些树走 IrBuilder + irToComparable 后与参考实现对账一致
  for (const [label, psd] of [['同名兄弟', psd1], ['空名', psd2], ['含#与/', psd3]]) {
    const ir = new IrBuilder({ withPhash: false }).build({ psd, psdPath: 'x.psd', sha256: 'x', slices: [] });
    const { mismatches } = crossCheck(referenceBuildIr(psd), irToComparable(ir));
    ok(`${label} 树端到端对账一致`, mismatches.length === 0, mismatches.slice(0, 3).join(' | '));
  }
}

console.log('\n=== QA3-X5. 参考实现自身健全性（免检金牌也要验）===');
{
  const g = (name, children) => ({ name, children, blendMode: 'pass through' });
  const r = (name, x, y, w, h) => ({ name, left: x, top: y, right: x + w, bottom: y + h, blendMode: 'normal' });
  // 嵌套穿透 + 深度
  const psd = { width: 100, height: 100, children: [g('外', [g('中', [g('内', [r('叶', 10, 20, 30, 40)])])])] };
  const ref = referenceBuildIr(psd);
  const byName = new Map(ref.layers.map((l) => [l.name, l]));
  assert.deepEqual(byName.get('外').bbox, { x: 10, y: 20, w: 30, h: 40 });
  assert.equal(byName.get('叶').depth, 3);
  ok('参考实现三层穿透 bbox 正确', true);
  // 深度上限 100 截断
  let node = r('深叶', 1, 1, 5, 5);
  for (let i = 0; i < 150; i++) node = g(`g${i}`, [node]);
  const ref2 = referenceBuildIr({ width: 50, height: 50, children: [node] });
  const top = ref2.layers.find((l) => l.name === 'g149');
  ok('参考实现深度上限 100 截断为 0', JSON.stringify(top.bbox) === JSON.stringify({ x: 0, y: 0, w: 0, h: 0 }),
    JSON.stringify(top.bbox));
  // 同一参考实现两次结果一致（无隐藏状态）
  ok('参考实现确定性', JSON.stringify(referenceBuildIr(psd)) === JSON.stringify(referenceBuildIr(psd)));
}

console.log('\n=== QA3-X6. 边界记录（交叉验证抓不到的）===');
{
  console.log('  [INFO] ① 定义性风险：参考实现与被测共享同一份 ARCHITECTURE 文字定义。');
  console.log('         若定义本身错（如「零尺寸叶子应参与并集」），两边会一致地错 ——');
  console.log('         交叉验证只能证明「实现符合共同解读」，不能证明「解读符合画师预期」。');
  console.log('  [INFO] ② 深度区间 100~256：参考实现上限 100，被测 256。');
  console.log('         落在此区间的树两边必然不一致（截断 vs 不截断），无法对账。');
  console.log('         真实 PSD 极少超过 10 层（HANDOFF §2.3 判定实际不可达）。');
  console.log('  [INFO] ③ MERGED_LAYER_GROUP 在含切片树上跳过对账（切片归属是另一套算法）。');
  console.log('  [INFO] ④ pHash 数值不参与对账。');
  console.log('  [INFO] ⑤ bitsPerChannel/NON_8BIT_CHANNELS 告警参考实现不预测');
  console.log('         （E-05 对账维度不含位深；该维度只由 E-01 守护）。');
  pass++; // 记录项
}

console.log(`\n=== QA3-e05 汇总: ${pass} pass / ${fail} fail ===`);
if (fail > 0) {
  console.log('失败项:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail > 0 ? 1 : 0);
