'use strict';
/**
 * src/fgui/xml-patcher.js —— M2 定点文本补丁引擎（M2-SPEC D1 / §2）
 *
 * ★ 为什么不重新生成 ★
 *   M1 的 renderComponentXml（component-indexer.js）是**有损渲染器**：只保留 8 类
 *   字段、固定属性顺序，会丢弃 `<text text="邮件详情">` 的 text 属性、注释、空白。
 *   「保留对象 ID、复用已有组件」的正确做法就是对存量 XML 做**外科手术式**修改：
 *   只改目标节点的目标属性值，其余字节原样保留。本模块即那把手术刀。
 *
 * ★ 与解析器的分工（禁止修改 xml-parse.js）★
 *   · 定位：复用 xml-parse.js 的 parseXmlDocument —— 节点带 line/col，用于
 *     换算绝对偏移；本模块**不重写** XML 解析器（lint 行为被 400+ 测试锁定）。
 *   · 补丁：由本模块**自己对 start-tag 源码区间做属性扫描**（小型 tokenizer），
 *     这样才能做到「只替换该属性值的字节、其余一个字节都不动」。
 *
 * ★ 定位语义（nodeLoc）★
 *   nodeLoc 是 { id?, name?, tag?, src? } 的组合；至少给一个键。命中规则：
 *     · 唯一命中 → 返回该节点；
 *     · 零命中   → 抛 AppError(BAD_ARGUMENT)；
 *     · 多命中   → 抛 AppError(BAD_ARGUMENT)，列出候选（**禁止猜**，M2-SPEC §5）。
 *
 * 纯函数，零 I/O：所有显式参数入、字符串出，便于单测与 dryrun 内存打补丁复用。
 */

const { AppError, CODES } = require('../core/errors');
const { parseXmlDocument } = require('./xml-parse');

/** nodeLoc 支持的定位键（其余键忽略）。 */
const LOC_KEYS = Object.freeze(['id', 'name', 'tag', 'src']);

/**
 * 计算每一行起始处的字符偏移（0-based 行号 -> 偏移）。
 * @param {string} text
 * @returns {number[]}
 */
