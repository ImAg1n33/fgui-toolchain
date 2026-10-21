'use strict';
/**
 * src/fgui/resource-resolver.js —— M1 第 4 个模块：解析 `ui://` 引用
 *
 * ★ 上游格式事实（对账自 docs/plugin_main.js.baseline 的 itemUrl）★
 *   上游 bridge 的 itemUrl() 生成的是 **`ui://<pkgId><itemId>`（无分隔符拼接）**，
 *   mcp_server.mjs.baseline 的工具描述也写明「Item URLs are 'ui://<pkgId><itemId>'」。
 *   而本项目 P1-a 的 R-04 lint 与 gen-xml 生成侧用的是 `ui://<pkgId>/<itemId>`（斜杠风格）。
 *   两种风格都真实存在于生态里，indexer 的职责是**提取信息**，所以两种都解析，
 *   并用 `style` 字段标明是哪一种（Q18 系列未确认前不擅自判错）。
 *
 * 解析规则（包 id 固定 8 位，与 constants.PKG_ID_LENGTH 对齐）：
 *   ui://abcd1234/a1b2c3d4  -> style='slash',  pkgId='abcd1234', itemId='a1b2c3d4'
 *   ui://abcd1234a1b2c3d4   -> style='concat', pkgId='abcd1234', itemId='a1b2c3d4'
 *
 * 宽容原则：解析不了就返回 null（记 warning 由上层决定），绝不抛异常打断索引。
 */

const { PKG_ID_LENGTH } = require('./constants');

/**
 * 解析一个 ui:// 引用。
 *
 * @param {string} raw 属性值原文
 * @returns {{raw:string, style:'slash'|'concat', pkgId:string, itemId:string}|null}
 */
function parseUiRef(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!/^ui:\/\//i.test(v)) return null;
  const rest = v.slice('ui://'.length);
  if (!rest) return null;

  // ★ 斜杠优先（2026-10-21 修正）★
  //   值里**含 `/` 就一律按 slash 拆**（pkgId = 第一个 `/` 之前、itemId = 之后），
  //   绝不用「前 N 位」硬切。原实现在「pkgId 不是 8 位 + 含 `/`」时会先命中 concat
  //   分支，把 `ui://abc123/x` 硬切成 `pkgId='abc123/p'`（长度恰好 8）——
  //   把**6 位包 id 掩藏成"合法"**，而 R-04 的职责正是要报出这种位数错误。
  const slashIdx = rest.indexOf('/');
  if (slashIdx >= 0) {
    const pkgId = rest.slice(0, slashIdx);
    const itemId = rest.slice(slashIdx + 1);
    if (!pkgId || !itemId) return null; // 缺包 id 或缺 itemId → 由上层报错，不猜
    return {
      raw: v,
      style: 'slash',
      pkgId,
      itemId,
    };
  }

  // 风格二：ui://<pkgId><itemId>（上游 bridge / 编辑器的风格，无分隔符）
  if (rest.length > PKG_ID_LENGTH) {
    const itemId = rest.slice(PKG_ID_LENGTH);
    if (itemId.trim()) {
      return {
        raw: v,
        style: 'concat',
        pkgId: rest.slice(0, PKG_ID_LENGTH),
        itemId,
      };
    }
  }

  // 其余形态（无 `/` 且长度不足/无 itemId）：如实返回 null，由上层决定
  return null;
}

/**
 * 判断属性名是否可能承载 ui:// 引用（与 lint 的 urlAttributes 同源，避免两套口径）。
 * @param {string} attr
 * @returns {boolean}
 */
function isRefAttr(attr) {
  return ['src', 'url', 'icon', 'defaultItem'].includes(attr);
}

module.exports = {
  parseUiRef,
  isRefAttr,
};
