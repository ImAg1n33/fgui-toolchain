'use strict';
/**
 * src/psd/ir-builder.js —— 图层树 -> DesignIr（★ D3：组 bbox 一律由子层并集推导 ★）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★★ 坑 2（ARCHITECTURE D3）：ag-psd 返回的组自身坐标不可信 ★★★
 *   实测：合成含 group 的 PSD 后读回，组 `outer` 自身 `left/top/right/bottom`
 *   **全为 0**，而其子层并集是 `20,10,180,90`。
 *   直接采信组自身坐标必错，会让 L2/L3 的尺寸校验全线失准。
 *
 *   本实现的硬规则：
 *     · 组的 bbox **永远**由 `deriveGroupBox()` 从子层递归并集推导，
 *       绝不读组自身的 left/top/right/bottom。
 *     · 每层带 `bboxSource` 字段标记来源：'own'（图层自身）/ 'derived'（子层并集）。
 *       人可一眼看出这个坐标是怎么来的，出错时能定位。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 产出符合 ARCHITECTURE §3.3 的 Design IR：
 *   { version, source{psdPath,psdSha256,canvas,dpr}, layers[], warnings[], sliceNames[] }
 *   每个字段带 `_comment` 说明（PRD A10：中间产物人可读）。
 */

const { normalizeName } = require('../core/normalize');
const { round6, sortBy } = require('../core/determinism');
const { extractText, isTextLayer } = require('./text-extract');
const { detectMerged, buildMergedWarning, buildSuspectedMergedWarning, isGroup } = require('./merged-detect');
const { assignSlicesToLayers, buildSliceSection } = require('./slice-extract');
const { layerImageData } = require('./reader');
const { phashFromRgba } = require('../imaging/phash');

/** IR 版本号。 */
const IR_VERSION = '1.0';

/** bbox 来源标记。 */
const BBOX_SOURCE = Object.freeze({ OWN: 'own', DERIVED: 'derived' });

/** 空 bbox。 */
const EMPTY_BOX = Object.freeze({ x: 0, y: 0, w: 0, h: 0 });

/**
 * 组嵌套深度上限（超出即降级为「跳过」，不栈溢出）。
 *
 * 真实 PSD 极少超过 10 层；256 是极宽松的余量。
 * 超限时 `deriveGroupBox` 会在返回值里带 `depthTruncated` 计数，
 * 使「因深度降级」与「本来就没有有效子层」在告警上可区分（QA 第二轮要求）。
 */
const MAX_GROUP_DEPTH = 256;

/**
 * ★ deriveGroupBox：组 bbox 由子层 bbox 并集推导 ★
 *
 * 这是 D3 的唯一实现点。**递归**向下求子层并集：
 *   - 子层是组 -> 递归调用本函数（★ 关键：绝不读组自身坐标）
 *   - 子层是叶子且有非零尺寸 -> 参与并集
 *   - 子层零尺寸（空图层/被隐藏且无像素）-> 跳过，但记录到 skipped 里
 *
 * ────────────────────────────────────────────────────────────────────────
 * ★★ 曾经有一个静默 bug，勿重犯 ★★
 *   本函数的注释一直写着「子层是组 -> 递归」，但实现里**没有递归调用**：
 *     const box = child.bbox || boxOfLayer(child);
 *   当子层是组且没有已构建的 `.bbox` 时，走 `boxOfLayer(child)` 去读组自身坐标 ——
 *   而组自身坐标**恒为 0**（D3 实测事实）—— 于是 `w<=0` -> `skipped++`，
 *   **整个子组连同它内部所有后代被整体丢弃**。
 *
 *   后果：组的 bbox 只含叶子孙层，尺寸偏小且**不报任何错**。
 *   组 bbox 是「父容器尺寸」，FGUI 里直接决定组件实际大小。
 *
 *   为什么自测没抓到：黄金样本里 `弹窗框架` 的另一个子层 `矩形11` 是
 *   480×320 全幅底框，而嵌套子组 `组1200` 的两个子层（8px 横条）完全落在它内部 ——
 *   **无论内层组参不参与并集，结果都一样**，bug 被 fixture 结构掩盖了。
 *
 *   教训：**「精确对账」若对账算法与被测算法共享同一缺陷，就是自证循环。**
 *   `test/unit/ir-builder.test.js` 现在用一份**独立编写的递归并集算法**做对账，
 *   并在 `test/fixtures/make-psd.js` 里加了「子组比兄弟节点更外扩」的结构。
 * ────────────────────────────────────────────────────────────────────────
 *
 * @param {Object[]} children 子层（ag-psd Layer 或已构建的 IR 节点）
 * @param {Object} [ctx] 内部递归用（depth 限制，防病态结构导致栈溢出）
 * @returns {{box:{x:number,y:number,w:number,h:number}, skipped:number, used:number}}
 */
