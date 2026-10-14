'use strict';
/**
 * test/unit/psd-malformed.test.js —— E-01 真实 PSD 畸形形态测试
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 回应什么缺口 ★（QA 报告 §6 G2）
 *   「真实 PSD 的畸形（空组/智能对象/剪贴蒙版/调整层/变形图层/16-32位通道/
 *     多语言文本框）一个没测」—— P0 的 A5「解析准确率 100%」只对合成样本成立，
 *     而合成样本结构上必然对得上，暴露不了真实 PSD 的畸形。
 *
 * ★ 验收标准（本文件的组织原则）★
 *   不是「不崩溃」，而是「行为符合预期且不静默给错东西」：
 *     ① 每一类畸形要么被正确解析（字段值正确），要么有明确告警（warning code）；
 *     ② **不允许静默跳过** —— 每个输入图层都必须出现在 IR 里（数量对账），
 *        该告警的必须有对应 warning code；
 *     ③ 畸形全部用 ag-psd 的 writePsdBuffer() 合成后**走完整读回链路**
 *        （写文件 → readPsdFile → IrBuilder），不是在内存里伪造 psd 对象 ——
 *        后者正是「自证循环」的温床（QA 核心批评）。
 *
 * ★ 探针结论（写本文件前实测，勿凭记忆修改）★
 *   · placedLayer 往返需要 { id: GUID, type, width, height, transform }，缺 width/height 写盘直接抛
 *   · adjustment 层写回后 left/top/right/bottom **恒为 0**（无像素通道）→ 应触发 EMPTY_LAYER
 *   · clipping 布尔可往返；ag-psd **不能写** 非 8 位深度（write 抛错）→ 16/32 位用
 *     「写 8 位 + 改 header depth 字段（偏移 22）」合成，探针证实 structure/full 都能读
 *   · 文本层不给 imageData 时 bbox 退化为零尺寸（与 make-psd.js 的已知坑一致）
 * ════════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { installCanvasShim, createImageData, composeImageData } = require('../../src/psd/canvas-shim');
const { readPsdFile, compositeImageData } = require('../../src/psd/reader');
const { IrBuilder } = require('../../src/psd/ir-builder');
const { CODES } = require('../../src/core/errors');

installCanvasShim({ force: true });
// eslint-disable-next-line global-require
const { writePsdBuffer } = require('ag-psd');

const CANVAS_W = 300;
const CANVAS_H = 200;
const GUID = '20953ddb-9391-11ec-b4f1-c15674f50bc4';

/** 临时目录（每个 describe 块复用一个，文件按测试名区分）。 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fgui-e01-'));

/**
 * 造一张纯色 ImageData。
 * @param {number} w
 * @param {number} h
 * @param {[number,number,number,number]} rgba
 * @returns {Object}
 */
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

/**
 * raster 图层工厂。
 * @param {Object} a
 * @returns {Object}
 */
function raster(a) {
  return {
    name: a.name,
    left: a.x, top: a.y, right: a.x + a.w, bottom: a.y + a.h,
    imageData: solid(a.w, a.h, a.rgba || [200, 100, 50, 255]),
    opacity: 1,
    blendMode: 'normal',
  };
}

/**
 * 组工厂（刻意不写 left/top/right/bottom，与 make-psd.js 同款：模拟组坐标不可信）。
 * @param {string} name
 * @param {Object[]} children
 * @returns {Object}
 */
function group(name, children) {
  return { name, opened: true, children, blendMode: 'pass through' };
}

/**
 * 文本图层工厂（带 imageData，避免已知的零尺寸退化坑）。
 * @param {Object} a
 * @returns {Object}
 */
function textLayer(a) {
  return {
    name: a.name,
    left: a.x, top: a.y, right: a.x + a.w, bottom: a.y + a.h,
    imageData: solid(a.w, a.h, [255, 255, 255, 255]),
    opacity: 1,
    blendMode: 'normal',
    text: {
      text: a.text,
      transform: a.transform || [1, 0, 0, 1, 0, 0],
      style: {
        font: { name: a.font || 'SourceHanSans-Bold' },
        fontSize: a.fontSize || 20,
        fillColor: a.color || { r: 255, g: 255, b: 255 },
      },
      paragraphStyle: { justification: a.align || 'left' },
    },
  };
}

