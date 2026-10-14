'use strict';
/**
 * test/unit/canvas-shim.test.js —— 坑 1 的验证（D2：ag-psd 依赖 canvas）
 *
 * ★ 验收标准 6：断言真的能从合成 PSD 拿到**非空 imageData** ★
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  createImageData, createShimCanvas, installCanvasShim, isInstalled,
  imageDataToBuffer, solidImageData,
} = require('../../src/psd/canvas-shim');
const { readPsdFile, extractSlices, compositeImageData, layerImageData, MODE } = require('../../src/psd/reader');

const PSD_A = path.resolve(__dirname, '../fixtures/golden/state_A.psd');

test('shim: createImageData 产出可用的 RGBA 容器', () => {
  const img = createImageData(4, 3);
  assert.equal(img.width, 4);
  assert.equal(img.height, 3);
  assert.equal(img.data.length, 4 * 3 * 4);
  assert.ok(img.data instanceof Uint8ClampedArray);
});

test('shim: putImageData -> getImageData 往返一致', () => {
  const canvas = createShimCanvas(8, 6);
  const ctx = canvas.getContext('2d');
  const img = createImageData(8, 6);
  for (let i = 0; i < 8 * 6; i++) {
    img.data[i * 4] = i % 256;
    img.data[i * 4 + 1] = 100;
    img.data[i * 4 + 2] = 200;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const got = ctx.getImageData(0, 0, 8, 6);
  assert.equal(got.width, 8);
  assert.equal(got.height, 6);
  for (let i = 0; i < 8 * 6 * 4; i++) {
    assert.equal(got.data[i], img.data[i], `字节 ${i} 应一致`);
  }
  assert.ok(canvas.__isShim, '应标记为垫片');
  assert.ok(canvas.__shimStats.put >= 1);
});

test('shim: getImageData 支持区域偏移', () => {
  const canvas = createShimCanvas(4, 4);
  const ctx = canvas.getContext('2d');
  const img = solidImageData(4, 4, [10, 20, 30, 255]);
  ctx.putImageData(img, 0, 0);
  const sub = ctx.getImageData(1, 1, 2, 2);
  assert.equal(sub.width, 2);
  assert.equal(sub.data.length, 2 * 2 * 4);
  assert.equal(sub.data[0], 10);
  assert.equal(sub.data[3], 255, 'alpha 应为 255');
});

test('shim: drawImage 支持 ImageData 源（合成预览路径）', () => {
  const canvas = createShimCanvas(4, 4);
  const ctx = canvas.getContext('2d');
  const src = solidImageData(4, 4, [200, 100, 50, 255]);
  ctx.drawImage(src, 0, 0);
  const got = ctx.getImageData(0, 0, 4, 4);
  assert.equal(got.data[0], 200);
  assert.equal(got.data[1], 100);
  assert.equal(got.data[2], 50);
  assert.ok(canvas.__shimStats.draw >= 1);
});

test('shim: 只支持 2d context（其他返回 null，与浏览器一致）', () => {
  const canvas = createShimCanvas(2, 2);
  assert.equal(canvas.getContext('webgl'), null);
  assert.ok(canvas.getContext('2d'));
});

test('shim: installCanvasShim 幂等', () => {
  const a = installCanvasShim();
  const b = installCanvasShim();
  assert.equal(a.initialized, true);
  assert.equal(b.initialized, true);
  assert.equal(isInstalled(), true);
  assert.equal(typeof a.agPsd.readPsd, 'function');
});

test('imageDataToBuffer: 正确导出底层字节', () => {
  const img = solidImageData(2, 2, [1, 2, 3, 4]);
  const buf = imageDataToBuffer(img);
  assert.equal(buf.length, 2 * 2 * 4);
  assert.equal(buf[0], 1);
  assert.equal(buf[3], 4);
});

// ======================================================================
// ★ 核心验收：不装原生 canvas 也能从合成 PSD 拿到非空 imageData
// ======================================================================
test('★ 坑1: FULL 模式能从合成 PSD 拿到图层与合成图的非空 imageData', () => {
  installCanvasShim({ force: true });
  const parsed = readPsdFile(PSD_A, { mode: MODE.FULL });

  // ---- 合成图 ----
  const comp = compositeImageData(parsed.psd);
  assert.ok(comp, '合成图 imageData 不应为空');
  assert.equal(comp.width, 720, '合成图宽度应等于画布宽');
  assert.equal(comp.height, 560);
  assert.ok(comp.data.length >= 720 * 560 * 4, '合成图应有足够的像素数据');
  // 非全零：确认真的解出了像素，而不是空壳
  let nonZero = 0;
  for (let i = 3; i < comp.data.length; i += 4) {
    if (comp.data[i] !== 0) { nonZero++; if (nonZero > 10) break; }
  }
  assert.ok(nonZero > 0, '合成图 alpha 通道不应全为 0');

  // ---- 图层 ----
  const rasterLayers = [];
  const collect = (nodes) => {
    for (const n of nodes || []) {
      if (Array.isArray(n.children)) collect(n.children);
      else rasterLayers.push(n);
    }
  };
  collect(parsed.psd.children);
  assert.ok(rasterLayers.length > 0, '应有 raster 图层');

  let withImage = 0;
  for (const l of rasterLayers) {
    const img = layerImageData(l);
    if (img && img.data && img.data.length === img.width * img.height * 4 && img.width > 0) withImage++;
  }
  assert.ok(withImage > 0,
    `★ 关键断言：应有图层的 imageData 非空（实测 ${withImage}/${rasterLayers.length}）`);
});

test('坑1: STRUCTURE 模式不解像素但结构完整（快速路径）', () => {
  installCanvasShim();
  const parsed = readPsdFile(PSD_A, { mode: MODE.STRUCTURE });
  assert.equal(parsed.mode, 'structure');
  assert.ok(Array.isArray(parsed.psd.children));
  assert.ok(parsed.psd.children.length > 0);
  // structure 模式应无图层像素
  assert.equal(layerImageData(parsed.psd.children[0]), null);
});

test('reader: 切片挂在 imageResources.slices 下（实测坑）', () => {
  installCanvasShim();
  const parsed = readPsdFile(PSD_A, { mode: MODE.STRUCTURE });
  // 明确断言这个位置是对的 —— 挂到 psd.slices 上读写都不生效
  assert.ok(parsed.psd.imageResources, 'imageResources 应存在');
  assert.ok(Array.isArray(parsed.psd.imageResources.slices), 'slices 应挂在 imageResources 下');

  const slices = extractSlices(parsed.psd);
  assert.equal(slices.length, 2);
  const names = slices.map((s) => s.name).sort();
  assert.deepEqual(names, ['btn_close', 'mail_bg']);
  const bg = slices.find((s) => s.name === 'mail_bg');
  assert.deepEqual(bg.rect, { x: 120, y: 80, w: 480, h: 320 });
});

test('reader: psdSha256 稳定（同文件两次读出同一指纹）', () => {
  installCanvasShim();
  const a = readPsdFile(PSD_A, { mode: MODE.STRUCTURE });
  const b = readPsdFile(PSD_A, { mode: MODE.STRUCTURE });
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.sha256.length, 64);
});

test('reader: 文件不存在抛 FILE_NOT_FOUND', () => {
  assert.throws(() => readPsdFile(path.join(__dirname, 'nope.psd')), (err) => {
    assert.equal(err.code, 'FILE_NOT_FOUND');
    assert.equal(err.exitCode, 1);
    return true;
  });
});

// ======================================================================
// ★★ BUG #2 回归：合成图必须有真实内容，不能是全黑 ★★
// ======================================================================
//
// 背景（QA 独立发现）：
//   旧断言是 `if (comp.data[i + 3] !== 0) nonZero++` —— **只看 alpha**。
//   纯黑不透明图的 alpha 恰好全为 255，所以这个断言**必然通过**。
//   实测当时合成图是 0/403200 非黑像素、只有 1 种颜色（0,0,0,255）。
//   这是典型的「断言了非空壳，没断言正确性」。
//
// 根因（不是 shim 的问题！）：ag-psd 的 writer **不会自动合成图层**，
//   只写你给的 `psd.imageData`；不填就读回一张全黑图。
//   修复在 fixture（make-psd.js 的 composeImage）+ 读端（ir-overlay 的 validateComposite）。
const { validateComposite } = require('../../src/report/ir-overlay');

test('★ BUG#2: 合成图 RGB 非黑像素占比 > 0（不能再是全黑图）', () => {
  installCanvasShim({ force: true });
  const parsed = readPsdFile(PSD_A, { mode: MODE.FULL });
  const comp = compositeImageData(parsed.psd);
  assert.ok(comp, '应有合成图');

  // ★ 关键：查 RGB 三个通道，**不是只查 alpha**
  let nonBlack = 0;
  for (let i = 0; i < comp.data.length; i += 4) {
    if (comp.data[i] || comp.data[i + 1] || comp.data[i + 2]) nonBlack++;
  }
  const ratio = nonBlack / (comp.width * comp.height);
  assert.ok(ratio > 0.01,
    `★ 合成图 RGB 非黑像素应 > 1%，实得 ${(ratio * 100).toFixed(2)}%`
    + '（0% 说明 ag-psd 未提供 psd.imageData，合成图是全黑的）');
});

test('★ BUG#2: 合成图颜色数 > 1（不能是纯色块）', () => {
  installCanvasShim({ force: true });
  const parsed = readPsdFile(PSD_A, { mode: MODE.FULL });
  const comp = compositeImageData(parsed.psd);
  const colors = new Set();
  for (let i = 0; i < comp.data.length && colors.size < 32; i += 4) {
    colors.add(`${comp.data[i] >> 3},${comp.data[i + 1] >> 3},${comp.data[i + 2] >> 3}`);
  }
  assert.ok(colors.size > 3,
    `★ 合成图应含多种颜色，实得 ${colors.size} 种（1 种 = 纯色块，核对价值为零）`);
});

test('★ BUG#2: 合成图内已知位置的像素值与写入的图层颜色一致', () => {
  installCanvasShim({ force: true });
  const parsed = readPsdFile(PSD_A, { mode: MODE.FULL });
  const comp = compositeImageData(parsed.psd);

  // 底框 `矩形11` 在 (120,80)-(600,400)，颜色 C.bgPanel = rgb(46,58,82)。
  // 取 x=122（刚好在底框内、但在装饰边框(128,88)与标题条之外）、y=300 处。
  // ★ 这里刻意选「只被底框覆盖」的点：若选了被装饰边框覆盖的点，
  //   读到的是上层颜色，测试就会给出误导性的结论。
  const probe = (x, y) => {
    const p = ((y * comp.width) + x) * 4;
    return [comp.data[p], comp.data[p + 1], comp.data[p + 2], comp.data[p + 3]];
  };
  const [r, g, b, a] = probe(122, 300);
  assert.ok(a > 0, '该点应不透明');
  assert.ok(Math.abs(r - 46) < 12 && Math.abs(g - 58) < 12 && Math.abs(b - 82) < 12,
    `★ (122,300) 应精确等于底框色 rgb(46,58,82)，实得 rgb(${r},${g},${b})`
    + '（若读到别的颜色，说明图层顺序反了：全幅底框盖在了上层）');

  // 装饰边框 (128,88)-(592,392)，颜色 C.deco = rgb(90,120,170)
  const [dr, dg, db] = probe(300, 300);
  assert.ok(Math.abs(dr - 90) < 12 && Math.abs(dg - 120) < 12 && Math.abs(db - 170) < 12,
    `★ (300,300) 应落在装饰边框 rgb(90,120,170)，实得 rgb(${dr},${dg},${db})`);

  // 关闭按钮 `图层129` 在 (552,92)-(584,124)，颜色 C.closeBtn = rgb(200,90,90)
  const [cr, cg, cb] = probe(560, 100);
  assert.ok(Math.abs(cr - 200) < 12 && Math.abs(cg - 90) < 12 && Math.abs(cb - 90) < 12,
    `★ (560,100) 应落在关闭按钮 rgb(200,90,90)，实得 rgb(${cr},${cg},${cb})`);
});

test('★ BUG#2: 合成图必须包含各图层写入的颜色（而非只有底层色）', () => {
  installCanvasShim({ force: true });
  const parsed = readPsdFile(PSD_A, { mode: MODE.FULL });
  const comp = compositeImageData(parsed.psd);
  // 关闭按钮与文本的颜色最「上层」，若图层顺序写反它们会被底框盖掉
  const want = [
    [200, 90, 90, '关闭按钮'],
    [226, 232, 244, '正文文本'],
    [90, 120, 170, '装饰边框'],
    [46, 58, 82, '弹窗底框'],
  ];
  const found = new Set();
  for (let i = 0; i < comp.data.length; i += 4) {
    found.add(`${comp.data[i]},${comp.data[i + 1]},${comp.data[i + 2]}`);
  }
  const missing = want
    .filter(([r, g, b]) => ![...found].some((c) => {
      const p = c.split(',').map(Number);
      return Math.abs(p[0] - r) < 10 && Math.abs(p[1] - g) < 10 && Math.abs(p[2] - b) < 10;
    }))
    .map(([, , , name]) => name);
  assert.equal(missing.length, 0,
    `★ 合成图缺少这些图层的颜色：${missing.join('、')} —— 通常是图层顺序反了（上层被盖住）`);
});

test('★ BUG#2: validateComposite 能识别全黑图（读端防御）', () => {
  const allBlack = {
    width: 8, height: 8,
    data: new Uint8ClampedArray(8 * 8 * 4).fill(0),
  };
  for (let i = 3; i < allBlack.data.length; i += 4) allBlack.data[i] = 255; // alpha 全不透明
  const r = validateComposite(allBlack);
  assert.equal(r.usable, false, '★ 全黑图必须判为不可用');
  assert.ok(r.reason.includes('全黑'), r.reason);
  // alpha 恒 255 也不能蒙混过关 —— 这正是旧断言查不出来的点
  assert.equal(r.stats.alphaRatio, 1, 'alpha 确实全不透明，但仍然不可用');
  assert.equal(r.stats.nonBlackRatio, 0);
});

test('★ BUG#2: validateComposite 能识别全透明图', () => {
  const allTransparent = {
    width: 8, height: 8,
    data: new Uint8ClampedArray(8 * 8 * 4), // alpha 恒 0
  };
  const r = validateComposite(allTransparent);
  assert.equal(r.usable, false, '全透明必须拦截');
  assert.equal(r.kind, 'degenerate');
});

test('★ BUG#2（QA2 修订）: 纯色图**不再**判不可用 —— 单色是合法内容', () => {
  // ★ 这条断言在 QA 第二轮被推翻并修订 ★
  //   原断言：'纯色块核对价值为零，应判不可用'
  //   QA 实测：单色图在真实素材里 legitimately 存在（纯色分割线/占位块/底框），
  //   且真实最常见的「底框+按钮」才是 2 色、根本不受影响。
  //   拦掉单色图没有收益（人仍能拿它核对相对位置），只有误报代价。
  const singleColor = {
    width: 8, height: 8,
    data: new Uint8ClampedArray(8 * 8 * 4),
  };
  for (let i = 0; i < singleColor.data.length; i += 4) {
    singleColor.data[i] = 100; singleColor.data[i + 1] = 100;
    singleColor.data[i + 2] = 100; singleColor.data[i + 3] = 255;
  }
  const r = validateComposite(singleColor);
  assert.equal(r.usable, true, '★ 单色图应放行（QA2 P2-2 修订：单色≠纯色）');
  assert.equal(r.kind, 'lowInfo');
  assert.ok(r.note.includes('不是错误'));
});

test('★ BUG#2: validateComposite 对正常合成图判为可用', () => {
  installCanvasShim({ force: true });
  const parsed = readPsdFile(PSD_A, { mode: MODE.FULL });
  const r = validateComposite(compositeImageData(parsed.psd));
  assert.equal(r.usable, true, `应判可用，实际原因: ${r.reason}`);
  assert.equal(r.reason, '');
  assert.ok(r.stats.distinctColors > 3);
});

test('★ BUG#2: validateComposite 对 null 不崩且给出可读理由', () => {
  const r = validateComposite(null);
  assert.equal(r.usable, false);
  assert.ok(r.reason.length > 10);
});

test('★ BUG#2: ir_overlay 底图不可用时必须显式警告（不给纯黑图）', async () => {
  const { renderIrOverlay } = require('../../src/report/ir-overlay');
  const ir = {
    source: { canvas: { w: 100, h: 100 }, psdPath: 'x.psd' },
    layers: [{
      id: 'L001', name: 'a', parent: null, type: 'raster',
      bbox: { x: 10, y: 10, w: 50, h: 50 }, bboxSource: 'own',
      visible: true, opacity: 1, merged: false, childCount: 0, sliceName: null,
    }],
    warnings: [], slices: [],
  };
  // 传入一个合成图全黑的 psd
  const fakePsd = {
    imageData: {
      width: 100, height: 100,
      data: (() => {
        const d = new Uint8ClampedArray(100 * 100 * 4);
        for (let i = 3; i < d.length; i += 4) d[i] = 255;
        return d;
      })(),
    },
  };
  const out = await renderIrOverlay({ ir, psd: fakePsd });
  assert.equal(out.compositeUsable, false, '应判底图不可用');
  assert.ok(out.compositeWarning.includes('全黑'), out.compositeWarning);
  assert.ok(out.html.includes('合成底图不可用'), '★ 页面必须显式警告，不能静默给错东西');
  assert.ok(!out.html.includes('data:image/png;base64,'), '★ 不可用时不应内联底图');
});

// ======================================================================
// ★ QA 第二轮 P2-2：单色图不应误报（区分「退化失败」与「信息量少但合法」）
// ======================================================================
//
// QA 实测的误报边界：
//   全黑（原 BUG）    1 色 -> 正确拦截 ✅
//   纯白单色          1 色 -> 误报 ⚠️
//   全透明            1 色 -> 正确拦截 ✅
//   两色（底框+按钮）  2 色 -> 不误报 ✅   ← 真实最常见形态
//   三色              3 色 -> 正常
//
// 结论：**误报边界是「单色图」而非「纯色图」**。
// 单色图在真实素材里 legitimately 存在（纯色分割线、纯色占位块、纯色底框），
// 拦掉它没有收益 —— 人仍能拿它核对 bbox 相对位置，只是信息量少一点。
// 故改为：放行 + 附提示（lowInfo），不与「真失败」（degenerate）同级。

/**
 * 造一张指定颜色分布的合成图。
 * @param {number} w
 * @param {number} h
 * @param {function(number,number):number[]} shader 返回 [r,g,b,a]
 * @returns {Object}
 */
