'use strict';
/**
 * src/create/plan-builder.js —— CREATE 模式核心（v0.3-B，纯函数、零 I/O）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 与 PATCH（gen-plan）的根本区别 ★
 *   PATCH 要求**已有目标组件 XML**，在存量文本上打补丁；
 *   CREATE **只吃 Design IR + 工程索引**，目标组件原本不存在 —— 从零拼新界面。
 *   因此本模块**绝不读取** change_plan.json / gen_plan.json / 任何已有组件 XML。
 *
 * ★ 硬规则来源 ★
 *   朋友 `.cursor/skills/fgui-ai-assembly/SKILL.md` 的公司制作规范，
 *   已提取到 `docs/DEV-PLAN.md` §1.3.2。本文件把其中可编码的部分固化为：
 *     ① 画布 750×1334（可覆盖）；xy/size **直接取 IR bbox**，绝对定位、不做缩放换算
 *     ② 层级 = 图层顺序（底→顶）；**覆盖全画布的最大层强制 layer 0 且命名 img_bg**
 *     ③ 命名前缀 image→img_ / text→txt_ / list→list_ / button→btn_（+ group→grp_）
 *     ④ 资源复用：同包 + type==='image'，按「图层名/切片名 ↔ 资源名」匹配
 *        → `src = <短资源 id>`（真实工程形态，**不拼 ui://**）；匹配不到 → toImport
 *     ⑤ 图标/立绘**禁止拉伸**：bbox 与固有尺寸不一致且不可九宫格 → 保留固有尺寸 + unresolved
 *     ⑥ 九宫格：仅当「摆放 > 固有」**且**资源具备 9grid 能力 → 建议 scale9grid（无切格值不猜）
 *     ⑦ 列表：≥2 个同尺寸、同列纵向堆叠 → 只在 deferred.listItems 给建议，v1 不建组件
 *     ⑧ Controller / Relations / gear：v1 一律 deferred，不自动生成
 *     ⑨ 文本：text/color(6位)/alpha/fontsize；估计值标 estimated:true
 *     ⑩ 确定性（B9）：无 Date.now / 随机 / 绝对路径
 *
 * ★ IR 顺序事实（实测，勿凭直觉）★
 *   `design_ir.layers` 按 **PSD 文档序 = 顶→底**（golden A：L001「标题文本」在最上，
 *   L018「矩形11」即弹窗底图在最下）。而 FGUI 的 displayList 是**底→顶**，
 *   故生成侧必须 **reverse**。`_layerFieldNote.id` 亦写明「按 PSD 文档序，父在子前」。
 * ════════════════════════════════════════════════════════════════════════════
 */

const path = require('path');
const { AppError, CODES } = require('../core/errors');
const { normalizeName } = require('../core/normalize');
// ★ 复用 PATCH 侧已固化的资源匹配纪律（精确优先 / 归一唯一 / ≥2 不猜 / 类型限定）
//   不另写一套，避免两处漂移。
const { findExportedResource, RESOURCE_MATCH } = require('../fgui/gen-plan');

/** 画布默认值（SKILL.md 硬规则）。 */
const DEFAULT_CANVAS = Object.freeze({ w: 750, h: 1334 });

/** IR type → FGUI 节点 tag（group 不进 nodes，见下方 scope 说明）。 */
const TAG_BY_TYPE = Object.freeze({ text: 'text', raster: 'image', smartobject: 'image' });

/** 命名前缀（SKILL.md：img / txt / btn / list）。 */
const PREFIX_BY_TYPE = Object.freeze({
  text: 'txt_', raster: 'img_', smartobject: 'img_', group: 'grp_',
});

/** 背景层固定命名。 */
const BG_NAME = 'img_bg';

/**
 * 解析 `--canvas 750x1334`。
 *
 * @param {string|undefined|null} s
 * @returns {{w:number, h:number}|null} 未传时返回 **null**（表示「未指定」，
 *          由 resolveCanvas 决定用 IR 画布还是默认值）；传了但格式非法则抛错
 * @throws {AppError} BAD_ARGUMENT
 */