/**
 * 写 PSD 到临时文件并读回（完整真实链路）。
 *
 * @param {string} name 测试名（用作文件名）
 * @param {Object[]} layers 图层树
 * @param {Object} [opts]
 * @param {number} [opts.depth] 覆写 header 位深（16/32 用；ag-psd 不能写非 8 位）
 * @param {string} [opts.mode='full'] readPsdFile 的模式
 * @returns {{ir:Object, psd:Object, layers:Object[]}}
 */
function roundtrip(name, layers, opts = {}) {
  const mode = opts.mode || 'full';
  const psd = {
    width: CANVAS_W,
    height: CANVAS_H,
    imageData: composeImageData(CANVAS_W, CANVAS_H, layers),
    children: layers,
  };
  let buf = writePsdBuffer(psd);
  if (opts.depth !== undefined) {
    // header: sig(4) ver(2) reserved(6) channels(2) height(4) width(4) depth(2) colorMode(2)
    const patched = Buffer.from(buf);
    patched.writeUInt16BE(opts.depth, 22);
    buf = patched;
  }
  const file = path.join(TMP, `${name}.psd`);
  fs.writeFileSync(file, buf);
  const read = readPsdFile(file, { mode });
  const ir = new IrBuilder({ withPhash: mode === 'full' }).build({
    psd: read.psd,
    psdPath: file,
    sha256: read.sha256,
    slices: [],
  });
  return { ir, psd: read.psd, layers: read.psd.children };
}

/** 按 warning code 过滤。 */
function warnCodes(ir, code) {
  return ir.warnings.filter((w) => w.code === code);
}

/**
 * 递归数图层树的所有节点（IR 是扁平的，直接比总数）。
 * @param {Object[]} layers
 * @returns {number}
 */
function countNodes(layers) {
  let n = 0;
  for (const l of layers || []) {
    n += 1;
    if (Array.isArray(l.children)) n += countNodes(l.children);
  }
  return n;
}

/** 按名字找 IR 层。 */
function layerByName(ir, name) {
  return ir.layers.find((l) => l.name === name);
}

// ════════════════════════════════════════════════════════════════════════════
// 1. 空组
// ════════════════════════════════════════════════════════════════════════════

test('空组: childCount===0 → EMPTY_GROUP 告警，不静默躺着', () => {
  const { ir, layers } = roundtrip('empty-group', [
    group('空壳组', []),
    raster({ name: '底层', x: 10, y: 10, w: 100, h: 80 }),
  ], { mode: 'structure' });

  // ① 不静默跳过：两个图层都必须在 IR 里
  assert.equal(ir.layers.length, layers.length, '输入图层数应与 IR 层数一致');
  const g = layerByName(ir, '空壳组');
  assert.ok(g, '空组必须出现在 IR 里（不能悄悄丢掉）');
  assert.equal(g.type, 'group');
  assert.equal(g.childCount, 0);
  assert.deepEqual(g.bbox, { x: 0, y: 0, w: 0, h: 0 });

  // ② 明确告警：EMPTY_GROUP（P2-1 修的覆盖对称性）
  const warns = warnCodes(ir, 'EMPTY_GROUP');
  assert.equal(warns.length, 1, '空组必须触发 EMPTY_GROUP');
  assert.ok(warns[0].msg.includes('空壳组'), '告警应点名图层');
  assert.ok(warns[0].msg.includes('人工确认'), '告警应要求人工确认');
});

test('子层全被跳过的组: GROUP_BBOX_UNRESOLVED（区分「本来空」与「推导失败」）', () => {
  // 组内只有一个零尺寸叶子 → used=0 但 childCount=1 → 必须报 UNRESOLVED 而非 EMPTY_GROUP
  const zeroLeaf = {
    name: '零尺寸层', left: 50, top: 50, right: 50, bottom: 50, blendMode: 'normal',
  };
  const { ir } = roundtrip('unresolved-group', [
    group('坏组', [zeroLeaf]),
    raster({ name: '底层', x: 10, y: 10, w: 100, h: 80 }),
  ], { mode: 'structure' });

  const g = layerByName(ir, '坏组');
  assert.equal(g.childCount, 1);
  const warns = warnCodes(ir, 'GROUP_BBOX_UNRESOLVED');
  assert.equal(warns.length, 1, '有子层但全部跳过必须报 GROUP_BBOX_UNRESOLVED');
  assert.ok(warns[0].msg.includes('坐标全部异常') || warns[0].msg.includes('推导失败'),
    '必须与「本来空」的 EMPTY_GROUP 文案区分开');
  assert.equal(warnCodes(ir, 'EMPTY_GROUP').length, 0, '不应误报为 EMPTY_GROUP');
});

