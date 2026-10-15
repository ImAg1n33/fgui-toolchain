'use strict';
/**
 * src/fgui/node-render.js —— 新节点渲染（M2 / M2-SPEC §2）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 职责边界（架构已定死，勿扩散）★
 *   renderNode 只负责把 **一个节点的 tag + attrs 渲染成一段节点文本**：
 *     固定属性序 + 属性值转义 + 自闭合/非自闭合两种形态。
 *   它**不做**：
 *     · 缩进 —— 由调用方（src/fgui/xml-patcher.js 的 insertChild）决定；
 *     · 定位/插入 —— 同上，insertChild 负责把这段文本摆到正确位置；
 *     · id 分配 —— 属 gen-plan（它才知道目标文件现有 id 序列）；
 *     · IR→attrs 语义映射 —— 见下方「取舍」说明。
 *
 * ★ M2-SPEC §2 中「同侪缩进检测」的说明 ★
 *   该行是笔误（team-lead 已确认）：缩进是 insertChild 的职责，
 *   node-render 不碰缩进。此处刻意不实现，避免两个模块抢同一件事。
 *
 * ★ 取舍：IR 文本/颜色/alpha 的映射不放这里 ★
 *   M2-SPEC §3 / D3 的「IR 文本 → text= / color=#rrggbb / alpha=0.x」是
 *   **gen-plan 的职责**，不是 node-render 的：
 *     · 它需要读 IR 的 text/opacity/bbox 并做决策（6 位色来源、round6、
 *       alpha 何时省略），属于「语义 → 属性」的翻译；
 *     · node-render 若掺入这条，就得认识 Design IR 结构 —— 而它应当是
 *       一个**对 IR 一无所知**的纯渲染器（只认 tag/attrs）。
 *   这样分层的好处：gen-plan 负责「该放哪些属性、值是什么」，
 *   node-render 负责「把它们渲染成合法文本」，两者可独立测试与替换。
 *   本文件的测试因此只覆盖渲染契约（属性序/转义/形态/非法 tag）。
 * ════════════════════════════════════════════════════════════════════════════
 */

const { AppError, CODES } = require('../core/errors');
// ★ 复用 xml-patcher 的转义实现（team-lead 明确要求：不要自己再写一遍）★
const { escapeAttrValue } = require('./xml-patcher');

/**
 * 固定属性序（M2-SPEC §2 / D3）。
 * 前 8 个按此序输出；其余属性按**传入的插入序**追加在末尾。
 */
const ATTR_ORDER = Object.freeze([
  'id', 'name', 'src', 'url', 'icon', 'defaultItem', 'xy', 'size',
]);

/** 合法标签名（与 lint 侧 XML 解析器的标签名规则一致）。 */
const TAG_RE = /^[A-Za-z_][\w.:-]*$/;

/**
 * 把一个节点的 tag + attrs 渲染成节点文本。
 *
 * @param {Object} node
 * @param {string} node.tag 标签名（必须匹配 /^[A-Za-z_][\w.:-]*$/）
 * @param {Object} [node.attrs] 属性表（值 undefined/null 的属性会被跳过）
 * @param {boolean} [node.selfClose=true] true → `<tag .../>`；false → `<tag ...></tag>`
 * @returns {string} 节点文本（不含缩进、不含换行）
 * @throws {AppError} CODES.BAD_ARGUMENT —— tag 缺失/非法
 *
 * @example
 *   renderNode({ tag: 'image', attrs: { src: 'ui://p/i', id: 'b00001' } })
 *   // => '<image id="b00001" src="ui://p/i"/>'
 *   renderNode({ tag: 'group', attrs: { id: 'b00002', name: 'g' }, selfClose: false })
 *   // => '<group id="b00002" name="g"></group>'
 */
function renderNode(node) {
  if (!node || typeof node !== 'object') {
    throw new AppError(CODES.BAD_ARGUMENT, 'renderNode 需要 { tag, attrs } 对象');
  }
  const { tag, attrs, selfClose } = node;

  if (typeof tag !== 'string' || !TAG_RE.test(tag)) {
    throw new AppError(CODES.BAD_ARGUMENT,
      `非法节点标签: ${JSON.stringify(tag)}（期望匹配 /^[A-Za-z_][\\w.:-]*$/，如 image/text/group）`,
      { tag });
  }

  const src = attrs && typeof attrs === 'object' ? attrs : {};
  // ★ undefined / null 的属性必须跳过（绝不渲染 attr="undefined"）★
  const present = Object.keys(src).filter((k) => src[k] !== undefined && src[k] !== null);

  // 固定序在前（只输出实际存在的），其余按插入序追加在末尾
  const known = ATTR_ORDER.filter((k) => present.includes(k));
  const rest = present.filter((k) => !ATTR_ORDER.includes(k));
  const ordered = [...known, ...rest];

  const rendered = ordered.map((k) => {
    const raw = src[k];
    // 布尔/数字统一转字符串再转义（DOM 里属性值都是文本）
    const text = typeof raw === 'string' ? raw : String(raw);
    return `${k}="${escapeAttrValue(text)}"`;
  });

  const head = rendered.length ? `${tag} ${rendered.join(' ')}` : tag;
  // 默认自闭合（叶子节点）；显式 false 时渲染成对标签
  return selfClose === false ? `<${head}></${tag}>` : `<${head}/>`;
}

module.exports = {
  renderNode,
  ATTR_ORDER,
  TAG_RE,
};
