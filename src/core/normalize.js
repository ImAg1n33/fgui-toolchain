'use strict';
/**
 * src/core/normalize.js —— 名称归一化。整个检索策略的地基（PRD K5）。
 *
 * ★★★ K5 铁律（写死在这里，任何改动都要重读）★★★
 *   实际文件名形如 `矩形1`、`矩形11`、`图层249(1)` —— **`矩形1` 是 `矩形11` 的前缀**。
 *   因此：
 *     1. 本模块只提供 **全等匹配**（normalizeName(a) === normalizeName(b)）。
 *        **严禁** startsWith / includes / 正则子串匹配 —— 那会把 矩形11 错配到 矩形1。
 *     2. 归一化后 `矩形1` !== `矩形11`，两者是不同的检索主键。
 *     3. 即便归一化后真同名（如 `矩形1.png` 与 `矩形1(1).png` 去副本后缀后同名），
 *        由上层（channel1-name）用 ±2px 尺寸校验二次判别；仍歧义则全部返回并标 AMBIGUOUS。
 *
 * 本模块是纯函数集合，不碰文件系统，便于单测。
 */

const { applyVariants, DEFAULT_VARIANTS } = require('./variants');

/** 扩展名剥离正则。放在函数外避免每次重建（性能：几百张图量级无所谓，但习惯要养）。 */
const EXT_RE = /\.[A-Za-z0-9]{1,5}$/;

/**
 * 副本后缀正则。**只认带括号的数字副本**，绝不裸剥尾部数字 ——
 * 裸剥会把 `矩形11` 变成 `矩形1`，正是 K5 事故的成因。
 * 覆盖：`(1)` `（1）` `[1]` `副本` `-副本` `_copy` `_副本`
 */
const COPY_SUFFIX_RE = /(?:[（(【\[]\s*\d+\s*[)）】\]]|副本|_副本|-副本|_copy|拷贝)$/;

/**
 * 全角转半角（ASCII 区 + 全角空格）。逐字符查表，纯函数。
 * 全角 ASCII：U+FF01 ~ U+FF5E 对应半角 0x21 ~ 0x7E（偏移 0xFEE0）
 * @param {string} ch
 * @returns {string}
 */
function toHalfWidth(ch) {
  const code = ch.codePointAt(0);
  if (code === 0x3000) return ' '; // 全角空格
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCodePoint(code - 0xfee0);
  return ch;
}

/**
 * 归一化一个名称。
 *
 * 步骤（顺序固定，保证确定性）：
 *   1. String 化 + trim
 *   2. 去扩展名（可选，.png/.jpg/…）
 *   3. 全角 -> 半角（含全角空格）
 *   4. 去副本后缀（可选，只认括号数字形式）
 *   5. 去所有空白（含不换行空格 U+00A0）
 *   6. 转小写
 *   7. 繁简映射（可选，词典缺失则降级不转换）
 *
 * @param {string} raw 原始名（文件名不含目录，或图层名）
 * @param {Object} [opts]
 * @param {boolean} [opts.stripCopySuffix=true] 去 `(1)` 副本后缀
 * @param {boolean} [opts.stripExtension=true] 去扩展名
 * @param {boolean} [opts.useVariants=true] 做繁简转换
 * @param {Object<string,string>} [opts.variants] 自定义繁简表
 * @returns {string} 归一化名（可能为空串）
 */
function normalizeName(raw, opts = {}) {
  const stripCopy = opts.stripCopySuffix !== false;
  const stripExt = opts.stripExtension !== false;
  const useVariants = opts.useVariants !== false;

  let s = raw === null || raw === undefined ? '' : String(raw);
  s = s.trim();
  if (!s) return '';

  if (stripExt) s = s.replace(EXT_RE, '');

  // 全角 -> 半角
  s = Array.from(s).map(toHalfWidth).join('');

  if (stripCopy) {
    // 最多剥 3 层，防御 `矩形1(1)(1)` 这种叠罗汉；3 层足够且避免死循环
    for (let i = 0; i < 3; i++) {
      const next = s.replace(COPY_SUFFIX_RE, '');
      if (next === s || !next) break;
      s = next;
    }
  }

  // 去所有空白：普通空格 / 制表 / U+00A0 / U+3000
  s = s.replace(/[\s\u00a0\u3000]+/g, '');

  s = s.toLowerCase();

  if (useVariants) {
    const table = opts.variants || DEFAULT_VARIANTS;
    s = applyVariants(s, table).text;
  }

  return s;
}

/**
 * ★ K5 唯一允许的匹配方式：归一化后 **全等**。
 * 严禁在此函数之外用 startsWith/includes 做名称匹配。
 *
 * @param {string} a
 * @param {string} b
 * @param {Object} [opts] 透传给 normalizeName
 * @returns {boolean}
 */
function isSameName(a, b, opts = {}) {
  const na = normalizeName(a, opts);
  const nb = normalizeName(b, opts);
  if (!na || !nb) return false;
  return na === nb;
}

/**
 * 归一化 + 返回元信息（供 evidence 写「为什么这么判」）。
 * @param {string} raw
 * @param {Object} [opts]
 * @returns {{raw:string, norm:string, variantsApplied:boolean, variantsTableSize:number}}
 */
function normalizeNameDetailed(raw, opts = {}) {
  const useVariants = opts.useVariants !== false;
  const table = opts.variants || DEFAULT_VARIANTS;
  const norm = normalizeName(raw, opts);
  const variantInfo = useVariants ? applyVariants(norm, table) : { applied: false, tableSize: 0 };
  return {
    raw: raw === null || raw === undefined ? '' : String(raw),
    norm,
    variantsApplied: variantInfo.applied,
    variantsTableSize: variantInfo.tableSize,
  };
}

/**
 * 从路径取不含目录、不含扩展名的 basename（不做归一化）。
 * @param {string} p
 * @returns {string}
 */
function baseNameOf(p) {
  const s = String(p || '');
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return idx >= 0 ? s.slice(idx + 1) : s;
}

/**
 * 尺寸校验（±tol px）。Ch-1 命中后的二次判别依据。
 * @param {{w:number,h:number}} a
 * @param {{w:number,h:number}} b
 * @param {number} [tol=2]
 * @returns {boolean}
 */
function sizeWithinTol(a, b, tol = 2) {
  if (!a || !b) return false;
  return Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;
}

module.exports = {
  normalizeName,
  normalizeNameDetailed,
  isSameName,
  baseNameOf,
  sizeWithinTol,
  COPY_SUFFIX_RE,
  EXT_RE,
};