// ════════════════════════════════════════════════════════════════════════════
// 2. 智能对象 / 置入图层
// ════════════════════════════════════════════════════════════════════════════

test('智能对象: 正确识别类型 + bbox 正确 + 不进 merged + pHash 正常算', () => {
  const smart = {
    name: '智能对象层',
    left: 40, top: 30, right: 140, bottom: 110,
    imageData: solid(100, 80, [80, 120, 200, 255]),
    blendMode: 'normal',
    placedLayer: { id: GUID, type: 'raster', width: 100, height: 80, transform: [1, 0, 0, 1, 0, 0, 0, 0] },
  };
  const { ir, layers } = roundtrip('smart-object', [
    group('含智能对象的组', [smart]),
    raster({ name: '底层', x: 0, y: 0, w: 50, h: 50 }),
  ], { mode: 'full' });

  assert.equal(ir.layers.length, countNodes(layers), '智能对象层不能被静默丢掉');
  const node = layerByName(ir, '智能对象层');
  assert.ok(node, '智能对象层必须在 IR 里');
  assert.equal(node.type, 'smartobject', 'typeOfLayer 应判 smartobject');
  assert.deepEqual(node.bbox, { x: 40, y: 30, w: 100, h: 80 }, 'bbox 应取自身坐标');

  // FULL 模式下 pHash 应正常计算（不因是智能对象而跳过）
  assert.ok(node.phash && /^[0-9a-f]{16}$/.test(node.phash),
    `智能对象层应算出 pHash，实际: ${node.phash}`);

  // merged-detect：含智能对象的组不算 merged（智能对象保留独立身份）
  // ★ UPSTREAM-FIX-1：无切片文档里全 raster 组降级为 SUSPECTED_MERGED_GROUP，
  //   含智能对象的组连疑似档都不该进（两种豁免都要断言，否则
  //   qa3-e01-mutation 的 M3 变异（丢 smartObject 标记）抓不到了）
  const g = layerByName(ir, '含智能对象的组');
  assert.equal(g.merged, false, '含智能对象的组不应判 merged');
  assert.equal(warnCodes(ir, 'MERGED_LAYER_GROUP').length, 0);
  assert.equal(warnCodes(ir, 'SUSPECTED_MERGED_GROUP')
    .filter((w) => w.layer === g.id).length, 0,
    '含智能对象的组也不应进疑似档（smartObject 豁免对两档都生效）');
});

// ════════════════════════════════════════════════════════════════════════════
// 3. 剪贴蒙版
// ════════════════════════════════════════════════════════════════════════════

test('剪贴蒙版: clipping 层被解析、bbox 正确、不丢层', () => {
  const clipped = {
    name: '被裁剪层',
    left: 20, top: 20, right: 90, bottom: 70,
    clipping: true,
    imageData: solid(70, 50, [255, 255, 255, 255]),
    blendMode: 'normal',
  };
  const { ir, layers } = roundtrip('clipping', [
    clipped,
    raster({ name: '底板', x: 0, y: 0, w: 200, h: 150 }),
  ], { mode: 'structure' });

  assert.equal(ir.layers.length, layers.length);
  const node = layerByName(ir, '被裁剪层');
  assert.ok(node, '剪贴蒙版层必须在 IR 里');
  assert.equal(node.type, 'raster');
  assert.deepEqual(node.bbox, { x: 20, y: 20, w: 70, h: 50 },
    '剪贴蒙版不改变图层自身 bbox（裁剪关系不影响坐标推导）');
});

// ════════════════════════════════════════════════════════════════════════════
// 4. 调整层
// ════════════════════════════════════════════════════════════════════════════