function deriveGroupBox(children, ctx) {
  const depth = (ctx && ctx.depth) || 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let skipped = 0;
  let used = 0;
  // ★ 深度截断计数（QA 第二轮要求）：超深与「本来就没有有效子层」必须能区分 ——
  //   否则超深嵌套降级后与空组一样都是 0,0,0,0，排查的人无法判断根因。
  let depthTruncated = 0;

  // ★ 入参防御：畸形 PSD 可能在 children 位置塞非数组（QA R2-1.8 实测 `123`）★
  //   不防御就是 `for...of` 直接抛 TypeError，把整个解析打断。
  const list = Array.isArray(children) ? children : [];

  for (const child of list) {
    if (!child) {
      skipped++;
      continue;
    }
    // ★★★ 关键分支：子层是组 -> 递归，绝不读组自身坐标 ★★★
    let box;
    if (Array.isArray(child.children)) {
      // ★ 判「子组自身」的深度（depth+1），不是父的深度 ★
      //   原写法 `depth >= MAX` 会让截断点整体上移一层：
      //   顶层 depth=0 时，整棵树能递归 257 层才触发，比声明的上限多一层 —— 不一致。
      if (depth + 1 > MAX_GROUP_DEPTH) {
        skipped++;
        depthTruncated++;
        continue;
      }
      const sub = deriveGroupBox(child.children, { depth: depth + 1 });
      // 递归内部的截断要**向上冒泡**，否则最外层看不到「深层发生过截断」
      depthTruncated += sub.depthTruncated || 0;
      box = sub.box;
    } else if (child.bbox) {
      // 已构建好的 IR 节点（其 bbox 本身已是 derived 结果）
      box = child.bbox;
    } else {
      // 叶子层：读自身坐标（唯一允许读 left/top/right/bottom 的地方）
      box = boxOfLayer(child);
    }

    if (!box || !Number.isFinite(box.w) || !Number.isFinite(box.h)
      || box.w <= 0 || box.h <= 0) {
      skipped++;
      continue;
    }
    used++;
    const x = box.x;
    const y = box.y;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + box.w > maxX) maxX = x + box.w;
    if (y + box.h > maxY) maxY = y + box.h;
  }

  if (used === 0) {
    return { box: { ...EMPTY_BOX }, skipped, used: 0, depthTruncated };
  }
  return {
    box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    skipped,
    used,
    depthTruncated,
  };
}

/**
 * 从 ag-psd 层取自身 bbox（不递归）。
 * @param {Object} layer
 * @returns {{x:number,y:number,w:number,h:number}}
 */
function boxOfLayer(layer) {
  if (!layer) return { ...EMPTY_BOX };
  const l = layer.left === undefined ? 0 : layer.left;
  const t = layer.top === undefined ? 0 : layer.top;
  const rr = layer.right === undefined ? l : layer.right;
  const bb = layer.bottom === undefined ? t : layer.bottom;
  return { x: l, y: t, w: Math.max(0, rr - l), h: Math.max(0, bb - t) };
}

/**
 * 取图层的**非单位**变换矩阵（E-01 变形图层用；单位矩阵返 null）。
 *
 * 两个来源：
 *   · 文本层：`layer.text.transform` = [a,b,c,d,tx,ty]（2x3 仿射前 6 个）
 *   · 智能对象：`layer.placedLayer.transform` = 8 个 double（同样取前 6 个）
 *
 * ★ 为什么要记它 ★（E-01 畸形形态测试的发现）
 *   变形图层（旋转/缩放/透视）此前被**静默**按未变换坐标处理 —— IR 的
 *   rotation 恒为 0、变换矩阵丢失，人拿 bbox 去和画师所见核对时会错位
 *   且没有任何提示。按项目铁律「宁可明确报错，不要静默给错东西」，
 *   非单位变换必须落进 IR 并告警。
 *
 * @param {Object} layer
 * @returns {number[]|null} [a,b,c,d,tx,ty]；无变换或单位变换时 null
 */
