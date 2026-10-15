'use strict';
/**
 * src/fgui/xml-parse.js —— FGUI 组件/package XML 的最小解析器（M1 从 lint-rules 提炼）
 *
 * ★ 为什么提炼到这个文件 ★（M1 Project Indexer 需要）
 *   indexer 要只读解析真实工程的 package.xml 与组件 XML，解析器与 lint
 *   必须是**同一份**：两处实现迟早漂移，而 lint 的行为已被 400+ 测试锁定。
 *   提炼后 lint-rules.js 改为引用本文件（导出保持兼容，lint 的公开 API 不变）。
 *
 * 设计要点（保持原 lint-rules 实现逐字不变，只搬家）：
 *   · 宽容模式：尽量解析出部分树，错误收集到 errors 而不抛；
 *   · 重复属性必须检出（上游实测：编辑器会炸错误框）；
 *   · BUG-A 修复：越界数字实体不上抛 RangeError，经 onBad 回调转可读错误；
 *   · 节点带位置（line/col/attrPos），lint 报错与 indexer 提取都依赖它。
 *
 * 节点结构：
 *   { tag, attrs:{name:value}, attrPos:{name:{line,col}}, children:[], text, line, col, parent }
 */

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

module.exports = {
  unescapeXml,
  parseXmlDocument,
  pathOf,
  walkElements,
  XML_ENTITIES,
  MAX_CODE_POINT,
};