function parseCanvas(s) {
  // ★ 未传 → null（不是默认值）★
  //   这是 P0 修复的关键：缺省时必须能区分「用户没传」与「用户传了 750x1334」，
  //   否则无法在「用 IR 自己的画布」与「CLI 显式覆盖」之间做正确决策。
  if (s === undefined || s === null || s === '') return null;
  const m = /^\s*(\d+)\s*[xX*]\s*(\d+)\s*$/.exec(String(s));
  if (!m) {
    throw new AppError(CODES.BAD_ARGUMENT,
      `--canvas 格式应为 <宽>x<高>（如 750x1334），实际 ${JSON.stringify(s)}`);
  }
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (!(w > 0) || !(h > 0)) {
    throw new AppError(CODES.BAD_ARGUMENT, `--canvas 宽高必须为正整数，实际 ${JSON.stringify(s)}`);
  }
  return { w, h };
}

/**
 * 决定最终画布：**CLI 显式 > IR 自带 > 默认 750×1334**（P0 修复）。
 *
 * ★ 为什么不能硬编码默认值 ★（外部审查 P0）
 *   真实 PSD 若为 1080×1920，而我们把原始像素坐标塞进 750×1334 的页面，
 *   等于**整页比例全错且不报错** —— 直接违背「与效果图 100% 重合」。
 *   故缺省时必须跟随 IR 自己的画布。
 *
 * 注意：我们**不做自动缩放换算**。CLI 覆盖值与 IR 画布不一致时，只把
 * 「不一致」明确摆出来（`mismatch` + warning），交人确认。
 *
 * @param {Object} a
 * @param {{w:number,h:number}|null} [a.cliCanvas] 用户显式传入（parseCanvas 的结果）
 * @param {Object} [a.ir]
 * @returns {{canvas:{w:number,h:number,source:string,mismatch?:boolean,irCanvas?:Object},
 *            warnings:Object[]}}
 */
function resolveCanvas(a = {}) {
  const cli = a.cliCanvas && Number.isFinite(a.cliCanvas.w) && Number.isFinite(a.cliCanvas.h)
    ? { w: a.cliCanvas.w, h: a.cliCanvas.h } : null;
  const irCanvas = (a.ir && a.ir.source && a.ir.source.canvas
    && Number.isFinite(a.ir.source.canvas.w) && Number.isFinite(a.ir.source.canvas.h))
    ? { w: a.ir.source.canvas.w, h: a.ir.source.canvas.h } : null;

  if (cli) {
    const out = { w: cli.w, h: cli.h, source: 'cli' };
    if (irCanvas && (irCanvas.w !== cli.w || irCanvas.h !== cli.h)) {
      out.mismatch = true;
      out.irCanvas = { w: irCanvas.w, h: irCanvas.h };
      return {
        canvas: out,
        warnings: [{
          code: 'CANVAS_MISMATCH',
          msg: `--canvas ${cli.w}x${cli.h} 与 IR 画布 ${irCanvas.w}x${irCanvas.h} 不一致 ——`
            + 'IR 坐标**未做缩放换算**（绝对定位按原像素写入），请确认页面尺寸后再构建',
        }],
      };
    }
    return { canvas: out, warnings: [] };
  }
  if (irCanvas) {
    return { canvas: { w: irCanvas.w, h: irCanvas.h, source: 'ir' }, warnings: [] };
  }
  return {
    canvas: { w: DEFAULT_CANVAS.w, h: DEFAULT_CANVAS.h, source: 'default' },
    warnings: [{
      code: 'CANVAS_FALLBACK_DEFAULT',
      msg: `IR 未提供画布尺寸（source.canvas），已退回默认 ${DEFAULT_CANVAS.w}x${DEFAULT_CANVAS.h}`
        + ' —— 若真实设计稿尺寸不同，整页比例会错，请用 --canvas 显式指定',
    }],
  };
}

/**
 * 清洗**组件/页面名**：保留大小写（FGUI 组件名约定 PascalCase，如 `MailPagePopup`）。
 *
 * ★ 为什么不复用 normalizeName ★
 *   `normalizeName` 会小写化 + 去副本后缀（适合检索主键与节点名），
 *   但组件名是**外部契约**（引用方按名查找），改大小写等于改名。
 *   故组件/页面名只做「去目录/扩展名 + 非法字符压 _」，**保留原大小写**。
 *
 * @param {string} raw
 * @returns {string}
 */
function sanitizeComponentName(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw)
    .replace(/\\/g, '/')
    .split('/').pop() // 去目录（PSD 路径可能带目录）
    .replace(/\.[^.]+$/, '') // 去扩展名
    .replace(/[^\w\u4e00-\u9fa5]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'Page';
}