function transformOfLayer(layer) {
  if (!layer) return null;
  const candidates = [layer.text && layer.text.transform, layer.placedLayer && layer.placedLayer.transform];
  for (const t of candidates) {
    if (!Array.isArray(t) || t.length < 6) continue;
    const m = t.slice(0, 6).map((v) => round6(Number(v)));
    if (m.some((v) => !Number.isFinite(v))) continue;
    // 单位矩阵 [1,0,0,1,0,0] → 视为无变换
    const isIdentity = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
    if (!isIdentity) return m;
  }
  return null;
}

/**
 * 判定 ag-psd 层的类型。
 * @param {Object} layer
 * @returns {'raster'|'text'|'group'|'smartobject'}
 */
function typeOfLayer(layer) {
  if (isGroup(layer)) return 'group';
  if (isTextLayer(layer)) return 'text';
  if (layer.smartObject || layer.placedLayer) return 'smartobject';
  return 'raster';
}

/**
 * Design IR 构建器。
 *
 * 用法：
 *   const ir = new IrBuilder({ normalizeOpts }).build({ psd, psdPath, sha256, slices });
 */
class IrBuilder {
  /**
   * @param {Object} [opts]
   * @param {Object} [opts.normalizeOpts] 透传给 normalizeName
   * @param {number} [opts.dpr=1]
   * @param {boolean} [opts.withPhash=true] 是否为 raster 层算 pHash（L3 兜底用）
   * @param {number} [opts.phashMaxSide=32] pHash 计算前的最大边长
   */
  constructor(opts = {}) {
    this.normalizeOpts = opts.normalizeOpts || {};
    this.dpr = opts.dpr === undefined ? 1 : opts.dpr;
    this.withPhash = opts.withPhash !== false;
    this.phashMaxSide = opts.phashMaxSide || 32;
  }