function lineStartOffsets(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/**
 * 把解析器给出的 (line, col) 换算成绝对字符偏移（指向该位置的字符）。
 * @param {string} text
 * @param {number} line 1-based
 * @param {number} col 1-based
 * @returns {number}
 */
function offsetOfLc(text, line, col) {
  const starts = lineStartOffsets(text);
  const base = starts[line - 1];
  return (base === undefined ? 0 : base) + (col - 1);
}

/**
 * 深度优先收集全部元素节点（跳过 #document 伪根）。
 * @param {Object|null} root
 * @returns {Object[]}
 */
function collectElementNodes(root) {
  const out = [];
  const stack = root ? [root] : [];
  while (stack.length) {
    const node = stack.pop();
    if (node.tag !== '#document') out.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return out;
}

/**
 * 把 nodeLoc 描述成人可读串（报错用）。
 * @param {Object} loc
 * @returns {string}
 */
function describeLoc(loc) {
  return LOC_KEYS
    .filter((k) => loc[k] !== undefined && loc[k] !== null)
    .map((k) => `${k}="${loc[k]}"`)
    .join(' ');
}

/**
 * 把一个解析节点描述成人可读串（报错列出候选用）。
 * @param {Object} node
 * @returns {string}
 */
function describeNode(node) {
  const id = node.attrs.id === undefined ? '(无 id)' : `id=${node.attrs.id}`;
  const name = node.attrs.name === undefined ? '' : ` name=${node.attrs.name}`;
  return `<${node.tag}>${id}${name}（第 ${node.line} 行）`;
}

/**
 * 定位一个唯一节点。
 *
 * @param {string} text XML 全文
 * @param {Object} nodeLoc { id?, name?, tag?, src? }
 * @returns {{node:Object, offset:number}} node 为解析节点，offset 指向其 `<`
 * @throws {AppError} 参数缺失 / 零命中 / 多命中
 */
function locateNode(text, nodeLoc) {
  if (typeof text !== 'string') {
    throw new AppError(CODES.BAD_ARGUMENT, 'text 必须是字符串');
  }
  if (!nodeLoc || typeof nodeLoc !== 'object' || Array.isArray(nodeLoc)) {
    throw new AppError(CODES.BAD_ARGUMENT, 'nodeLoc 必须是对象（至少含 id/name/tag/src 之一）');
  }
  const keys = LOC_KEYS.filter((k) => nodeLoc[k] !== undefined && nodeLoc[k] !== null);
  if (!keys.length) {
    throw new AppError(CODES.BAD_ARGUMENT, 'nodeLoc 至少要指定 id / name / tag / src 之一');
  }

  const parsed = parseXmlDocument(text);
  if (!parsed.root) {
    throw new AppError(CODES.BAD_ARGUMENT, 'XML 为空或没有根元素，无法定位节点');
  }
  const all = collectElementNodes(parsed.root);
  // ★ tag 键比较的是元素名（解析节点里在 n.tag），id/name/src 才在 n.attrs ★
  const hits = all.filter((n) => keys.every((k) => (
    k === 'tag' ? String(n.tag) === String(nodeLoc[k]) : String(n.attrs[k]) === String(nodeLoc[k])
  )));

  if (hits.length === 0) {
    throw new AppError(
      CODES.BAD_ARGUMENT,
      `找不到匹配节点（${describeLoc(nodeLoc)}）—— 请检查 name/id 是否与工程实际一致`,
      { loc: nodeLoc },
    );
  }
  if (hits.length > 1) {
    const candidates = hits.map((n) => describeNode(n));
    throw new AppError(
      CODES.BAD_ARGUMENT,
      `定位到 ${hits.length} 个节点（${describeLoc(nodeLoc)}），拒绝猜测，请改用唯一 id 定位：`
        + candidates.join('；'),
      { loc: nodeLoc, candidates: hits.map((n) => (n.attrs.id === undefined ? null : n.attrs.id)) },
    );
  }

  const node = hits[0];
  return { node, offset: offsetOfLc(text, node.line, node.col) };
}

/**
 * 扫描一个 start-tag（从 `<` 起），逐属性记录源码区间。
 *
 * 返回每个属性：{ name, hasValue, quote, quotePos, valueStart, valueEnd }
 *   · quotePos  —— 开引号偏移（无引号时为 '=' 前一个字符偏移）
 *   · valueStart / valueEnd —— 值区间 [start, end)（不含引号）
 * 另含 selfClose / gtOffset（`>` 偏移）/ slashOffset（`/>` 的 `/` 偏移）。
 *
 * 这是本模块的**核心**：只有拿到每个值的精确字节区间，才能做到「只改目标
 * 属性、其余原样」。宽容：畸形处尽量跳过而不是崩溃。
 *
 * @param {string} text
 * @param {number} offset `<` 的绝对偏移
 * @returns {{tag:string, attrs:Object[], selfClose:boolean, gtOffset:number,
 *            slashOffset:number, endOffset:number}}
 * @throws {AppError} 不是标签起点 / 标签名非法 / 标签未闭合 / 引号未闭合
 */
function scanStartTag(text, offset) {
  if (text[offset] !== '<') {
    throw new AppError(CODES.BAD_ARGUMENT, `偏移 ${offset} 处不是 '<'（scanStartTag 需要 start-tag 起点）`);
  }
  let i = offset + 1;
  const nameMatch = /^[A-Za-z_][\w.:-]*/.exec(text.slice(i));
  if (!nameMatch) {
    throw new AppError(CODES.BAD_ARGUMENT, `无法解析的标签名（偏移 ${offset}）：${JSON.stringify(text.slice(offset, offset + 24))}`);
  }
  const tag = nameMatch[0];
  i += tag.length;

  const attrs = [];
  let selfClose = false;
  let gtOffset = -1;
  let slashOffset = -1;

  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) {
      throw new AppError(CODES.BAD_ARGUMENT, `标签 <${tag}> 未闭合（文件在标签内结束）`);
    }
    if (text[i] === '>') { gtOffset = i; selfClose = false; i += 1; break; }
    if (text[i] === '/' && text[i + 1] === '>') {
      slashOffset = i; gtOffset = i + 1; selfClose = true; i += 2; break;
    }
    if (text[i] === '/') { i += 1; continue; } // 孤立 '/'：跳过（宽容）

    const attrMatch = /^[^\s=/>]+/.exec(text.slice(i));
    if (!attrMatch) { i += 1; continue; }
    const name = attrMatch[0];
    const nameStart = i;
    i += name.length;

    const wsBeforeEq = (() => { let j = i; while (j < text.length && /\s/.test(text[j])) j++; return j; })();
    if (text[wsBeforeEq] !== '=') {
      // 无值属性（HTML 式宽容写法）：如实记录，不当作可替换值
      attrs.push({ name, nameStart, hasValue: false, quote: '', quotePos: wsBeforeEq, valueStart: wsBeforeEq, valueEnd: wsBeforeEq });
      i = wsBeforeEq;
      continue;
    }
    i = wsBeforeEq + 1;
    while (i < text.length && /\s/.test(text[i])) i++;

    const quote = text[i];
    if (quote !== '"' && quote !== "'") {
      // 无引号值：尽力读取到空白或 '>'
      const vEnd = /[\s>]/.exec(text.slice(i));
      const stop = vEnd ? i + vEnd.index : text.length;
      attrs.push({ name, nameStart, hasValue: true, quote: '', quotePos: i - 1, valueStart: i, valueEnd: stop });
      i = stop;
      continue;
    }
    const quotePos = i;
    const endQuote = text.indexOf(quote, i + 1);
    if (endQuote < 0) {
      throw new AppError(CODES.BAD_ARGUMENT, `标签 <${tag}> 的属性 '${name}' 引号未闭合`);
    }
    attrs.push({ name, nameStart, hasValue: true, quote, quotePos, valueStart: quotePos + 1, valueEnd: endQuote });
    i = endQuote + 1;
  }

  return { tag, attrs, selfClose, gtOffset, slashOffset, endOffset: i };
}

