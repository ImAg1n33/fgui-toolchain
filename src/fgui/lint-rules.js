'use strict';
/**
 * src/fgui/lint-rules.js —— 纯函数 lint（P1-a-02 / ARCHITECTURE §8.6 / 决策 11）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 契约（架构定死，不可违背）★
 *   纯函数：入参 XML 字符串，出参问题数组，**不碰文件系统、不碰网络**。
 *   因此 P0 阶段就能完整单测，P1 不用返工（ARCHITECTURE 决策 11）。
 *   需要外部信息（图片尺寸 / 九宫格特征）时由调用方**注入**（见 opts.resources），
 *   本模块自身永远不做 I/O —— 这也是它能被事务层复用的原因。
 *
 * ★ 每条规则的知识来源（docs/UPSTREAM-README.md 已核实事实）★
 *   R-00 XML 结构合法（可解析 + 根为 component + 无重复属性）
 *       上游：XML 非法如重复属性，编辑器双击会炸错误框；手写 XML 必须先 lint
 *   R-01 displayList 仅允许合法标签    上游 STANDARDS.md §2.6：共 10 种
 *       （UPSTREAM-FIX-2；高频发明错误 <input>/<movieclip> 拦截并教正确写法）
 *   R-02 extention 仅合法值            上游 STANDARDS（UPSTREAM-FIX-2 核对一致）→ 配置驱动
 *   R-03 颜色必须 6 位 + alpha 属性     上游实测：#RRGGBBAA 只取后 6 位 → 纯蓝
 *   R-04 ui:// 包 id 位数校验          上游事故：6 位吃 itemId 首字符，Q2 → 配置驱动
 *   R-05 scale9grid 格式 + 图片边界对账 上游 lint 已有；负值 warn（svg 怪癖）
 *   R-06 exported="true" 齐全          上游事故：漏则发布静默丢包
 *   R-07 id 序列 b000NN / c000NN       上游 STANDARDS（含唯一性）
 *   R-08 语义命名，禁 n0/n1             上游 STANDARDS，Q20 未确认 → 配置驱动
 *   R-09 单组件对象数 ≤ 80 告警        上游 STANDARDS，阈值可配置
 *   R-10 九宫格适用性                   复用 P0 src/imaging/grid9.js，不重写
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ★ 已知宽松放行（QA 第三轮独立攻击发现，P1-a 收口时 consciously 接受）★
 *   1. ~~大写 `UI://` scheme 跳过 R-04~~ —— **已修**（BUG-A 同轮）：识别改为
 *      大小写不敏感，大写变体现在也走包 id 位数校验；
 *   2. **根元素前后的垃圾文本被静默忽略**（严格 XML 非法）。
 *      理由：宽容模式的既定设计（宁可能解析出部分树再报结构错，也不要
 *      一遇脏数据就整体拒绝）；displayList 内的文本内容同样不参与规则。
 *   3. **属性值内裸 `<`**（如 `text="a < b"`）被放行（严格 XML 须 `&lt;`）。
 *      理由：FairyGUI 编辑器自身对属性值内容宽容；报错会误拦含 `<` 的
 *      合法文本（如 `text="a < b"` 的提示文案）。
 *   4. **`displayList > group` 内嵌的非法标签不查**（R-01 只查 displayList
 *      直接子级）。理由：R-01 的语义是「displayList 的直接子级必须是合法
 *      舞台对象类型」；group 是逻辑容器，其子级的合法性由 FairyGUI 自身
 *      结构约束保证（group 内同样只允许舞台对象，但不在本轮规则范围）。
 *   以上 2~4 均为低危，记录在此以免将来被当成漏报 bug 反复排查。
 *   另：真实编辑器版本（Q1）未确认，上述宽松度可能随 Q1 答案收紧。
 */

const { deepMerge } = require('../core/config');const {
  unescapeXml, parseXmlDocument, pathOf,
} = require('./xml-parse');
const { sortBy } = require('../core/determinism');
const { computeGrid9 } = require('../imaging/grid9');
// ★ R-04 改用共享解析器（同时支持 slash 与 concat 两种 ui:// 风格）★
//   M2-SPEC §4.2 ⑩：真实 FairyGUI 6.1.4 工程的引用是**拼接无斜杠**
//   （如 `ui://mailpkg1item001`）；R-04 原先自写的只认 slash 的正则会把整串当包 id
//   （14 位）→ 把合法引用判成「包 id 不是 8 位」+「缺少 itemId」两个 error。
const { parseUiRef } = require('./resource-resolver');
const {
  DEFAULT_FGUI_CONFIG, COLOR_HEX6_RE, COLOR_HEX8_RE, buildIdPattern,
} = require('./constants');

// ════════════════════════════════════════════════════════════════════════════
// 第一部分：XML 解析器（★ M1：已提炼到 ./xml-parse.js，与 indexer 共用同一份 ★）
// ════════════════════════════════════════════════════════════════════════════
//
// 为什么自己写而不用依赖：
//   1. 禁网红线 + 零安装约束下，引入 xml2js 之类的包不值得；
//   2. FGUI 组件 XML 是属性为中心的扁平结构（无命名空间、无混合内容），
//      一个 ~150 行的 tokenizer 足够，且能给出**行号**——lint 报错必须带位置。
// 3. 重复属性必须检出（上游：编辑器会炸错误框），通用解析器往往静默保留最后一个。

// ════════════════════════════════════════════════════════════════════════════
// 第二部分：配置解析
// ════════════════════════════════════════════════════════════════════════════

/**
 * 解析 lint 配置。
 *
 * 接受三种形态（都按「局部覆盖」语义与默认值深合并）：
 *   1. undefined                          → 全默认
 *   2. 完整配置对象（loadConfig 的返回值，含 .fgui 段）→ 取 config.fgui
 *   3. fgui 段本身（含 displayListTags 等键）→ 直接用
 *
 * @param {Object} [config]
 * @returns {Object} 合并后的 lint 配置（新对象，不改入参）
 */