  /**
   * 构建 Design IR。
   *
   * @param {Object} input
   * @param {Object} input.psd ag-psd 解析结果
   * @param {string} input.psdPath 源文件路径（会被 POSIX 相对化）
   * @param {string} input.sha256 源文件指纹
   * @param {Object[]} [input.slices] extractSlices 的输出
   * @returns {Object} DesignIr
   */
  build(input) {
    const psd = input.psd;
    const warnings = [];

    // ---- 第 1 遍：扁平化，分配 id，收集 group 与 slice 的对应关系 ----
    const flat = [];
    let counter = 0;
    // ag-psd 层 -> 序号，用于 merged-detect 判断子树里是否有 slice
    const sliceByLayerIndex = new Map();

    /**
     * 递归遍历。
     * @param {Object[]} siblings
     * @param {string|null} parentId
     * @param {number} depth
     */
    const walk = (siblings, parentId, depth) => {
      for (const layer of siblings || []) {
        counter++;
        const irIndex = counter; // 与遍历序号一致（1-based）
        const id = `L${String(counter).padStart(3, '0')}`;
        const type = typeOfLayer(layer);

        const node = {
          id,
          name: layer.name || '',
          normName: normalizeName(layer.name || '', this.normalizeOpts),
          parent: parentId,
          type,
          depth,
          bbox: null,
          bboxSource: BBOX_SOURCE.OWN,
          rotation: 0,
          opacity: round6(layer.opacity === undefined ? 1 : layer.opacity),
          visible: layer.hidden !== true,
          blend: layer.blendMode || 'normal',
          merged: false,
          childCount: 0,
          sliceName: null,
          text: null,
          phash: null,
          transform: null,
        };

        if (type === 'group') {
          // ★★★ D3：组 bbox 走 deriveGroupBox，绝不读组自身坐标 ★★★
          const derived = deriveGroupBox(layer.children || []);
          node.bbox = derived.box;
          node.bboxSource = BBOX_SOURCE.DERIVED;
          node.childCount = (layer.children || []).length;
          // 记录 derive 的细节，便于排查“为什么这个组 bbox 是空的”
          node._derive = {
            usedChildren: derived.used,
            skippedChildren: derived.skipped,
            // ★ 超深截断计数：让「因深度上限降级」与「本来就没有有效子层」可区分
            depthTruncated: derived.depthTruncated || 0,
          };

          // ★★★ 组的空 bbox 告警（QA P2-1）★★★
          //   叶子层 bbox=0 早有 EMPTY_LAYER 告警，组却没有 —— **告警覆盖不对称**。
          //   根因与 BUG#1 同源：告警逻辑只写在叶子分支，组分支漏了。
          //   后果：空组/子层全被跳过的组在 IR 里静静躺着「bbox=0」，
          //   人看不出是「本来就空」还是「推导失败了」—— 而后者正是 BUG#1 的症状。
          //
          //   两种情况必须**分开报**（严重度不同，处置也不同）：
          //     ① 根本没有子层            -> EMPTY_GROUP，画师可能还没画完/是空壳
          //     ② 有子层但全被跳过（used=0）-> GROUP_BBOX_UNRESOLVED，**很可能是解析出了问题**
          if (node.bbox.w === 0 || node.bbox.h === 0) {
            if (node.childCount === 0) {
              warnings.push({
                code: 'EMPTY_GROUP',
                layer: id,
                msg: `组『${node.name}』(${id}) 没有任何子层，bbox 为 0 —— `
                  + '若画师确实画了内容，说明该组在 PSD 里被折叠或内容丢失，请人工确认',
              });
            } else if (derived.used === 0) {
              // ★ 区分两种「used=0」：超深截断 vs 坐标全异常 —— 处置完全不同
              const isDepthTruncation = (derived.depthTruncated || 0) > 0;
              warnings.push({
                code: 'GROUP_BBOX_UNRESOLVED',
                layer: id,
                msg: isDepthTruncation
                  ? `★ 组『${node.name}』(${id}) 的嵌套深度超过 ${MAX_GROUP_DEPTH} 层上限，`
                    + `有 ${derived.depthTruncated} 个子组被跳过，bbox 降级为 0。`
                    + '真实 PSD 极少见这种结构（QA 判定为实际不可达），'
                    + '若确实出现请人工核对该组内容'
                  : `★ 组『${node.name}』(${id}) 有 ${node.childCount} 个子层，`
                    + `但**全部**被跳过（skipped=${derived.skipped}，used=0），bbox 推导失败为 0。`
                    + '这通常意味着子层坐标全部异常（零尺寸/畸形），'
                    + '**该组及其子层的位置信息不可信**，请人工核对',
              });
            } else {
              // used>0 却仍算出 0：理论上不该发生（并集非空必有面积），出现即为逻辑缺陷
              warnings.push({
                code: 'GROUP_BBOX_UNRESOLVED',
                layer: id,
                msg: `★ 组『${node.name}』(${id}) 明明有 ${derived.used} 个有效子层，`
                  + 'bbox 却为 0 —— 这是 deriveGroupBox 的逻辑缺陷，请上报',
              });
            }
          }

          flat.push(node);
          walk(layer.children || [], id, depth + 1);
        } else {
          // 叶子：自身坐标可信
          node.bbox = boxOfLayer(layer);
          node.bboxSource = BBOX_SOURCE.OWN;

          // ★ 变形图层信号（E-01）：非单位变换矩阵必须落 IR + 告警，不许静默 ★
          const transform = transformOfLayer(layer);
          if (transform) {
            node.transform = transform;
            warnings.push({
              code: 'TRANSFORMED_LAYER',
              layer: id,
              msg: `图层『${node.name}』(${id}) 带非单位变换矩阵 [${transform.join(',')}]`
                + '（旋转/缩放/变形）：bbox 取自图层记录坐标，可能未反映变换后的实际外接框，'
                + '与画师所见核对时请注意',
            });
          }

          // 文本抽取
          if (type === 'text') {
            const { text, warnings: tw } = extractText(layer);
            node.text = text;
            warnings.push(...tw);
          }

          // pHash（L3 兜底用）。需要 FULL 模式读出的 imageData。
          if (this.withPhash && type !== 'text') {
            const img = layerImageData(layer);
            if (img && img.width > 0 && img.height > 0) {
              try {
                node.phash = phashFromRgba(img);
              } catch (err) {
                warnings.push({
                  code: 'EMPTY_LAYER',
                  layer: id,
                  msg: `图层『${node.name}』pHash 计算失败（${err.message}），L3 兜底对该层不可用`,
                });
              }
            }
          }

          // 零尺寸告警（人总要看到，别静默）
          if (node.bbox.w === 0 || node.bbox.h === 0) {
            warnings.push({
              code: 'EMPTY_LAYER',
              layer: id,
              msg: `图层『${node.name}』(${type}) bbox 为零尺寸 `
                + `(${node.bbox.x},${node.bbox.y},${node.bbox.w}x${node.bbox.h})，`
                + '可能是空图层或纯矢量层无像素，请人工确认',
            });
          }

          flat.push(node);
        }
      }
    };

    walk(psd.children || [], null, 0);

    // ---- 第 1.5 遍：位深信号（E-01 畸形形态测试发现）----
    // 16/32 位通道的 PSD 能解析出结构，但像素派生特征（pHash）与合成图
    // 都按 8 位假设计算 —— 不告警就是「静默给错东西」，必须显式记录。
    const bitsPerChannel = psd.bitsPerChannel === undefined ? 8 : psd.bitsPerChannel;
    if (bitsPerChannel !== 8) {
      warnings.push({
        code: 'NON_8BIT_CHANNELS',
        layer: null,
        msg: `PSD 位深为 ${bitsPerChannel} 位（非常规 8 位）：像素派生特征（pHash）与合成图预览`
          + '均按 8 位假设计算，结果不可信，L3 兜底匹配对该文件无效，请人工核对',
      });
    }

    // ---- 第 2 遍：切片归属 ----
    const slices = input.slices || [];
    const assignment = assignSlicesToLayers(flat, slices);
    for (const [layerId, sl] of assignment) {
      const node = flat.find((l) => l.id === layerId);
      if (node) {
        node.sliceName = sl.name;
        // merged-detect 用：标记该层携带 slice
        sliceByLayerIndex.set(Number(layerId.slice(1)), true);
      }
    }
    const sliceSection = buildSliceSection(slices, assignment);
    warnings.push(...sliceSection.warnings);

    // ---- 第 3 遍：合并图层标记（R2-F5 + ★ UPSTREAM-FIX-1 两档语义 ★）----
    // 必须在切片归属之后做：判据要求「子树里没有任何图层携带 slice」。
    //
    // ★ docHasSlices 是「无切片」信号有无判别力的分水岭 ★：
    //   - 文档有切片 -> 纯栅格无切片组是异常信号 -> merged=true（强证据，
    //     触发 planner/matcher 的 L3 封顶与 INFERRED 联动）；
    //   - 文档没有切片 -> 「无切片」是常态（画师导出后往往不保存切片），
    //     绝不标 merged（不触发任何联动），只发 SUSPECTED_MERGED_GROUP
    //     info 级提示。否则无切片 PSD 里的普通分层组会被大面积误判，
    //     人工确认量暴涨（外部审查核实的问题一）。
    const docHasSlices = slices.length > 0;
    const byId = new Map(flat.map((l) => [l.id, l]));
    for (const node of flat) {
      if (node.type !== 'group' || node.childCount === 0) continue;
      const pseudoLayer = this.rebuildForDetect(node, byId);
      const info = detectMerged(pseudoLayer, { sliceByLayerIndex, docHasSlices });
      if (info.merged) {
        node.merged = true;
        warnings.push(buildMergedWarning(node, info));
      } else if (info.suspected) {
        // 疑似档：不动 node.merged（保持 false），只发 info 级提示
        warnings.push(buildSuspectedMergedWarning(node, info));
      }
    }

    // ---- 排序：按 id（= PSD 文档序），保证确定性 ----
    const layers = sortBy(flat, (l) => l.id);

    // warnings 排序：按 (code, layer) —— §8.5 规则 6
    const sortedWarnings = sortBy(warnings, (w) => w.code, (w) => w.layer, (w) => w.msg);

    return {
      version: IR_VERSION,
      _comment: '由 fgui-rb psd-ir 生成。bbox 为绝对坐标，单位 px。'
        + 'merged=true 表示画师已合并该组，子层信息不可恢复（仅强证据档：'
        + '文档有切片时纯栅格无切片组才标 merged；无切片文档只发 '
        + 'SUSPECTED_MERGED_GROUP info 提示，不标 merged）。'
        + '本文件可手工编辑，后续 diff-plan 会读取它。',
      _bboxNote: '组图层的 bbox 一律由其子层并集推导（bboxSource="derived"）；'
        + 'ag-psd 返回的组自身坐标在实测中恒为 0，不可直接采信（ARCHITECTURE D3 / 坑 2）。'
        + '叶子图层用自身坐标（bboxSource="own"）。',
      _layerFieldNote: {
        id: 'L+3位序号，按 PSD 文档序，父在子前，稳定可复现',
        name: '画师原名，不做任何改写',
        normName: '归一化名（去副本后缀/全半角/大小写/空格/繁简），仅供检索使用',
        parent: '父图层 id，null = 顶层',
        type: 'raster | text | group | smartobject',
        bbox: '{x,y,w,h} 绝对坐标',
        bboxSource: 'own = 图层自身坐标；derived = 子层并集推导（仅 group）',
        opacity: '0..1，定点化到 6 位',
        visible: 'false 表示画师隐藏了该层',
        merged: 'true = 该组被画师合并，子层信息不可恢复（R2-F5；仅强证据档：'
          + '文档有切片时才判，无切片文档的疑似组不标此字段）',
        childCount: '直接子层数',
        sliceName: '导出的切片名（L1 最强匹配通道的依据），无则 null',
        text: 'type=text 时为 {value,fontSize,color,align,font}；color 恒为 6 位 #RRGGBB',
        phash: '16 位十六进制 = 64bit DCT pHash，供 L3 兜底匹配；无像素时 null',
        transform: '非单位变换矩阵 [a,b,c,d,tx,ty]（旋转/缩放/变形图层，E-01 新增信号）；'
          + 'null = 无变换。带变换时 bbox 可能未反映变换后外接框，已配 TRANSFORMED_LAYER 告警',
      },
      source: {
        _comment: '输入指纹。psdPath 为 POSIX 相对路径，psdSha256 用于增量与复现验证。',
        psdPath: input.psdPath || '',
        psdSha256: input.sha256 || '',
        canvas: { w: psd.width || 0, h: psd.height || 0 },
        dpr: this.dpr,
        bitsPerChannel,
      },
      layers: layers.map((l) => this.decorateLayer(l, flat)),
      warnings: sortedWarnings,
      slices: sliceSection.slices,
      sliceNames: sliceSection.sliceNames,
    };
  }