/**
 * 把任意名字清洗成合法的 FGUI 节点名片段。
 *
 * 复用 `normalizeName`（去副本后缀/扩展名/全半角/大小写/空格/繁简）**之后**，
 * 再把剩余的非字母数字/中文/下划线字符统一压成 `_`（避免生成带空格或标点的名字）。
 *
 * @param {string} raw
 * @param {Object} [opts] 透传 normalizeName
 * @returns {string}
 */
function sanitizeName(raw, opts) {
  const base = normalizeName(String(raw === undefined || raw === null ? '' : raw), opts);
  const cleaned = base
    .replace(/[^\w\u4e00-\u9fa5]+/g, '_') // 非 [字母数字_中文] → _
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'node';
}

/**
 * 页面名：显式指定优先（保留大小写），否则用 IR 的 psdPath 基名，最后退 'Page'。
 * @param {Object} ir
 * @param {string|undefined|null} explicit
 * @returns {string}
 */
function pickPageName(ir, explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return sanitizeComponentName(explicit);
  const pd = ir && ir.source && typeof ir.source.psdPath === 'string' ? ir.source.psdPath : '';
  if (pd) {
    const name = sanitizeComponentName(pd);
    if (name && name !== 'Page') return name;
  }
  return 'Page';
}

/**
 * bbox 是否覆盖给定画布（允许向外超出）。
 * @param {Object} bbox
 * @param {{w:number,h:number}} canvas
 * @returns {boolean}
 */
function coversCanvas(bbox, canvas) {
  if (!bbox || !canvas) return false;
  return bbox.x <= 0 && bbox.y <= 0
    && bbox.x + bbox.w >= canvas.w && bbox.y + bbox.h >= canvas.h;
}

/**
 * 识别背景层：**覆盖全画布**的层里面积最大的那个（并列取 IR 中更靠后者＝更靠底）。
 *
 * 参考画布优先用 IR 自带 `source.canvas`（设计稿自己的尺寸），缺失才退目标画布 ——
 * 因为「覆盖整个设计稿」才是背景的语义，与目标画布尺寸可能不同（不做缩放换算）。
 *
 * @param {Object[]} layers
 * @param {Object} ir
 * @param {{w:number,h:number}} canvas
 * @returns {string|null} layerId
 */
function detectBackgroundLayerId(layers, ir, canvas) {
  const ref = (ir && ir.source && ir.source.canvas
    && Number.isFinite(ir.source.canvas.w) && Number.isFinite(ir.source.canvas.h))
    ? { w: ir.source.canvas.w, h: ir.source.canvas.h }
    : canvas;
  let best = null;
  for (const l of layers || []) {
    if (!l || !l.bbox || !coversCanvas(l.bbox, ref)) continue;
    const area = l.bbox.w * l.bbox.h;
    if (!best || area >= best.area) best = { id: l.id, area }; // >= → 并列取更靠底（数组更后）
  }
  return best ? best.id : null;
}

/**
 * 取「可渲染叶子」（raster/smartobject/text），按 **底→顶** 排序。
 *
 * v1 拍平：group 容器不进 nodes（它们的 bbox 是子层并集，且 FGUI group 的语义
 * 与 PSD 分组并不等价）。该取舍在 plan.deferred 与 md 中显式说明，不静默。
 *
 * @param {Object[]} layers
 * @returns {{leaves:Object[], groupCount:number}}
 */
function collectLeavesBottomToTop(layers) {
  const list = Array.isArray(layers) ? layers : [];
  const leaves = [];
  let groupCount = 0;
  for (const l of list) {
    if (!l) continue;
    if (l.type === 'group') { groupCount++; continue; }
    if (!TAG_BY_TYPE[l.type]) continue; // 未知类型不猜，由调用方警告
    if (!l.bbox || !Number.isFinite(l.bbox.x) || !Number.isFinite(l.bbox.y)
      || !Number.isFinite(l.bbox.w) || !Number.isFinite(l.bbox.h)) continue;
    leaves.push(l);
  }
  // IR 是顶→底；FGUI 要底→顶
  leaves.reverse();
  return { leaves, groupCount };
}

