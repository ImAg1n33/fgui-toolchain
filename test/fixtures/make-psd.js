'use strict';
/**
 * test/fixtures/make-psd.js —— ★ 合成黄金样本 PSD（破解「本机没有真实素材」的死结）
 *
 * 用 ag-psd 的 writePsdBuffer() 生成两份「邮件弹窗」PSD，模拟多状态界面：
 *   state_A.psd  状态 A：普通邮件（弹窗底框 / 关闭按钮 / 标题 / 正文 / 时效）
 *   state_B.psd  状态 B：带奖励（+ 3 个奖励物品 + 领取按钮，重复素材被合并成一个组）
 *
 * ★ 刻意埋入的 4 个测试要点 ★
 *   1. **嵌套组**：`弹窗框架 > 组 1200 > 装饰边框`，验证 IrBuilder 的父子关系与
 *      deriveGroupBox() 的递归并集。
 *   2. **坑 2 触发**：ag-psd 读回时**组自身 left/top/right/bottom 恒为 0**。
 *      组 bbox 必须由子层并集推导。单测断言 `bboxSource==='derived'` 且并集正确 ——
 *      如果实现直接采信组自身坐标，拿到 0,0,0,0，测试就会红。
 *   3. **命名陷阱**：`矩形1` 与 `矩形11` 同时存在于同一份 PSD 中，
 *      且在 B 态里 `矩形11` 被移动了位置。验证 K5 与 L2 匹配不会前缀误匹配。
 *   4. **合并组**：B 态的 `组1200拷贝` 内含 3 个纯 raster 子层且无一携带 slice，
 *      验证 merged-detect 把它标 merged=true 并产出 lost_info 警告（A6：漏报=后面必猜错）。
 *
 * 另外包含：
 *   · 文本图层（标题 + 正文），验证 text-extract 的内容/字号/颜色/对齐抽取
 *   · 导出切片（imageResources.slices），验证 L1 最强匹配通道
 *   · A/B 之间存在 MOVE（矩形11 移动）、RESIZE（弹窗底框变宽）、RESTYLE（正文颜色变化）
 */

const fs = require('fs');
const path = require('path');
const {
  installCanvasShim, createImageData, composeImageData,
} = require('../../src/psd/canvas-shim');
const { round6 } = require('../../src/core/determinism');

/** 输出目录（相对项目根）。 */
const OUT_DIR = path.resolve(__dirname, 'golden');

/** 画布尺寸。 */
const CANVAS_W = 720;
const CANVAS_H = 560;

/**
 * 造一张纯色 ImageData。
 * @param {number} w
 * @param {number} h
 * @param {[number,number,number,number]} rgba
 * @returns {Object} ag-psd 的 PixelData
 */
function solid(w, h, rgba) {
  const img = createImageData(w, h);
  const [r, g, b, a] = rgba;
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = a;
  }
  return img;
}

/**
 * 造一个 raster 图层。
 * @param {Object} a
 * @param {string} a.name 图层名（画师原名）
 * @param {number} a.x
 * @param {number} a.y
 * @param {number} a.w
 * @param {number} a.h
 * @param {[number,number,number,number]} a.rgba
 * @param {number} [a.opacity=1]
 * @param {boolean} [a.hidden=false]
 * @returns {Object} ag-psd Layer
 */
function raster(a) {
  return {
    name: a.name,
    left: a.x,
    top: a.y,
    right: a.x + a.w,
    bottom: a.y + a.h,
    imageData: solid(a.w, a.h, a.rgba),
    opacity: a.opacity === undefined ? 1 : a.opacity,
    hidden: !!a.hidden,
    blendMode: 'normal',
  };
}

/**
 * 造一个文本图层。
 *
 * ⚠ 实测坑：ag-psd 写纯文本图层时**不携带像素**，读回的 left/top/right/bottom 会退化成
 *   left===right、top===bottom（零尺寸）。要让 bbox 正确，必须同时给 imageData。
 *   所以这里既写 text 又写 imageData（画师在 Photoshop 里看到的也是这样：
 *   文本图层有自己的栅格化预览）。
 *
 * @param {Object} a
 * @param {string} a.name
 * @param {number} a.x
 * @param {number} a.y
 * @param {number} a.w
 * @param {number} a.h
 * @param {string} a.text
 * @param {number} a.fontSize
 * @param {[number,number,number]} a.color RGB 0..255
 * @param {string} a.align left|center|right
 * @returns {Object}
 */
