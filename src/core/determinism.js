'use strict';
/**
 * src/core/determinism.js —— 确定性输出的地基（ARCHITECTURE §4.4 / 验收项 B9）
 *
 * 污染源与对策：
 *   对象键序  -> sortKeysDeep：按键名字母序重建对象，不依赖插入序
 *   浮点      -> round6：Number(v.toFixed(6))
 *   数组顺序  -> sortBy：所有输出数组显式排序
 *   时间戳    -> 产物内零时间戳（由调用方保证，本模块不产生）
 *   绝对路径  -> toPosixRel：跨平台 POSIX 相对化（★ 不用宿主 OS 规则 ★）
 *   Map/Set   -> entriesSorted：先排序再输出
 */

const path = require('path');
const { AppError, CODES } = require('./errors');

/** 浮点定点化位数。B9 要求逐字节一致，必须消除平台浮点差异。 */
const FLOAT_PRECISION = 6;

/**
 * 浮点定点化。非有限值原样返回（交由上层决定如何报错，不静默吞）。
 * @param {number} value
 * @returns {number}
 */
function round6(value) {
  if (typeof value !== 'number') return value;
  if (!Number.isFinite(value)) return value;
  return Number(value.toFixed(FLOAT_PRECISION));
}

/**
 * 递归定点化：对象与数组中的所有浮点。
 * @param {unknown} value
 * @returns {unknown}
 */
function roundDeep(value) {
  if (typeof value === 'number') return round6(value);
  if (Array.isArray(value)) return value.map(roundDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = roundDeep(value[key]);
    return out;
  }
  return value;
}

/**
 * 递归按键名字母序重建对象。数组元素顺序保持不变（排序是调用方的显式责任）。
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    // Buffer / Date 等非普通对象原样返回
    if (Buffer.isBuffer(value) || value instanceof Date) return value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue; // undefined 不入 JSON
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * 稳定的字符串比较器（不用 localeCompare，避免 ICU 差异导致的不确定性）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function cmpStr(a, b) {
  const sa = a === null || a === undefined ? '' : String(a);
  const sb = b === null || b === undefined ? '' : String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

/**
 * 按 keyFn 取字段做多级稳定排序。
 * @template T
 * @param {T[]} arr
 * @param {...(function(T): any)} keyFns
 * @returns {T[]} 新数组
 */
function sortBy(arr, ...keyFns) {
  if (!Array.isArray(arr)) return [];
  const fns = keyFns.filter((f) => typeof f === 'function');
  const decorated = arr.map((item, index) => ({
    item,
    index,
    keys: fns.map((fn) => fn(item)),
  }));
  decorated.sort((a, b) => {
    for (let i = 0; i < fns.length; i++) {
      const ka = a.keys[i];
      const kb = b.keys[i];
      let c;
      if (typeof ka === 'number' && typeof kb === 'number') c = ka - kb;
      else c = cmpStr(ka, kb);
      if (c !== 0) return c;
    }
    return a.index - b.index; // 完全相等时保持原序（稳定）
  });
  return decorated.map((d) => d.item);
}

/**
 * Map 条目按键排序后输出。禁止直接遍历 Map 写产物。
 * @param {Map<string, any>} map
 * @returns {[string, any][]}
 */
function entriesSorted(map) {
  return [...map.entries()].sort((a, b) => cmpStr(a[0], b[0]));
}

/**
 * 路径形态：Windows（盘符 / UNC）/ POSIX 绝对 / 相对（形态中立）。
 *
 * ★ 为什么「相对」要单独一类 ★
 *   真实管线里 `toPosixRel(rootDir, ir.source.psdPath)` 的两侧天然不同形态：
 *   rootDir 是宿主机绝对路径（Windows 上是 `D:\UItool`），而 IR 里的 psdPath
 *   是相对路径（`test/fixtures/golden/state_A.psd`）。相对路径没有「属于哪个
 *   系统」的概念（它只有分隔符写法），因此视为**形态中立**，跟随另一侧。
 *
 * @param {string} p
 * @returns {'win'|'posix'|'relative'}
 */
