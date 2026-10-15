'use strict';
/**
 * test/unit/xml-patcher.test.js —— M2 第 1 步：定点文本补丁引擎 golden 字节级测试
 *
 * ★ 为什么是「字节级」★（M2-SPEC §8）
 *   M2 的正确性承诺是：「保留对象 ID、复用已有组件 —— 只改目标节点的目标属性，
 *   其余字节原样保留」。任何一处空白/属性序/引号风格/注释的漂移都会让画师在
 *   编辑器里看到意料之外的 diff。所以这里不比结构，直接比**字符串**：
 *   · 改一个属性值后，把新值换回旧值必须**逐字符等于原文**；
 *   · 文本属性、注释、引号风格、拼接风格 ui:// 一律原样。
 *
 * 输入基准：合成 fixture 的 MailDetail.xml / RewardCell.xml 原文（确定性生成）。
 * 六条 golden 逐条对应规格 §8 的六项要求（顺序一致）。
 *
 * 按审查者纪律：只加守住回归的用例，不追求数量。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { makeFguiProject } = require('../fixtures/make-fgui-project');
const { AppError } = require('../../src/core/errors');
const {
  patchAttrs, insertChild, setAttr,
} = require('../../src/fgui/xml-patcher');

const ROOT = path.resolve(__dirname, '../..');
const FIXTURE = path.join(ROOT, 'test/fixtures/fgui-project');

/** 保证 fixture 存在（缺就现造；脚本确定性，重复造无害）。 */
function ensureFixture() {
  if (!fs.existsSync(path.join(FIXTURE, 'MailPopup.fairy'))) {
    try {
      makeFguiProject({ outDir: FIXTURE });
    } catch (err) {
      throw new Error(
        `合成工程 fixture 缺失且现场生成失败：${err.message}\n`
        + '请先跑 `npm run fixtures`（其中包含 make-fgui-project.js）',
      );
    }
  }
  return FIXTURE;
}

/** 读取 fixture 里的一个文本文件。 */
function readFixture(rel) {
  return fs.readFileSync(path.join(ensureFixture(), rel), 'utf8');
}

// ────────────────────────────────────────────────────────────────────────────
// golden 1：只改目标属性值，其余字节逐字节保留
// ────────────────────────────────────────────────────────────────────────────
test('golden 1: patchAttrs 只改目标属性值，text/属性序/注释/空白/XML 声明逐字节保留', () => {
  let xml = readFixture('assets/MailDetail/MailDetail.xml');
  // 在样本里插一条注释（验证补丁不吞注释/空白）
  xml = xml.replace('  <displayList>', '  <displayList>\n    <!-- 注释：验证补丁不吞注释与空白 -->');
  const before = xml;

  const after = patchAttrs(xml, { id: 'b00001' }, { xy: '200,200' });

  // (a) 结果与原文只差目标属性值：把新值换回旧值必须逐字符等于原文
  assert.notEqual(after, before);
  assert.equal(after.replace('xy="200,200"', 'xy="24,24"'), before);

  // (b) 逐字节保留：XML 声明 / 注释 / text 属性 / 其它节点属性序
  assert.ok(after.includes('<?xml version="1.0" encoding="utf-8"?>'));
  assert.ok(after.includes('<!-- 注释：验证补丁不吞注释与空白 -->'));
  assert.ok(after.includes('<text id="b00002" name="title" xy="140,32" size="200,36" text="邮件详情"/>'));
  assert.ok(after.includes('<component id="c00001" name="frame" src="ui://a1b2c3d4/e4f5a6b7" xy="0,0" size="480,320"/>'));
});

// ────────────────────────────────────────────────────────────────────────────
// golden 2：insertChild 缩进与同侪一致、属性序 id→name→src→xy→size、自闭合、id 已分配
// ────────────────────────────────────────────────────────────────────────────
test('golden 2: insertChild 缩进 4 空格与同侪一致，内容逐字节保留（属性序/自闭合）', () => {
  const xml = readFixture('assets/MailDetail/MailDetail.xml');
  const rendered = '<image id="b00004" name="new_icon" src="ui://e5f6a7b8/a7b8c9d0" xy="24,260" size="96,96"/>';

  const after = insertChild(xml, { tag: 'displayList' }, rendered);

  // 新行以 4 空格缩进（与同侪一致）、内容逐字节等于给定串、紧邻闭合标签之前
  assert.ok(after.includes(`\n    ${rendered}\n  </displayList>`), '缩进/位置不符');

  // 插入行必须逐字节等于渲染串（引擎不重排、不规范化）
  const insertedLine = after.split('\n').find((l) => l.includes('id="b00004"'));
  assert.equal(insertedLine, `    ${rendered}`);

  // 自闭合
  assert.ok(rendered.endsWith('/>'));

  // 属性序 id→name→src→xy→size 在原位保持
  const order = ['id="b00004"', 'name="new_icon"', 'src="ui://e5f6a7b8/a7b8c9d0"', 'xy="24,260"', 'size="96,96"'];
  let cursor = -1;
  for (const token of order) {
    const idx = insertedLine.indexOf(token);
    assert.ok(idx > cursor, `属性序错乱（${token}）`);
    cursor = idx;
  }

  // 其余内容不变：去掉新行后逐字节等于原文
  assert.equal(after.replace(`    ${rendered}\n`, ''), xml);
});