/**
 * 从某个元素的 start-tag 起点出发，找到与之配对的闭标签 `<` 偏移。
 *
 * 自己走一遍轻量扫描（跳过注释/CDATA/PI/DOCTYPE），按同名标签维护深度，
 * 保证嵌套同名标签也能正确配对。
 *
 * @param {string} text
 * @param {number} offset 该元素 `<` 的偏移
 * @param {string} tag 元素标签名
 * @returns {number} 配对闭标签 `<` 的偏移；找不到返回 -1
 */
function findElementEnd(text, offset, tag) {
  let i = offset;
  let depth = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;

    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      if (e < 0) break;
      i = e + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9);
      if (e < 0) break;
      i = e + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const e = text.indexOf('?>', lt + 2);
      if (e < 0) break;
      i = e + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      const e = text.indexOf('>', lt + 2);
      if (e < 0) break;
      i = e + 1;
      continue;
    }
    if (text.startsWith('</', lt)) {
      const e = text.indexOf('>', lt + 2);
      if (e < 0) break;
      const name = text.slice(lt + 2, e).trim();
      if (name === tag) {
        depth -= 1;
        if (depth === 0) return lt;
      }
      i = e + 1;
      continue;
    }

    let st;
    try {
      st = scanStartTag(text, lt);
    } catch (err) {
      i = lt + 1;
      continue;
    }
    if (st.tag === tag && !st.selfClose) depth += 1;
    i = st.endOffset;
  }
  return -1;
}

/**
 * 检测工程的缩进单位（最小正缩进宽度），缺省 2。
 * @param {string} text
 * @returns {number}
 */
function detectIndentUnit(text) {
  let unit = 0;
  for (const line of text.split('\n')) {
    const m = /^([ \t]+)\S/.exec(line);
    if (!m) continue;
    const w = m[1].length;
    if (w > 0 && (unit === 0 || w < unit)) unit = w;
  }
  return unit || 2;
}

/**
 * 求插入子节点时应使用的缩进串（与同侪一致；无同侪则父缩进 + 一级）。
 * @param {string} text
 * @param {Object} parentNode 解析节点
 * @param {number} closeOffset 父节点闭标签 `<` 偏移
 * @returns {string}
 */
function detectChildIndent(text, parentNode, closeOffset) {
  const kids = parentNode.children || [];
  if (kids.length) {
    const last = kids[kids.length - 1];
    const childOffset = offsetOfLc(text, last.line, last.col);
    const lineStart = text.lastIndexOf('\n', childOffset - 1) + 1;
    const lead = text.slice(lineStart, childOffset);
    if (/^[ \t]*$/.test(lead)) return lead; // 与同侪逐字节一致
  }
  // 无子节点（或子节点与父标签同行）：父缩进 + 一级
  const parentOffset = offsetOfLc(text, parentNode.line, parentNode.col);
  const parentLineStart = text.lastIndexOf('\n', parentOffset - 1) + 1;
  const parentLead = text.slice(parentLineStart, parentOffset);
  const baseLead = /^[ \t]*$/.test(parentLead) ? parentLead : '';
  return baseLead + ' '.repeat(detectIndentUnit(text));
}

/**
 * 归一化 changes 参数为 [{name, value}]。
 * 接受两种形态：
 *   · 对象：{ xy:'592,72', visible:'false' }
 *   · 数组：[{ attr:'xy', value:'592,72' }, { name:'size', value:'1,2' }]
 * 过滤掉 value 为 null/undefined 的项。
 *
 * @param {Object|Object[]} changes
 * @returns {{name:string, value:*}[]}
 */
function normalizeChanges(changes) {
  let list = [];
  if (Array.isArray(changes)) {
    list = changes.map((c) => ({ name: c.attr !== undefined ? c.attr : c.name, value: c.value }));
  } else if (changes && typeof changes === 'object') {
    list = Object.entries(changes).map(([name, value]) => ({ name, value }));
  }
  return list.filter((c) => c.name !== undefined && c.name !== null && c.value !== undefined && c.value !== null);
}

