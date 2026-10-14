'use strict';
/**
 * test/unit/ir-builder.test.js —— ★ 坑 2 的验证（D3：组 bbox 恒为 0）
 *
 * ★ 验收标准 7：断言组的 `bboxSource === 'derived'` 且 bbox 等于**子层并集**，
 *   不是 0,0,0,0 ★（ARCHITECTURE T01 验收② / D3）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { IrBuilder, deriveGroupBox, boxOfLayer, BBOX_SOURCE } = require('../../src/psd/ir-builder');
const { readPsdFile, extractSlices, MODE } = require('../../src/psd/reader');
const { installCanvasShim } = require('../../src/psd/canvas-shim');

const GOLDEN = path.resolve(__dirname, '../fixtures/golden');
const PSD_A = path.join(GOLDEN, 'state_A.psd');
const PSD_B = path.join(GOLDEN, 'state_B.psd');

/** 构建 IR（带缓存，避免重复解析）。 */
let cacheA = null;
let cacheB = null;
function irOf(which) {
  if (which === 'A') {
    if (!cacheA) {
      installCanvasShim();
      const parsed = readPsdFile(PSD_A, { mode: MODE.FULL });
      cacheA = new IrBuilder().build({
        psd: parsed.psd, psdPath: PSD_A, sha256: parsed.sha256, slices: extractSlices(parsed.psd),
      });
    }
    return cacheA;
  }
  if (!cacheB) {
    installCanvasShim();
    const parsed = readPsdFile(PSD_B, { mode: MODE.FULL });
    cacheB = new IrBuilder().build({
      psd: parsed.psd, psdPath: PSD_B, sha256: parsed.sha256, slices: extractSlices(parsed.psd),
    });
  }
  return cacheB;
}

// ======================================================================
// ★★★ 坑 2：组 bbox 恒为 0，必须由子层并集推导 ★★★
// ======================================================================
test('★ 坑2 前置验证: ag-psd 读回的组自身坐标确实是 0,0,0,0', () => {
  // 这条测试是整套断言的地基：先证明「直接采信组坐标必错」，
  // 后面的 deriveGroupBox 断言才有意义。若哪天 ag-psd 修好了这条会红，
  // 届时可以简化实现，但**不能删** —— 它记录了为什么必须并集推导。
  installCanvasShim();
  const parsed = readPsdFile(PSD_A, { mode: MODE.STRUCTURE });
  const group = parsed.psd.children.find((c) => Array.isArray(c.children));
  assert.ok(group, '应能找到一个组图层');
  assert.equal(group.left, 0);
  assert.equal(group.top, 0);
  assert.equal(group.right, 0);
  assert.equal(group.bottom, 0);
  assert.equal(boxOfLayer(group).w, 0, '组自身 w 确为 0');
});

test('★ 坑2: 所有组图层的 bboxSource 均为 derived 且 bbox 非零', () => {
  const ir = irOf('A');
  const groups = ir.layers.filter((l) => l.type === 'group');
  assert.ok(groups.length >= 3, `A 态应至少有 3 个组，实得 ${groups.length}`);

  for (const g of groups) {
    assert.equal(g.bboxSource, BBOX_SOURCE.DERIVED,
      `组『${g.name}』(${g.id}) 的 bboxSource 应为 derived`);
    assert.ok(g.bbox.w > 0 && g.bbox.h > 0,
      `组『${g.name}』(${g.id}) 的 bbox 应非零，实得 ${g.bbox.w}x${g.bbox.h}`);
    assert.notDeepEqual(g.bbox, { x: 0, y: 0, w: 0, h: 0 },
      `组『${g.name}』的 bbox 不应是 0,0,0,0 —— 这说明 deriveGroupBox 没生效`);
  }
});