/** 数字定点化（避免浮点尾巴破坏 B9；与 P0 round6 同语义）。 */
function round6(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

/**
 * 构造 create_plan（CREATE 模式核心）。
 *
 * @param {Object} args
 * @param {Object} args.ir design_ir.json
 * @param {Object} args.projectIndex project_index.json（只读；可为空对象）
 * @param {{w:number,h:number}} [args.canvas]
 * @param {string} [args.pageName]
 * @param {string} [args.pkg] 目标包名（缺省取索引里第一个包）
 * @param {Object} [args.normalizeOpts] 透传 normalizeName
 * @returns {Object} create_plan
 */
function buildCreatePlan(args = {}) {
  const ir = args.ir;
  if (!ir || typeof ir !== 'object' || !Array.isArray(ir.layers)) {
    throw new AppError(CODES.BAD_ARGUMENT, 'buildCreatePlan 需要含 layers[] 的 Design IR 对象');
  }
  const projectIndex = args.projectIndex && typeof args.projectIndex === 'object' ? args.projectIndex : {};
  // ★ P0：画布缺省跟随 IR（不再硬编码 750×1334）★
  const resolvedCanvas = resolveCanvas({ cliCanvas: args.canvas, ir });
  const canvas = resolvedCanvas.canvas;
  const warnings = resolvedCanvas.warnings.slice();
  const normOpts = args.normalizeOpts && typeof args.normalizeOpts === 'object'
    ? args.normalizeOpts : { stripCopySuffix: false, stripExtension: true, useVariants: true };

  const pkgs = (projectIndex.project && Array.isArray(projectIndex.project.packages))
    ? projectIndex.project.packages : [];
  const pkg = typeof args.pkg === 'string' && args.pkg.trim()
    ? args.pkg.trim()
    : (pkgs.length && pkgs[0].name ? String(pkgs[0].name) : null);

  const pageName = pickPageName(ir, args.pageName, normOpts);
  const { leaves, groupCount } = collectLeavesBottomToTop(ir.layers);
  const bgLayerId = detectBackgroundLayerId(leaves.slice().reverse(), ir, canvas);

  const nodes = [];
  const reused = [];
  const toImport = [];
  const unresolved = [];
  const deferred = { controllers: [], relations: [], listItems: [] };

  // ★ 层级编号：背景固定 0，其余按「底→顶」从 0（无背景）或 1（有背景）连续递增。
  //   不能直接用数组下标 —— 背景在 IR 里的位置可能不是最后一个（画师可能把它放顶层），
  //   直接下标会与「强制 0」撞号，导致排序退化。
  let nextLayer = bgLayerId !== null ? 1 : 0;

  leaves.forEach((layer, idx) => {
    const isBg = layer.id === bgLayerId;
    // 可见性：IR 明确不可见的图层不进 nodes（CREATE 只拼可见界面），但要留痕。
    // 放在最前面 —— 否则会白白消耗一个 layer 号，留下层号空洞。
    if (layer.visible === false) {
      warnings.push({
        code: 'LAYER_HIDDEN_SKIPPED', layerId: layer.id,
        msg: `图层 ${layer.id}（${layer.name}）在 PSD 中不可见，未生成节点（如需保留请人工补）`,
      });
      return;
    }
    const tag = TAG_BY_TYPE[layer.type];
    const businessName = isBg
      ? BG_NAME
      : `${PREFIX_BY_TYPE[layer.type] || 'img_'}${sanitizeName(layer.sliceName || layer.normName || layer.name, normOpts)}`;

    const node = {
      tempId: `N${idx + 1}`,
      tag,
      name: businessName,
      // ★ 层级：覆盖全画布的背景强制 0；其余按底→顶连续编号
      layer: isBg ? 0 : nextLayer++,
      attrs: { xy: `${layer.bbox.x},${layer.bbox.y}` },
      source: {
        layerId: layer.id,
        name: layer.name === undefined ? null : layer.name,
        bbox: { x: layer.bbox.x, y: layer.bbox.y, w: layer.bbox.w, h: layer.bbox.h },
      },
      confidence: 0.6, // 未定资源/存在 unresolved 时下调；下方 resolved 分支改回 1.0
      notes: [],
    };

    // ---- 尺寸：默认取 IR bbox（绝对定位，不缩放）----
    let sizeW = layer.bbox.w;
    let sizeH = layer.bbox.h;

    if (tag === 'image') {
      const keys = [layer.sliceName, layer.name, layer.normName].filter((k) => typeof k === 'string' && k);
      const hit = findExportedResource(projectIndex, pkg, keys, normOpts, { type: 'image' });

      if (hit.match) {
        const res = hit.match;
        node.attrs.src = String(res.id);
        reused.push({
          layerId: layer.id,
          resourceId: String(res.id),
          name: res.name === undefined ? null : res.name,
        });

        const rw = Number.isFinite(res.width) ? res.width : null;
        const rh = Number.isFinite(res.height) ? res.height : null;
        if (rw && rh) {
          const same = rw === sizeW && rh === sizeH;
          const bigger = sizeW > rw || sizeH > rh;
          const gridCapable = res.scale === '9grid'
            || (typeof res.scale9grid === 'string' && res.scale9grid.trim() !== '');
          if (!same && bigger && gridCapable) {
            // ⑥ 九宫格：摆放 > 固有 且资源具备 9grid 能力
            if (typeof res.scale9grid === 'string' && res.scale9grid.trim()) {
              node.attrs.scale9grid = res.scale9grid.trim();
              node.notes.push(`资源自带 scale9grid=${res.scale9grid.trim()}，按 9grid 拉伸`);
            } else {
              // 只有结果没有切格值 —— 不猜具体值
              node.notes.push('资源声明为 9grid 但 package.xml 未给切格值，需人工设置 scale9grid');
              unresolved.push({
                layerId: layer.id,
                reason: 'scale9grid-values-missing',
                hint: `资源 ${res.name || res.id} 标为 9grid 但无切格数据，已按原尺寸 ${rw}x${rh} 保守处理`,
              });
              sizeW = rw; sizeH = rh;
            }
          } else if (!same) {
            // ⑤ 图标/立绘：**等比缩放（上限 1，不放大） + 在 bbox 内居中**。
            //
            // ★ 为什么不是「保留固有尺寸」★（team-lead 实跑踩到）
            //   原实现只把 size 换成固有尺寸，xy 仍是 bbox 左上角 → 实际占位
            //   (bbox.x .. bbox.x+固有w) ，比设计稿**偏移** (固有w-bbox.w)/2。
            //   例：bbox 48×48 @ (340,700)、固有 96×96 → 占 (340..436)，
            //   而效果图要的是居中在 (340..388) —— 偏 24px，验收不合格
            //   （朋友原话「做到百分之百与效果图重合」）。
            //   SKILL.md 的原文是「不要拉大 size，**用等比缩放**，不设九宫格」，
            //   即：等比缩到装得下、但不放大；随之必须在 bbox 内居中。
            const scale = Math.min(layer.bbox.w / rw, layer.bbox.h / rh, 1);
            let fw = Math.round(rw * scale);
            let fh = Math.round(rh * scale);
            // round 可能进位一格 —— 夹回 bbox，保证「装得下」
            fw = Math.min(fw, layer.bbox.w);
            fh = Math.min(fh, layer.bbox.h);
            const fx = Math.round(layer.bbox.x + (layer.bbox.w - fw) / 2);
            const fy = Math.round(layer.bbox.y + (layer.bbox.h - fh) / 2);
            sizeW = fw;
            sizeH = fh;
            node.attrs.xy = `${fx},${fy}`;
            const scaleText = Number(scale.toFixed(4));
            node.notes.push(`IR bbox ${layer.bbox.w}x${layer.bbox.h} 与资源固有 ${rw}x${rh} 不一致：`
              + `按「等比缩放、不放大」缩放 scale=${scaleText} → ${fw}x${fh}，并在 bbox 内居中`);
            unresolved.push({
              layerId: layer.id,
              // ⚠ reason 保留 `non-uniform-scale`：这是既有契约名（e2e/下游已按此匹配），
              //   语义已从「不缩放」升级为「等比缩放 + 居中」，但改名会破坏契约，故只更新 hint。
              reason: 'non-uniform-scale',
              hint: `图标/立绘等比缩放 scale=${scaleText}（上限 1，不放大）→ size=${fw},${fh}`
                + `，居中 xy=${fx},${fy}（原 bbox ${layer.bbox.w}x${layer.bbox.h} @ `
                + `${layer.bbox.x},${layer.bbox.y}，固有 ${rw}x${rh}）`,
            });
          }
        }
        node.confidence = 1.0;
      } else if (hit.status === RESOURCE_MATCH.AMBIGUOUS) {
        // ④ 唯一性纪律：≥2 候选不猜
        node.notes.push(`资源匹配歧义（候选 ${hit.candidates.join(', ')}），未绑定 src`);
        unresolved.push({
          layerId: layer.id,
          reason: 'ambiguous-asset',
          hint: `归一化后命中多个资源，需人工选定：${hit.candidates.join(', ')}`,
        });
      } else if (hit.status === RESOURCE_MATCH.TYPE_MISMATCH) {
        node.notes.push('同名资源存在但不是图片类型，未绑定 src');
        toImport.push({
          layerId: layer.id,
          suggestedName: `${sanitizeName(layer.name, normOpts)}.png`,
          w: layer.bbox.w,
          h: layer.bbox.h,
          reason: `同名资源不是图片类型（${hit.candidates.join(', ')}）`,
        });
      } else {
        // 未登记 → toImport（绝不静默丢弃）
        toImport.push({
          layerId: layer.id,
          suggestedName: `${sanitizeName(layer.name, normOpts)}.png`,
          w: layer.bbox.w,
          h: layer.bbox.h,
          reason: '同包未找到匹配资源',
        });
        node.notes.push('同包未找到匹配资源，已列入待导入清单（toImport）');
      }
    }

    if (tag === 'text') {
      const t = layer.text && typeof layer.text === 'object' ? layer.text : null;
      if (t) {
        if (typeof t.value === 'string') node.attrs.text = t.value;
        if (typeof t.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(t.color)) {
          node.attrs.color = t.color; // 6 位铁律
        } else if (t.color !== undefined && t.color !== null) {
          warnings.push({
            code: 'TEXT_COLOR_REJECTED', layerId: layer.id,
            msg: `图层 ${layer.id} 的文本颜色 ${JSON.stringify(t.color)} 非 6 位 #RRGGBB，已拒绝写入`,
          });
        }
        if (Number.isFinite(t.fontSize)) {
          node.attrs.fontsize = t.fontSize;
          // ⑨ PSD 字号 → FGUI 字号是估计（无真实 FGUI 侧对账数据）
          node.estimated = true;
          node.estimatedFields = ['fontsize'];
          node.notes.push(`fontsize=${t.fontSize} 来自 PSD 文本尺寸，属估计值，需人工确认`);
        }
      } else {
        warnings.push({ code: 'TEXT_EMPTY', layerId: layer.id, msg: `图层 ${layer.id} 是 text 但无 text 数据` });
      }
      if (typeof layer.opacity === 'number' && layer.opacity < 1) {
        node.attrs.alpha = String(round6(layer.opacity));
      }
      node.confidence = node.estimated ? 0.8 : 1.0;
    }

    node.attrs.size = `${sizeW},${sizeH}`;

    nodes.push(node);
  });

  // ---- ⑦ 列表建议：同尺寸 + 同列纵向堆叠（≥2）----
  ensureUniqueNames(nodes); // 先消歧，后续建议/引用都以唯一名为准
  const stacks = detectVerticalStacks(nodes);
  for (const s of stacks) {
    deferred.listItems.push({
      suggestion: `Comp/${sanitizeComponentName(s.label)}Item`,
      sampleNode: s.tempIds[0],
      reason: `检测到 ${s.tempIds.length} 个同尺寸（${s.w}x${s.h}）且同列纵向堆叠的图片节点，`
        + '建议抽成列表项组件后挂 defaultItem（v1 不自动建组件）',
    });
  }

  // ---- ⑧ Controller / Relations：v1 一律 deferred ----
  const overlapped = detectOverlapping(nodes);
  if (overlapped.length >= 2) {
    deferred.controllers.push({
      suggestion: `ctrl_${sanitizeName(pageName, normOpts)}State`,
      members: overlapped.slice(0, 6),
      reason: `检测到 ${overlapped.length} 个完全重叠的节点，疑似互斥状态，建议用一个 controller 切换显隐（v1 不自动生成）`,
    });
  }
  deferred.relations.push({
    suggestion: '适配归组',
    // ★ advisory：对每一页都成立的通用建议，不计入 readiness 的 blocker ★
    advisory: true,
    reason: '全页绝对定位（xy/size 取 IR bbox，未做缩放换算）—— 需要屏幕适配时请人工加 Relations'
      + '（左右/上下居中 + 拉伸），v1 不自动生成',
  });

  if (groupCount > 0) {
    deferred.relations.push({
      suggestion: 'PSD 分组未映射为 FGUI group',
      reason: `IR 里有 ${groupCount} 个 group 容器；v1 拍平为绝对定位节点（PSD 分组与 FGUI group 语义不等价），`
        + '如需分组请人工确认',
    });
  }

  // ---- 排序：layer 升序（背景 0 最前），同 layer 按原顺序 ----
  nodes.sort((a, b) => (a.layer - b.layer) || (a.tempId < b.tempId ? -1 : a.tempId > b.tempId ? 1 : 0));

  const plan = {
    version: '0.1',
    mode: 'create',
    _comment: 'CREATE 模式的编辑脚本：**只由 Design IR + 工程索引生成**，'
      + '不需要任何已存在的组件 XML（与 PATCH 的本质区别）。'
      + 'v1 不调用 Bridge、不写任何 FGUI 文件；deferred 区块交由人工确认。'
      + '本文件可人工编辑（改 name/attrs/layer）后交给后续导入步骤。',
    _fieldNote: {
      'canvas.source': 'ir = 取自 Design IR 自带画布（默认）；cli = --canvas 显式指定；'
        + 'default = IR 与 CLI 都没有，已退回 750x1334（会发 warning）',
      'canvas.mismatch': 'true 表示 --canvas 与 IR 画布不一致；IR 坐标**未做缩放换算**，需人工确认',
      nodes: '页面直接子节点，按 layer 升序（0 = 最底，背景固定 img_bg）',
      'nodes[].attrs': 'xy/size 取 IR bbox（绝对定位，不做整体缩放换算）；'
        + '**例外**：资源固有尺寸与 bbox 不一致的图标/立绘，等比缩放（上限 1，不放大）并在 bbox 内居中',
      'nodes[].attrs.src': '同包短资源 ID（真实工程形态），**不是** ui:// 引用',
      'nodes[].estimated': 'true 表示含估计值（如 fontsize），需人工确认',
      assets: 'reused = 复用的同包资源；toImport = 需先导入并登记的素材（绝不静默丢弃）',
      deferred: 'controllers / relations / listItems —— v1 一律只给建议，不自动生成',
      unresolved: '结构性未决项（如 non-uniform-scale、ambiguous-asset），必须人工处理',
    },
    // ★ canvas.source 必须落盘：ir / cli / default —— 让人一眼看出坐标基准来自哪 ★
    canvas,
    page: { name: pageName, pkg, size: [canvas.w, canvas.h] },
    nodes,
    components: [], // v1 不建组件（列表项只在 deferred 给建议）
    assets: { reused, toImport },
    deferred,
    unresolved,
    warnings,
    summary: {
      nodes: nodes.length,
      reused: reused.length,
      toImport: toImport.length,
      deferred: deferred.controllers.length + deferred.relations.length + deferred.listItems.length,
      unresolved: unresolved.length,
    },
    // ★ 就绪度：把「计划生成成功」与「可以构建」分开（v0.3-C）★
    readiness: computeReadiness({ unresolved, toImport, deferred }),
  };

  return plan;
}

/**
 * 检测「同尺寸 + 同列纵向堆叠」的图片节点（列表建议用）。
 *
 * 保守启发式：仅当同 size、同 x、按 y 升序且相邻 y 间距一致或相近（差值 ≤ 2px）时成组。
 *
 * @param {Object[]} nodes
 * @returns {{label:string, w:number, h:number, tempIds:string[]}[]}
 */
function detectVerticalStacks(nodes) {
  const groups = new Map();
  for (const n of nodes || []) {
    if (n.tag !== 'image') continue;
    const [w, h] = String(n.attrs.size || '').split(',').map(Number);
    const [x, y] = String(n.attrs.xy || '').split(',').map(Number);
    if (![w, h, x, y].every(Number.isFinite)) continue;
    const key = `${w}x${h}@${x}`;
    const arr = groups.get(key) || [];
    arr.push({ tempId: n.tempId, y, w, h, x, label: n.name });
    groups.set(key, arr);
  }
  const out = [];
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => (a.y - b.y) || (a.tempId < b.tempId ? -1 : 1));
    // 间距一致性检查（相邻 y 差相等）
    const gaps = [];
    for (let i = 1; i < arr.length; i++) gaps.push(arr[i].y - arr[i - 1].y);
    const uniform = gaps.every((g) => Math.abs(g - gaps[0]) <= 2);
    if (!uniform) continue;
    out.push({
      label: arr[0].label, w: arr[0].w, h: arr[0].h, tempIds: arr.map((a) => a.tempId),
    });
  }
  // 确定性：按 tempIds 首个排序
  out.sort((a, b) => (a.tempIds[0] < b.tempIds[0] ? -1 : 1));
  return out;
}

