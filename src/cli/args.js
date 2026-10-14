'use strict';
/**
 * src/cli/args.js —— CLI 参数取值助手
 *
 * 为什么单独成文件：重复传入的 flag（`--psd a.psd --psd b.psd`，R2-F7 多份解析）
 * 在 parseArgs 里会聚合成数组。若每个命令各自 `String(flags.x)`，
 * 数组会被字符串化成 `"a.psd,b.psd"`，是个静默的错误路径。
 * 统一走这里的 `flagStr` / `flagNum` / `flagBool`，从根上消掉这类坑。
 */

/**
 * 取首个值（数组取 [0]）。
 * @param {*} v
 * @returns {*}
 */
function firstOf(v) {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * 取字符串值。
 * @param {*} v
 * @param {string} [fallback]
 * @returns {string|undefined}
 */
function flagStr(v, fallback) {
  if (v === undefined || v === null) return fallback;
  if (Array.isArray(v)) return v.length ? String(v[0]) : fallback;
  if (v === true) return fallback; // `--flag` 无值时不当成字符串
  return String(v);
}

/**
 * 取全部值（数组展开，单值包一层）。
 * @param {*} v
 * @returns {string[]}
 */
function flagAll(v) {
  if (v === undefined || v === null || v === true) return [];
  return (Array.isArray(v) ? v : [v]).map(String);
}

/**
 * 取数值。
 * @param {*} v
 * @param {number} fallback
 * @returns {number}
 */
function flagNum(v, fallback) {
  const s = flagStr(v);
  if (s === undefined) return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 取布尔。`--flag`（无值）与 `--flag true/1/yes` 都为真；`--no-flag` 由 parseArgs 转成 false。
 * @param {*} v
 * @param {boolean} fallback
 * @returns {boolean}
 */
function flagBool(v, fallback) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(firstOf(v)).toLowerCase();
  if (s === '') return true; // `--flag` 形式
  return s === 'true' || s === '1' || s === 'yes';
}

module.exports = { firstOf, flagStr, flagAll, flagNum, flagBool };