test('★ 坑2: 组 bbox 精确等于其子层 bbox 并集', () => {
  const ir = irOf('A');
  const byId = new Map(ir.layers.map((l) => [l.id, l]));

  for (const g of ir.layers.filter((l) => l.type === 'group')) {
    const children = ir.layers.filter((l) => l.parent === g.id);
    assert.ok(children.length > 0, `组『${g.name}』应有子层`);

    // 独立算一遍并集，和 IR 里的值对账
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const c of children) {
      assert.ok(c.bbox.w > 0 && c.bbox.h > 0, `子层『${c.name}』bbox 应非零`);
      minX = Math.min(minX, c.bbox.x);
      minY = Math.min(minY, c.bbox.y);
      maxX = Math.max(maxX, c.bbox.x + c.bbox.w);
      maxY = Math.max(maxY, c.bbox.y + c.bbox.h);
    }
    assert.deepEqual(
      { x: g.bbox.x, y: g.bbox.y, w: g.bbox.w, h: g.bbox.h },
      { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
      `组『${g.name}』(${g.id}) 的 bbox 应等于子层并集`,
    );
  }
  assert.ok(byId.size > 0);
});

test('★ 坑2: 嵌套组的 bbox 是「递归并集」（不是只算直接子层）', () => {
  const ir = irOf('A');
  // A 态结构：弹窗框架 > [矩形11, 组1200 > [矩形1, 边框光], 装饰边框]
  const outer = ir.layers.find((l) => l.name === '弹窗框架');
  assert.ok(outer, '应存在『弹窗框架』组');
  assert.equal(outer.bboxSource, 'derived');

  const inner = ir.layers.find((l) => l.name === '组 1200');
  assert.ok(inner, '应存在嵌套组『组 1200』');
  assert.equal(inner.parent, outer.id, '嵌套关系应正确');

  // 整体并集：矩形11(120,80,480x320) 与 装饰边框(128,88,464x304)
  assert.deepEqual(
    { x: outer.bbox.x, y: outer.bbox.y, w: outer.bbox.w, h: outer.bbox.h },
    { x: 120, y: 80, w: 480, h: 320 },
    '外层组 bbox 应为 120,80,480x320',
  );
  // 内层组并集：矩形1(120,80,480x8) 与 边框光(120,392,480x8)
  assert.deepEqual(
    { x: inner.bbox.x, y: inner.bbox.y, w: inner.bbox.w, h: inner.bbox.h },
    { x: 120, y: 80, w: 480, h: 320 },
    '内层组 bbox 应由其两个子层并集推导',
  );
  assert.ok(inner.bbox.w > 0);
});

test('deriveGroupBox: 直接单测（含边界情况）', () => {
  // 空数组 -> 空 box
  assert.deepEqual(deriveGroupBox([]).box, { x: 0, y: 0, w: 0, h: 0 });
  // 零尺寸子层被跳过
  const r = deriveGroupBox([
    { bbox: { x: 0, y: 0, w: 0, h: 0 } },
    { bbox: { x: 10, y: 20, w: 30, h: 40 } },
  ]);
  assert.deepEqual(r.box, { x: 10, y: 20, w: 30, h: 40 });
  assert.equal(r.skipped, 1);
  assert.equal(r.used, 1);
  // 全部零尺寸 -> 空 box，used=0
  const all0 = deriveGroupBox([{ bbox: { x: 0, y: 0, w: 0, h: 0 } }]);
  assert.equal(all0.used, 0);
  assert.deepEqual(all0.box, { x: 0, y: 0, w: 0, h: 0 });
});

test('叶子图层的 bboxSource 为 own', () => {
  const ir = irOf('A');
  const leaves = ir.layers.filter((l) => l.type !== 'group');
  assert.ok(leaves.length > 0);
  for (const l of leaves) {
    assert.equal(l.bboxSource, BBOX_SOURCE.OWN, `叶子『${l.name}』应为 own`);
  }
});