/**
 * 转义属性值中的特殊字符（写回新值时用）。
 * @param {*} s
 * @returns {string}
 */
function escapeAttrValue(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 定点修改指定节点的若干属性（值），其余字节原样保留。
 *
 * · 已存在的属性 → 只替换其值区间（**保留原引号风格**：双/单引号都不动）；
 * · 不存在的属性 → 追加到 start-tag 末尾（自闭合插在 `/>` 前）。
 *
 * @param {string} text XML 全文
 * @param {Object} nodeLoc { id?, name?, tag?, src? }
 * @param {Object|Object[]} changes 属性改动，见 normalizeChanges
 * @returns {string} 新 XML 全文
 * @throws {AppError} 定位失败 / 多命中
 */
function patchAttrs(text, nodeLoc, changes) {
  const list = normalizeChanges(changes);
  if (!list.length) return text;

  const { offset } = locateNode(text, nodeLoc);
  const startTag = scanStartTag(text, offset);

  /** @type {{from:number, to:number, text:string}[]} */
  const edits = [];
  /** @type {{name:string, value:*}[]} */
  const additions = [];

  for (const ch of list) {
    const tok = startTag.attrs.find((a) => a.name === ch.name);
    if (tok && tok.hasValue) {
      edits.push({ from: tok.valueStart, to: tok.valueEnd, text: escapeAttrValue(ch.value) });
    } else {
      additions.push(ch);
    }
  }

  if (additions.length) {
    const insertPos = startTag.selfClose ? startTag.slashOffset : startTag.gtOffset;
    const ins = additions.map((a) => ` ${a.name}="${escapeAttrValue(a.value)}"`).join('');
    edits.push({ from: insertPos, to: insertPos, text: ins });
  }

  // 从后往前套用，保证偏移不互相影响
  edits.sort((a, b) => b.from - a.from);
  let out = text;
  for (const e of edits) {
    out = out.slice(0, e.from) + e.text + out.slice(e.to);
  }
  return out;
}

/**
 * 单属性写法的便捷封装。
 * @param {string} text
 * @param {Object} nodeLoc
 * @param {string} name 属性名
 * @param {*} value 属性值
 * @returns {string}
 */
function setAttr(text, nodeLoc, name, value) {
  return patchAttrs(text, nodeLoc, { [name]: value });
}

/**
 * 在父节点的最后一个子级之后插入一个已渲染好的节点（文本级）。
 *
 * · 定位父节点 → 找配对闭标签 → 在闭标签所在行**之前**插入；
 * · 缩进与同侪一致（取最后一个子节点所在行的前导空白；无同侪则父缩进 + 一级）。
 *
 * ★ 本函数**不渲染**新节点（渲染属 node-render.js，M2 第 3 步）：renderedNode
 *   由调用方给出，本函数只负责摆放字节，绝不规范化其内容。
 *
 * @param {string} text XML 全文
 * @param {Object} parentLoc { id?, name?, tag?, src? }
 * @param {string} renderedNode 已渲染的子节点文本（如 `<image id="b00004" .../>`）
 * @returns {string} 新 XML 全文
 * @throws {AppError} 定位失败 / 父节点自闭合 / 找不到闭标签
 */
function insertChild(text, parentLoc, renderedNode) {
  if (typeof renderedNode !== 'string' || !renderedNode.trim()) {
    throw new AppError(CODES.BAD_ARGUMENT, 'insertChild 的 renderedNode 必须是非空字符串');
  }
  const { node, offset } = locateNode(text, parentLoc);
  const startTag = scanStartTag(text, offset);
  if (startTag.selfClose) {
    throw new AppError(CODES.BAD_ARGUMENT, `父节点 <${node.tag}> 是自闭合标签，不能插入子节点`);
  }
  const closeOffset = findElementEnd(text, offset, node.tag);
  if (closeOffset < 0) {
    throw new AppError(CODES.BAD_ARGUMENT, `找不到 <${node.tag}> 的配对闭标签，无法插入子节点`);
  }
  const indent = detectChildIndent(text, node, closeOffset);
  const lineStart = text.lastIndexOf('\n', closeOffset - 1) + 1;
  const body = String(renderedNode).replace(/\n+$/, '');
  const inserted = `${indent}${body}\n`;
  return text.slice(0, lineStart) + inserted + text.slice(lineStart);
}

module.exports = {
  patchAttrs,
  insertChild,
  setAttr,
  scanStartTag,
  findElementEnd,
  locateNode,
  detectIndentUnit,
  detectChildIndent,
  normalizeChanges,
  escapeAttrValue,
  lineStartOffsets,
};