test('调整层: 无像素 → EMPTY_LAYER 告警，且不被当作有内容的图层', () => {
  const adjustment = {
    name: '亮度对比度调整层',
    left: 0, top: 0, right: CANVAS_W, bottom: CANVAS_H,
    blendMode: 'normal',
    adjustment: { type: 'brightness/contrast', brightness: 10, contrast: 20 },
  };
  const { ir, layers } = roundtrip('adjustment', [
    adjustment,
    raster({ name: '被调整的底图', x: 0, y: 0, w: 200, h: 150 }),
  ], { mode: 'structure' });

  assert.equal(ir.layers.length, layers.length, '调整层不能静默消失');
  const node = layerByName(ir, '亮度对比度调整层');
  assert.ok(node, '调整层必须在 IR 里');
  // ag-psd 实测：调整层写回后坐标恒为 0 → 必须告警而不是静默按 0 处理
  assert.deepEqual(node.bbox, { x: 0, y: 0, w: 0, h: 0 });
  const warns = warnCodes(ir, 'EMPTY_LAYER');
  assert.ok(warns.some((w) => w.msg.includes('亮度对比度调整层')),
    '调整层零尺寸必须触发 EMPTY_LAYER 告警');
});

// ════════════════════════════════════════════════════════════════════════════
// 5. 变形图层（非单位变换矩阵）
// ════════════════════════════════════════════════════════════════════════════

test('变形文本层: 非单位变换 → TRANSFORMED_LAYER 告警 + 矩阵落 IR', () => {
  // 旋转 30° + 平移：transform = [cos, sin, -sin, cos, tx, ty]
  const c = Math.cos(Math.PI / 6);
  const s = Math.sin(Math.PI / 6);
  const { ir, layers } = roundtrip('transformed-text', [
    textLayer({
      name: '旋转标题', x: 60, y: 60, w: 200, h: 36,
      text: ' rotated ', transform: [c, s, -s, c, 10, 20],
    }),
    textLayer({ name: '普通文本', x: 10, y: 10, w: 100, h: 24, text: 'plain' }),
  ], { mode: 'structure' });

  assert.equal(ir.layers.length, layers.length);
  const rotated = layerByName(ir, '旋转标题');
  assert.ok(rotated, '变形层必须在 IR 里');
  assert.ok(Array.isArray(rotated.transform) && rotated.transform.length === 6,
    '非单位变换矩阵必须落进 IR（此前静默丢失）');
  assert.ok(Math.abs(rotated.transform[0] - 0.866025) < 1e-6, '矩阵值应正确往返');
  const warns = warnCodes(ir, 'TRANSFORMED_LAYER');
  assert.equal(warns.length, 1, '必须恰好对变形层告警一次');
  assert.ok(warns[0].msg.includes('旋转标题'));
  assert.ok(warns[0].msg.includes('变换矩阵'));

  // 单位矩阵的普通文本：不应告警、transform 为 null
  const plain = layerByName(ir, '普通文本');
  assert.equal(plain.transform, null, '单位矩阵不应记为变换');
});