function pathFlavor(p) {
  const s = String(p === undefined || p === null ? '' : p);
  // C:\x / C:/x / C:x（盘符形态）
  if (/^[A-Za-z]:/.test(s)) return 'win';
  // UNC：\\server\share 或 //server/share
  if (/^[\\/]{2}[^\\/]/.test(s)) return 'win';
  // POSIX 绝对
  if (s.startsWith('/')) return 'posix';
  return 'relative';
}

/**
 * 路径的**书写形态**（含相对路径），供 basename / dirname 等字符串操作选规则集。
 *
 * 与 pathFlavor() 的区别：pathFlavor() 把相对路径视为形态中立（toPosixRel 需要
 * 相对侧跟随绝对侧），而这里相对路径必须按自己的分隔符判定 —— 否则取 basename
 * 时又要用宿主规则（第 2 层宿主化问题的根因）。
 *
 * @param {string} p
 * @returns {'win'|'posix'}
 */
function pathShape(p) {
  const f = pathFlavor(p);
  if (f !== 'relative') return f;
  const s = String(p === undefined || p === null ? '' : p);
  if (s.includes('\\')) return 'win';
  return 'posix'; // 含 '/' 或纯文件名：两种规则结果一致
}

/**
 * 按形态选对应的路径规则集。
 *
 * ★ 全模块唯一允许「宿主无关地」使用路径字符串 API 的入口 ★
 *   直接调 `path.basename/relative/...` 用的是**宿主 OS** 规则 —— 这正是
 *   Ubuntu CI 两次失败的根因（第 1 层 relative、第 2 层 basename）。
 *   形态相关的一切操作都必须经这里拿 win32/posix 规则集。
 *
 * @param {string} flavor 'win' | 'posix' | 'relative'
 * @returns {Object} path.win32 或 path.posix
 */
function pathLibFor(flavor) {
  return flavor === 'win' ? path.win32 : path.posix;
}

/**
 * 形态无关的 basename（★ 第 2 层宿主化问题的修复点 ★）。
 *
 * 事故复盘：降级分支曾用宿主版 basename —— Windows 上
 * `path.basename('C:\\Users\\x\\solid.psd')` = `solid.psd`（对），
 * 而 Linux 上 `path.posix.basename` 不认反斜杠 → 整串原样返回 →
 * 产物里出现 `outside-root/C:/Users/x/solid.psd`（绝对路径泄漏）。
 * Windows 开发机测不出来，只有 Linux runner 会红。
 *
 * @param {string} p 任意形态的路径
 * @returns {string} 文件名（POSIX 风格，不含盘符与分隔符残留）
 */
function basenameByShape(p) {
  const lib = pathLibFor(pathShape(p));
  const base = lib.basename(String(p));
  // 双保险：即便上游传进奇怪形态，产物里也绝不留盘符/分隔符
  return String(base)
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:\/?/, '')
    .replace(/[:\\]/g, '_');
}

/**
 * 取 Windows 路径的根（盘符或 UNC 根），用于判断是否跨根。
 * @param {string} p Windows 形态路径
 * @returns {string} 归一化的根（小写盘符，如 'c:'；UNC 为 '\\\\server\\share' 的小写形式）
 */