test('图层 id 按文档序递增且父在子前', () => {
  const ir = irOf('A');
  for (let i = 0; i < ir.layers.length; i++) {
    assert.equal(ir.layers[i].id, `L${String(i + 1).padStart(3, '0')}`);
  }
  const seen = new Set();
  for (const l of ir.layers) {
    if (l.parent) assert.ok(seen.has(l.parent), `${l.id} 的父 ${l.parent} 应先出现`);
    seen.add(l.id);
  }
});

test('★ A6: 合并组被标记 merged=true 并产出 lost_info 告警', () => {
  const irA = irOf('A');
  const mergedA = irA.layers.filter((l) => l.merged);
  assert.ok(mergedA.length >= 1, 'A 态的『组 1200』应被标 merged');
  for (const m of mergedA) {
    const w = irA.warnings.find((x) => x.code === 'MERGED_LAYER_GROUP' && x.layer === m.id);
    assert.ok(w, `合并组 ${m.id} 应有 MERGED_LAYER_GROUP 告警`);
    assert.ok(w.msg.includes('被合并'));
    assert.ok(w.lost_info, '★ 告警必须带 lost_info（漏报 = 后面必猜错）');
    assert.equal(w.lost_info.requiresHumanConfirm, true);
    assert.equal(w.lost_info.defaultIfUnconfirmed, 'skip');
    assert.equal(w.lost_info.confidenceCap, 0.5);
  }
});

test('A6: 含 slice 的组不应被误标 merged', () => {
  const irA = irOf('A');
  // 『弹窗框架』的子树里有携带 mail_bg 切片的矩形11 -> 不算合并
  const frame = irA.layers.find((l) => l.name === '弹窗框架');
  assert.ok(frame);
  assert.equal(frame.merged, false, '含 slice 的组不应被标 merged');
});

test('文本图层抽取内容/字号/颜色/对齐（颜色必须 6 位）', () => {
  const ir = irOf('A');
  const texts = ir.layers.filter((l) => l.type === 'text');
  assert.equal(texts.length, 3);

  const title = texts.find((l) => l.name === '标题文本');
  assert.ok(title);
  assert.equal(title.text.value, '邮件详情');
  assert.equal(title.text.fontSize, 26);
  assert.equal(title.text.color, '#f5e6c8', '颜色应为 6 位小写 hex');
  assert.equal(title.text.color.length, 7, '★ #RRGGBB 长度必须是 7（含 #）');
  assert.ok(!/\d{8}$/.test(title.text.color), '★ 绝不能输出 8 位色（上游坑：运行时只取后 6 位）');
  assert.equal(title.text.align, 'left');
  assert.ok(title.text.font.includes('SourceHanSans'));
});

test('B 态文本颜色变化被记录（RESTYLE 的判据）', () => {
  const irA = irOf('A');
  const irB = irOf('B');
  const a = irA.layers.find((l) => l.name === '正文文本');
  const b = irB.layers.find((l) => l.name === '正文文本');
  assert.notEqual(a.text.color, b.text.color, '★ 两态正文颜色应不同（用于验证 RESTYLE）');
  assert.equal(a.text.color, '#e2e8f4');
  assert.equal(b.text.color, '#ffd678');
});

test('切片归属到图层（L1 最强匹配通道的地基）', () => {
  const ir = irOf('A');
  const bg = ir.layers.find((l) => l.sliceName === 'mail_bg');
  assert.ok(bg, '应有图层携带 mail_bg 切片');
  assert.equal(bg.name, '矩形11');
  assert.equal(bg.bbox.x, 120);
  assert.ok(ir.sliceNames.includes('mail_bg'));
  assert.ok(ir.sliceNames.includes('btn_close'));
  // slices 段落里应记录归属图层
  const s = ir.slices.find((x) => x.name === 'mail_bg');
  assert.equal(s.layer, bg.id);
});