function textLayer(a) {
  return {
    name: a.name,
    left: a.x,
    top: a.y,
    right: a.x + a.w,
    bottom: a.y + a.h,
    imageData: solid(a.w, a.h, [a.color[0], a.color[1], a.color[2], 255]),
    opacity: 1,
    blendMode: 'normal',
    text: {
      text: a.text,
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        font: { name: a.font || 'SourceHanSans-Bold' },
        fontSize: a.fontSize,
        // fillColor 会被 ag-psd 读回成 0..255 的浮点，text-extract 负责取整
        fillColor: { r: a.color[0], g: a.color[1], b: a.color[2] },
      },
      paragraphStyle: { justification: a.align },
    },
  };
}

/**
 * 造一个组。
 * @param {Object} a
 * @param {string} a.name
 * @param {Object[]} a.children
 * @returns {Object}
 */
function group(a) {
  return {
    name: a.name,
    opened: true,
    // 刻意**不写** left/top/right/bottom —— 模拟真实 PSD 里组坐标不可信的情况。
    // 若实现错误地采信组自身坐标，本函数产生的组在读回后是 0,0,0,0，
    // deriveGroupBox() 的单测会立刻失败（这正是坑 2 的价值）。
    children: a.children,
    blendMode: 'pass through',
  };
}

/**
 * 造一份切片资源（ag-psd 实测：切片挂在 `psd.imageResources.slices` 下，
 * **不是** `psd.slices`；挂错位置读写都不生效）。
 * @param {{name:string, x:number, y:number, w:number, h:number}[]} items
 * @param {string} groupName
 * @returns {Object} imageResources 片段
 */
function sliceResource(items, groupName) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const slices = items.map((it, i) => {
    minX = Math.min(minX, it.x);
    minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x + it.w);
    maxY = Math.max(maxY, it.y + it.h);
    return {
      id: i + 1,
      groupId: 0,
      origin: 'userGenerated',
      associatedLayerId: 0,
      name: it.name,
      type: 'image',
      bounds: { left: it.x, top: it.y, right: it.x + it.w, bottom: it.y + it.h },
      url: '',
      target: '',
      message: '',
      altTag: '',
      cellTextIsHTML: false,
      cellText: '',
      horizontalAlignment: 'default',
      verticalAlignment: 'default',
      backgroundColorType: 'none',
      backgroundColor: { r: 0, g: 0, b: 0, a: 0 },
    };
  });
  return {
    slices: [{
      bounds: { left: minX, top: minY, right: maxX, bottom: maxY },
      groupName,
      slices,
    }],
  };
}

/** 配色（与 make-assets.js 的调性一致，便于交叉验证）。 */
const C = {
  bgPanel: [46, 58, 82, 255],
  border: [120, 150, 200, 255],
  titleBar: [62, 78, 108, 255],
  closeBtn: [200, 90, 90, 255],
  bodyText: [226, 232, 244, 255],
  reward: [232, 180, 96, 255],
  claimBtn: [96, 176, 128, 255],
  deco: [90, 120, 170, 255],
};

/**
 * 构建状态 A 的 PSD 数据结构。
 * @returns {Object} ag-psd Psd
 */
function buildStateA() {
  return {
    width: CANVAS_W,
    height: CANVAS_H,
    // ★ 合成图（composite）★★
    //   ag-psd 的 writer **不会自动把图层合成成预览图**（源码 psdWriter.js:218
    //   只写你给的 `psd.imageData`；不填它，读回来就是一张全黑图）。
    //   ir_overlay.html 的唯一用途是让小 Q 把 bbox 叠在效果图上人工核对，
    //   全黑底图 = 把人工校验手段本身搞坏，而且「看起来正常」（HTML 能开、框能画）。
    //   故这里用 composeImage() 自己合成，见文件底部。
    imageData: composeImage(CANVAS_W, CANVAS_H, buildStateALayers()),
    children: buildStateALayers(),
    imageResources: sliceResource([
      { name: 'mail_bg', x: 120, y: 80, w: 480, h: 320 },
      { name: 'btn_close', x: 552, y: 92, w: 32, h: 32 },
    ], 'MailPopup'),
  };
}

/**
 * 构建状态 A 的图层列表。
 *
 * ★★刻意埋入的「子组比兄弟节点更外扩」结构 ★★
 *   `最外层容器` 的子层里，`外扩子组`（bbox 在 20,60）比另一个兄弟
 *   `窄兄弟组`（bbox 在 400,400）**更外扩**。若 `deriveGroupBox` 不递归子组，
 *   `外扩子组` 会被整体跳过，`最外层容器` 的 bbox 立刻偏小。
 *   这个结构是**唯一**能暴露该 bug 的形状，旧版 fixture 里一个都没有。
 *
 * @returns {Object[]} ag-psd Layer[]
 */