function resolveLintConfig(config) {
  const base = JSON.parse(JSON.stringify(DEFAULT_FGUI_CONFIG));
  if (!config || typeof config !== 'object') return base;
  const section = (config.fgui && typeof config.fgui === 'object' && !Array.isArray(config.fgui))
    ? config.fgui
    : config;
  return deepMerge(base, section);
}

/**
 * 归一化资源信息表（图片尺寸 / 特征注入）。
 * @param {Object|Map} [resources]
 * @returns {Map<string, {w:number,h:number,features?:Object}>}
 */
function normalizeResources(resources) {
  // ★ 已是「资源表对象」（如 gen-dryrun 的 LintResourceTable：带 get/has 分派逻辑）★
  //   必须**原样返回**，否则会被 Object.entries 拆成 byUrl/localById 之类的属性，破坏其语义。
  if (!(resources instanceof Map)
      && resources && typeof resources === 'object'
      && typeof resources.get === 'function' && typeof resources.has === 'function') {
    return resources;
  }
  const map = new Map();
  if (resources instanceof Map) {
    for (const [k, v] of resources) map.set(k, v);
  } else if (resources && typeof resources === 'object') {
    for (const [k, v] of Object.entries(resources)) map.set(k, v);
  }
  return map;
}

/**
 * 按 ui:// 引用查资源信息（先全串匹配，再退化为末段资源名匹配）。
 * @param {Map<string,Object>} resMap
 * @param {string} ref
 * @returns {Object|null}
 */
function lookupResource(resMap, ref) {
  if (!ref || typeof ref !== 'string') return null;
  if (resMap.has(ref)) return resMap.get(ref);
  const tail = ref.split('/').pop();
  if (tail && resMap.has(tail)) return resMap.get(tail);
  return null;
}

/**
 * 统一解析「这个节点引用了哪个资源」—— R-05 / R-10 / R-11 **一处实现、三处复用**。
 *
 * ★ 为什么需要它（PATCH 兼容缺口，2026-10-21）★
 *   改造前 R-05/R-10 用 `firstUiRef()`，后者只认 `/^ui:\/\//`：
 *     · 真实工程 `<image src="q0jse">`（**短资源 ID**）→ ref=null → **尺寸检查直接跳过**；
 *     · 真实工程 `ui://mailpkg1item001`（**拼接无斜杠**）→ `lookupResource` 的
 *       `tail = ref.split('/').pop()` 拿到的是整串 → **同样命不中**。
 *   两者叠加的后果：九宫格那套保护（R-10 的胶囊事故防线）在真实工程形态下**静默失效**。
 *
 * 分步（按顺序）：
 *   1. `cfg.urlAttributes` 里**形态合法**的 `ui://` 引用 → `parseUiRef` 解析（天然支持
 *      slash 与 concat）→ 用**归一化键** `ui://<pkgId>/<itemId>` 查表（表就是按归一化键登记的）；
 *      查不到再把 `itemId` 当短 ID 查 `localById`（兼容"引用了别的包却只写了 id"的病态输入，
 *      命中时带回 note 提示人工确认）。
 *   2. `<image>` 的 `src` **不含 `://`** → 直接按短 ID 查 `localById`。
 *   3. 都拿不到 → 返回 `null` + **明确原因**（`no-ref` / `no-resources` / `unknown-resource`），
 *      由调用方写进告警/notes —— **绝不静默跳过**。
 *
 * @param {Object} node
 * @param {Object} resMap 资源表（LintResourceTable 或普通 Map）
 * @param {Object} cfg
 * @param {Object} [opts]
 * @param {boolean} [opts.shortIdOnly=false] 只走第 2 步（R-11 用）
 * @returns {{entry:Object|null, attr:string|null, raw:string|null,
 *            reason:null|'no-ref'|'no-resources'|'unknown-resource', note:string|null}}
 */
