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

const { deepMerge } = require('../core/config');
const { sortBy } = require('../core/determinism');
const { computeGrid9 } = require('../imaging/grid9');
const {
  DEFAULT_FGUI_CONFIG, COLOR_HEX6_RE, COLOR_HEX8_RE, buildIdPattern,
} = require('./constants');

// ════════════════════════════════════════════════════════════════════════════
// 第一部分：最小 XML 解析器（内部实现，lint 的唯一输入通道）
// ════════════════════════════════════════════════════════════════════════════
//
// 为什么自己写而不用依赖：
//   1. 禁网红线 + 零安装约束下，引入 xml2js 之类的包不值得；
//   2. FGUI 组件 XML 是属性为中心的扁平结构（无命名空间、无混合内容），
//      一个 ~150 行的 tokenizer 足够，且能给出**行号**——lint 报错必须带位置。
// 3. 重复属性必须检出（上游：编辑器会炸错误框），通用解析器往往静默保留最后一个。

/** XML 实体表。 */
const XML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

/**
 * Unicode 码点合法上界（String.fromCodePoint 的硬限制）。
 * 越界码点（如 &#x110000;）会让 fromCodePoint 抛 RangeError ——
 * BUG-A 的根因就是没校验这一项。
 */
const MAX_CODE_POINT = 0x10FFFF;

/**
 * 反转 XML 实体。
 *
 * ★ BUG-A 修复 ★（QA 第三轮独立发现）
 *   原实现只校验 `code >= 0`，`&#x110000;` / `&#99999999999;` 会让
 *   `String.fromCodePoint()` 抛 **未捕获 RangeError**，lint 整体崩溃
 *   （经事务层传播为裸异常，退出码契约失效）。真实触发形态：用户把
 *   `&#x1F600;`（emoji）多打一个 0 成 `&#x1F6000;` —— 手滑完全可能。
 *   现改为：越界码点不抛异常，经 `onBad` 回调上报（由 parseXmlDocument
 *   转成带位置的 R-00 可读错误），属性值里**原样保留**该实体文本。
 *
 * @param {string} s
 * @param {Function} [onBad] 越界实体回调：(rawEntity, code) => void
 * @returns {string}
 */
function unescapeXml(s, onBad) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > MAX_CODE_POINT) {
        if (typeof onBad === 'function') onBad(all, Number.isFinite(code) ? code : NaN);
        return all; // 原样保留，让上层报可读错误而不是崩溃
      }
      return String.fromCodePoint(code);
    }
    const hit = XML_ENTITIES[body];
    return hit === undefined ? all : hit;
  });
}

/**
 * 解析 XML 文档（宽容模式：尽量解析出部分树，错误收集到 errors）。
 *
 * 节点结构：
 *   { tag, attrs:{name:value}, attrPos:{name:{line,col}}, children:[], text, line, col, parent }
 *
 * @param {string} text XML 源码
 * @returns {{root:Object|null, decl:string|null, errors:{message:string,line:number,col:number}[]}}
 */