function buildStateALayers() {
  return [
      // ★★★ 顶层顺序语义：children[0] = 最上层 ★★★
      //   所以「越靠前 = 越靠上」。这里按真实的 UI 层级排：
      //     最上层：嵌套结构、最右下的独立控件、文本
      //     中间层：关闭按钮组
      //     最下层：弹窗框架（全幅底框，盖住所有内容）
      // ---- 文本（最上层）----
      textLayer({
        name: '标题文本', x: 148, y: 92, w: 200, h: 36,
        text: '邮件详情', fontSize: 26, color: [245, 230, 200], align: 'left',
      }),
      textLayer({
        name: '正文文本', x: 148, y: 160, w: 300, h: 28,
        text: '发件人：小Q', fontSize: 20, color: C.bodyText, align: 'left',
      }),
      textLayer({
        name: '时效文本', x: 148, y: 200, w: 300, h: 24,
        text: '有效期：7天', fontSize: 18, color: [180, 190, 210], align: 'left',
      }),
      // ---- A 态独有的图层（B 态应判 REMOVE）----
      raster({ name: '旧附件角标', x: 520, y: 300, w: 40, h: 40, rgba: [150, 150, 160, 255] }),
      // ---- ★★★ 嵌套组暴露结构（针对 deriveGroupBox 不递归的 bug）★★★
      // `最外层容器` 的两个子层中：
      //   · `外扩子组` 位于 (20,60)-(260,140)     —— **比兄弟节点更外扩**
      //   · `窄兄弟组` 位于 (400,400)-(500,440)  —— 右下角，面积小得多
      // 若父组并集不递归子组，`外扩子组`（及其全部后代）被整体跳过，
      // 父组 bbox 会退化成只剩 (400,400,100x40)，与期望的 (20,60,480x380) 差很远。
      group({
        name: '最外层容器',
        children: [
          group({
            name: '窄兄弟组',
            children: [
              raster({ name: '兄弟子层', x: 400, y: 400, w: 100, h: 40, rgba: [130, 110, 90, 255] }),
            ],
          }),
          group({
            name: '外扩子组',
            children: [
              raster({ name: '外扩子层1', x: 20, y: 60, w: 240, h: 60, rgba: [80, 120, 160, 255] }),
              raster({ name: '外扩子层2', x: 20, y: 120, w: 240, h: 20, rgba: [110, 140, 180, 255] }),
            ],
          }),
        ],
      }),
      // ---- 关闭按钮（弹窗之上）----
      group({
        name: '关闭按钮组',
        children: [
          raster({ name: '图层129', x: 552, y: 92, w: 32, h: 32, rgba: C.closeBtn }),
        ],
      }),
      // ---- 顶层：弹窗框架（嵌套组，验证父子关系 + 组 bbox 并集）——
      //   ★ 放在**最后** = 最下层；组内全幅底框也放最后 = 组内最下层
      group({
        name: '弹窗框架',
        children: [
          // ★ 组内同样是 children[0]=最上层。全幅底框必须放在**最后**（最下层），
          //   否则它会盖住组内的标题条与装饰边框。
          group({
            name: '组 1200',
            children: [
              raster({ name: '矩形1', x: 120, y: 80, w: 480, h: 8, rgba: C.titleBar }),
              raster({ name: '边框光', x: 120, y: 392, w: 480, h: 8, rgba: C.border }),
            ],
          }),
          raster({ name: '装饰边框', x: 128, y: 88, w: 464, h: 304, rgba: C.deco }),
          // 状态 A 宽 480 —— 全幅底框放在最后 = 最下层
          raster({ name: '矩形11', x: 120, y: 80, w: 480, h: 320, rgba: C.bgPanel }),
        ],
      }),
  ];
}