/**
 * 检测完全重叠的节点（疑似互斥状态 → controller 建议）。
 *
 * ★ 用 `source.bbox`（设计稿真实几何）而不是 `attrs.size` ★
 *   `attrs.size` 可能因「禁止拉伸」被改成固有尺寸（见规则⑤），
 *   那之后再用它判重叠会**漏掉真实重叠**（设计上叠在一起的两个状态，输出尺寸不同了）。
 *
 * @param {Object[]} nodes
 * @returns {string[]} tempIds
 */
function detectOverlapping(nodes) {
  const map = new Map();
  for (const n of nodes || []) {
    const b = n.source && n.source.bbox ? n.source.bbox : null;
    if (!b) continue;
    const key = `${b.x},${b.y},${b.w},${b.h}`;
    const arr = map.get(key) || [];
    arr.push(n.tempId);
    map.set(key, arr);
  }
  const out = [];
  for (const arr of map.values()) if (arr.length >= 2) out.push(...arr);
  out.sort();
  return out;
}

/**
 * 节点名去重（确定性）：同名按出现顺序追加 `_2`、`_3`…
 *
 * FGUI 里 id 唯一但 name 可以重名；重名会让后续「按名引用/定位」产生歧义，
 * 而生成侧完全有能力避免 —— 故在这里直接消歧，不把歧义留给下游。
 *
 * @param {Object[]} nodes
 */