test('零尺寸图层产出 EMPTY_LAYER 告警（不静默吞）', () => {
  const install = require('../../src/psd/canvas-shim').installCanvasShim;
  install();
  const { IrBuilder: IB } = require('../../src/psd/ir-builder');
  const fakePsd = {
    width: 100,
    height: 100,
    children: [{ name: '空图层', left: 0, top: 0, right: 0, bottom: 0 }],
  };
  const ir = new IB({ withPhash: false }).build({ psd: fakePsd, psdPath: 'x.psd', sha256: 'x' });
  const w = ir.warnings.find((x) => x.code === 'EMPTY_LAYER');
  assert.ok(w, '零尺寸图层应有 EMPTY_LAYER 告警');
  assert.ok(w.msg.includes('人工确认'));
});

test('IR 产物结构完整且带 _comment（PRD A10 人可读）', () => {
  const ir = irOf('A');
  assert.equal(ir.version, '1.0');
  assert.ok(ir._comment, '顶层应有 _comment');
  assert.ok(ir._bboxNote, '应有 _bboxNote 说明组 bbox 来源');
  assert.ok(ir._layerFieldNote, '应有逐字段说明');
  assert.equal(ir._layerFieldNote.bboxSource, 'own = 图层自身坐标；derived = 子层并集推导（仅 group）');
  assert.ok(ir.source.canvas.w === 720);
  assert.ok(ir.source.psdSha256.length === 64);
  // 每层必备字段
  for (const l of ir.layers) {
    for (const key of ['id', 'name', 'normName', 'parent', 'type', 'bbox', 'bboxSource',
      'rotation', 'opacity', 'visible', 'blend', 'merged', 'childCount', 'sliceName', 'text']) {
      assert.ok(key in l, `图层 ${l.id} 缺字段 ${key}`);
    }
  }
});

test('命名陷阱样本在 IR 中同时存在且归一名不相等', () => {
  const irA = irOf('A');
  const irB = irOf('B');
  const a1 = irA.layers.find((l) => l.name === '矩形1');
  const b11 = irB.layers.find((l) => l.name === '矩形11');
  assert.ok(a1, 'A 态应有『矩形1』');
  assert.ok(b11, 'B 态应有『矩形11』');
  assert.notEqual(a1.normName, b11.normName, '★ 归一名必须不相等');
  assert.equal(a1.normName, '矩形1');
  assert.equal(b11.normName, '矩形11');
});

// ======================================================================
// ★★ BUG #1 回归：嵌套组 bbox 必须递归子组 ★★
// ======================================================================
//
// 背景（QA 独立发现的静默错误）：
//   deriveGroupBox 的注释一直写着「子层是组 -> 递归」，但实现里**没有递归**。
//   子层是组且无 .bbox 时走 boxOfLayer(child) 读组自身坐标 —— 而组自身坐标**恒为 0**（D3）
//   -> w<=0 -> skipped++ -> **整个子组连同其全部后代被整体丢弃**。
//   旧 fixture 恰好让子组完全落在兄弟节点内部，bug 被结构掩盖。
//
// ★ 本文件的断言刻意采用「独立编写的对账算法」★
//   绝不复用 deriveGroupBox 的任何逻辑 —— 否则就是拿同一把尺子量自己
//   （这正是 bug 逃过旧测试的原因：旧测试的「精确对账」用了同样的缺陷算法）。
const {
  referenceUnionBox, buggyNonRecursiveUnionBox,
} = require('./helpers/reference-union');

test('★ BUG#1: 子组比兄弟节点更外扩时，父组 bbox 必须覆盖子组', () => {
  // 复现 QA 给出的最小案例：子组在 (0,0)-(10,10)，兄弟在 (500,400)-(520,420)
  const r = deriveGroupBox([
    { name: '内层组', children: [{ left: 0, top: 0, right: 10, bottom: 10 }] },
    { left: 500, top: 400, right: 520, bottom: 420, name: '独叶' },
  ]);
  assert.deepEqual(r.box, { x: 0, y: 0, w: 520, h: 420 },
    '★ 子组必须参与并集。旧实现返回 (500,400,20x20)（子组被整体跳过）');
  assert.equal(r.used, 2, '两个子层都应参与');
  assert.equal(r.skipped, 0, '不应有子层被跳过');
});