/**
 * ★ 合成预览图（composite）—— ag-psd 不会自动合成，必须自己给 ★
 *
 * 根因（QA BUG #2 实测发现）：
 *   `ag-psd` 的 writer **不会把图层合成成预览图**。源码 `psdWriter.js:218`：
 *     let imageData = psd.imageData;
 *     if (!imageData && psd.canvas) { imageData = psd.canvas.getContext('2d').getImageData(...) }
 *   —— 它只写**你给的** `psd.imageData`。不填，读回来就是一张**全黑不透明图**。
 *
 * 为什么这个 bug 危险：
 *   `ir_overlay.html` 是 R2-F6 的交付物，**唯一用途**就是让小 Q 把 bbox
 *   叠在效果图上人工核对。全黑底图 = 把人工校验手段本身搞坏，
 *   而且「看起来正常」（HTML 能开、框能画）—— 这类静默错误最伤信任。
 *   注意：真实的 Photoshop PSD **自带**合成预览图，所以这个 bug 只在
 *   合成 fixture 上暴露；但它证明了一件事：**读端拿到的合成图必须校验，
 *   不能假设它非空**（见 src/report/ir-overlay.js 的 validateComposite）。
 *
 * 合成算法：按图层顺序**从下到上**做 source-over alpha 混合。
 *
 * ★ 图层顺序语义（实测确认，勿搞反）★
 *   ag-psd 保持数组原序，**`children[0]` = 最上层**（与 Photoshop 一致）。
 *   故从下到上合成必须**倒序遍历**：`for (i = len-1; i >= 0; i--)`。
 *   验证方式：两个 20x20 图层在 y=0 / y=10 处重叠，前者红后者绿；
 *   写进 PSD 后读回 `children[0]` 仍是先写的那个 —— 说明「先写 = 在上」。
 *
 * ★ fixture 语义修正（合成图做出来后发现的坑）★
 *   初版把全幅底框 `矩形11` 放在 children 开头 = **最上层**，
 *   于是它把关闭按钮、文本、嵌套结构**全盖住了** —— 合成图里只剩一块底色，
 *   看起来「正常」（有颜色了）但内容是错的。
 *   现按真实的 UI 层级排：**底框放最后（最下层），控件与装饰放前面（上层）**。
 *
 * @param {number} canvasW
 * @param {number} canvasH
 * @param {Object[]} layers ag-psd Layer 树
 * @returns {Object} ImageData（{width,height,data:Uint8ClampedArray}）
 */
function composeImage(canvasW, canvasH, layers) {
  // ★ 转发到 src/psd/canvas-shim.js 的公共实现 ——
  //   合成逻辑放在 core 里，让 fixture 与外部调用方共用同一份，避免两处实现漂移。
  return composeImageData(canvasW, canvasH, layers);
}


/** 转发到 src/psd/canvas-shim.js 的公共实现。 */
function checkComposite(img) {
  return require('../../src/psd/canvas-shim').checkComposite(img);
}

/**
 * 构建状态 B 的 PSD 数据结构（带奖励）。
 *
 * 与 A 的差异（对应七类差异）：
 *   RESIZE  弹窗底框 `矩形11` 480x320 -> 560x360
 *   MOVE     `图层129` 关闭按钮 (552,92) -> (632,92)（跟着底框变宽而右移）
 *   RESTYLE  `正文文本` 颜色变化
 *   ADD      3 个奖励物品 + 领取按钮
 *   REMOVE   A 态的 `旧附件角标` 在 B 态消失
 *   MERGED   `组1200拷贝` 是被画师合并的组（3 个 raster、无 slice）-> merged=true
 *
 * @returns {Object} ag-psd Psd
 */
function buildStateB() {
  const layers = buildStateBLayers();
  return {
    width: CANVAS_W,
    height: CANVAS_H,
    // ★ 同 BUG #2：ag-psd 不自动合成，必须自己给，否则读回来是全黑图
    imageData: composeImage(CANVAS_W, CANVAS_H, layers),
    children: layers,
    imageResources: sliceResource([
      { name: 'mail_bg', x: 80, y: 60, w: 560, h: 360 },
      { name: 'btn_close', x: 592, y: 72, w: 32, h: 32 },
      { name: 'btn_claim', x: 260, y: 380, w: 200, h: 56 },
    ], 'MailPopup'),
  };
}

/**
 * 构建状态 B 的图层列表。
 * @returns {Object[]} ag-psd Layer[]
 */