function parseXmlDocument(text) {
  const src = text === null || text === undefined ? '' : String(text);
  const errors = [];

  // 行起始偏移表 → O(log n) 定位（组件 XML 通常 < 100KB，线性也够，但这更稳）
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  /**
   * @param {number} pos
   * @returns {{line:number, col:number}}
   */
  const locate = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: pos - lineStarts[lo] + 1 };
  };

  const root = {
    tag: '#document', attrs: {}, attrPos: {}, children: [], text: '', line: 1, col: 1, parent: null,
  };
  const stack = [root];
  let decl = null;
  let pos = 0;

  // ★ BUG-A：实体越界收集器（带位置，转 R-00 可读错误）★
  const badEntities = [];
  /** 当前反转义操作的定位上下文（属性位置或节点位置）。 */
  let entityPos = { line: 1, col: 1 };
  const onBadEntity = (raw, code) => {
    badEntities.push({ raw, code, line: entityPos.line, col: entityPos.col });
  };

  /**
   * 跳过空白。
   * @param {number} i
   * @returns {number}
   */
  const skipWs = (i) => {
    while (i < src.length && /\s/.test(src[i])) i++;
    return i;
  };

  while (pos < src.length) {
    const lt = src.indexOf('<', pos);
    if (lt < 0) break;
    // 标签前的文本内容（只保留非空白，lint 不需要混合内容语义）
    const between = src.slice(pos, lt);
    if (between.trim()) {
      const top = stack[stack.length - 1];
      top.text += between;
    }

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) {
        const p = locate(lt);
        errors.push({ message: 'XML 注释未闭合（缺少 -->）', line: p.line, col: p.col });
        break;
      }
      pos = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end < 0) {
        const p = locate(lt);
        errors.push({ message: 'CDATA 节未闭合（缺少 ]]>）', line: p.line, col: p.col });
        break;
      }
      stack[stack.length - 1].text += src.slice(lt + 9, end);
      pos = end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end < 0) {
        const p = locate(lt);
        errors.push({ message: 'XML 声明/处理指令未闭合（缺少 ?>）', line: p.line, col: p.col });
        break;
      }
      if (decl === null) decl = src.slice(lt + 2, end);
      pos = end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2);
      if (end < 0) {
        const p = locate(lt);
        errors.push({ message: 'DOCTYPE/声明节未闭合（缺少 >）', line: p.line, col: p.col });
        break;
      }
      pos = end + 1;
      continue;
    }

    if (src.startsWith('</', lt)) {
      // ---- 闭合标签 ----
      const end = src.indexOf('>', lt + 2);
      if (end < 0) {
        const p = locate(lt);
        errors.push({ message: '闭合标签未闭合（缺少 >）', line: p.line, col: p.col });
        break;
      }
      const name = src.slice(lt + 2, end).trim();
      const top = stack[stack.length - 1];
      if (top.tag === '#document') {
        const p = locate(lt);
        errors.push({
          message: `闭合标签 </${name}> 没有对应的开标签（根层级多出一个闭合）`,
          line: p.line, col: p.col,
        });
      } else if (top.tag !== name) {
        const p = locate(lt);
        errors.push({
          message: `闭合标签不匹配：开标签是 <${top.tag}>（第 ${top.line} 行），闭标签是 </${name}>`,
          line: p.line, col: p.col,
        });
        stack.pop(); // 宽容：按闭标签回退一层，继续解析后续内容
      } else {
        stack.pop();
      }
      pos = end + 1;
      continue;
    }

    // ---- 开标签（含自闭合）----
    const p = locate(lt);
    let i = lt + 1;
    const nameMatch = /^[A-Za-z_][\w.:-]*/.exec(src.slice(i));
    if (!nameMatch) {
      errors.push({
        message: `无法解析的标签（< 后面不是合法标签名）：${JSON.stringify(src.slice(lt, lt + 24))}`,
        line: p.line, col: p.col,
      });
      const next = src.indexOf('>', lt);
      pos = next < 0 ? src.length : next + 1;
      continue;
    }
    const tag = nameMatch[0];
    i += tag.length;

    const attrs = {};
    const attrPos = {};
    let selfClose = false;
    let tagBroken = false;

    for (;;) {
      i = skipWs(i);
      if (i >= src.length) {
        errors.push({ message: `标签 <${tag}> 未闭合（文件在标签内结束）`, line: p.line, col: p.col });
        tagBroken = true;
        break;
      }
      if (src[i] === '>') { i++; break; }
      if (src[i] === '/' && src[i + 1] === '>') { selfClose = true; i += 2; break; }
      if (src[i] === '/') {
        // 形如 <tag / > 或 <tag/ > 的宽松写法
        const after = skipWs(i + 1);
        if (src[after] === '>') { selfClose = true; i = after + 1; break; }
        errors.push({ message: `标签 <${tag}> 内出现孤立的 '/'`, line: p.line, col: p.col });
        i++;
        continue;
      }
      // 属性名
      const attrMatch = /^[^\s=/>]+/.exec(src.slice(i));
      if (!attrMatch) {
        errors.push({
          message: `标签 <${tag}> 内无法解析的属性（位置 ${locate(i).line} 行）`,
          line: p.line, col: p.col,
        });
        i++;
        continue;
      }
      const attrName = attrMatch[0];
      i += attrMatch[0].length;
      i = skipWs(i);
      if (src[i] !== '=') {
        // 无值属性（HTML 式宽容写法）—— 记为错误更诚实：FGUI XML 一律 name="value"
        errors.push({
          message: `属性 '${attrName}' 缺少 '='（FGUI XML 要求 name="value" 形式）`,
          line: p.line, col: p.col,
        });
        attrs[attrName] = '';
        continue;
      }
      i = skipWs(i + 1);
      const quote = src[i];
      if (quote !== '"' && quote !== "'") {
        const vEnd = /[\s>]/.exec(src.slice(i));
        const raw = vEnd ? src.slice(i, i + vEnd.index) : src.slice(i);
        errors.push({
          message: `属性 '${attrName}' 的值未加引号（FGUI XML 要求双引号）：${JSON.stringify(raw.slice(0, 32))}`,
          line: p.line, col: p.col,
        });
        attrs[attrName] = unescapeXml(raw);
        i += raw.length;
        continue;
      }
      const endQuote = src.indexOf(quote, i + 1);
      if (endQuote < 0) {
        errors.push({ message: `属性 '${attrName}' 的引号未闭合`, line: p.line, col: p.col });
        tagBroken = true;
        break;
      }
      if (Object.prototype.hasOwnProperty.call(attrs, attrName)) {
        // ★ 上游实测：重复属性会让编辑器双击组件时炸错误框 —— 必须先 lint ★
        entityPos = locate(i);
        const dupValue = unescapeXml(src.slice(i + 1, endQuote), onBadEntity);
        errors.push({
          message: `属性 '${attrName}' 在同一个标签内重复定义（值 '${attrs[attrName]}' 与 '${dupValue}'）`
            + ' —— 上游实测：重复属性会导致编辑器打开该组件时弹错误框',
          line: p.line, col: p.col,
        });
      }
      entityPos = locate(i);
      attrs[attrName] = unescapeXml(src.slice(i + 1, endQuote), onBadEntity);
      attrPos[attrName] = locate(i);
      i = endQuote + 1;
    }

    if (tagBroken) {
      pos = src.length;
      continue;
    }

    const node = {
      tag, attrs, attrPos, children: [], text: '', line: p.line, col: p.col, parent: stack[stack.length - 1],
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
    pos = i;
  }

  if (stack.length > 1) {
    const unclosed = stack.slice(1).map((n) => `<${n.tag}>(第${n.line}行)`).join(' ');
    errors.push({ message: `以下标签未闭合：${unclosed}`, line: 1, col: 1 });
  }

  // ★ BUG-A：越界实体转成带位置的可读结构错误（不让 RangeError 冲出 lint）★
  for (const b of badEntities) {
    const codeText = Number.isFinite(b.code) ? String(b.code) : '（无法解析）';
    errors.push({
      message: `XML 实体 ${b.raw} 的码点 ${codeText} 越界：合法 Unicode 码点范围是 0 ~ 1114111`
        + `（0x10FFFF）。已按原文保留该实体。常见原因是手滑多打了数字`
        + `（如 emoji &#x1F600; 写成 &#x1F6000;），请修正为合法实体`,
      line: b.line, col: b.col,
    });
  }

  const top = root.children.filter((c) => typeof c === 'object');
  return { root: top.length ? top[0] : null, decl, errors };
}