function ensureUniqueNames(nodes) {
  const used = new Map();
  for (const n of nodes || []) {
    const base = n.name;
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    if (count > 1) {
      n.name = `${base}_${count}`;
      n.notes.push(`重名消歧：原 name='${base}' 已存在，改为 '${n.name}'`);
    }
  }
}

/** 资源匹配「就绪度」状态（v0.3-C）。 */
const READINESS = Object.freeze({
  READY: 'ready',             // 无任何待人工项 → 可交给 Executor
  NEEDS_HUMAN: 'needs-human', // 有待导入素材或需处理的 deferred → 人先确认
  BLOCKED: 'blocked',         // 有 unresolved（结构性未决）→ 不能构建
});

/**
 * 计算 readiness（外部审查要求：别让「计划生成了」被当成「可以构建了」）。
 *
 * ★ 为什么必须有它 ★
 *   `ok: true` 只表示**规划文件生成成功**；即使有大量 toImport / unresolved /
 *   deferred，命令照样成功退出。未来的 Executor 若把 ok 当成「整页 UI 可成功生成」，
 *   就会在缺素材/结构未决的页面上强行构建 —— 这是灾难性误判。
 *
 * 判定优先级（lead 定）：unresolved → blocked；否则 toImport 或任何**需处理的**
 * deferred → needs-human；全空 → ready。
 *
 * ★ 关于 `advisory` ★
 *   `deferred.relations` 里有一条「绝对定位 → 请人工加 Relations」是**对每一页都
 *   成立的通用建议**，不是检测到的问题。若把它也计入 blocker，则任何页面永远不可能
 *   ready（`--strict` 恒为 4，失去意义）。故这类条目带 `advisory: true`，**不计入
 *   blocker**，但仍保留在 plan 与 md 里可见 —— 既不为难 CI，也不隐藏事实。
 *
 * @param {Object} a
 * @param {Object[]} [a.unresolved]
 * @param {Object[]} [a.toImport]
 * @param {Object} [a.deferred]
 * @returns {{status:string, blockers:{kind:string,count:number}[]}}
 */