function buildStateBLayers() {
  return [
      group({
        name: '弹窗框架',
        children: [
          // ★ 已合并组：3 个纯 raster 子层、无一携带 slice -> merged-detect 应标 true
          //   对应业务事实「第二份 PSD 只给新增素材分层，重复素材被合并」
          group({
            name: '组1200拷贝',
            children: [
              raster({ name: '图层301', x: 80, y: 60, w: 560, h: 8, rgba: C.titleBar }),
              raster({ name: '图层302', x: 80, y: 412, w: 560, h: 8, rgba: C.border }),
              raster({ name: '图层303', x: 88, y: 68, w: 544, h: 344, rgba: C.deco }),
            ],
          }),
          // ★ RESIZE：底框变宽 480 -> 560（全幅底框放最后 = 最下层）
          raster({ name: '矩形11', x: 80, y: 60, w: 560, h: 360, rgba: C.bgPanel }),
        ],
      }),
      // ★ MOVE：关闭按钮随底框加宽而右移
      group({
        name: '关闭按钮组',
        children: [
          raster({ name: '图层129', x: 592, y: 72, w: 32, h: 32, rgba: C.closeBtn }),
        ],
      }),
      textLayer({
        name: '标题文本', x: 108, y: 72, w: 200, h: 36,
        text: '邮件详情', fontSize: 26, color: [245, 230, 200], align: 'left',
      }),
      // ★ RESTYLE：同位置同尺寸，颜色变了
      textLayer({
        name: '正文文本', x: 108, y: 140, w: 300, h: 28,
        text: '发件人：小Q', fontSize: 20, color: [255, 214, 120], align: 'left',
      }),
      textLayer({
        name: '时效文本', x: 108, y: 180, w: 300, h: 24,
        text: '有效期：3天', fontSize: 18, color: [180, 190, 210], align: 'left',
      }),
      // ---- ★ ADD：3 个奖励物品（同尺寸、等距 -> 结构建议器应建议 GList+Cell）----
      group({
        name: '奖励组',
        children: [
          raster({ name: '图层249', x: 108, y: 240, w: 96, h: 96, rgba: C.reward }),
          raster({ name: '图层249', x: 216, y: 240, w: 96, h: 96, rgba: C.reward }),
          raster({ name: '图层249', x: 324, y: 240, w: 96, h: 96, rgba: C.reward }),
        ],
      }),
      // ---- ★ ADD：领取按钮 ----
      group({
        name: '领取按钮组',
        children: [
          raster({ name: 'btn_claim', x: 260, y: 380, w: 200, h: 56, rgba: C.claimBtn }),
        ],
      }),
      // ---- ★ 嵌套组暴露结构（与 A 态同名，便于跨态比对）----
      // B 态里 `最外层容器` 的两个子组位置与 A 态不同（MOVE + RESIZE），
      // 同样保留「子组比兄弟节点更外扩」的形状，防止该结构被优化掉。
      group({
        name: '最外层容器',
        children: [
          group({
            name: '外扩子组',
            children: [
              raster({ name: '外扩子层1', x: 40, y: 440, w: 300, h: 70, rgba: [90, 130, 170, 255] }),
              raster({ name: '外扩子层2', x: 40, y: 510, w: 300, h: 24, rgba: [120, 150, 190, 255] }),
            ],
          }),
          group({
            name: '窄兄弟组',
            children: [
              raster({ name: '兄弟子层', x: 560, y: 40, w: 120, h: 44, rgba: [140, 120, 100, 255] }),
            ],
          }),
        ],
      }),
  ];
}

/**
 * 生成两份黄金样本 PSD。
 * @param {Object} [opts]
 * @param {string} [opts.outDir]
 * @returns {{outDir:string, files:string[]}}
 */
function makePsds(opts = {}) {
  const outDir = opts.outDir || OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  installCanvasShim({ force: true });
  // eslint-disable-next-line global-require
  const { writePsdBuffer } = require('ag-psd');

  const files = [];
  const checks = [];
  const write = (name, psd) => {
    // ★ 写盘前自检：合成图退化就当场报错，不要「造出一张全黑图还以为成功」
    const chk = checkComposite(psd.imageData);
    if (!chk.ok) throw new Error(`${name}: ${chk.msg}`);
    checks.push({ name, ...chk });
    const buf = writePsdBuffer(psd);
    fs.writeFileSync(path.join(outDir, name), buf);
    files.push(name);
  };
  write('state_A.psd', buildStateA());
  write('state_B.psd', buildStateB());
  files.sort();
  return { outDir, files, checks };
}

module.exports = {
  makePsds,
  buildStateA,
  buildStateB,
  buildStateALayers,
  buildStateBLayers,
  composeImage,
  checkComposite,
  raster,
  textLayer,
  group,
  sliceResource,
  solid,
  CANVAS_W,
  CANVAS_H,
  OUT_DIR,
};

// 直接执行时生成（npm run fixtures）
if (require.main === module) {
  const res = makePsds();
  for (const c of res.checks) process.stdout.write(`  ${c.name}: ${c.msg}\n`);
  process.stdout.write(`make-psd: 生成 ${res.files.length} 份黄金样本 PSD -> ${res.outDir}\n`);
}