/**
 * 计算节点的可读路径（用于报错定位）。
 * @param {Object} node
 * @returns {string} 形如 `component > displayList > image[2]`
 */
function pathOf(node) {
  if (!node || node.tag === '#document') return '(document)';
  const chain = [];
  /** @type {Object|null} */
  let cur = node;
  while (cur && cur.tag !== '#document') {
    const siblings = cur.parent
      ? cur.parent.children.filter((c) => c.tag === cur.tag)
      : [cur];
    const idx = siblings.indexOf(cur);
    chain.unshift(siblings.length > 1 ? `${cur.tag}[${idx}]` : cur.tag);
    cur = cur.parent;
  }
  return chain.join(' > ');
}

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
 * 元素上第一个 ui:// 引用（按配置的属性顺序）。
 *
 * ★ scheme 大小写不敏感识别 ★（QA 第三轮：原实现只认小写 `ui://`，
 *   大写 `UI://` 会**完全跳过 R-04 包 id 校验** —— 明确的绕过路径）。
 *   识别后按原值参与 R-04 校验（位数/结构），报错信息里带原值，
 *   用户能看到自己写的是 `UI://`。FairyGUI 规范写法是小写，
 *   P1-b 生成侧只产出小写（写入 P1-b 设计备忘）。
 */