  /**
   * 给 IR 层节点补上可读性字段（slice rect 等）。
   * @param {Object} node
   * @param {Object[]} all
   * @returns {Object}
   */
  decorateLayer(node, all) {
    const out = { ...node };
    if (node.sliceName) {
      const owner = all.find((l) => l.sliceName === node.sliceName && l.id === node.id);
      out.slice = {
        name: node.sliceName,
        rect: owner ? [owner.bbox.x, owner.bbox.y, owner.bbox.w, owner.bbox.h] : null,
      };
    } else {
      out.slice = null;
    }
    return out;
  }

  /**
   * 由 IR 节点重建一个「可供 merged-detect 消费」的伪 ag-psd 层树。
   *
   * 为什么需要重建：merged-detect 的判据要看整棵子树的叶子类型，
   * 而 IR 节点已经把 group 的坐标改成 derived 了。这里只需要结构与类型，
   * 不需要坐标，故用 IR 节点直接构造。
   *
   * ★ E-01 修复：必须透传 smartobject 类型 ★
   *   原实现把叶子一律建成 `{name, text, __irIndex}`，**丢失了智能对象标记** ——
   *   于是「组内只有智能对象」会被 merged-detect 判成 all_raster → merged=true
   *   （静默错误：智能对象保留独立身份，不是被合并的像素块）。
   *   detectMerged 检查的正是 `leaf.smartObject || leaf.placedLayer`，
   *   所以这里必须把类型带回去。
   *
   * @param {Object} groupNode IR 组节点
   * @param {Map<string,Object>} byId
   * @returns {Object}
   */
  rebuildForDetect(groupNode, byId) {
    const self = this;
    const build = (id) => {
      const n = byId.get(id);
      if (!n) return null;
      if (n.type === 'group') {
        return {
          name: n.name,
          text: null,
          children: (self.childIdsOf(id, byId) || []).map(build).filter(Boolean),
        };
      }
      return {
        name: n.name,
        // 文本层在 IR 里是 node.text，merged-detect 看 layer.text
        text: n.type === 'text' ? { text: n.text ? n.text.value : '' } : null,
        // ★ 智能对象标记必须透传（E-01：否则含智能对象的组被误判 merged）★
        smartObject: n.type === 'smartobject' ? true : undefined,
        __irIndex: Number(n.id.slice(1)),
      };
    };
    return build(groupNode.id);
  }

  /**
   * 找某组的直接子层 id 列表。
   * @param {string} parentId
   * @param {Map<string,Object>} byId
   * @returns {string[]}
   */
  childIdsOf(parentId, byId) {
    const out = [];
    for (const n of byId.values()) {
      if (n.parent === parentId) out.push(n.id);
    }
    // byId 是插入序（= 文档序），已确定；再显式按 id 排一次保证万无一失
    return out.sort();
  }
}

module.exports = {
  IrBuilder,
  deriveGroupBox,
  MAX_GROUP_DEPTH,
  boxOfLayer,
  typeOfLayer,
  transformOfLayer,
  IR_VERSION,
  BBOX_SOURCE,
};
