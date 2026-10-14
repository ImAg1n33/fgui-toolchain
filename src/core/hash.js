'use strict';
/**
 * src/core/hash.js —— 哈希工具
 *
 * - contentSha256：特征指纹，用于增量扫描与映射缓存失效检测
 * - assetId：sha1(relPath) 前 16 位，稳定可复现（跨机器一致，不依赖内容）
 * - hamming64：pHash 汉明距离（64bit）
 */

const crypto = require('crypto');

/**
 * @param {Buffer|string} data
 * @returns {string} 小写 hex
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * @param {Buffer|string} data
 * @returns {string} 小写 hex
 */
function sha1(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

/**
 * 素材 id：sha1(相对路径) 前 16 位。
 * 用相对路径而非内容，保证同一路径重建 fixture 后 id 不变（B9 逐字节一致的前提之一）。
 * @param {string} relPath POSIX 相对路径
 * @returns {string} 16 位小写 hex
 */
function assetId(relPath) {
  return sha1(relPath).slice(0, 16);
}

/**
 * 特征指纹：sha256 前 16 位。用于 map.json 的失效检测。
 * @param {string} sha256hex
 * @returns {string}
 */
function fingerprint(sha256hex) {
  return String(sha256hex || '').slice(0, 16);
}

/**
 * 16 位 hex（64bit）之间的汉明距离。
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..64
 */
function hamming64(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (sa.length !== sb.length) return 64;
  let dist = 0;
  for (let i = 0; i < sa.length; i++) {
    let x = parseInt(sa[i], 16);
    let y = parseInt(sb[i], 16);
    if (Number.isNaN(x) || Number.isNaN(y)) return 64;
    let z = x ^ y;
    while (z) {
      dist += z & 1;
      z >>= 1;
    }
  }
  return dist;
}

/**
 * 64bit 汉明距离归一化到 0..1 相似度。
 * @param {string} a
 * @param {string} b
 * @returns {number} 1 = 完全相同
 */
function phashSimilarity(a, b) {
  return 1 - hamming64(a, b) / 64;
}

/**
 * 两个 bbox 的 IoU（交并比）。
 * @param {{x:number,y:number,w:number,h:number}} a
 * @param {{x:number,y:number,w:number,h:number}} b
 * @returns {number} 0..1
 */
function bboxIou(a, b) {
  if (!a || !b) return 0;
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const uni = a.w * a.h + b.w * b.h - inter;
  if (uni <= 0) return 0;
  return inter / uni;
}

/**
 * 主色距离（0..1，0 = 完全相同）。用欧氏距离除以最大可能距离。
 * @param {{r:number,g:number,b:number}} a
 * @param {{r:number,g:number,b:number}} b
 * @returns {number}
 */
function colorDistance(a, b) {
  if (!a || !b) return 1;
  const dr = (a.r || 0) - (b.r || 0);
  const dg = (a.g || 0) - (b.g || 0);
  const db = (a.b || 0) - (b.b || 0);
  const dist = Math.sqrt(dr * dr + dg * dg + db * db);
  const max = Math.sqrt(255 * 255 * 3);
  return Math.min(1, dist / max);
}

module.exports = {
  sha256,
  sha1,
  assetId,
  fingerprint,
  hamming64,
  phashSimilarity,
  bboxIou,
  colorDistance,
};
