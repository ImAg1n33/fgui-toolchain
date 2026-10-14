'use strict';
/**
 * src/core/fs-json.js —— 确定性 JSON 读写（ARCHITECTURE §4.4 地基）
 *
 * 唯一允许写 JSON 产物的入口。保证：
 *   - 2 空格缩进、行尾 \n（非 \r\n）、UTF-8 无 BOM、末尾恰好一个 \n
 *   - 键名字母序（不依赖插入序）
 *   - 浮点全部 toFixed(6)
 *   - 产物内零时间戳（时间戳只允许进 run_meta.json 与 .bak.<ts> 文件名）
 */

const fs = require('fs');
const path = require('path');
const {
  sortKeysDeep, roundDeep, toPosixRel, toPosix, basenameByShape,
} = require('./determinism');
const { AppError, CODES } = require('./errors');
const { atomicWrite } = require('./atomic');

/**
 * 把任意值转成「确定性 + 定点化」后的可序列化结构。
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalize(value) {
  return roundDeep(sortKeysDeep(value));
}

/**
 * 序列化为确定性 JSON 文本（末尾恰好一个 \n）。
 * @param {unknown} value
 * @returns {string}
 */
function stringifyJson(value) {
  return JSON.stringify(canonicalize(value), null, 2) + '\n';
}

/**
 * 确保父目录存在。
 * @param {string} dir
 */
function ensureDir(dir) {
  if (!dir || fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 确定性写 JSON。
 * @param {string} filePath
 * @param {unknown} value
 * @param {Object} [opts]
 * @param {string} [opts.root] 相对化基准目录；给出时把 value 内的绝对路径转 POSIX 相对
 * @returns {{path:string, bytes:number}}
 */
function writeJson(filePath, value, opts = {}) {
  let payload = value;
  if (opts.root) payload = relativizePaths(value, opts.root);
  const text = stringifyJson(payload);
  const dir = path.dirname(filePath);
  ensureDir(dir);
  try {
    // 'utf8' 不写 BOM；显式用 \n
    fs.writeFileSync(filePath, text, { encoding: 'utf8' });
  } catch (err) {
    throw new AppError(CODES.WRITE_FAILED, `写 JSON 失败: ${filePath}`, { cause: err.message });
  }
  return { path: filePath, bytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * 递归把对象里所有形如 `C:\a\b` 或 `/a/b` 的字符串值转成相对 root 的 POSIX 路径。
 * 只处理显式标记为路径的键，避免误伤普通文本。
 * @param {unknown} value
 * @param {string} root
 * @returns {unknown}
 */
/**
 * 单个路径值的相对化（含跨根降级）。
 *
 * ★ 为什么需要降级 ★
 *   `toPosixRel()` 在跨盘符 / 跨 UNC 根 / 形态混用时会**明确报错** —— 此时
 *   「相对路径」在语义上不存在，而旧实现会静默把 `C:\Users\...` 写进产物
 *   （B9 事故）。但 CLI 也不该因为「PSD 放在另一个盘」就整体崩掉，所以这里
 *   降级为 `outside-root/<文件名>`：确定性、不含任何绝对路径信息；
 *   原因由调用方（CLI）另行告警，绝不静默。
 *
 * @param {string} val 待相对化的路径值
 * @param {string} root 基准目录
 * @returns {string}
 */
function relativizePathValue(val, root) {
  try {
    return toPosixRel(root, val);
  } catch (err) {
    if (err && err.code === 'BAD_ARGUMENT') {
      // ★ basename 也必须按形态取（第 2 层宿主化）：宿主版 basename 在 Linux 上
      //   不认反斜杠，会把整串 Windows 路径当成文件名 → 产物里出现绝对路径。
      const out = `outside-root/${basenameByShape(val)}`;
      // ★ 机器化守卫：降级结果里绝不允许残留盘符或分隔符（任何宿主都成立）
      if (/^[A-Za-z]:/.test(out) || out.includes('\\') || out.includes(':')) {
        throw new AppError(CODES.BAD_ARGUMENT,
          `降级后的路径仍含绝对路径信息（${out}）—— 绝不能写进产物（B9）：${JSON.stringify(val)}`);
      }
      return out;
    }
    throw err;
  }
}

function relativizePaths(value, root) {
  const PATH_KEYS = new Set([
    'psdPath', 'psdBase', 'psdTarget', 'relPath', 'path', 'assetPath', 'file', 'fguiProject',
  ]);
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const key of Object.keys(node)) {
        const val = node[key];
        if (PATH_KEYS.has(key) && typeof val === 'string' && val && !val.startsWith('null')) {
          out[key] = relativizePathValue(val, root);
        } else {
          out[key] = walk(val);
        }
      }
      return out;
    }
    return node;
  };
  return walk(value);
}

/**
 * 读 JSON。文件不存在返回 null（由调用方决定是否报错）。
 * @param {string} filePath
 * @returns {unknown|null}
 */
function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new AppError(CODES.READ_FAILED, `读 JSON 失败: ${filePath}`, { cause: err.message });
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new AppError(CODES.READ_FAILED, `JSON 解析失败: ${filePath}`, { cause: err.message });
  }
}

