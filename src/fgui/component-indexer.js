'use strict';
/**
 * src/fgui/component-indexer.js —— M1 第 3 个模块：解析组件 XML
 *
 * 组件 XML 结构（上游事实：bridge 的 read_component 直接 File.ReadAllText 读全文、
 * list_children 走编辑器 API 取 content.children；我们离线只读，解析同一份 XML）：
 *
 *   <?xml version="1.0" encoding="utf-8"?>
 *   <component size="480,320" extention="Button" exported="true">
 *     <displayList>
 *       <image id="b00001" name="popup_bg" src="ui://abcd1234/a1b2c3d4" xy="0,0" size="480,320"/>
 *       <component id="c00001" name="cell" src="ui://abcd1234/e5f6a7b8" xy="0,0" size="64,64"/>
 *       <graph id="b00002" name="deco" xy="0,0" size="120,2"/>
 *     </displayList>
 *   </component>
 *
 * ★ 宽容解析 ★
 *   字段缺失记 null + warning，绝不让单个畸形组件打断整次索引；
 *   解析器与 lint 同一份（xml-parse.js），但 indexer 不重复 lint 的判决。
 */

const { parseXmlDocument } = require('./xml-parse');
const { parseUiRef } = require('./resource-resolver');

/**
 * 解析 "x,y" 形态的向量属性。
 * @param {string|undefined} v
 * @returns {[number,number]|null}
 */
function parseVec(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const parts = v.split(',');
  if (parts.length !== 2) return null;
  const a = Number(parts[0].trim());
  const b = Number(parts[1].trim());
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [a, b];
}

/**
 * 把一个 XML 节点转成索引用的小节（递归）。
 *
 * @param {Object} node 解析器节点
 * @param {string} parentPath 可读路径（round-trip 与报错定位用）
 * @param {Object} acc {uiRefs:Object[], warnings:string[]} 收集器
 * @returns {Object} 索引节点
 */
function toIndexNode(node, parentPath, acc) {
  const attrs = node.attrs || {};
  const path = parentPath ? `${parentPath} > ${node.tag}` : node.tag;
  const out = {
    tag: node.tag,
    id: attrs.id === undefined ? null : String(attrs.id),
    name: attrs.name === undefined ? null : String(attrs.name),
    xy: parseVec(attrs.xy),
    size: parseVec(attrs.size),
    src: attrs.src === undefined ? null : String(attrs.src),
    url: attrs.url === undefined ? null : String(attrs.url),
    icon: attrs.icon === undefined ? null : String(attrs.icon),
    defaultItem: attrs.defaultItem === undefined ? null : String(attrs.defaultItem),
    children: [],
  };

  // ui:// 引用收集（哪个节点、哪个属性、原文、解析结果）
  for (const attr of ['src', 'url', 'icon', 'defaultItem']) {
    const raw = attrs[attr];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const ref = parseUiRef(raw);
    if (ref) {
      acc.uiRefs.push({ path, attr, ref });
    } else if (/^ui:\/\//i.test(raw.trim())) {
      acc.warnings.push(`${path} 的 ${attr}="${raw}" 形似 ui:// 但解析不出包 id/itemId（已如实记录原文）`);
    }
  }

  for (const c of node.children || []) {
    out.children.push(toIndexNode(c, path, acc));
  }
  return out;
}

/**
 * 解析一份组件 XML。
 *
 * @param {string} xmlText 组件 XML 全文
 * @returns {{ok:boolean, error:string|null, size:[number,number]|null,
 *            extention:string|null, exported:string|null, root:Object|null,
 *            uiRefs:Object[], warnings:string[]}}
 */