test('★ BUG#1: 三层嵌套，bbox 应递归穿透到最底层叶子', () => {
  const tree = [{
    name: 'L1',
    children: [{
      name: 'L2',
      children: [{
        name: 'L3',
        children: [
          { left: 10, top: 20, right: 40, bottom: 60, name: 'deep1' },
          { left: 100, top: 200, right: 160, bottom: 260, name: 'deep2' },
        ],
      }],
    }],
  }];
  const r = deriveGroupBox(tree);
  assert.deepEqual(r.box, { x: 10, y: 20, w: 150, h: 240 },
    '★ 递归到第三层，并集应为 (10,20)-(160,260)');
});

test('★ BUG#1: 黄金样本里存在「子组更外扩」结构，且实现与独立算法一致', () => {
  const ir = irOf('A');
  const outer = ir.layers.find((l) => l.name === '最外层容器');
  assert.ok(outer, '★ fixture 必须含「最外层容器」结构（这是唯一能暴露该 bug 的形状）');
  assert.deepEqual(
    { x: outer.bbox.x, y: outer.bbox.y, w: outer.bbox.w, h: outer.bbox.h },
    { x: 20, y: 60, w: 480, h: 380 },
    '最外层容器 bbox 应为 (20,60,480x380) = 外扩子组(20,60,240x80) ∪ 窄兄弟组(400,400,100x40)',
  );

  // ★ 用独立算法对全部组逐一核对
  const mismatches = [];
  for (const g of ir.layers.filter((l) => l.type === 'group')) {
    const ref = referenceUnionBox(g.id, ir.layers);
    const norm = ref || { x: 0, y: 0, w: 0, h: 0 };
    const got = g.bbox;
    if (got.x !== norm.x || got.y !== norm.y || got.w !== norm.w || got.h !== norm.h) {
      mismatches.push(`${g.id}/${g.name}: 实现 ${JSON.stringify(got)} vs 独立算法 ${JSON.stringify(norm)}`);
    }
  }
  assert.equal(mismatches.length, 0,
    `★ 实现与独立算法不一致（这正是旧 bug 藏身处）：\n${mismatches.join('\n')}`);
});

test('★ BUG#1: 独立算法能区分「递归」与「不递归」（证明测试不是恒真）', () => {
  const ir = irOf('A');
  const outer = ir.layers.find((l) => l.name === '最外层容器');
  const children = ir.layers.filter((l) => l.parent === outer.id);

  // 递归算法的结果
  const recursive = referenceUnionBox(outer.id, ir.layers);
  // 不递归（模拟旧 bug）—— 用 helpers 里的 buggy 版，两者独立
  const nonRecursive = buggyNonRecursiveUnionBox(outer.id, ir.layers);
  assert.ok(children.some((c) => c.type === 'group'), 'fixture 必须含子组，否则本测试恒真');

  // 两个结果必须不同 —— 否则说明这个 fixture 仍然掩盖 bug，测试无效
  assert.notDeepEqual(recursive, nonRecursive,
    '★ 若两者相同，说明该 fixture 仍掩盖 bug，本回归测试无效，必须换一个 fixture 结构');
  assert.deepEqual(recursive, { x: 20, y: 60, w: 480, h: 380 });
});