function resolveResourceReference(node, resMap, cfg, opts = {}) {
  const noRef = {
    entry: null, attr: null, raw: null, reason: 'no-ref', note: null,
  };
  if (!node || !node.attrs) return noRef;

  const localTable = resMap && resMap.localById ? resMap.localById : null;
  const localSize = localTable
    ? localTable.size
    : (resMap && typeof resMap.size === 'number' ? resMap.size : 0);
  const tableEmpty = !resMap || (typeof resMap.size === 'number' && resMap.size === 0);
  const shortIdMode = opts.shortIdOnly === true;

  const reasons = [];
  const getByKey = (key) => (resMap && typeof resMap.get === 'function' ? resMap.get(key) : null);
  const getLocal = (v) => (localTable ? localTable.get(v) : getByKey(v));
  const noResources = {
    entry: null, attr: null, raw: null, reason: 'no-resources', note: null,
  };

  // ── 第 1 步：形态合法的 ui:// 引用（短 ID 模式跳过）──
  if (!shortIdMode) {
    for (const attr of (cfg.urlAttributes || [])) {
      const raw = node.attrs[attr];
      if (typeof raw !== 'string' || !/^ui:\/\//i.test(raw)) continue;
      const parsed = parseUiRef(raw);
      if (!parsed) {
        reasons.push(`${attr}="${raw}" 不是合法 ui:// 引用`);
        continue;
      }
      // ★ 查表前必须先归一化 ★：表按 `ui://<pkgId>/<itemId>` 登记；
      //   直接拿原文查（concat 形态）永远命不中 —— 这正是原缺口。
      const key = `ui://${parsed.pkgId}/${parsed.itemId}`;
      const hit = getByKey(key);
      if (hit) {
        return {
          entry: hit, attr, raw, reason: null, note: null,
        };
      }
      // 兜底：把 itemId 当短 ID 查**本地表**（"引用了别的包却只写了 id"的病态输入）
      const byLocal = parsed.itemId ? getLocal(parsed.itemId) : null;
      if (byLocal) {
        return {
          entry: byLocal,
          attr,
          raw,
          reason: null,
          note: `${attr}="${raw}" 未按 ${key} 命中，已退化为按短 ID '${parsed.itemId}'`
            + ' 在**目标包**内命中 —— 请确认该引用是否本就该指向本包',
        };
      }
      reasons.push(`${attr}="${raw}" 指向的资源未登记（归一化键 ${key}）`);
    }
    if (tableEmpty) return noResources;
  }

  // ── 第 2 步：短资源 ID（image.src 且不含 ://）──
  const src = node.attrs.src;
  if (typeof src === 'string' && src.trim() && !src.includes('://')) {
    const val = src.trim();
    if (localSize === 0) return noResources;
    const hit = getLocal(val);
    if (hit) {
      return {
        entry: hit, attr: 'src', raw: src, reason: null, note: null,
      };
    }
    reasons.push(`src="${val}" 是短资源 ID，但目标包内没有该 id`);
    return {
      entry: null, attr: 'src', raw: src, reason: 'unknown-resource', note: reasons.join('；'),
    };
  }

  // ── 第 3 步：拿不到 ──
  if (!shortIdMode && reasons.length) {
    return {
      entry: null, attr: null, raw: null, reason: 'unknown-resource', note: reasons.join('；'),
    };
  }
  return noRef;
}

// ════════════════════════════════════════════════════════════════════════════
// 第三部分：规则实现
// ════════════════════════════════════════════════════════════════════════════
//
// 每个 check(ctx) 返回原始问题数组：
//   { severity:'error'|'warning', message:string, line:number|null, col:number|null,
//     node:Object|null, target:string|null }
// 引擎负责补 rule id / path / 排序。

/**
 * 深度遍历所有元素节点。
 * @param {Object|null} root
 * @param {(node:Object) => void} visit
 */
function walkElements(root, visit) {
  if (!root) return;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    visit(node);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
}

/**
 * 找所有 displayList 元素。
 * @param {Object|null} root
 * @returns {Object[]}
 */
function findDisplayLists(root) {
  const out = [];
  walkElements(root, (n) => { if (n.tag === 'displayList') out.push(n); });
  return out;
}

/**
 * 收集 displayList 下的所有显示对象（含嵌套）。
 * @param {Object|null} root
 * @returns {Object[]}
 */
function collectDisplayObjects(root) {
  const out = [];
  for (const dl of findDisplayLists(root)) {
    walkElements(dl, (n) => { if (n !== dl) out.push(n); });
  }
  return out;
}

/**
 * 按**指定属性清单**找第一个 ui:// 引用（R-04 专用）。
 *
 * ★ 为什么 R-04 用独立清单 `cfg.uiRefAttributes`（含 `font`）★
 *   它只服务"引用合法性校验"；而 `cfg.urlAttributes` 是"指向**可测量尺寸**的资源"，
 *   R-05/R-10 依赖它去量图片宽高。把 `font` 混进 urlAttributes 会让
 *   `<text font="ui://…">` 被当成引用了一张图 → 误报。
 *
 * ★ 已删除旧的 `firstUiRef(node, cfg)`（只认 `ui://`）★
 *   真实工程的短 ID `src="q0jse"` 在那里永远是 null，导致 R-05/R-10 **静默跳过**。
 *   现在"这个节点引用了哪个资源"统一走 `resolveResourceReference()`。
 *
 * @param {Object} node
 * @param {string[]} attrs
 * @returns {{attr:string, value:string}|null}
 */
function firstUiRefByAttrs(node, attrs) {
  for (const attr of attrs || []) {
    const v = node.attrs[attr];
    if (typeof v === 'string' && /^ui:\/\//i.test(v)) return { attr, value: v };
  }
  return null;
}

// ---- R-00：XML 结构合法 ----
function checkStructure(ctx) {
  const issues = [];
  for (const e of ctx.parsed.errors) {
    issues.push({
      severity: 'error',
      message: `XML 结构错误：${e.message}（第 ${e.line} 行）`,
      line: e.line, col: e.col, node: null, target: null,
    });
  }
  const root = ctx.parsed.root;
  if (!root) {
    issues.push({
      severity: 'error',
      message: 'XML 文档为空或没有可解析的根元素：组件 XML 必须以 <component> 为根',
      line: 1, col: 1, node: null, target: null,
    });
  } else if (root.tag !== 'component') {
    issues.push({
      severity: 'error',
      message: `根元素必须是 <component>（FGUI 组件 XML 的根），当前是 <${root.tag}>`
        + ' —— 编辑器加载时会直接报错',
      line: root.line, col: root.col, node: root, target: root.tag,
    });
  }
  return issues;
}

// ---- R-01：displayList 仅允许合法标签 ----
//
// ★ UPSTREAM-FIX-2：高频发明错误的「教学式」提示 ★
//   STANDARDS §2.6 点名了两类高频发明错误 —— 光说「不允许」不够，
//   错误信息必须教用户正确写法（ObjectType 名 ≠ XML 标签名）：
//     <input>     -> 输入框其实是 <text input="true" prompt="..."/>
//                    （ObjectType 叫 InputText，但 XML 标签就是 text + input 属性）
//     <movieclip> -> 序列帧动画其实是 <jta src="ui://..."/>
//                    （movieclip 只在 package.xml 里作资源登记标签，不上舞台）
const TAG_FIX_HINTS = Object.freeze({
  input: '输入框的正确写法是 <text input="true" prompt="请输入"/>'
    + '（ObjectType 叫 InputText，但 XML 标签就是 text + input 属性）',
  inputtext: '输入框的正确写法是 <text input="true" prompt="请输入"/>'
    + '（不存在 <inputtext> 标签：ObjectType 叫 InputText，XML 标签是 text + input 属性）',
  movieclip: '序列帧动画的正确写法是 <jta src="ui://包id/资源名"/>'
    + '（movieclip 只在 package.xml 里作资源登记标签，不上舞台）',
  swf: 'SWF 动画已不被 displayList 支持：请改用 <jta src="ui://包id/资源名"/>',
});

function checkDisplayListTags(ctx) {
  const issues = [];
  const legal = ctx.cfg.displayListTags;
  for (const dl of findDisplayLists(ctx.parsed.root)) {
    for (const child of dl.children) {
      if (!legal.includes(child.tag)) {
        const hint = TAG_FIX_HINTS[child.tag];
        issues.push({
          severity: 'error',
          message: `displayList 内不允许 <${child.tag}>：合法标签只有 ${legal.join(' / ')}`
            + `（依据上游 STANDARDS.md §2.6；配置项 fgui.displayListTags，`
            + `合作方版本如有差异可调整）`
            + (hint ? `。${hint}` : '')
            + `。位置：${pathOf(child)}`,
          line: child.line, col: child.col, node: child, target: child.tag,
        });
      }
    }
  }
  return issues;
}

// ---- R-02：extention 仅合法值 ----
function checkExtention(ctx) {
  const issues = [];
  const legal = ctx.cfg.extentionTypes;
  walkElements(ctx.parsed.root, (node) => {
    const v = node.attrs.extention;
    if (v === undefined) return;
    if (!legal.includes(v)) {
      issues.push({
        severity: 'error',
        message: `extention="${v}" 不是合法扩展类型：合法值为 ${legal.join(' / ')}`
          + `（依据上游 STANDARDS.md §2.6；配置项 fgui.extentionTypes，`
          + `合作方版本如有差异可调整）。位置：${pathOf(node)}`,
        line: node.line, col: node.col, node, target: v,
      });
    }
  });
  return issues;
}

// ---- R-03：颜色必须 6 位（+ alpha 属性按配置）----
function checkColors(ctx) {
  const issues = [];
  const attrNames = ctx.cfg.colorAttributes;
  walkElements(ctx.parsed.root, (node) => {
    for (const attr of attrNames) {
      const v = node.attrs[attr];
      if (v === undefined) continue;
      const at = node.attrPos[attr] || { line: node.line, col: node.col };
      if (COLOR_HEX8_RE.test(v)) {
        // ★ 上游实测：8 位色运行时只取后 6 位，#000000c8 → 纯蓝 ★
        issues.push({
          severity: 'error',
          message: `${attr}="${v}" 是 8 位色：上游实测运行时**只取后 6 位**`
            + `（#000000c8 会渲染成纯蓝），颜色必须写 6 位 #RRGGBB，`
            + `透明度改用 alpha="0.x" 属性（如 alpha="${(parseInt(v.slice(7), 16) / 255).toFixed(2)}"）。`
            + `位置：${pathOf(node)} 的 ${attr} 属性（第 ${at.line} 行）`,
          line: at.line, col: at.col, node, target: v,
        });
      } else if (!COLOR_HEX6_RE.test(v)) {
        issues.push({
          severity: 'error',
          message: `${attr}="${v}" 颜色格式非法：期望 6 位十六进制 #RRGGBB`
            + `（3 位缩写/命名色/8 位色都不合法）。位置：${pathOf(node)} 的 ${attr} 属性（第 ${at.line} 行）`,
          line: at.line, col: at.col, node, target: v,
        });
      }
    }
    // alpha 属性（若存在）必须合法
    const alpha = node.attrs.alpha;
    if (alpha !== undefined) {
      const n = Number(alpha);
      const at = node.attrPos.alpha || { line: node.line, col: node.col };
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        issues.push({
          severity: 'error',
          message: `alpha="${alpha}" 不是合法透明度：期望 0~1 的数字（如 alpha="0.5"）。`
            + `位置：${pathOf(node)} 的 alpha 属性（第 ${at.line} 行）`,
          line: at.line, col: at.col, node, target: alpha,
        });
      }
    }
    // 颜色必须配 alpha 属性（默认关闭，见 constants.js 注释）
    if (ctx.cfg.colorRequireAlpha) {
      const hasColor = attrNames.some((a) => node.attrs[a] !== undefined);
      if (hasColor && node.attrs.alpha === undefined) {
        issues.push({
          severity: 'error',
          message: `${pathOf(node)} 有颜色属性但缺少 alpha="0.x"：当前配置要求颜色必须显式声明透明度`
            + '（fgui.colorRequireAlpha，若上游规范不强制可改回 false）',
          line: node.line, col: node.col, node, target: null,
        });
      }
    }
  });
  return issues;
}

// ---- R-04：ui:// 包 id 位数校验（同时接受 slash 与 concat 两种风格）----
//
// ★ M2-SPEC §4.2 ⑩ 修正 ★
//   真实 FairyGUI 6.1.4 工程的引用是**拼接无斜杠**：`ui://mailpkg1item001`
//   （pkgId=mailpkg1, itemId=item001）。原实现自写正则 `/^ui:\/\/([^/]*)(?:\/(.*))?$/`
//   会把整串当 pkgId（14 位）→ 报「包 id 不是 8 位」+「缺少 itemId」**两个 error**，
//   把真实工程的**合法**引用判成错误。改用 `parseUiRef`（已同时支持两种风格），
//   拆分规则：concat 形态取「前 pkgIdLength 位为包 id、其余为 itemId」。
function checkUiRefs(ctx) {
  const issues = [];
  const want = ctx.cfg.pkgIdLength;
  walkElements(ctx.parsed.root, (node) => {
    // R-04 用**专用清单**（含 font）；未配置时退回 urlAttributes（旧配置兼容）
    const ref = firstUiRefByAttrs(node, ctx.cfg.uiRefAttributes || ctx.cfg.urlAttributes);
    if (!ref) return;
    const at = node.attrPos[ref.attr] || { line: node.line, col: node.col };
    const parsed = parseUiRef(ref.value);
    if (!parsed) {
      issues.push({
        severity: 'error',
        message: `${ref.attr}="${ref.value}" 不是合法 ui:// 引用：期望 `
        + `ui://<包id>/<资源名>（斜杠）或 ui://<包id><资源名>（拼接，上游编辑器风格）。`
        + `修复方向：补全包 id 与资源名。位置：${pathOf(node)} 的 ${ref.attr} 属性（第 ${at.line} 行）`,
        line: at.line, col: at.col, node, target: ref.value,
      });
      return;
    }
    // parseUiRef 现在「含 '/' 一律按 slash 拆」，故 pkgId 位数错误不再被掩藏
    if (parsed.pkgId.length !== want) {
      issues.push({
        severity: 'error',
        message: `${ref.attr}="${ref.value}" 的包 id '${parsed.pkgId}' 是 ${parsed.pkgId.length} 位，`
          + `应为 ${want} 位。上游事故：6 位包 id 会吃掉 itemId 首字符，导致 27 张图 + 组件`
          + '静默丢失（发布成功但内容缺）。修复方向：把包 id 补齐/改为 package.xml 里的 8 位 id。位置：'
          + `${pathOf(node)} 的 ${ref.attr} 属性（第 ${at.line} 行）`,
        line: at.line, col: at.col, node, target: parsed.pkgId,
      });
    }
    if (!parsed.itemId) {
      issues.push({
        severity: 'error',
        message: `${ref.attr}="${ref.value}" 缺少 itemId：ui:// 引用必须同时给出资源标识`
          + `（ui://<包id>/<资源名> 或 ui://<包id><资源名>）。修复方向：补上 itemId。位置：`
          + `${pathOf(node)} 的 ${ref.attr} 属性（第 ${at.line} 行）`,
        line: at.line, col: at.col, node, target: ref.value,
      });
    }
    // ★ P1：包 id **存在性**（不只是位数）★
    //   拼接形态尤其容易错配（8 位 + 合法长度 ≠ 存在的包）。索引里有包清单时才判断，
    //   且默认只 **warning** —— 索引不完整（只扫了部分包）时不该把合法引用判成 error。
    const pkgs = ctx.packages || [];
    if (pkgs.length) {
      const known = pkgs.some((p) => p && (String(p.id) === parsed.pkgId || String(p.name) === parsed.pkgId));
      if (!known) {
        issues.push({
          severity: 'warning',
          message: `${ref.attr}="${ref.value}" 的包 id '${parsed.pkgId}' 不在本次工程索引的包清单里`
            + `（已知包：${pkgs.map((p) => (p.id || p.name)).join(', ')}）—— 可能是跨工程引用、`
            + '索引不完整，或包 id 错配。修复方向：核对 package.xml 的包 id 或重跑 project-index。位置：'
            + `${pathOf(node)} 的 ${ref.attr} 属性（第 ${at.line} 行）`,
          line: at.line, col: at.col, node, target: parsed.pkgId,
        });
      }
    }
  });
  return issues;
}

// ---- R-11：短资源 ID `src` 的登记性校验 ----
//
// ★ 为什么需要（M2-SPEC §4.2 ⑩）★
//   真实工程里组件内 `<image>` 引用**同包**图片用的是**短资源 ID**：
//     `src="q0jse"`（即 package.xml 里 `resources[].id`），**不带 `ui://`**。
//   改了形态之后 R-04 检不到它们（R-04 只看 `ui://`），于是会丢掉
//   「这个引用指向的资源是否存在」这一层保护 —— 本规则补上。
//
// 边界（刻意不做，避免噪声/越权）：
//   · 只对 `<image>` 的 `src` 生效；其它属性/标签的 `ui://` 交给 R-04；
//   · 值里含 `://` → 交给 R-04，本规则不重复报；
//   · `resources` 未注入（空表）→ **整条规则跳过**（无登记信息时无法判断，
//     宁可不动；`LINT_RESOURCES_EMPTY` 已经会就"资源表为空"发出显式告警）。
function checkShortSrcRefs(ctx) {
  const issues = [];
  const resMap = ctx.resources;
  if (!resMap || typeof resMap.get !== 'function') return issues;
  // ★ P0：只有**目标包**有资源信息时才具备判断能力 ★
  //   别的包有资源不能构成"能判断这个短 ID" —— 否则跨包同名会误判（曾把 Common 的
  //   component 当成 Mail 里的引用目标）。表对象用 localById 计量；普通 Map 退回 size。
  const localSize = (resMap.localById && typeof resMap.localById.size === 'number')
    ? resMap.localById.size
    : resMap.size;
  // 未注入/目标包无资源信息 → 跳过（不产生噪声；空表告警由 gen-dryrun 的 LINT_RESOURCES_EMPTY 负责）
  if (localSize === 0) return issues;

  walkElements(ctx.parsed.root, (node) => {
    if (node.tag !== 'image') return;
    const raw = node.attrs.src;
    if (typeof raw !== 'string') return;
    const val = raw.trim();
    if (!val) return;
    if (val.includes('://')) return; // ui:// 形态 → R-04 负责

    const at = node.attrPos.src || { line: node.line, col: node.col };
    // ★ 复用统一解析入口（shortIdOnly）★
    //   短 ID 只查**目标包的 id**（不回退 name：撞键场景会静默放行，见 P0 修复）。
    const resolved = resolveResourceReference(node, resMap, ctx.cfg, { shortIdOnly: true });
    const hit = resolved.entry;
    if (!hit) {
      issues.push({
        severity: 'error',
        message: `image 的 src="${val}" 是短资源 ID，但目标包 resources[] 里**没有**这个 id`
          + ' —— 引用会静默失效（发布成功但图片不显示）。请核对 package.xml 是否登记该资源，'
          + '或改用 ui:// 引用。位置：'
          + `${pathOf(node)} 的 src 属性（第 ${at.line} 行）`,
        line: at.line, col: at.col, node, target: val,
      });
      return;
    }
    // 命中项若带 type 且不是 image → 引用了非图片资源（组件/字体等）
    if (hit.type !== undefined && hit.type !== null && hit.type !== 'image') {
      issues.push({
        severity: 'error',
        message: `image 的 src="${val}" 指向的是 type='${hit.type}' 的资源，不是图片`
          + ' —— 图片节点的 src 必须引用图片资源，否则运行时不渲染。位置：'
          + `${pathOf(node)} 的 src 属性（第 ${at.line} 行）`,
        line: at.line, col: at.col, node, target: val,
      });
    }
  });
  return issues;
}

// ---- R-05：scale9grid 格式 + 图片边界对账 ----
function checkScale9Grid(ctx) {
  const issues = [];
  const stats = ctx.stats.scale9;
  walkElements(ctx.parsed.root, (node) => {
    const v = node.attrs.scale9grid;
    if (v === undefined) return;
    const at = node.attrPos.scale9grid || { line: node.line, col: node.col };
    const parts = String(v).split(',');
    const allInt = parts.every((p) => /^-?\d+$/.test(p.trim()));
    if (parts.length !== 4 || !allInt) {
      issues.push({
        severity: 'error',
        message: `scale9grid="${v}" 格式非法：期望 "l,t,w,h" 4 个整数（左,上,中心宽,中心高），`
          + '如 scale9grid="10,10,460,300"。位置：'
          + `${pathOf(node)} 的 scale9grid 属性（第 ${at.line} 行）`,
        line: at.line, col: at.col, node, target: v,
      });
      return;
    }
    const nums = parts.map((p) => parseInt(p.trim(), 10));
    const hasNegative = nums.some((n) => n < 0);
    if (hasNegative) {
      // 官方编辑器从 svg 导入时会产生负值 —— 告警不拦截，避免误拦（上游 lint 同款策略）
      issues.push({
        severity: 'warning',
        message: `scale9grid="${v}" 含负值：官方编辑器从 svg 导入时会出现这种值，`
          + '通常无害但请人工确认是否符合预期。位置：'
          + `${pathOf(node)} 的 scale9grid 属性（第 ${at.line} 行）`,
        line: at.line, col: at.col, node, target: v,
      });
      return;
    }
    // 边界对账：需要调用方注入图片尺寸（本模块不做 I/O）
    //   ★ 用统一解析入口（支持短 ID 与 concat/slash 两种 ui://）★
    const resolved = resolveResourceReference(node, ctx.resources, ctx.cfg);
    const info = resolved.entry;
    if (resolved.note && resolved.reason === null) {
      // 退化命中（跨包引用却只写了短 ID）—— 不静默，提示人工确认
      issues.push({
        severity: 'warning',
        message: `scale9grid 资源解析降级：${resolved.note}。位置：`
          + `${pathOf(node)} 的 scale9grid 属性（第 ${at.line} 行）`,
        line: at.line, col: at.col, node, target: v,
      });
    }
    if (!info || !Number.isFinite(info.w) || !Number.isFinite(info.h)) {
      stats.sizeUnknown++;
      // 引用指向未知资源 → 不静默（warning，不是 error：索引不完整时不误伤）
      if (resolved.reason === 'unknown-resource') {
        issues.push({
          severity: 'warning',
          message: `scale9grid 无法对账（尺寸未知）：${resolved.note}`
            + ' —— 九宫格边界检查已跳过，请核对资源登记或重跑 project-index。位置：'
            + `${pathOf(node)} 的 scale9grid 属性（第 ${at.line} 行）`,
          line: at.line, col: at.col, node, target: v,
        });
      }
      return;
    }
    stats.checked++;
    const [l, t, w, h] = nums;
    if (l + w > info.w || t + h > info.h) {
      issues.push({
        severity: 'error',
        message: `scale9grid="${v}" 越界：中心矩形 (${l},${t},${w}x${h}) 超出图片 `
          + `${resolved.raw || resolved.attr} 的尺寸 `
          + `${info.w}x${info.h}（右边界 ${l + w} > ${info.w} 或 下边界 ${t + h} > ${info.h}）——`
          + '上游 resolveScale9Grid 对越界直接抛错，运行期会炸。位置：'
          + `${pathOf(node)} 的 scale9grid 属性（第 ${at.line} 行）`,
        line: at.line, col: at.col, node, target: v,
      });
    }
  });
  return issues;
}

// ---- R-06：exported="true" 齐全 ----
function checkExported(ctx) {
  const issues = [];
  if (!ctx.cfg.exportedRequired) return issues;
  const root = ctx.parsed.root;
  if (!root || root.tag !== 'component') return issues; // 根不对由 R-00 报
  const v = root.attrs.exported;
  if (v === undefined) {
    issues.push({
      severity: 'error',
      message: '组件缺少 exported="true"：上游事故 —— 漏写会导致发布时该组件被静默跳过'
        + '（发布成功但包里没有它）。位置：根元素 <component>',
      line: root.line, col: root.col, node: root, target: null,
    });
  } else if (v !== 'true') {
    issues.push({
      severity: 'error',
      message: `exported="${v}"：发布时该组件会被跳过（静默丢包），应为 exported="true"。`
        + '位置：根元素 <component>',
      line: root.line, col: root.col, node: root, target: v,
    });
  }
  return issues;
}

// ---- R-07：id 序列 + 唯一性 ----
function checkIds(ctx) {
  const issues = [];
  const pattern = buildIdPattern(ctx.cfg.idPrefixes, ctx.cfg.idDigits);
  const seen = new Map();
  for (const node of collectDisplayObjects(ctx.parsed.root)) {
    const id = node.attrs.id;
    if (id === undefined || id === '') {
      issues.push({
        severity: 'error',
        message: `显示对象缺少 id：${pathOf(node)}（第 ${node.line} 行）。FGUI 用 id 标识舞台对象，`
          + '缺失会导致编辑器加载异常',
        line: node.line, col: node.col, node, target: null,
      });
      continue;
    }
    if (!pattern.test(id)) {
      const prefixSample = (ctx.cfg.idPrefixes && ctx.cfg.idPrefixes[0]) || 'b';
      issues.push({
        severity: 'error',
        message: `id="${id}" 不符合 id 序列规范：期望 ${ctx.cfg.idPrefixes.join('/')} + ${ctx.cfg.idDigits} 位序号`
          + `（如 ${prefixSample}${String(1).padStart(ctx.cfg.idDigits, '0')}）。位置：${pathOf(node)}`,
        line: node.line, col: node.col, node, target: id,
      });
    }
    seen.set(id, (seen.get(id) || 0) + 1);
  }
  for (const [id, count] of [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (count > 1) {
      issues.push({
        severity: 'error',
        message: `id="${id}" 重复出现 ${count} 次：id 必须唯一，否则编辑器无法区分舞台对象`,
        line: null, col: null, node: null, target: id,
      });
    }
  }
  return issues;
}

// ---- R-08：语义命名 ----
function checkNames(ctx) {
  const issues = [];
  const patterns = (ctx.cfg.bannedNamePatterns || []).map((p) => {
    try {
      return { src: p, re: new RegExp(p, 'i') };
    } catch {
      return { src: p, re: null };
    }
  });
  for (const node of collectDisplayObjects(ctx.parsed.root)) {
    const name = node.attrs.name;
    if (name === undefined) continue; // 缺 name 由 R-07 之外的约定处理，不重复报
    if (!name.trim()) {
      issues.push({
        severity: 'error',
        message: `对象名为空：${pathOf(node)}（第 ${node.line} 行）。STANDARDS 要求业务语义命名`
          + '（如 popup_bg / btn_close / reward_list）',
        line: node.line, col: node.col, node, target: name,
      });
      continue;
    }
    for (const p of patterns) {
      if (p.re && p.re.test(name)) {
        issues.push({
          severity: 'error',
          message: `对象名 "${name}" 无语义（命中禁用模式 ${p.src}）：STANDARDS 要求业务语义命名`
            + `（如 popup_bg / btn_close / reward_list），禁止 n0/img1 这类生成器默认名。`
            + `位置：${pathOf(node)}（第 ${node.line} 行）`,
          line: node.line, col: node.col, node, target: name,
        });
        break; // 一个名字报一次即可
      }
    }
  }
  return issues;
}

// ---- R-09：单组件对象数 ----
function checkObjectCount(ctx) {
  const issues = [];
  const objs = collectDisplayObjects(ctx.parsed.root);
  const max = ctx.cfg.maxObjectsPerComponent;
  if (objs.length > max) {
    issues.push({
      severity: 'warning',
      message: `组件含 ${objs.length} 个显示对象，超过建议上限 ${max}（配置项 fgui.maxObjectsPerComponent）：`
        + '考虑拆分为多个组件，或把重复结构改写成列表/循环（上游 STANDARDS）',
      line: null, col: null, node: null, target: String(objs.length),
    });
  }
  return issues;
}

// ---- R-10：九宫格适用性（复用 P0 grid9.js）----
function checkGrid9(ctx) {
  const issues = [];
  const stats = ctx.stats.grid9;
  if (!ctx.cfg.grid9LintEnabled) {
    stats.skipped = 'disabled';
    return issues;
  }
  const thresholds = ctx.grid9Thresholds;
  walkElements(ctx.parsed.root, (node) => {
    if (node.attrs.scale9grid === undefined) return;
    // ★ 用统一解析入口：短 ID 与 concat/slash 两种 ui:// 都能拿到资源 ★
    //   （改前 `firstUiRef` 只认 `ui://`，真实工程的 `src="q0jse"` 直接 ref=null → 静默跳过）
    const resolved = resolveResourceReference(node, ctx.resources, ctx.cfg);
    const info = resolved.entry;
    if (!info || !info.features) {
      stats.noFeatures++;
      return; // 「未提供 features」已由 notes 显式说明（不静默）；未知资源由 R-05 报 warning，避免重复
    }
    stats.checked++;
    const r = computeGrid9(info.features, thresholds);
    if (r.verdict === 'NEVER') {
      issues.push({
        severity: 'warning',
        message: `${pathOf(node)} 对图片 ${resolved.raw || resolved.attr} 设置了 scale9grid，但九宫格启发式判定为 NEVER`
          + `（禁切）：${r.evidence.join('；')}。拉伸可能破形（线上事故方向）。`
          + '注意：启发式有已知误判（HANDOFF-P1 §2.1 六项），此处只告警不拦截，请人工确认',
        line: node.line, col: node.col, node, target: resolved.raw || resolved.attr,
      });
    }
    // CAN_9GRID / SINGLE_AXIS_ONLY 不产 finding：
    //   SINGLE_AXIS_ONLY 的建议格式待 Q17 确认，未确认前不出建议（避免把错建议当规则）。
  });
  return issues;
}

/** 规则表（顺序即 stats.rulesChecked 的顺序）。 */
const RULES = Object.freeze([
  { id: 'R-00', title: 'XML 结构合法（可解析 / 根为 component / 无重复属性）', check: checkStructure },
  { id: 'R-01', title: 'displayList 仅允许合法标签', check: checkDisplayListTags },
  { id: 'R-02', title: 'extention 仅合法值', check: checkExtention },
  { id: 'R-03', title: '颜色必须 6 位 + alpha 属性', check: checkColors },
  { id: 'R-04', title: 'ui:// 包 id 位数校验', check: checkUiRefs },
  { id: 'R-05', title: 'scale9grid 格式合法 + 图片边界对账', check: checkScale9Grid },
  { id: 'R-06', title: 'exported="true" 齐全', check: checkExported },
  { id: 'R-07', title: 'id 序列规范 + 唯一性', check: checkIds },
  { id: 'R-08', title: '语义命名（禁无语义名）', check: checkNames },
  { id: 'R-09', title: '单组件对象数上限', check: checkObjectCount },
  { id: 'R-10', title: '九宫格适用性（复用 grid9.js）', check: checkGrid9 },
  { id: 'R-11', title: '短资源 ID src 的登记性校验（image src 不含 ui://）', check: checkShortSrcRefs },
]);

// ════════════════════════════════════════════════════════════════════════════
// 第四部分：入口
// ════════════════════════════════════════════════════════════════════════════

/**
 * lint 一份组件 XML。
 *
 * @param {string|Object} xml XML 字符串，或 parseXmlDocument 的返回值 / 其 .root
 * @param {Object} [opts]
 * @param {Object} [opts.config] 配置（完整配置或 fgui 段，见 resolveLintConfig）
 * @param {string} [opts.fileName] 文件名（仅用于报错可读性）
 * @param {Object|Map} [opts.resources] 资源注入：ui:// 引用 → { w, h, features }
 *        （R-05 边界对账与 R-10 九宫格用；本模块不做 I/O，由调用方提供）
 * @returns {{ok:boolean, fileName:string|null, errors:Object[], warnings:Object[],
 *            notes:string[], stats:Object}}
 */
function lintComponentXml(xml, opts = {}) {
  const cfg = resolveLintConfig(opts.config);
  const fileName = opts.fileName || null;

  let parsed;
  if (typeof xml === 'string' || xml === null || xml === undefined) {
    // ★ BUG-A 兜底：解析路径上的任何未预期异常都转成 R-00 结构化错误，
    //   绝不让裸异常冲出 lint（事务层依赖「lint 要么返回结果要么抛 AppError」）★
    try {
      parsed = parseXmlDocument(xml);
    } catch (err) {
      parsed = {
        root: null,
        decl: null,
        errors: [{
          message: `XML 解析器未预期失败（这是工具缺陷，已按结构错误拦截而非崩溃）：${err.message}`,
          line: 1, col: 1,
        }],
      };
    }
  } else if (xml.root && Array.isArray(xml.errors)) {
    parsed = xml; // 已是 parseXmlDocument 的返回值
  } else if (xml.tag) {
    parsed = { root: xml, decl: null, errors: [] }; // 已是节点
  } else {
    parsed = { root: null, decl: null, errors: [{ message: '入参既不是 XML 字符串也不是可识别的解析结果', line: 1, col: 1 }] };
  }

  const ctx = {
    parsed,
    cfg,
    fileName,
    resources: normalizeResources(opts.resources),
    // R-04 的「包 id 是否存在」warning 用；空数组 = 不做该判断（索引不完整时不误伤）
    packages: Array.isArray(opts.packages) ? opts.packages : [],
    grid9Thresholds: (opts.config && opts.config.grid9) || undefined,
    stats: {
      elements: 0,
      displayObjects: 0,
      scale9: { checked: 0, sizeUnknown: 0 },
      grid9: { checked: 0, noFeatures: 0, skipped: null },
      rulesChecked: RULES.map((r) => r.id),
    },
  };
  walkElements(parsed.root, () => { ctx.stats.elements++; });
  ctx.stats.displayObjects = collectDisplayObjects(parsed.root).length;

  const errors = [];
  const warnings = [];
  for (const rule of RULES) {
    let raw = [];
    try {
      raw = rule.check(ctx) || [];
    } catch (err) {
      // 规则自身崩溃 = 实现缺陷，按 error 上报而不是静默跳过（§8.1 禁止静默吞异常）
      errors.push({
        rule: rule.id,
        severity: 'error',
        message: `lint 规则 ${rule.id} 自身执行失败（这是工具 bug，不是 XML 问题）：${err.message}`,
        line: null, col: null, path: '(lint-internal)', target: null,
      });
      continue;
    }
    for (const issue of raw) {
      const entry = {
        rule: rule.id,
        severity: issue.severity === 'warning' ? 'warning' : 'error',
        message: issue.message,
        line: issue.line === undefined ? null : issue.line,
        col: issue.col === undefined ? null : issue.col,
        path: issue.node ? pathOf(issue.node) : '(document)',
        target: issue.target === undefined ? null : issue.target,
      };
      if (entry.severity === 'warning') warnings.push(entry);
      else errors.push(entry);
    }
  }

  // 确定性排序：行 → 列 → 规则 → 信息（同一输入两次 lint 结果逐字节一致，B9）
  const sortIssues = (arr) => sortBy(
    arr,
    (i) => (i.line === null ? 1e9 : i.line),
    (i) => (i.col === null ? 1e9 : i.col),
    (i) => i.rule,
    (i) => i.path,
    (i) => i.message,
  );

  const notes = [];
  if (ctx.stats.scale9.sizeUnknown > 0) {
    notes.push(`R-05：${ctx.stats.scale9.sizeUnknown} 个 scale9grid 因调用方未提供图片尺寸（opts.resources），`
      + '只校验了格式、未做边界对账（非静默跳过：stats.scale9.sizeUnknown 有计数）');
  }
  if (ctx.stats.grid9.noFeatures > 0) {
    notes.push(`R-10：${ctx.stats.grid9.noFeatures} 个带 scale9grid 的对象因调用方未提供 features，`
      + '未做九宫格适用性检查（非静默跳过：stats.grid9.noFeatures 有计数）');
  }

  return {
    ok: errors.length === 0,
    fileName,
    errors: sortIssues(errors),
    warnings: sortIssues(warnings),
    notes,
    stats: ctx.stats,
  };
}

module.exports = {
  lintComponentXml,
  parseXmlDocument,
  pathOf,
  resolveLintConfig,
  RULES,
  // 供测试与上层复用的内部件（导出即契约，勿随意改语义）
  unescapeXml,
  walkElements,
  collectDisplayObjects,
  findDisplayLists,
  // 统一资源引用解析入口（R-05/R-10/R-11 共用；导出以便单测与后续复用）
  resolveResourceReference,
};