function computeReadiness(a = {}) {
  const unresolved = Array.isArray(a.unresolved) ? a.unresolved : [];
  const toImport = Array.isArray(a.toImport) ? a.toImport : [];
  const d = a.deferred && typeof a.deferred === 'object' ? a.deferred : {};
  const actionableDeferred = [
    ...(Array.isArray(d.controllers) ? d.controllers : []),
    ...(Array.isArray(d.listItems) ? d.listItems : []),
    ...(Array.isArray(d.relations) ? d.relations : []).filter((r) => !(r && r.advisory === true)),
  ];

  const blockers = [];
  if (unresolved.length) blockers.push({ kind: 'unresolved', count: unresolved.length });
  if (toImport.length) blockers.push({ kind: 'toImport', count: toImport.length });
  if (actionableDeferred.length) blockers.push({ kind: 'deferred', count: actionableDeferred.length });

  const status = unresolved.length
    ? READINESS.BLOCKED
    : (blockers.length ? READINESS.NEEDS_HUMAN : READINESS.READY);
  return { status, blockers };
}

module.exports = {
  buildCreatePlan,
  parseCanvas,
  resolveCanvas,
  computeReadiness,
  READINESS,
  sanitizeName,
  sanitizeComponentName,
  pickPageName,
  coversCanvas,
  detectBackgroundLayerId,
  collectLeavesBottomToTop,
  detectVerticalStacks,
  detectOverlapping,
  ensureUniqueNames,
  DEFAULT_CANVAS,
  BG_NAME,
  TAG_BY_TYPE,
  PREFIX_BY_TYPE,
};