test('BUG#1: 极深嵌套不栈溢出（递归深度有上限）', () => {
  // 造一个 400 层深的树。MAX_DEPTH=256 意味着最深处的叶子**到不了**，
  // 于是 used=0、bbox 为零 —— 这是**正确**的降级行为（不崩溃、不返回垃圾）。
  // 这里要断言的是「不抛栈溢出」，不是「仍能算到最深处的叶子」。
  let node = { left: 1, top: 1, right: 5, bottom: 5, name: 'leaf' };
  for (let i = 0; i < 400; i++) node = { name: `g${i}`, children: [node] };
  let r = null;
  assert.doesNotThrow(() => { r = deriveGroupBox([node]); }, '★ 400 层不应栈溢出');
  assert.ok(r, '应返回结果而非抛错');
  assert.ok(typeof r.skipped === 'number' && typeof r.used === 'number');

  // 未超深度的树必须能正常算到叶子
  let shallow = { left: 1, top: 1, right: 5, bottom: 5, name: 'leaf' };
  for (let i = 0; i < 10; i++) shallow = { name: `g${i}`, children: [shallow] };
  const r2 = deriveGroupBox([shallow]);
  assert.deepEqual(r2.box, { x: 1, y: 1, w: 4, h: 4 }, '10 层嵌套应正常穿透到叶子');
  assert.equal(r2.used, 1);
});

test('BUG#1: 组的 _derive 记录应反映递归后的参与情况', () => {
  const ir = irOf('A');
  const outer = ir.layers.find((l) => l.name === '最外层容器');
  assert.ok(outer._derive, '应保留 _derive 明细供人排查');
  assert.equal(outer._derive.usedChildren, 2, '两个子组都应参与');
  assert.equal(outer._derive.skippedChildren, 0);
});

// ======================================================================
// ★ QA 第二轮 P2-1：组 bbox=0 必须有告警（告警覆盖对称性）
// ======================================================================
//
// QA 实测：空组 bbox={0,0,0,0}、_derive={used:0,skipped:0}，但**针对该层 0 条告警**。
// 根因与 BUG#1 同源 —— 告警逻辑只写在叶子分支，组分支漏了。
// 后果：空组在 IR 里静静躺着「bbox=0」，人分不清是「本来就空」还是「推导失败了」，
//       而后者正是 BUG#1 的症状。
const {
  installCanvasShim: _ics,
} = require('../../src/psd/canvas-shim');
const { IrBuilder: _IB } = require('../../src/psd/ir-builder');

/**
 * 造一棵含指定结构的图层树并构建 IR。
 * @param {Object[]} children
 * @returns {Object} DesignIr
 */
function irOfTree(children) {
  _ics();
  const { IrBuilder: IB } = require('../../src/psd/ir-builder');
  return new IB({ withPhash: false }).build({
    psd: { width: 200, height: 200, children },
    psdPath: 'synthetic.psd',
    sha256: 'x',
    slices: [],
  });
}

/**
 * 造一个组。
 * @param {string} name
 * @param {Object[]} children
 * @returns {Object}
 */
function grp(name, children) {
  return { name, children, blendMode: 'pass through' };
}

/**
 * 造一个叶子层。
 * @param {string} name
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {boolean} [hidden]
 * @returns {Object}
 */
function leaf(name, x, y, w, h, hidden) {
  return {
    name, left: x, top: y, right: x + w, bottom: y + h, opacity: 1, hidden: !!hidden,
  };
}

test('★ QA2-P2-1: 空组（无子层）产出 EMPTY_GROUP 告警', () => {
  const ir = irOfTree([grp('空组', [])]);
  const g = ir.layers.find((l) => l.name === '空组');
  assert.ok(g, '应有该组');
  assert.equal(g.bbox.w, 0);
  assert.equal(g.childCount, 0);
  const w = ir.warnings.find((x) => x.layer === g.id && x.code === 'EMPTY_GROUP');
  assert.ok(w, '★ 空组必须有 EMPTY_GROUP 告警（原实现漏了）');
  assert.ok(w.msg.includes('没有任何子层'), w.msg);
  assert.ok(w.msg.includes('人工确认'), '告警应说明需要人工确认');
});