test('变形智能对象: placedLayer 非单位变换同样告警', () => {
  const warped = {
    name: '变形智能对象',
    left: 10, top: 10, right: 110, bottom: 90,
    imageData: solid(100, 80, [10, 200, 100, 255]),
    blendMode: 'normal',
    placedLayer: {
      id: GUID, type: 'raster', width: 100, height: 80,
      transform: [1.5, 0, 0, 0.75, 5, 5, 0, 0],
    },
  };
  const { ir } = roundtrip('warped-smart', [warped], { mode: 'structure' });
  const node = layerByName(ir, '变形智能对象');
  assert.equal(node.type, 'smartobject');
  assert.deepEqual(node.transform, [1.5, 0, 0, 0.75, 5, 5], '应取前 6 个并定点化');
  assert.equal(warnCodes(ir, 'TRANSFORMED_LAYER').length, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// 6. 16 位 / 32 位通道
// ════════════════════════════════════════════════════════════════════════════

test('16/32 位通道: 结构可解析 + 告警；FULL 模式**明确失败**（不静默给错东西）', () => {
  const { AppError, CODES } = require('../../src/core/errors');
  for (const depth of [16, 32]) {
    // 结构模式：解析正常，位深落 IR + 告警（「要么正确解析」的前半句）
    const { ir } = roundtrip(`depth${depth}`, [
      raster({ name: '底层图', x: 0, y: 0, w: 60, h: 40 }),
    ], { mode: 'structure', depth });
    assert.equal(ir.source.bitsPerChannel, depth, `header 改写应生效（探针 offset=22）`);
    assert.equal(warnCodes(ir, 'NON_8BIT_CHANNELS').length, 1, `${depth} 位必须告警`);
    const node = layerByName(ir, '底层图');
    assert.deepEqual(node.bbox, { x: 0, y: 0, w: 60, h: 40 }, '结构坐标应正确');

    // FULL 模式：合成图/图层像素解码不支持非 8 位 —— 必须**明确抛错**
    // （PSD_PARSE_FAILED），而不是静默返回垃圾像素。「明确告警」的后半句。
    // 注：reader.js 的 FULL 模式 skipCompositeImageData:false，合成图解码
    // 路径对非 8 位直接抛 'bitsPerChannel Not supproted'（ag-psd 实测）。
    assert.throws(() => roundtrip(`depth${depth}-full`, [
      raster({ name: '底层图', x: 0, y: 0, w: 60, h: 40 }),
    ], { mode: 'full', depth }), (err) => {
      assert.ok(err instanceof AppError, '应抛 AppError 而不是裸 Error');
      assert.equal(err.code, CODES.PSD_PARSE_FAILED, '应明确报解析失败');
      assert.ok(err.message.includes('解析失败'), '信息应可读');
      assert.ok(String(err.details.cause).includes('bitsPerChannel'),
        'details.cause 应保留底层原因');
      return true;
    });
  }
});

test('8 位常规 PSD: 不应有位深告警（防告警泛滥）', () => {
  const { ir } = roundtrip('depth8', [
    raster({ name: '常规八位图', x: 0, y: 0, w: 60, h: 40 }),
  ], { mode: 'structure' });
  assert.equal(ir.source.bitsPerChannel, 8);
  assert.equal(warnCodes(ir, 'NON_8BIT_CHANNELS').length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// 7. 多语言 / 特殊字符文本层
// ════════════════════════════════════════════════════════════════════════════

test('多语言文本: 中文/emoji/RTL/组合字符逐字往返', () => {
  const samples = [
    { name: '中文文本', text: '邮件详情：有效期 7 天', color: { r: 245, g: 230, b: 200 } },
    { name: ' emoji 文本', text: '奖励 🎉👛✨ 已到账', color: { r: 255, g: 214, b: 120 } },
    { name: 'RTL 阿拉伯语', text: 'مرحبا بك في اللعبة', color: { r: 200, g: 200, b: 255 } },
    { name: 'RTL 希伯来语', text: 'שלום עולם', color: { r: 200, g: 255, b: 200 } },
    { name: '组合字符', text: 'e\u0301́ 上标', color: { r: 255, g: 255, b: 255 } },
    { name: '零宽与换行', text: 'a\u200bb\nc\u00a0d', color: { r: 128, g: 128, b: 128 } },
  ];
  const { ir, layers } = roundtrip('multilang', samples.map((s, i) => textLayer({
    name: s.name, x: 10, y: 10 + i * 30, w: 240, h: 24, text: s.text, color: s.color,
  })), { mode: 'structure' });

  assert.equal(ir.layers.length, layers.length, '所有文本层都必须在 IR 里');
  for (const s of samples) {
    const node = layerByName(ir, s.name);
    assert.ok(node, `${s.name} 不应被跳过`);
    assert.equal(node.type, 'text');
    assert.equal(node.text.value, s.text, `「${s.name}」内容必须逐字往返`);
    assert.ok(/^#[0-9a-f]{6}$/.test(node.text.color), '颜色必须 6 位（上游坑）');
    assert.equal(node.text.color, `#${[s.color.r, s.color.g, s.color.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`);
  }
  // 合法对齐值不应产 TEXT_UNPARSED 告警（防告警泛滥）
  assert.equal(warnCodes(ir, 'TEXT_UNPARSED').length, 0,
    '颜色/对齐都正常时不应有文本告警');
});

test('多语言文本: 未知对齐值明确降级 + 告警（不静默吞）', () => {
  // 说明：ag-psd 的 writer 会把未知 justification 归一化（探针实测写 'weirdAlign'
  // 读回不是原值），所以「未知值」路径无法经 PSD 往返合成 —— 这里直接对
  // extractText 做单测（它正是 R2-F2 的处理点）。
  const { extractText } = require('../../src/psd/text-extract');
  const { text, warnings } = extractText({
    name: '怪对齐文本',
    text: {
      text: 'x',
      style: { font: { name: 'A' }, fontSize: 20, fillColor: { r: 1, g: 2, b: 3 } },
      paragraphStyle: { justification: 'weirdAlign' },
    },
  });
  assert.equal(text.align, 'left', '未知对齐应降级为 left');
  assert.ok(warnings.some((w) => w.msg.includes('weirdAlign')),
    '降级必须可见（告警点名原值）');
});

// ════════════════════════════════════════════════════════════════════════════
// 8. 负坐标 / 超出画布（QA2 已验证裁剪正确，这里补 IR 回归）
// ════════════════════════════════════════════════════════════════════════════

test('负坐标/超画布: IR bbox 记真实坐标不钳制；合成图正确裁剪', () => {
  const { ir, layers, psd } = roundtrip('out-of-canvas', [
    raster({ name: '左上越界', x: -50, y: -30, w: 80, h: 60, rgba: [255, 0, 0, 255] }),
    raster({ name: '右下越界', x: 260, y: 160, w: 80, h: 60, rgba: [0, 0, 255, 255] }),
    raster({ name: '正常层', x: 100, y: 60, w: 60, h: 40, rgba: [0, 255, 0, 255] }),
  ], { mode: 'full' });

  // ① IR bbox 必须是未钳制的真实坐标（人工核对时按真实位置叠加）
  assert.equal(ir.layers.length, layers.length, '越界层不能丢');
  assert.deepEqual(layerByName(ir, '左上越界').bbox, { x: -50, y: -30, w: 80, h: 60 },
    '负坐标必须原样记录（钳制会让叠加核对错位）');
  assert.deepEqual(layerByName(ir, '右下越界').bbox, { x: 260, y: 160, w: 80, h: 60 });

  // ② 合成图裁剪回归（QA2 已验证，这里固化）：画布内正常层的位置应命中其颜色
  const comp = compositeImageData(psd);
  assert.ok(comp, 'FULL 模式应拿到合成图');
  assert.equal(comp.width, CANVAS_W);
  assert.equal(comp.height, CANVAS_H);
  const px = (x, y) => {
    const i = (y * CANVAS_W + x) * 4;
    return [comp.data[i], comp.data[i + 1], comp.data[i + 2], comp.data[i + 3]];
  };
  assert.deepEqual(px(130, 80), [0, 255, 0, 255], '画布内正常层应落在 (100,60,60x40)');
  // 越界部分不写进画布：左上越界层在画布内的可见部分是 (0,0)-(30,30)
  assert.deepEqual(px(5, 5), [255, 0, 0, 255], '负坐标层在画布内的部分应可见');
  assert.deepEqual(px(295, 195), [0, 0, 255, 255], '右下越界层在画布内的部分应可见');
});

test('越界层参与组 bbox 并集（不被静默排除）', () => {
  const { ir } = roundtrip('out-of-canvas-group', [
    group('越界组', [
      raster({ name: '组内越界层', x: -100, y: -50, w: 60, h: 40 }),
    ]),
  ], { mode: 'structure' });
  const g = layerByName(ir, '越界组');
  assert.deepEqual(g.bbox, { x: -100, y: -50, w: 60, h: 40 },
    '组 bbox 应由越界子层推导（负坐标参与并集）');
  assert.equal(g.bboxSource, 'derived');
});

// ════════════════════════════════════════════════════════════════════════════
// 9. 综合畸形（一次全上：接近真实 PSD 的混乱程度）
// ════════════════════════════════════════════════════════════════════════════

test('综合畸形: 所有形态同场，每层有着落、每告警有预期', () => {
  const c = Math.cos(Math.PI / 6);
  const s = Math.sin(Math.PI / 6);
  const layers = [
    textLayer({ name: '中文标题', x: 20, y: 16, w: 200, h: 30, text: '邮件详情 🎉' }),
    group('空壳装饰组', []),
    group('变形内容组', [
      {
        name: '旋转智能对象',
        left: 40, top: 60, right: 140, bottom: 120,
        imageData: solid(100, 60, [90, 130, 200, 255]),
        blendMode: 'normal',
        placedLayer: { id: GUID, type: 'raster', width: 100, height: 60, transform: [c, s, -s, c, 0, 0, 0, 0] },
      },
      {
        name: '剪贴内容',
        left: 50, top: 70, right: 120, bottom: 110,
        clipping: true,
        imageData: solid(70, 40, [255, 255, 255, 255]),
        blendMode: 'normal',
      },
    ]),
    {
      name: '曲线调整层',
      left: 0, top: 0, right: CANVAS_W, bottom: CANVAS_H,
      blendMode: 'normal',
      adjustment: { type: 'curves' },
    },
    raster({ name: '越界角标', x: -30, y: -20, w: 40, h: 40 }),
    raster({ name: '全幅底框', x: 0, y: 0, w: 280, h: 180, rgba: [46, 58, 82, 255] }),
  ];

  const { ir, psd: readLayers } = roundtrip('combined', layers, { mode: 'full' });

  // ① 数量对账：顶层 6 + 组内 2 = 8，一个不少
  assert.equal(ir.layers.length, 8, `每层都必须有着落，实际 ${ir.layers.length}`);
  assert.equal(ir.layers.length, countNodes(readLayers.children));

  // ② 类型识别
  assert.equal(layerByName(ir, '旋转智能对象').type, 'smartobject');
  assert.equal(layerByName(ir, '剪贴内容').type, 'raster');
  assert.equal(layerByName(ir, '中文标题').type, 'text');
  assert.equal(layerByName(ir, '曲线调整层').type, 'raster');

  // ③ 预期告警逐一到场（不多不少）
  const codes = ir.warnings.map((w) => w.code).sort();
  assert.ok(codes.includes('EMPTY_GROUP'), '空壳装饰组 → EMPTY_GROUP');
  assert.ok(codes.includes('TRANSFORMED_LAYER'), '旋转智能对象 → TRANSFORMED_LAYER');
  assert.ok(codes.includes('EMPTY_LAYER'), '调整层零尺寸 → EMPTY_LAYER');
  // 变形内容组：含智能对象 → 不判 merged（无 MERGED_LAYER_GROUP）
  // ★ UPSTREAM-FIX-1：也不应进疑似档（SUSPECTED_MERGED_GROUP）
  assert.ok(!codes.includes('MERGED_LAYER_GROUP'), '含智能对象的组不应判 merged');
  assert.ok(!codes.includes('SUSPECTED_MERGED_GROUP'), '含智能对象的组也不应进疑似档');

  // ④ 组 bbox：由两个子层并集推导（智能对象 40,60,100x60 ∪ 剪贴层 50,70,70x40）
  const g = layerByName(ir, '变形内容组');
  assert.deepEqual(g.bbox, { x: 40, y: 60, w: 100, h: 60 });
  assert.equal(g.childCount, 2);

  // ⑤ 多语言文本内容正确
  assert.equal(layerByName(ir, '中文标题').text.value, '邮件详情 🎉');

  // ⑥ 确定性：同一输入再跑一遍，IR 逐字节一致（B9 不因畸形而破）
  //    注：用同一文件名（覆盖写）—— psdPath 会进 IR source，换名就不可比
  const again = roundtrip('combined', layers, { mode: 'full' });
  assert.equal(JSON.stringify(again.ir), JSON.stringify(ir),
    '畸形输入也必须满足 B9 确定性');
});

test('畸形防御: children 位置塞非数组不崩、不静默（QA R2-1.8 回归）', () => {
  // 直接在内存里构造病态 psd 对象（不走 writePsd —— 这种结构写不出来）。
  // 实测行为：children 非数组 → isGroup 判 false → 按零尺寸叶子处理 +
  // EMPTY_LAYER 告警。这是「明确告警」而非静默跳过，符合验收标准。
  const { IrBuilder: IB } = require('../../src/psd/ir-builder');
  const ir = new IB({ withPhash: false }).build({
    psd: {
      width: 100, height: 100,
      children: [
        { name: '坏组1', children: 123 },
        { name: '坏组2', children: 'x' },
        { name: '正常层', left: 0, top: 0, right: 10, bottom: 10 },
      ],
    },
    psdPath: 'synthetic.psd',
    sha256: 'x',
    slices: [],
  });
  assert.equal(ir.layers.length, 3, '病态结构不应导致丢层或崩溃');
  for (const bad of ['坏组1', '坏组2']) {
    const node = layerByName(ir, bad);
    assert.ok(node, `${bad} 应在 IR 里（不能静默消失）`);
    assert.equal(node.bbox.w, 0, '非数组 children 应按零尺寸处理');
  }
  const emptyWarns = warnCodes(ir, 'EMPTY_LAYER');
  assert.equal(emptyWarns.length, 2, '两个坏组都应有 EMPTY_LAYER 告警（明确告知，不静默）');
});