function compositeOf(w, h, shader) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const [r, g, b, a] = shader(x, y);
      data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = a;
    }
  }
  return { width: w, height: h, data };
}

test('★ QA2-P2-2: 纯白单色图应放行（附 lowInfo 提示），不再误报', () => {
  const img = compositeOf(32, 32, () => [255, 255, 255, 255]);
  const r = validateComposite(img);
  assert.equal(r.usable, true, '★ 纯白单色图是合法内容，不该被拦（原实现误报）');
  assert.equal(r.kind, 'lowInfo', '应标为 lowInfo（信息量少但合法）');
  assert.ok(r.note.length > 10, 'lowInfo 必须给出说明');
  assert.ok(r.note.includes('不是错误'), '应明确说明这不是错误，避免误导');
  assert.equal(r.reason, '', 'lowInfo 不该带 reason（那是错误才用的）');
});

test('★ QA2-P2-2: 纯色单色（灰）同样放行', () => {
  const r = validateComposite(compositeOf(32, 32, () => [128, 128, 128, 255]));
  assert.equal(r.usable, true);
  assert.equal(r.kind, 'lowInfo');
});

test('★ QA2-P2-2: 真失败（全黑/全透明）仍必须拦截，且 kind=degenerate', () => {
  // 全黑但 alpha 不透明 —— 就是原 BUG#2 的形态
  const allBlack = compositeOf(16, 16, () => [0, 0, 0, 255]);
  const r1 = validateComposite(allBlack);
  assert.equal(r1.usable, false, '★ 全黑图必须拦截');
  assert.equal(r1.kind, 'degenerate', '应标为 degenerate（内容是错的）');
  assert.ok(r1.reason.includes('全黑'));

  // 全透明
  const allClear = compositeOf(16, 16, () => [0, 0, 0, 0]);
  const r2 = validateComposite(allClear);
  assert.equal(r2.usable, false, '全透明必须拦截');
  assert.equal(r2.kind, 'degenerate');
  assert.ok(r2.reason.includes('全透明'));
});