/**
 * 确定性写文本（HTML 产物同样要求 \n + 无 BOM + 末尾一个 \n）。
 * @param {string} filePath
 * @param {string} text
 * @returns {{path:string, bytes:number}}
 */
function writeText(filePath, text) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
  ensureDir(path.dirname(filePath));
  try {
    fs.writeFileSync(filePath, normalized, { encoding: 'utf8' });
  } catch (err) {
    throw new AppError(CODES.WRITE_FAILED, `写文本失败: ${filePath}`, { cause: err.message });
  }
  return { path: filePath, bytes: Buffer.byteLength(normalized, 'utf8') };
}

/**
 * 读文本。
 * @param {string} filePath
 * @returns {string}
 */
function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new AppError(CODES.READ_FAILED, `读文本失败: ${filePath}`, { cause: err.message });
  }
}

/**
 * 原子写文本（支持 `now` 注入与 .bak 备份）。
 *
 * ★ 为什么要给 writeText 也走原子写 ★（QA 独立验证时发现）
 *   原先 `writeText` 直接 `fs.writeFileSync`，而 `atomicWrite` 独立存在 ——
 *   于是 `--now` 注入对 JSON 产物之外的文件（例如 .bak 备份名）完全无效，
 *   「确定性验证」这条承诺只对一半的文件成立。
 *   统一到 atomicWrite 后：备份名可复现、写入是原子的（不会留下半截文件）。
 *
 * @param {string} filePath
 * @param {string} text
 * @param {Object} [opts]
 * @param {string} [opts.root] 相对化基准（当前仅 writeJson 支持）
 * @param {Date|string|number} [opts.now] 注入时间戳（决定 .bak 文件名）
 * @param {boolean} [opts.backup=false] 目标已存在时是否备份
 * @returns {{path:string, bytes:number, backupPath:string|null}}
 */
function writeTextAtomic(filePath, text, opts = {}) {
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
  const r = atomicWrite({
    targetPath: filePath,
    content: normalized,
    now: opts.now,
    backup: opts.backup,
  });
  return { path: r.targetPath, bytes: r.bytes, backupPath: r.backupPath };
}

/**
 * 原子写 JSON（支持 `now` 注入与 .bak 备份）。
 *
 * 与旧版 writeJson 的差别：走 atomicWrite 而不是裸 writeFileSync。
 * `now` 目前不进 JSON **内容**（产物内零时间戳是硬要求，B9），
 * 但会用于 `.bak` 文件名 —— 这才是 `now` 的正确用途：
 * 注入固定值后，备份文件名可复现，便于比对两次运行。
 *
 * @param {string} filePath
 * @param {unknown} value
 * @param {Object} [opts]
 * @param {string} [opts.root] 相对化基准；给出时把 value 内的绝对路径转 POSIX 相对
 * @param {Date|string|number} [opts.now] 注入时间戳（决定 .bak 文件名）
 * @param {boolean} [opts.backup=false]
 * @returns {{path:string, bytes:number, backupPath:string|null}}
 */
function writeJsonAtomic(filePath, value, opts = {}) {
  let payload = value;
  if (opts.root) payload = relativizePaths(value, opts.root);
  const r = writeTextAtomic(filePath, stringifyJson(payload), opts);
  return r;
}

module.exports = {
  canonicalize,
  stringifyJson,
  writeJson,
  writeJsonAtomic,
  writeText,
  writeTextAtomic,
  readJson,
  readText,
  ensureDir,
};