function winRoot(p) {
  const s = String(p).replace(/\//g, '\\');
  const drive = /^([A-Za-z]:)/.exec(s);
  if (drive) return drive[1].toLowerCase();
  const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(s);
  if (unc) return `\\\\${unc[1].toLowerCase()}\\${unc[2].toLowerCase()}`;
  return '';
}

/**
 * ★ 路径 POSIX 相对化（跨平台，UPSTREAM-FIX-6）★
 *
 * 产物里绝不允许出现 Windows 绝对路径 —— 而旧实现恰恰做不到这件事：
 *   `path.relative()` 用**宿主 OS** 的路径规则。在 Linux 上 `D:\UItool\out`
 *   只是「一个带反斜杠的相对目录名」（反斜杠不是分隔符），旧实现会算出
 *   `../D:/UItool/out/sub/x.json` —— 把本机绝对路径写进产物，直接违反 B9。
 *   ★ 讽刺点：这个函数的注释原本就是「绝不允许出现 Windows 绝对路径」，
 *     而它在 Linux 上违反了自己；只有 CI 上了 Ubuntu 才暴露（加 CI 的价值）。
 *
 * 规则：
 *   1. 先判两侧形态（Windows 盘符 / UNC / POSIX 绝对 / 相对）。**两侧都是绝对路径
 *      且形态不同** → 明确报错，不静默产出奇怪结果；相对路径形态中立，跟随另一侧。
 *   2. 同形态 → 用对应规则集算相对路径（path.win32 / path.posix），
 *      与宿主 OS 无关，Windows 与 Linux 上结果一致（相对路径跟随绝对侧）。
 *   3. 跨盘符 / 跨 UNC 根 → **明确报错**：此时「相对路径」在语义上不存在，
 *      path.win32.relative() 会直接返回绝对路径，写进产物就是事故。
 *   4. 最后统一分隔符，并做一道机器化守卫：结果若仍像绝对路径则报错。
 *
 * @param {string} from 基准目录
 * @param {string} target 目标路径
 * @returns {string} POSIX 风格相对路径
 * @throws {AppError} 形态混用 / 跨根 / 结果仍为绝对路径
 */
function toPosixRel(from, target) {
  const fa = pathFlavor(from);
  const ta = pathFlavor(target);
  const bothAbsolute = fa !== 'relative' && ta !== 'relative';
  if (bothAbsolute && fa !== ta) {
    throw new AppError(CODES.BAD_ARGUMENT,
      `toPosixRel: 两侧绝对路径形态不一致（${fa} vs ${ta}）：`
      + `from=${JSON.stringify(from)} target=${JSON.stringify(target)}。`
      + '跨平台产物需要同形态输入：要么都是 Windows 绝对路径，要么都是 POSIX 绝对路径。');
  }

  // 形态中立（相对）跟随另一侧；两侧都相对则按 POSIX 规则
  const flavor = (fa === 'win' || ta === 'win') ? 'win' : 'posix';
  const lib = pathLibFor(flavor);
  /** 统一分隔符到选定形态。 */
  const norm = (x) => (lib === path.win32 ? String(x).replace(/\//g, '\\') : String(x).replace(/\\/g, '/'));
  const f = norm(from);
  const t = norm(target);

  let rel;
  if (flavor === 'win') {
    const ra = winRoot(f);
    const rb = winRoot(t);
    if (bothAbsolute && ra && rb && ra !== rb) {
      throw new AppError(CODES.BAD_ARGUMENT,
        `toPosixRel: 两侧 Windows 路径不在同一个根（${ra} vs ${rb}），无法产出相对路径：`
        + `from=${JSON.stringify(from)} target=${JSON.stringify(target)}。`
        + '跨盘符的相对路径不存在（path.win32 会返回绝对路径），把绝对路径写进产物是 B9 事故 —— 必须明确报错');
    }
    rel = lib.relative(f, t);
  } else {
    rel = lib.relative(f, t);
  }

  const out = String(rel).replace(/\\/g, '/');
  // ★ 机器化守卫：任何输入组合下都不得把绝对路径漏进产物
  if (/^[A-Za-z]:/.test(out) || /^\/\//.test(out)) {
    throw new AppError(CODES.BAD_ARGUMENT,
      `toPosixRel: 结果仍是绝对路径（${out}）—— 绝不能写进产物（B9）：`
      + `from=${JSON.stringify(from)} target=${JSON.stringify(target)}`);
  }
  return out;
}

/**
 * 规范化为 POSIX 风格路径（不改变绝对/相对性质，仅统一分隔符）。
 * @param {string} p
 * @returns {string}
 */
function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * 深拷贝（结构化克隆，退化到 JSON 序列化 —— 产物里本就没有函数/循环引用）。
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * 生成确定性排序用的组合 key。
 * @param {...any} parts
 * @returns {string}
 */
function joinKey(...parts) {
  return parts.map((p) => (p === null || p === undefined ? '' : String(p))).join(' ');
}

module.exports = {
  FLOAT_PRECISION,
  pathFlavor,
  pathShape,
  pathLibFor,
  basenameByShape,
  round6,
  roundDeep,
  sortKeysDeep,
  sortBy,
  cmpStr,
  entriesSorted,
  toPosixRel,
  toPosix,
  deepClone,
  joinKey,
};