function firstUiRef(node, cfg) {
  for (const attr of cfg.urlAttributes) {
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

// ---- R-04：ui:// 包 id 位数校验 ----
function checkUiRefs(ctx) {
  const issues = [];
  const want = ctx.cfg.pkgIdLength;
  walkElements(ctx.parsed.root, (node) => {
    const ref = firstUiRef(node, ctx.cfg);
    if (!ref) return;
    const at = node.attrPos[ref.attr] || { line: node.line, col: node.col };
    const m = /^ui:\/\/([^/]*)(?:\/(.*))?$/i.exec(ref.value);
    if (!m) {
      issues.push({
        severity: 'error',
        message: `${ref.attr}="${ref.value}" 不是合法 ui:// 引用：期望 ui://<包id>/<资源名>。`
        + `位置：${pathOf(node)} 的 ${ref.attr} 属性（第 ${at.line} 行）`,
        line: at.line, col: at.col, node, target: ref.value,
      });
      return;
    }
    const pkgId = m[1];
    if (pkgId.length !== want) {
      issues.push({
        severity: 'error',
        message: `${ref.attr}="${ref.value}" 的包 id '${pkgId}' 是 ${pkgId.length} 位，`
          + `应为 ${want} 位。上游事故：6 位包 id 会吃掉 itemId 首字符，导致 27 张图 + 组件`
          + '静默丢失（发布成功但内容缺）。位置：'
          + `${pathOf(node)} 的 ${ref.attr} 属性（第 ${at.line} 行）`,
        line: at.line, col: at.col, node, target: pkgId,
      });
    }
    if (!m[2]) {
      issues.push({
        severity: 'error',
        message: `${ref.attr}="${ref.value}" 缺少 itemId：ui:// 引用必须是 ui://<包id>/<资源名> 完整形式。`
        + `位置：${pathOf(node)} 的 ${ref.attr} 属性（第 ${at.line} 行）`,
        line: at.line, col: at.col, node, target: ref.value,
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
    const ref = firstUiRef(node, ctx.cfg);
    const info = ref ? lookupResource(ctx.resources, ref.value) : null;
    if (!info || !Number.isFinite(info.w) || !Number.isFinite(info.h)) {
      stats.sizeUnknown++;
      return;
    }
    stats.checked++;
    const [l, t, w, h] = nums;
    if (l + w > info.w || t + h > info.h) {
      issues.push({
        severity: 'error',
        message: `scale9grid="${v}" 越界：中心矩形 (${l},${t},${w}x${h}) 超出图片 ${ref.value} 的尺寸 `
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
    const ref = firstUiRef(node, ctx.cfg);
    const info = ref ? lookupResource(ctx.resources, ref.value) : null;
    if (!info || !info.features) {
      stats.noFeatures++;
      return;
    }
    stats.checked++;
    const r = computeGrid9(info.features, thresholds);
    if (r.verdict === 'NEVER') {
      issues.push({
        severity: 'warning',
        message: `${pathOf(node)} 对图片 ${ref.value} 设置了 scale9grid，但九宫格启发式判定为 NEVER`
          + `（禁切）：${r.evidence.join('；')}。拉伸可能破形（线上事故方向）。`
          + '注意：启发式有已知误判（HANDOFF-P1 §2.1 六项），此处只告警不拦截，请人工确认',
        line: node.line, col: node.col, node, target: ref.value,
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
};
