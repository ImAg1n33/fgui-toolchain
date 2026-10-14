'use strict';
/**
 * test/unit/phash.test.js —— 自实现 64bit DCT pHash（ARCHITECTURE D7）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { phashFromGray, phashFromRgba, phashFromBuffer, GRAY_SIZE, LOW_FREQ } = require('../../src/imaging/phash');
const { hamming64, phashSimilarity } = require('../../src/core/hash');

/**
 * 造测试图案。
 * @param {number} n
 * @param {function(number,number):number} fn (x,y) -> 0..255
 * @returns {Uint8Array}
 */
function pattern(n, fn) {
  const out = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) out[y * n + x] = Math.round(fn(x, y));
  }
  return out;
}

test('phash: 输出恒为 16 位十六进制', () => {
  const g = pattern(32, (x, y) => (x * 8 + y * 4) % 256);
  const h = phashFromGray(g);
  assert.equal(h.length, 16, `实际 ${h} 长度 ${h.length}`);
  assert.match(h, /^[0-9a-f]{16}$/);
});

test('phash: 自汉明距离为 0（确定性核心）', () => {
  const g = pattern(32, (x, y) => ((x * 37 + y * 91) % 251));
  const h1 = phashFromGray(g);
  const h2 = phashFromGray(g);
  assert.equal(h1, h2, '同输入两次必须完全相同');
  assert.equal(hamming64(h1, h2), 0);
  assert.equal(phashSimilarity(h1, h2), 1);
});

test('phash: 跨次运行稳定（连续 5 次一致）', () => {
  const g = pattern(32, (x, y) => Math.sin(x / 3) * 127 + 127);
  const set = new Set();
  for (let i = 0; i < 5; i++) set.add(phashFromGray(g));
  assert.equal(set.size, 1, `5 次应只产出 1 个值，实得 ${[...set]}`);
});

test('phash: 相同图案的不同数组实例产出相同 hash', () => {
  const fn = (x, y) => ((x * y) % 256);
  const a = pattern(32, fn);
  const b = pattern(32, fn);
  assert.notEqual(a, b, '两个不同的 Buffer 实例');
  assert.equal(phashFromGray(a), phashFromGray(b));
});

test('phash: 纯色图的 hash 稳定（退化但不崩）', () => {
  const g1 = new Uint8Array(1024).fill(128);
  const g2 = new Uint8Array(1024).fill(128);
  assert.equal(phashFromGray(g1), phashFromGray(g2));
  assert.match(phashFromGray(g1), /^[0-9a-f]{16}$/);
});

test('phash: 结构不同的图 hash 应不同', () => {
  const stripes = pattern(32, (x) => (Math.floor(x / 4) % 2) * 255);
  const checker = pattern(32, (x, y) => ((Math.floor(x / 4) + Math.floor(y / 4)) % 2) * 255);
  const h1 = phashFromGray(stripes);
  const h2 = phashFromGray(checker);
  assert.notEqual(h1, h2, '竖条与棋盘格应产生不同 hash');
  assert.ok(hamming64(h1, h2) > 0);
});

test('phashFromRgba: 与 phashFromGray 走同一路径且结果合法', () => {
  const w = 48;
  const h = 48;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const v = ((x * 5 + y * 11) % 256);
      data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255;
    }
  }
  const hash = phashFromRgba({ width: w, height: h, data });
  assert.match(hash, /^[0-9a-f]{16}$/);
  // 再算一次应一致
  assert.equal(hash, phashFromRgba({ width: w, height: h, data }));
});

test('phashFromRgba: 透明像素按白底合成（不污染结构特征）', () => {
  const w = 16;
  const h = 16;
  // 全透明 vs 全白不透明：视觉上都是白底，hash 应一致
  const transparent = new Uint8Array(w * h * 4); // alpha=0, rgb=0
  const white = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    white[i * 4] = 255; white[i * 4 + 1] = 255; white[i * 4 + 2] = 255; white[i * 4 + 3] = 255;
  }
  assert.equal(
    phashFromRgba({ width: w, height: h, data: transparent }),
    phashFromRgba({ width: w, height: h, data: white }),
    '全透明（按白底合成）应与全白一致',
  );
});

test('hamming64: 边界情况', () => {
  assert.equal(hamming64('0000000000000000', '0000000000000000'), 0);
  assert.equal(hamming64('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(hamming64('0000000000000000', '0000000000000001'), 1);
  // 长度不同 -> 视为完全不同（返回 64）
  assert.equal(hamming64('0000', '0000000000000000'), 64);
  // 非法字符 -> 64（不崩）
  assert.equal(hamming64('zzzz', '0000000000000000'), 64);
});

test('phashFromBuffer: 走 decoder 的灰度路径', async () => {
  const { createDecoder } = require('../../src/imaging/decoder');
  const fs = require('fs');
  const path = require('path');
  const p = path.resolve(__dirname, '../fixtures/golden/assets/panel_1.png');
  if (!fs.existsSync(p)) return; // fixture 未生成则跳过
  const dec = createDecoder();
  const buf = fs.readFileSync(p);
  const h1 = await phashFromBuffer(buf, dec);
  const h2 = await phashFromBuffer(buf, dec);
  assert.match(h1, /^[0-9a-f]{16}$/);
  assert.equal(h1, h2, '同文件两次应一致');
});

test('常量与架构一致', () => {
  assert.equal(GRAY_SIZE, 32);
  assert.equal(LOW_FREQ, 8);
});