test('★ QA2-P2-1: 子层全被跳过的组产出 GROUP_BBOX_UNRESOLVED（★ 疑似解析故障）', () => {
  // 三个子层全部零尺寸 -> used=0 -> bbox 推导失败
  const ir = irOfTree([grp('全跳过组', [
    leaf('零1', 0, 0, 0, 0),
    leaf('零2', 0, 0, 0, 0),
    leaf('零3', 0, 0, 0, 0),
  ])]);
  const g = ir.layers.find((l) => l.name === '全跳过组');
  assert.equal(g.childCount, 3, '有 3 个子层');
  assert.equal(g._derive.usedChildren, 0, '全部被跳过');
  assert.equal(g.bbox.w, 0);
  const w = ir.warnings.find((x) => x.layer === g.id && x.code === 'GROUP_BBOX_UNRESOLVED');
  assert.ok(w, '★ 子层全被跳过的组必须告警（这是 BUG#1 的症状）');
  assert.ok(w.msg.includes('位置信息不可信'), w.msg);
  // 不得与 EMPTY_GROUP 混淆 —— 两者的处置完全不同
  assert.equal(ir.warnings.find((x) => x.layer === g.id && x.code === 'EMPTY_GROUP'), undefined,
    '有子层却报 EMPTY_GROUP 会误导排查方向');
});

test('★ QA2-P2-1: 部分子层被跳过但仍有有效层 -> 不告警（正常使用）', () => {
  const ir = irOfTree([grp('正常组', [
    leaf('有效', 10, 10, 50, 50),
    leaf('零', 0, 0, 0, 0),
  ])]);
  const g = ir.layers.find((l) => l.name === '正常组');
  assert.equal(g.bbox.w, 50, 'bbox 应等于唯一有效子层');
  assert.equal(g._derive.usedChildren, 1);
  assert.equal(g._derive.skippedChildren, 1);
  assert.equal(ir.warnings.filter((x) => x.layer === g.id
    && ['EMPTY_GROUP', 'GROUP_BBOX_UNRESOLVED'].includes(x.code)).length, 0,
  '部分跳过是正常现象，不该告警制造噪声');
});

test('★ QA2-P2-1: 告警覆盖对称性（叶子与组都有各自的空告警）', () => {
  const ir = irOfTree([
    grp('空组', []),
    grp('全跳过组', [leaf('零', 0, 0, 0, 0)]),
    leaf('零叶子', 0, 0, 0, 0),
  ]);
  const codes = new Set(ir.warnings.map((w) => w.code));
  // 叶子侧
  assert.ok(codes.has('EMPTY_LAYER'), '★ 叶子 bbox=0 应有 EMPTY_LAYER');
  // 组侧（本轮补齐）
  assert.ok(codes.has('EMPTY_GROUP'), '★ 组 childCount=0 应有 EMPTY_GROUP');
  assert.ok(codes.has('GROUP_BBOX_UNRESOLVED'), '★ 组有子层但全跳过应有 GROUP_BBOX_UNRESOLVED');
  // 三种 code 都必须带 layer id（能定位）
  for (const w of ir.warnings) {
    if (['EMPTY_LAYER', 'EMPTY_GROUP', 'GROUP_BBOX_UNRESOLVED'].includes(w.code)) {
      assert.ok(w.layer, `${w.code} 告警必须带 layer id`);
      assert.ok(w.msg.length > 10, `${w.code} 告警内容过短`);
    }
  }
});

test('★ QA2-P2-1: 真实黄金样本里若有零尺寸组也必须告警（端到端不漏）', () => {
  const ir = irOf('A');
  // 遍历所有组，凡 bbox 为 0 的必须有对应告警 —— 这条断言直接对应 QA 的实测方式
  for (const g of ir.layers.filter((l) => l.type === 'group')) {
    if (g.bbox.w === 0 || g.bbox.h === 0) {
      const has = ir.warnings.some((w) => w.layer === g.id
        && ['EMPTY_GROUP', 'GROUP_BBOX_UNRESOLVED'].includes(w.code));
      assert.ok(has, `★ 组『${g.name}』(${g.id}) bbox 为 0 却没有告警`);
    }
  }
});