function indexComponentXml(xmlText) {
  const out = {
    ok: false,
    error: null,
    size: null,
    extention: null,
    exported: null,
    root: null,
    uiRefs: [],
    warnings: [],
  };
  if (typeof xmlText !== 'string' || !xmlText.trim()) {
    out.error = '空文件';
    out.warnings.push('组件 XML 为空 —— 跳过');
    return out;
  }

  let parsed;
  try {
    parsed = parseXmlDocument(xmlText);
  } catch (err) {
    out.error = `解析器异常: ${err.message}`;
    out.warnings.push(`组件 XML 解析异常 —— 跳过（${err.message}）`);
    return out;
  }
  const rootNode = parsed.root;
  if (!rootNode || rootNode.tag !== 'component') {
    out.error = `根元素不是 <component>（实际: ${rootNode ? rootNode.tag : 'null'}）`;
    out.warnings.push('组件 XML 根元素不符 —— 跳过');
    return out;
  }

  out.ok = true;
  out.size = parseVec(rootNode.attrs.size);
  out.extention = rootNode.attrs.extention === undefined ? null : String(rootNode.attrs.extention);
  out.exported = rootNode.attrs.exported === undefined ? null : String(rootNode.attrs.exported);
  if (!out.size) out.warnings.push('组件缺少可解析的 size 属性（记 null）');

  const acc = { uiRefs: out.uiRefs, warnings: out.warnings };
  out.root = toIndexNode(rootNode, '', acc);
  // 解析器的宽容错误也如实记录（indexer 不当法官，但绝不静默）
  for (const e of parsed.errors || []) {
    out.warnings.push(`XML 结构提示（第 ${e.line} 行）: ${e.message}`);
  }
  return out;
}

/**
 * 把索引节点树重新渲染成 XML 字符串（round-trip 交叉验证用）。
 *
 * 只渲染索引保留的字段（tag/id/name/xy/size/src/url/icon/defaultItem），
 * 目的不是复刻编辑器输出，而是证明「解析 -> 渲染 -> 再解析」结构不丢。
 *
 * @param {Object} node 索引节点
 * @param {number} [depth]
 * @returns {string}
 */
function renderIndexNode(node, depth = 0) {
  const pad = '  '.repeat(depth + 1);
  const attrs = [];
  if (node.id) attrs.push(`id="${node.id}"`);
  if (node.name) attrs.push(`name="${node.name}"`);
  if (node.src) attrs.push(`src="${node.src}"`);
  if (node.url) attrs.push(`url="${node.url}"`);
  if (node.icon) attrs.push(`icon="${node.icon}"`);
  if (node.defaultItem) attrs.push(`defaultItem="${node.defaultItem}"`);
  if (node.xy) attrs.push(`xy="${node.xy.join(',')}"`);
  if (node.size) attrs.push(`size="${node.size.join(',')}"`);
  const attrStr = attrs.length ? ` ${attrs.join(' ')}` : '';
  if (!node.children || !node.children.length) {
    return `${pad}<${node.tag}${attrStr}/>`;
  }
  const inner = node.children.map((c) => renderIndexNode(c, depth + 1)).join('\n');
  return `${pad}<${node.tag}${attrStr}>\n${inner}\n${pad}</${node.tag}>`;
}

/**
 * 渲染一份完整组件 XML（round-trip 用）。
 *
 * ★ 只渲染 displayList 一级的内容（根节点的 size/extention/exported 提到
 *   wrapper 上）—— 否则再解析会多出一层嵌套，round-trip 结构不一致。
 *
 * @param {Object} component indexComponentXml 的返回值
 * @returns {string}
 */
function renderComponentXml(component) {
  const size = component.size ? component.size.join(',') : '0,0';
  const ext = component.extention ? ` extention="${component.extention}"` : '';
  const exported = component.exported ? ` exported="${component.exported}"` : '';
  const inner = (component.root.children || [])
    .map((c) => renderIndexNode(c, 0))
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n`
    + `<component size="${size}"${ext}${exported}>\n`
    + `${inner}\n`
    + `</component>\n`;
}

module.exports = {
  indexComponentXml,
  renderComponentXml,
  renderIndexNode,
  parseVec,
};
