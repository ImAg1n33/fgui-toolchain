'use strict';
/**
 * test/unit/normalize.test.js —— 名称归一化
 *
 * ★ 本文件必须包含 K5 陷阱用例：`矩形1` vs `矩形11`（PRD K5 / ARCHITECTURE §8.4）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeName, normalizeNameDetailed, isSameName, sizeWithinTol, baseNameOf,
} = require('../../src/core/normalize');

test('normalizeName: 基本归一化', () => {
  assert.equal(normalizeName('图层129'), '图层129');
  assert.equal(normalizeName('图层129.png'), '图层129');
  assert.equal(normalizeName('  图层129  '), '图层129');
  assert.equal(normalizeName('Layer 1'), 'layer1', '空格应被去除');
  assert.equal(normalizeName('EFFECT'), 'effect', '应转小写');
});

test('normalizeName: 全角转半角', () => {
  assert.equal(normalizeName('（１）'), '(1)');
  assert.equal(normalizeName('ＡＢＣ'), 'abc');
  assert.equal(normalizeName('　　　　', { stripExtension: false }), '');
});

test('normalizeName: 去副本后缀（只认带括号的数字形式）', () => {
  assert.equal(normalizeName('图层249(1)'), '图层249');
  assert.equal(normalizeName('图层249（1）'), '图层249');
  assert.equal(normalizeName('图层249 [2]'), '图层249');
  assert.equal(normalizeName('图层249副本'), '图层249');
  assert.equal(normalizeName('矩形1(1)(2)'), '矩形1', '叠罗汉副本后缀应剥到干净');
});

// ======================================================================
// ★★★ K5 陷阱：矩形1 是 矩形11 的前缀 ★★★
// 这是 PRD 记录的最危险的命名陷阱。若归一化或匹配环节用了
// startsWith / includes，`矩形11` 的检索会返回 `矩形1` —— 素材张冠李戴。
// ======================================================================
test('K5 陷阱: 矩形1 与 矩形11 归一化后不相等', () => {
  const a = normalizeName('矩形1');
  const b = normalizeName('矩形11');
  assert.equal(a, '矩形1');
  assert.equal(b, '矩形11');
  assert.notEqual(a, b, '★ 归一化后必须不相等，否则 Ch-1 会误匹配');
});

test('K5 陷阱: 归一化后 矩形1 确实不等于 矩形11（显式复验）', () => {
  // 防回归：若将来有人"优化"归一化逻辑导致尾部数字被吃掉，这条会红
  assert.equal(normalizeName('矩形1').length, 3);
  assert.equal(normalizeName('矩形11').length, 4);
  assert.notEqual(normalizeName('矩形1'), normalizeName('矩形11'));
});

test('K5 陷阱: isSameName 对前缀关系返回 false', () => {
  assert.equal(isSameName('矩形1', '矩形11'), false, '★ 前缀不等于全等');
  assert.equal(isSameName('矩形11', '矩形1'), false);
  assert.equal(isSameName('矩形1', '矩形1'), true);
  assert.equal(isSameName('图层249(1)', '图层249'), true, '去副本后缀后应相等');
});

test('K5 陷阱: 一串数字后缀的边界情况', () => {
  // 尾部裸数字永远不能被当成副本后缀剥掉
  for (const n of ['矩形1', '矩形11', '矩形111', '图层249', '组1200拷贝']) {
    assert.ok(normalizeName(n).length > 0, `${n} 归一化后不应为空`);
  }
  assert.equal(normalizeName('矩形111'), '矩形111');
  assert.notEqual(normalizeName('矩形111'), normalizeName('矩形11'));
});

test('normalizeNameDetailed: 返回元信息供 evidence 使用', () => {
  const d = normalizeNameDetailed('图层249(1)');
  assert.equal(d.raw, '图层249(1)');
  assert.equal(d.norm, '图层249');
  assert.equal(typeof d.variantsApplied, 'boolean');
  assert.ok(d.variantsTableSize > 0, '默认应内置常用繁简字表');
});

test('繁简映射：默认表生效且词典缺失时可降级', () => {
  // 找一个确实在默认表里的字
  const { DEFAULT_VARIANTS } = require('../../src/core/variants');
  const trad = Object.keys(DEFAULT_VARIANTS)[0];
  const simp = DEFAULT_VARIANTS[trad];
  assert.equal(normalizeName(trad), simp, '默认表应生效');

  // 词典缺失 -> 降级为不转换，且降级是「可见的」（tableSize=0）
  const d = normalizeNameDetailed(trad, { variants: {} });
  assert.equal(d.norm, trad, '空词典应降级为不转换');
  assert.equal(d.variantsTableSize, 0, '降级必须能被 evidence 标注');
  assert.equal(d.variantsApplied, false);
});

test('baseNameOf: 从 POSIX 路径取 basename', () => {
  assert.equal(baseNameOf('a/b/c/矩形1.png'), '矩形1.png');
  assert.equal(baseNameOf('a\\b\\矩形11.png'), '矩形11.png');
  assert.equal(baseNameOf('矩形1.png'), '矩形1.png');
  assert.equal(baseNameOf(''), '');
});

test('sizeWithinTol: ±2px 尺寸校验', () => {
  assert.equal(sizeWithinTol({ w: 100, h: 50 }, { w: 100, h: 50 }), true);
  assert.equal(sizeWithinTol({ w: 100, h: 50 }, { w: 102, h: 48 }), true, '容差内应通过');
  assert.equal(sizeWithinTol({ w: 100, h: 50 }, { w: 103, h: 50 }), false, '超出容差应拒绝');
  assert.equal(sizeWithinTol(null, { w: 1, h: 1 }), false);
});

test('归一化是幂等的（normalize(normalize(x)) === normalize(x)）', () => {
  const names = ['矩形1', '图层249(1)', 'Group 1', '特效', '组1200拷贝', 'ＲＥＵＳＥ'];
  for (const n of names) {
    const once = normalizeName(n);
    assert.equal(normalizeName(once), once, `${n} 归一化应幂等`);
  }
});