test('★ QA2-P2-2: 两色（真实最常见的底框+按钮）正常放行', () => {
  // 左半纯色底框，右半纯色按钮 —— QA 实测这是最常见形态，绝不能误报
  const img = compositeOf(32, 32, (x) => (x < 16 ? [60, 70, 90, 255] : [200, 90, 90, 255]));
  const r = validateComposite(img);
  assert.equal(r.usable, true, '★ 两色图必须放行');
  assert.equal(r.kind, 'ok', '两色属正常信息量，不该是 lowInfo');
  assert.equal(r.note, '');
});

test('★ QA2-P2-2: 三色及以上正常放行', () => {
  const img = compositeOf(32, 32, (x) => {
    if (x < 10) return [60, 70, 90, 255];
    if (x < 20) return [200, 90, 90, 255];
    return [100, 200, 120, 255];
  });
  const r = validateComposite(img);
  assert.equal(r.usable, true);
  assert.equal(r.kind, 'ok');
});

test('★ QA2-P2-2: null 仍判不可用且不崩', () => {
  const r = validateComposite(null);
  assert.equal(r.usable, false);
  assert.ok(r.reason.length > 10);
});

test('★ QA2-P2-2: ir_overlay 对单色图显示底图 + 提示，而非隐藏', async () => {
  const { renderIrOverlay } = require('../../src/report/ir-overlay');
  const ir = {
    source: { canvas: { w: 100, h: 100 }, psdPath: 'x.psd' },
    layers: [{
      id: 'L001', name: 'a', parent: null, type: 'raster',
      bbox: { x: 10, y: 10, w: 50, h: 50 }, bboxSource: 'own',
      visible: true, opacity: 1, merged: false, childCount: 0, sliceName: null,
    }],
    warnings: [], slices: [],
  };
  // 单色合成图
  const single = {
    imageData: compositeOf(100, 100, () => [128, 128, 128, 255]),
  };
  const out = await renderIrOverlay({ ir, psd: single });
  assert.equal(out.compositeUsable, true, '★ 单色图应可用');
  assert.equal(out.compositeKind, 'lowInfo');
  assert.ok(out.compositeNote.length > 10, '应有提示');
  assert.ok(out.html.includes('data:image/png;base64,'), '★ 单色图应照常内联底图');
  assert.ok(out.html.includes('单色'), '页面应显示单色提示');
  assert.ok(!out.html.includes('合成底图不可用'), '单色图不该显示「底图不可用」');

  // 对照：全黑图仍必须隐藏底图
  const black = { imageData: compositeOf(100, 100, () => [0, 0, 0, 255]) };
  const out2 = await renderIrOverlay({ ir, psd: black });
  assert.equal(out2.compositeUsable, false, '全黑图仍必须拦截');
  assert.ok(out2.html.includes('合成底图不可用'));
  assert.ok(!out2.html.includes('data:image/png;base64,'), '全黑图不得内联底图');
});