// ────────────────────────────────────────────────────────────────────────────
// golden 3：setAttr visible=false 追加到既有节点 start-tag 末尾，不动既有属性
// ────────────────────────────────────────────────────────────────────────────
test('golden 3: setAttr 新属性追加到末尾，既有属性一个都不动', () => {
  const xml = readFixture('assets/MailDetail/MailDetail.xml');
  const after = setAttr(xml, { id: 'b00003' }, 'visible', 'false');

  assert.ok(after.includes(
    '<list id="b00003" name="rewards" xy="24,140" size="312,96" defaultItem="RewardCell" visible="false"/>',
  ));
  // 追加在末尾：去掉新属性即还原原文
  assert.equal(after.replace(' visible="false"', ''), xml);
});

// ────────────────────────────────────────────────────────────────────────────
// golden 4：同名多节点 → 抛 AppError（不猜）；零命中同样抛错
// ────────────────────────────────────────────────────────────────────────────
test('golden 4: 同名多节点命中 → 抛 AppError 且列候选，拒绝猜测', () => {
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<component size="100,100">',
    '  <displayList>',
    '    <image id="b00001" name="dup" xy="0,0" size="10,10"/>',
    '    <image id="b00002" name="dup" xy="10,10" size="10,10"/>',
    '  </displayList>',
    '</component>',
    '',
  ].join('\n');

  assert.throws(
    () => patchAttrs(xml, { name: 'dup' }, { xy: '5,5' }),
    (err) => {
      assert.ok(err instanceof AppError, '必须是 AppError');
      assert.equal(err.code, 'BAD_ARGUMENT');
      assert.match(err.message, /2 个节点/);
      assert.deepEqual(err.details.candidates, ['b00001', 'b00002']);
      return true;
    },
  );

  // 零命中同样拒绝（不静默、不新建）
  assert.throws(
    () => patchAttrs(xml, { name: 'nope' }, { xy: '5,5' }),
    (err) => err instanceof AppError && err.code === 'BAD_ARGUMENT',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// golden 5：属性值原引号风格保留（单引号变体）
// ────────────────────────────────────────────────────────────────────────────
test('golden 5: 属性值原引号风格保留（单引号变体不改成双引号）', () => {
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<component size="100,100">',
    '  <displayList>',
    "    <image id='b00001' name='q' src='ui://pkg/id' xy='0,0' size='10,10'/>",
    '  </displayList>',
    '</component>',
    '',
  ].join('\n');

  const after = patchAttrs(xml, { id: 'b00001' }, { xy: '3,4' });

  assert.ok(after.includes("xy='3,4'"), '单引号应保留');
  assert.ok(!after.includes('xy="3,4"'), '不应擅自改成双引号');
  // 其余单引号属性原样
  assert.ok(after.includes("src='ui://pkg/id'"));
  // 只差该属性值
  assert.equal(after.replace("xy='3,4'", "xy='0,0'"), xml);
});

// ────────────────────────────────────────────────────────────────────────────
// golden 6：拼接风格 ui:// 原样保留，不规范化（M1 探针教训）
// ────────────────────────────────────────────────────────────────────────────
test('golden 6: 拼接风格 ui:// 被打补丁节点原样保留，不规范化成斜杠风格', () => {
  const xml = readFixture('assets/MailDetail/RewardCell.xml');

  const after = patchAttrs(xml, { id: 'b00001' }, { xy: '12,16' });

  // src 一字不改（上游 bridge 的无斜杠拼接风格保留）
  assert.ok(after.includes('src="ui://e5f6a7b8a7b8c9d0"'), '拼接风格 src 被改写');
  assert.ok(!after.includes('ui://e5f6a7b8/a7b8c9d0'), '不应插入斜杠规范化');
  // 目标属性确实改了，其余逐字节不变
  assert.ok(after.includes('xy="12,16"'));
  assert.equal(after.replace('xy="12,16"', 'xy="0,0"'), xml);
});
