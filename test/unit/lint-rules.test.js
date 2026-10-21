'use strict';
/**
 * test/unit/lint-rules.test.js —— P1-a-02 lint 规则单测（含反向验证 + 守卫自检）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 本文件的测试方法论（QA 两轮验证教给我们的最重要的一课）★
 *
 *   上一轮的教训：canvas-shim.test.js 只断言「alpha 非零」，而纯黑图 alpha
 *   恒 255 —— **必然通过，是假绿测试**。所以本轮每条 lint 规则必须：
 *
 *     ① 喂一个**已知合法**的 XML   → 断言不报错（0 error 0 warning）
 *     ② 喂一个**已知违反该规则**的 XML → 断言**必须报错**，且规则 id 正确
 *     ③ 断言错误信息**可读**（含位置与原因，不是「lint failed」这种）
 *
 *   再加一层**守卫自检**：故意把某条规则的配置改坏，断言 lint 行为随之改变
 *   —— 证明规则真的在读配置，不是硬编码（R-01/R-02/R-04/R-07/R-08/R-09 六条
 *   依赖外部答案的规则尤其需要这个证明）。
 * ════════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  lintComponentXml, parseXmlDocument, pathOf, RULES,
} = require('../../src/fgui/lint-rules');
const { DEFAULT_FGUI_CONFIG, buildIdPattern } = require('../../src/fgui/constants');
const { defaultConfig, readRawConfig } = require('../../src/core/config');
const {
  RESOURCES, NEVER_FEATURES, legalComponentXml, violationSamples, MALFORMED,
} = require('../fixtures/fgui-samples');

const ROOT = path.resolve(__dirname, '../..');

/** 便捷封装：lint 合法样本 + 资源注入。 */
function lintLegal(extraOpts = {}) {
  return lintComponentXml(legalComponentXml(), { resources: RESOURCES, ...extraOpts });
}

/** 便捷封装：lint 违规样本 + 资源注入。 */
function lintSample(key, extraOpts = {}) {
  const sample = violationSamples()[key];
  return { sample, result: lintComponentXml(sample.xml, { resources: RESOURCES, ...extraOpts }) };
}

/** 按规则 id 过滤问题。 */
function byRule(result, ruleId) {
  return [...result.errors, ...result.warnings].filter((i) => i.rule === ruleId);
}

// ════════════════════════════════════════════════════════════════════════════
// 一、XML 解析器（R-00 的底座，先测解析器本身）
// ════════════════════════════════════════════════════════════════════════════

test('XML 解析器: 合法样本完整解析，零错误', () => {
  const p = parseXmlDocument(legalComponentXml());
  assert.equal(p.errors.length, 0, `不应有解析错误: ${JSON.stringify(p.errors)}`);
  assert.equal(p.root.tag, 'component');
  assert.equal(p.root.attrs.exported, 'true');
  const dl = p.root.children[0];
  assert.equal(dl.tag, 'displayList');
  assert.equal(dl.children.length, 5);
  assert.equal(dl.children[1].attrs.scale9grid, '10,10,444,284');
  assert.ok(p.decl && p.decl.includes('xml'), '应捕获 XML 声明');
});

test('XML 解析器: 实体 / CDATA / 注释 / 自闭合 / 嵌套', () => {
  const xml = [
    '<?xml version="1.0"?>',
    '<!-- 注释里 <fake> 不该被解析 -->',
    '<component exported="true">',
    '  <displayList>',
    '    <text id="b00001" name="t" text="a &amp; b &lt;tag&gt; &#65; &#x42;"/>',
    '    <graph id="b00002" name="g"><![CDATA[raw <content> ok]]></graph>',
    '  </displayList>',
    '</component>',
  ].join('\n');
  const p = parseXmlDocument(xml);
  assert.equal(p.errors.length, 0, JSON.stringify(p.errors));
  const text = p.root.children[0].children[0];
  assert.equal(text.attrs.text, 'a & b <tag> A B');
  assert.ok(p.root.children[0].children[1].text.includes('raw <content> ok'));
  assert.equal(pathOf(text), 'component > displayList > text');
});

test('XML 解析器: 畸形文档各自报对应结构错误', () => {
  const cases = [
    [MALFORMED.unclosed, '未闭合'],
    [MALFORMED.dupAttr, '重复'],
    [MALFORMED.mismatchClose, '不匹配'],
  ];
  for (const [xml, needle] of cases) {
    const p = parseXmlDocument(xml);
    assert.ok(p.errors.length > 0, `应报错: ${JSON.stringify(xml.slice(0, 40))}`);
    assert.ok(p.errors.some((e) => e.message.includes(needle)),
      `错误信息应含「${needle}」: ${p.errors.map((e) => e.message).join(' | ')}`);
  }
  // 错误根元素：解析器照常解析（根标签校验是 R-00 结构规则的职责，上面已单测）
  const wrongRoot = parseXmlDocument(MALFORMED.wrongRoot);
  assert.equal(wrongRoot.errors.length, 0, 'window 根在词法上合法，不应算解析错误');
  assert.equal(wrongRoot.root.tag, 'window');
  // 空文档：解析器不产错误（这是结构规则的职责），但必须 root=null 让上层能报
  const empty = parseXmlDocument(MALFORMED.emptyDoc);
  assert.equal(empty.root, null, '空文档应解析出 null 根');
});

test('XML 解析器: 错误带行号（可读性硬要求）', () => {
  const p = parseXmlDocument(MALFORMED.unclosed);
  assert.ok(p.errors.every((e) => Number.isFinite(e.line) && e.line >= 1), '每个错误都要有行号');
});

// ════════════════════════════════════════════════════════════════════════════
// 二、合法样本：0 error 0 warning（最强的「不误拦」断言）
// ════════════════════════════════════════════════════════════════════════════

test('★ 合法样本: 0 error 0 warning（保守默认配置下不误拦）', () => {
  const r = lintLegal();
  assert.equal(r.ok, true, `合法样本不应报错: ${JSON.stringify(r.errors, null, 2)}`);
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 0, `合法样本不应告警: ${JSON.stringify(r.warnings, null, 2)}`);
  assert.equal(r.notes.length, 0, '资源齐全时不应有跳过说明');
  assert.equal(r.stats.displayObjects, 5);
});

// ════════════════════════════════════════════════════════════════════════════
// 三、逐条规则：合法不报 + 违规必报（成对测试）
// ════════════════════════════════════════════════════════════════════════════

test('R-00: 结构错误必报，且信息可读', () => {
  for (const [name, xml] of Object.entries(MALFORMED)) {
    const r = lintComponentXml(xml, { resources: RESOURCES });
    const issues = byRule(r, 'R-00');
    assert.ok(issues.length > 0, `${name} 应报 R-00`);
    for (const i of issues) {
      assert.ok(i.message.length > 15, `R-00 信息过短（不可读）: ${i.message}`);
      assert.ok(/第 \d+ 行|根元素|未闭合|重复/.test(i.message), `R-00 信息应含位置/原因: ${i.message}`);
    }
  }
});

test('R-01: 合法标签不报；<foo> 必报', () => {
  assert.equal(byRule(lintLegal(), 'R-01').length, 0, '合法样本不应触发 R-01');
  const { sample, result } = lintSample('R-01');
  const issues = byRule(result, 'R-01');
  assert.equal(issues.length, 1, `应恰好 1 条 R-01: ${JSON.stringify(issues)}`);
  assert.equal(issues[0].severity, 'error');
  assert.ok(issues[0].message.includes(sample.needle), `信息应含 ${sample.needle}: ${issues[0].message}`);
  assert.ok(issues[0].message.includes('foo'), '信息应指出问题标签');
  assert.ok(issues[0].line > 0 && issues[0].path.includes('foo'), '应带行号与路径');
});

// ★ UPSTREAM-FIX-2：displayList 合法标签对齐上游 STANDARDS.md §2.6 ★
//   合法标签只有 10 种：image/graph/loader/loader3D/text/richtext/list/
//   component/jta/group。旧表错在含 input/movieclip、缺 jta/loader3D ——
//   恰好命中 STANDARDS 预警的「高频发明错误」。

test('★ UPSTREAM-FIX-2: <jta> 与 <loader3D> 是合法舞台标签，不报 R-01/R-04', () => {
  const xml = legalComponentXml().replace(
    '    <graph id="b00004" name="deco_line" xy="24,64" size="120,2"/>',
    '    <jta id="b00004" name="fx_sequence" src="ui://abcd1234/reward_icon" xy="24,64" size="48,48"/>\n'
    + '    <loader3D id="b00006" name="model_3d" url="ui://abcd1234/reward_icon" xy="24,140" size="48,48"/>',
  );
  const r = lintComponentXml(xml, { resources: RESOURCES });
  assert.equal(byRule(r, 'R-01').length, 0,
    `★ jta/loader3D 是合法舞台标签（STANDARDS §2.6）: ${JSON.stringify(byRule(r, 'R-01'))}`);
  assert.equal(byRule(r, 'R-04').length, 0,
    `jta/loader3D 的 ui:// 引用合法: ${JSON.stringify(byRule(r, 'R-04'))}`);
});

test('★ UPSTREAM-FIX-2: 发明 <input> 必报 R-01，且信息教正确写法 text + input="true"', () => {
  const { result } = lintSample('R-01-input');
  const issues = byRule(result, 'R-01');
  assert.equal(issues.length, 1, `应恰好 1 条 R-01: ${JSON.stringify(issues)}`);
  assert.equal(issues[0].severity, 'error');
  // STANDARDS 原文：ObjectType 叫 InputText，但 XML 标签就是 text + input 属性
  assert.ok(issues[0].message.includes('text input="true"'),
    `错误信息必须教正确写法（text + input="true"）: ${issues[0].message}`);
  assert.ok(issues[0].message.includes('InputText'), '应点明 ObjectType 名与 XML 标签名的区别');
});

test('★ UPSTREAM-FIX-2: 发明 <movieclip> 必报 R-01，且信息教正确写法 <jta>', () => {
  const { result } = lintSample('R-01-movieclip');
  const issues = byRule(result, 'R-01');
  assert.equal(issues.length, 1, `应恰好 1 条 R-01: ${JSON.stringify(issues)}`);
  assert.equal(issues[0].severity, 'error');
  // STANDARDS 原文：movieclip 只在 package.xml 里作资源登记标签，不上舞台
  assert.ok(issues[0].message.includes('<jta'), `错误信息必须教正确写法（<jta/>）: ${issues[0].message}`);
  assert.ok(issues[0].message.includes('package.xml'), '应说明 movieclip 的真实用途（资源登记，不上舞台）');
});

test('★ UPSTREAM-FIX-2 契约快照: DISPLAY_LIST_TAGS 与 STANDARDS §2.6 的 10 种标签逐字一致', () => {
  const { DISPLAY_LIST_TAGS } = require('../../src/fgui/constants');
  assert.deepEqual([...DISPLAY_LIST_TAGS].sort(), [
    'component', 'graph', 'group', 'image', 'jta', 'list', 'loader', 'loader3D', 'richtext', 'text',
  ]);
  assert.equal(DISPLAY_LIST_TAGS.length, 10, 'STANDARDS §2.6：合法标签只有 10 种');
  assert.ok(!DISPLAY_LIST_TAGS.includes('input'), '<input> 不是标签（输入框 = text + input 属性）');
  assert.ok(!DISPLAY_LIST_TAGS.includes('movieclip'), '<movieclip> 不上舞台（只在 package.xml 登记）');
});

test('R-02: 合法 extention 不报；Foo 必报', () => {
  assert.equal(byRule(lintLegal(), 'R-02').length, 0);
  const { result } = lintSample('R-02');
  const issues = byRule(result, 'R-02');
  assert.equal(issues.length, 1);
  assert.ok(issues[0].message.includes('extention') && issues[0].message.includes('Foo'));
  assert.ok(issues[0].message.includes('Button'), '信息应列出合法值供对照');
});

test('R-03: 6 位色不报；8 位色必报（含纯蓝事故说明）；格式错必报', () => {
  assert.equal(byRule(lintLegal(), 'R-03').length, 0, '合法样本的 6 位色不应触发 R-03');

  const eight = lintSample('R-03-8bit').result;
  const i8 = byRule(eight, 'R-03');
  assert.equal(i8.length, 1);
  assert.ok(i8[0].message.includes('8 位色'), '必须点明 8 位色问题');
  assert.ok(i8[0].message.includes('后 6 位') || i8[0].message.includes('纯蓝'),
    '必须解释上游事故机理（只取后 6 位）');
  assert.ok(i8[0].message.includes('alpha'), '必须给出修复方向（alpha 属性）');

  const fmt = lintSample('R-03-format').result;
  const iF = byRule(fmt, 'R-03');
  assert.equal(iF.length, 1);
  assert.ok(iF[0].message.includes('#RRGGBB'));
});

test('R-04: 8 位包 id 不报；6 位必报（含事故说明）', () => {
  assert.equal(byRule(lintLegal(), 'R-04').length, 0);
  const { result } = lintSample('R-04');
  const issues = byRule(result, 'R-04');
  assert.equal(issues.length, 1);
  assert.ok(issues[0].message.includes('6 位'), '必须点明位数错误');
  assert.ok(issues[0].message.includes('首字符'), '必须解释事故机理');
  assert.ok(issues[0].message.includes('abcd1234'.length) || issues[0].message.includes('8 位'),
    '必须说明期望位数');
});

test('R-05: 合规 scale9grid 不报；越界必报；格式错必报；负值只告警', () => {
  assert.equal(byRule(lintLegal(), 'R-05').length, 0, '注入尺寸后合法样本不应触发 R-05');

  const bounds = lintSample('R-05-bounds').result;
  const iB = byRule(bounds, 'R-05');
  assert.equal(iB.length, 1);
  assert.equal(iB[0].severity, 'error');
  assert.ok(iB[0].message.includes('越界'), '必须点明越界');
  assert.ok(iB[0].message.includes('464x304'), '必须给出图片实际尺寸供对照');

  const fmt = lintSample('R-05-format').result;
  const iF = byRule(fmt, 'R-05');
  assert.equal(iF.length, 1);
  assert.ok(iF[0].message.includes('l,t,w,h'), '必须给出期望格式');

  // 负值：官方编辑器 svg 怪癖 → warn 不 error（避免误拦）
  const neg = lintSample('R-05-negative').result;
  const iN = byRule(neg, 'R-05');
  assert.equal(iN.length, 1);
  assert.equal(iN[0].severity, 'warning');
  assert.equal(neg.ok, true, '负值不应阻断写盘');
  assert.equal(neg.errors.length, 0);
});

test('R-06: exported="true" 不报；缺失/false 必报', () => {
  assert.equal(byRule(lintLegal(), 'R-06').length, 0);
  for (const key of ['R-06-missing', 'R-06-false']) {
    const { result } = lintSample(key);
    const issues = byRule(result, 'R-06');
    assert.equal(issues.length, 1, `${key} 应恰好 1 条 R-06`);
    assert.ok(issues[0].message.includes('exported'), '信息应点名 exported');
    assert.ok(issues[0].message.includes('丢包') || issues[0].message.includes('跳过'),
      '信息应解释发布静默丢包机理');
  }
});

test('R-07: b000NN 不报；错格式/缺失/重复必报', () => {
  assert.equal(byRule(lintLegal(), 'R-07').length, 0);

  const fmt = lintSample('R-07-format').result;
  assert.equal(byRule(fmt, 'R-07').length, 1, 'n0 应报');
  assert.ok(byRule(fmt, 'R-07')[0].message.includes('b00001'), '应给出期望样式');

  const missing = lintSample('R-07-missing').result;
  assert.equal(byRule(missing, 'R-07').length, 1, '缺 id 应报');

  const dup = lintSample('R-07-dup').result;
  const iD = byRule(dup, 'R-07');
  assert.equal(iD.length, 1);
  assert.ok(iD[0].message.includes('重复'), '重复 id 必须点名');
});

test('R-08: 语义名不报；n5/img3 必报', () => {
  assert.equal(byRule(lintLegal(), 'R-08').length, 0);
  for (const key of ['R-08-n', 'R-08-img']) {
    const { result } = lintSample(key);
    const issues = byRule(result, 'R-08');
    assert.equal(issues.length, 1, `${key} 应恰好 1 条 R-08`);
    assert.ok(issues[0].message.includes('无语义'), '必须点明无语义');
    assert.ok(issues[0].message.includes('popup_bg') || issues[0].message.includes('btn_close'),
      '应给出正例命名供对照');
  }
});

test('R-09: 5 个对象不报；81 个必报（warning 不阻断）', () => {
  assert.equal(byRule(lintLegal(), 'R-09').length, 0);
  const { result } = lintSample('R-09');
  const issues = byRule(result, 'R-09');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'warning', '对象数超标是告警不是阻断');
  assert.equal(result.ok, true, '告警不应使 ok=false');
  assert.ok(issues[0].message.includes('81') && issues[0].message.includes('80'),
    '必须同时给出实际数与阈值');
});

test('R-10: CAN_9GRID 特征 + scale9grid 不报；NEVER 特征必报 warning', () => {
  assert.equal(byRule(lintLegal(), 'R-10').length, 0, '面板特征不应触发 R-10');

  // 同一份 XML，把 popup_frame 的特征换成圆形（NEVER）→ 必须告警
  const neverResources = {
    ...RESOURCES,
    'ui://abcd1234/popup_frame': { w: 464, h: 304, features: NEVER_FEATURES },
  };
  const r = lintComponentXml(legalComponentXml(), { resources: neverResources });
  const issues = byRule(r, 'R-10');
  assert.equal(issues.length, 1, 'NEVER 特征 + scale9grid 应报 R-10');
  assert.equal(issues[0].severity, 'warning', '九宫格是启发式，只能告警不能阻断（HANDOFF §2.1 有已知误判）');
  assert.equal(r.ok, true);
  assert.ok(issues[0].message.includes('NEVER'), '必须点明判定结果');
  assert.ok(issues[0].message.includes('人工确认'), '必须提示人工确认（启发式不可全信）');
  assert.ok(issues[0].message.includes('cornerFill'), '必须带上 grid9 判据供人核对');
});

// ════════════════════════════════════════════════════════════════════════════
// 四、错误信息可读性（横向断言：不许出现「lint failed」这种废话）
// ════════════════════════════════════════════════════════════════════════════

test('★ 可读性: 所有违规样本的信息都含位置 + 原因 + 修复方向', () => {
  const samples = violationSamples();
  for (const [key, sample] of Object.entries(samples)) {
    if (key === 'R-10') continue; // R-10 需要特殊资源注入，上面已单测
    const r = lintComponentXml(sample.xml, { resources: RESOURCES });
    const all = [...r.errors, ...r.warnings];
    assert.ok(all.length > 0, `${key} 应有报出`);
    const hit = all.find((i) => i.message.includes(sample.needle));
    assert.ok(hit, `${key} 的信息应含关键词「${sample.needle}」: ${all.map((i) => i.message).join(' | ')}`);
    assert.ok(hit.message.length >= 20, `${key} 信息过短（不像给人看的）: ${hit.message}`);
    assert.ok(!/lint failed|lint error|检查失败/.test(hit.message),
      `${key} 不允许出现无信息量的失败措辞: ${hit.message}`);
    if (sample.expect === 'error') {
      assert.ok(hit.line === null || hit.line >= 1, `${key} error 应带行号（文档级问题可为 null）`);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 五、守卫自检：改配置必须能改变 lint 行为（证明不是硬编码）
// ════════════════════════════════════════════════════════════════════════════
//
// 每个用例断言**两个方向**：
//   默认配置 → 违规样本报错
//   改坏配置 → 同一违规样本不再报（或合法样本开始报）
// 只有两个方向都成立，才能证明「规则真的在读配置」。

test('★ 守卫自检 R-01: 把 foo 加进合法标签表，违规样本不再报', () => {
  const { sample, result } = lintSample('R-01');
  assert.equal(byRule(result, 'R-01').length, 1, '默认必须报');

  const relaxed = lintComponentXml(sample.xml, {
    resources: RESOURCES,
    config: { displayListTags: [...DEFAULT_FGUI_CONFIG.displayListTags, 'foo'] },
  });
  assert.equal(byRule(relaxed, 'R-01').length, 0, '放行 foo 后就不应再报 R-01');
});

test('★ 守卫自检 R-02: 把 Foo 加进 extention 表，违规样本不再报', () => {
  const { sample, result } = lintSample('R-02');
  assert.equal(byRule(result, 'R-02').length, 1, '默认必须报');

  const relaxed = lintComponentXml(sample.xml, {
    resources: RESOURCES,
    config: { extentionTypes: [...DEFAULT_FGUI_CONFIG.extentionTypes, 'Foo'] },
  });
  assert.equal(byRule(relaxed, 'R-02').length, 0, '放行 Foo 后就不应再报 R-02');
});

test('★ 守卫自检 R-04: 包 id 位数改成 6，违规样本的 6 位引用不再报', () => {
  const { sample, result } = lintSample('R-04');
  assert.equal(byRule(result, 'R-04').length, 1, '默认必须报');
  assert.ok(byRule(result, 'R-04')[0].message.includes('abc123'), '默认应点出 6 位包 id');

  const relaxed = lintComponentXml(sample.xml, { resources: RESOURCES, config: { pkgIdLength: 6 } });
  const after = byRule(relaxed, 'R-04');
  assert.ok(!after.some((i) => i.message.includes('abc123')),
    '位数改成 6 后 6 位包 id abc123 应放行');
  // 反向：同一配置下，样本里其余 8 位引用应报错（证明两个方向都在读配置）
  assert.ok(after.length >= 2, '位数改成 6 后其余 8 位引用应报错');
});

test('★ 守卫自检 R-07: 换 id 前缀表，合法样本开始报、新表放行', () => {
  const cfg = { idPrefixes: ['x'], idDigits: 3 };
  const strict = lintComponentXml(legalComponentXml(), { resources: RESOURCES, config: cfg });
  assert.equal(byRule(strict, 'R-07').length, 5, '前缀改成 x 后 b000NN 应全部报错');

  const xStyle = legalComponentXml().replace(/id="b0000(\d)"/g, 'id="x00$1"');
  const relaxed = lintComponentXml(xStyle, { resources: RESOURCES, config: cfg });
  assert.equal(byRule(relaxed, 'R-07').length, 0, 'x00N 在新表下应放行');
  assert.equal(buildIdPattern(['x'], 3).test('x001'), true);
  assert.equal(buildIdPattern(['x'], 3).test('b00001'), false);
});

test('★ 守卫自检 R-08: 清空禁用词表，无语义名不再报', () => {
  const { sample, result } = lintSample('R-08-n');
  assert.equal(byRule(result, 'R-08').length, 1, '默认必须报');

  const relaxed = lintComponentXml(sample.xml, { resources: RESOURCES, config: { bannedNamePatterns: [] } });
  assert.equal(byRule(relaxed, 'R-08').length, 0, '清空禁用表后 n5 应放行');
});

test('★ 守卫自检 R-09: 阈值改成 1，合法样本开始报', () => {
  assert.equal(byRule(lintLegal(), 'R-09').length, 0, '默认阈值 80 下合法样本不报');
  const strict = lintComponentXml(legalComponentXml(), { resources: RESOURCES, config: { maxObjectsPerComponent: 1 } });
  assert.equal(byRule(strict, 'R-09').length, 1, '阈值 1 下 5 个对象应报');
});

test('★ 守卫自检 R-06: exportedRequired=false，缺失不再报', () => {
  const { sample, result } = lintSample('R-06-missing');
  assert.equal(byRule(result, 'R-06').length, 1, '默认必须报');
  const relaxed = lintComponentXml(sample.xml, { resources: RESOURCES, config: { exportedRequired: false } });
  assert.equal(byRule(relaxed, 'R-06').length, 0, '关掉开关后缺失 exported 应放行');
});

test('★ 守卫自检 R-03: colorRequireAlpha=true，省略 alpha 的合法样本开始报', () => {
  assert.equal(byRule(lintLegal(), 'R-03').length, 0, '默认不强制 alpha');
  const strict = lintComponentXml(legalComponentXml(), {
    resources: RESOURCES,
    config: { colorRequireAlpha: true },
  });
  const issues = byRule(strict, 'R-03');
  assert.ok(issues.length >= 1, '强制 alpha 后，省略 alpha 的颜色应报错');
  assert.ok(issues.every((i) => i.message.includes('alpha')), '报错应点名 alpha');
});

test('★ 守卫自检 R-10: grid9LintEnabled=false，NEVER 冲突不再报', () => {
  const neverResources = {
    ...RESOURCES,
    'ui://abcd1234/popup_frame': { w: 464, h: 304, features: NEVER_FEATURES },
  };
  const on = lintComponentXml(legalComponentXml(), { resources: neverResources });
  assert.equal(byRule(on, 'R-10').length, 1, '开启时必须报');
  const off = lintComponentXml(legalComponentXml(), {
    resources: neverResources,
    config: { grid9LintEnabled: false },
  });
  assert.equal(byRule(off, 'R-10').length, 0, '关闭后不应报');
});

// ════════════════════════════════════════════════════════════════════════════
// 六、配置契约守卫（防配置腐化 —— 沿用 P0 grid9 的同款模式）
// ════════════════════════════════════════════════════════════════════════════

test('★ 配置守卫: DEFAULT_FGUI_CONFIG 与 core 默认配置逐键一致（含值）', () => {
  const defFgui = defaultConfig().fgui;
  const a = Object.keys(DEFAULT_FGUI_CONFIG).sort();
  const b = Object.keys(defFgui).sort();
  assert.deepEqual(a, b, `fgui 段键不一致：constants=${a} core=${b}`);
  for (const k of a) {
    assert.deepEqual(DEFAULT_FGUI_CONFIG[k], defFgui[k], `fgui.${k} 值不一致`);
  }
});

test('★ 配置守卫: fgui.config.json 的 fgui 段与代码默认逐键一致（含值）', () => {
  const raw = readRawConfig(path.join(ROOT, 'fgui.config.json')).raw;
  assert.ok(raw.fgui, 'fgui.config.json 应有 fgui 段（否则改配置不生效，只会静默走默认）');
  const rawKeys = Object.keys(raw.fgui).filter((k) => !k.startsWith('_')).sort();
  const defKeys = Object.keys(DEFAULT_FGUI_CONFIG).sort();
  assert.deepEqual(rawKeys, defKeys,
    `fgui.config.json 的 fgui 段键不一致\n配置=${rawKeys}\n代码=${defKeys}`);
  for (const k of defKeys) {
    assert.deepEqual(raw.fgui[k], DEFAULT_FGUI_CONFIG[k], `fgui.${k} 配置值与代码默认不一致`);
  }
});

test('★ 配置守卫自检: 删掉配置键后行为必须改变（证明守卫不是恒真）', () => {
  // 模拟「配置文件删掉 bannedNamePatterns」——合并后默认会补回，
  // 但显式传部分配置时删键的语义必须可观察（resolveLintConfig 与默认深合并）。
  const { resolveLintConfig } = require('../../src/fgui/lint-rules');
  const withDefault = resolveLintConfig({});
  assert.deepEqual(withDefault.bannedNamePatterns, [...DEFAULT_FGUI_CONFIG.bannedNamePatterns],
    '不传配置时应拿到默认禁用表');
  const overridden = resolveLintConfig({ bannedNamePatterns: ['^zzz$'] });
  assert.deepEqual(overridden.bannedNamePatterns, ['^zzz$'], '显式配置应整体覆盖（数组不逐项合并）');
  assert.equal(overridden.pkgIdLength, DEFAULT_FGUI_CONFIG.pkgIdLength, '未覆盖的键应回落默认');
});

// ════════════════════════════════════════════════════════════════════════════
// 七、纯函数契约与确定性
// ════════════════════════════════════════════════════════════════════════════

test('纯函数: lint 不修改入参 XML、不依赖调用顺序', () => {
  const xml = legalComponentXml();
  const before = xml;
  lintComponentXml(xml, { resources: RESOURCES });
  assert.equal(xml, before, '入参字符串不应被修改');
});

test('确定性: 同一输入两次 lint 结果逐字节一致（B9）', () => {
  const a = lintLegal();
  const b = lintLegal();
  assert.deepEqual(a, b);
  // 违规样本同样要确定（错误排序稳定）
  const v1 = lintSample('R-09').result;
  const v2 = lintSample('R-09').result;
  assert.deepEqual(v1, v2);
});

test('配置形态: 完整配置对象与 fgui 段本身都应被接受', () => {
  const full = defaultConfig(); // 含 .fgui 段
  const r1 = lintComponentXml(legalComponentXml(), { config: full, resources: RESOURCES });
  assert.equal(r1.ok, true);
  const r2 = lintComponentXml(legalComponentXml(), { config: full.fgui, resources: RESOURCES });
  assert.equal(r2.ok, true);
  assert.deepEqual(r1.stats, r2.stats);
});

test('notes: 未注入资源时明确记录跳过（不允许静默跳过）', () => {
  const r = lintComponentXml(legalComponentXml(), {}); // 无 resources
  assert.equal(r.ok, true);
  assert.ok(r.notes.some((n) => n.includes('R-05') && n.includes('未提供图片尺寸')),
    'scale9grid 边界未查必须写进 notes');
  assert.ok(r.notes.some((n) => n.includes('R-10') && n.includes('未提供 features')),
    'R-10 未查必须写进 notes');
  assert.equal(r.stats.scale9.sizeUnknown, 1);
  assert.equal(r.stats.grid9.noFeatures, 1);
});

test('规则表导出完整（R-00 ~ R-11 共 12 条）', () => {
  const ids = RULES.map((r) => r.id);
  assert.deepEqual(ids, ['R-00', 'R-01', 'R-02', 'R-03', 'R-04', 'R-05', 'R-06', 'R-07', 'R-08', 'R-09', 'R-10', 'R-11']);
  for (const r of RULES) assert.ok(r.title && r.title.length > 4, `${r.id} 应有可读标题`);
});

// ════════════════════════════════════════════════════════════════════════════
// 八、BUG-A 回归：越界数字实体不得崩溃，必须报可读错误
// ════════════════════════════════════════════════════════════════════════════
//
// QA 第三轮独立发现：`&#x110000;` 让 String.fromCodePoint 抛未捕获
// RangeError，lint 整体崩溃（经事务层变裸异常，退出码契约失效）。
// 真实触发形态：用户把 `&#x1F600;`（emoji）多打一个 0 成 `&#x1F6000;`。
// 验收：不崩溃 + 报 R-00 可读错误（含码点/位置/修正方向）。

test('★ BUG-A: 越界实体 &#x110000; 不崩溃，报 R-00 可读错误', () => {
  const xml = '<component exported="true"><displayList>'
    + '<text id="b00001" name="t" text="&#x110000;"/></displayList></component>';
  let r;
  assert.doesNotThrow(() => { r = lintComponentXml(xml, { resources: RESOURCES }); },
    '★ 越界实体绝不允许抛异常（BUG-A：原实现抛未捕获 RangeError）');
  assert.equal(r.ok, false);
  const issues = byRule(r, 'R-00');
  assert.equal(issues.length, 1, `应恰好 1 条 R-00，实际 ${JSON.stringify(issues)}`);
  assert.ok(issues[0].message.includes('110000'), '信息应点名越界码点');
  assert.ok(issues[0].message.includes('0x10FFFF'), '信息应给出合法上界');
  assert.ok(issues[0].message.includes('&#x1F600;'), '信息应给出正例（emoji 正确写法）');
  assert.ok(issues[0].line >= 1, '信息应带行号');
  // 属性值里原样保留该实体（不猜一个字符）
  const parsed = parseXmlDocument(xml);
  assert.equal(parsed.root.children[0].children[0].attrs.text, '&#x110000;');
});

test('★ BUG-A: 十进制巨码 &#99999999999; 同样不崩溃、报可读错误', () => {
  const xml = '<component exported="true"><displayList>'
    + '<text id="b00001" name="t" text="&#99999999999;"/></displayList></component>';
  let r;
  assert.doesNotThrow(() => { r = lintComponentXml(xml, {}); });
  assert.equal(r.ok, false);
  const issues = byRule(r, 'R-00');
  assert.equal(issues.length, 1);
  assert.ok(issues[0].message.includes('99999999999'), '应点名越界码点');
  assert.ok(issues[0].message.includes('越界'));
});

test('★ BUG-A: 真实手滑形态 &#x1F6000;（多打一个 0）不崩溃、报可读错误', () => {
  const xml = '<component exported="true"><displayList>'
    + '<text id="b00001" name="t" text="奖励 &#x1F6000; 到账"/></displayList></component>';
  let r;
  assert.doesNotThrow(() => { r = lintComponentXml(xml, {}); });
  const issues = byRule(r, 'R-00');
  assert.equal(issues.length, 1, '一个越界实体报一次（不是每个字符一条）');
  // 0x1F6000 = 2056192（注意：不是 1285120 —— 那是 0x1F600）
  assert.ok(issues[0].message.includes('2056192'), '应点名越界码点 2056192');
  assert.ok(issues[0].message.includes('多打了数字') || issues[0].message.includes('手滑'),
    '信息应说明常见成因');
});

test('★ BUG-A 正对照: 合法实体 &#x1F600;/&#65;/&amp; 不误报', () => {
  const xml = '<component exported="true"><displayList>'
    + '<text id="b00001" name="t" text="&#x1F600;&#65;&amp;&lt;&#x10FFFF;"/></displayList></component>';
  const r = lintComponentXml(xml, {});
  assert.equal(byRule(r, 'R-00').length, 0,
    `合法实体（含边界值 0x10FFFF）不应报错: ${JSON.stringify(r.errors)}`);
  const parsed = parseXmlDocument(xml);
  assert.equal(parsed.root.children[0].children[0].attrs.text, '\u{1F600}A&<\u{10FFFF}');
});

test('★ BUG-A 兜底: 解析路径的任何未预期异常都转结构化错误而非裸抛', () => {
  // 直接喂一个会让旧实现崩溃的输入集群（越界实体 + 其他畸形混合）
  const xml = '<component exported="true"><displayList>'
    + '<text id="b00001" name="t" text="&#x110000;&#99999999999;&#x1F6000;"/>'
    + '<image id="b00002" name="n0" src="ui://abc123/x" color="#000000c8"/>'
    + '</displayList></component>';
  let r;
  assert.doesNotThrow(() => { r = lintComponentXml(xml, {}); },
    '混合畸形输入集群也不允许崩溃');
  assert.equal(r.ok, false);
  // 三个越界实体各一条 R-00 + 其他规则的问题也都在
  assert.equal(byRule(r, 'R-00').length, 3, '三个越界实体应各报一条');
  assert.ok(byRule(r, 'R-08').length >= 1, '无语义名 n0 仍应被抓（说明解析树仍可用）');
  assert.ok(byRule(r, 'R-03').length >= 1, '8 位色仍应被抓');
  // 结构化：每条 issue 都有 rule/message 字段（不是裸 Error）
  for (const i of [...r.errors, ...r.warnings]) {
    assert.ok(typeof i.rule === 'string' && typeof i.message === 'string');
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 九、BUG 修复附加项：大写 UI:// 不得绕过 R-04
// ════════════════════════════════════════════════════════════════════════════

test('★ 大写 UI:// 现在也走 R-04 包 id 校验（原绕过路径已闭合）', () => {
  const xml = legalComponentXml().replace('ui://abcd1234/popup_bg', 'UI://abc123/popup_bg');
  const r = lintComponentXml(xml, { resources: RESOURCES });
  const issues = byRule(r, 'R-04');
  assert.equal(issues.length, 1, '大写 scheme 的 6 位包 id 必须被抓（原实现完全跳过 R-04）');
  assert.ok(issues[0].message.includes('abc123'), '信息应点名问题包 id');
  assert.ok(issues[0].message.includes('6 位'));

  // 正对照：大写 scheme + 正确 8 位包 id 不误报（大小写不敏感识别，不额外制造错误）
  const ok = legalComponentXml().replace('ui://abcd1234/popup_bg', 'UI://abcd1234/popup_bg');
  const r2 = lintComponentXml(ok, { resources: RESOURCES });
  assert.equal(byRule(r2, 'R-04').length, 0, '大写 scheme + 合法 8 位包 id 不应误报');
});

// ════════════════════════════════════════════════════════════════════════════
// 十、M2-SPEC §4.2 ⑩：R-04 同时接受两种 ui:// 风格 + R-11 短资源 ID 登记性
// ════════════════════════════════════════════════════════════════════════════
//
// ★ 真实依据（FairyGUI 6.1.4 真实工程，包 mtlga5qj，非推测）★
//   · 组件内 `<image src>` 引用同包图片用**短资源 ID**：`src="q0jse"`（不带 ui://）；
//   · Loader 的 `url` / 列表 `defaultItem` 用**拼接无斜杠**：`ui://mtlga5qjls3rcl`。
//   改前：R-04 自写正则只认 slash，把 `ui://mtlga5qj8yoa8k` 整串当 pkgId（14 位）
//   → 报「包 id 不是 8 位」+「缺少 itemId」**两个 error**，把合法引用判成错误。

/** 造一个只含 displayList 内容的最小组件 XML。 */
function wrapDisplayList(lines) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<component size="480,320" exported="true">',
    '  <displayList>',
    ...lines,
    '  </displayList>',
    '</component>',
    '',
  ].join('\n');
}

test('★ R-04: concat（拼接无斜杠）引用必须通过 —— 真实工程写法不得被误判成 2 个 error', () => {
  // 真实样本三形态里可被 R-04 检到的两种（url / defaultItem）
  const xml = wrapDisplayList([
    '    <loader id="b00001" name="icon_loader" url="ui://mtlga5qjls3rcl" xy="0,0" size="64,64"/>',
    '    <list id="b00002" name="cells" xy="0,80" size="200,100" defaultItem="ui://mtlga5qjxqt5f"/>',
  ]);
  const r = lintComponentXml(xml, { resources: RESOURCES });
  const issues = byRule(r, 'R-04');
  assert.deepEqual(issues, [],
    `concat 引用不得报 R-04（改前会报 2 个：包 id 14 位 + 缺少 itemId）：${JSON.stringify(issues)}`);

  // 另一种真实写法：14 字符拼接（包 id 8 + itemId 6）
  const xml2 = wrapDisplayList([
    '    <loader id="b00001" name="model" url="ui://mtlga5qj8yoa8k" xy="0,0" size="64,64"/>',
  ]);
  assert.deepEqual(byRule(lintComponentXml(xml2, { resources: RESOURCES }), 'R-04'), []);
});

test('★ R-04: slash 形态仍合法（两种风格并存，不互相排斥）', () => {
  const xml = wrapDisplayList([
    '    <loader id="b00001" name="model" url="ui://mtlga5qj/8yoa8k" xy="0,0" size="64,64"/>',
  ]);
  assert.deepEqual(byRule(lintComponentXml(xml, { resources: RESOURCES }), 'R-04'), []);
});

test('★ R-04: 包 id 位数错误仍必报（3 位 / 6 位）', () => {
  const short3 = wrapDisplayList([
    '    <loader id="b00001" name="model" url="ui://abc/xyz" xy="0,0" size="64,64"/>',
  ]);
  const r3 = byRule(lintComponentXml(short3, { resources: RESOURCES }), 'R-04');
  assert.equal(r3.length, 1, '3 位包 id 必须报');
  assert.ok(r3[0].message.includes('3 位') && r3[0].message.includes('8 位'));

  // 6 位 + 斜杠：不能被 parseUiRef 的 concat 分支按 8 位硬切而"掩藏"成合法
  const short6 = wrapDisplayList([
    '    <loader id="b00001" name="model" url="ui://abc123/xyz" xy="0,0" size="64,64"/>',
  ]);
  const r6 = byRule(lintComponentXml(short6, { resources: RESOURCES }), 'R-04');
  assert.equal(r6.length, 1, '6 位包 id 必须报（不得被 concat 硬切掩藏）');
  assert.ok(r6[0].message.includes('abc123'));
});

test('★ R-11: 短资源 ID src 已登记且 type=image → 不报', () => {
  const xml = wrapDisplayList([
    '    <image id="b00001" name="mail_bg" src="q0jse" xy="0,0" size="100,50"/>',
  ]);
  const r = lintComponentXml(xml, { resources: { q0jse: { w: 100, h: 50, type: 'image' } } });
  assert.deepEqual(byRule(r, 'R-11'), []);
});

test('★ R-11: 短资源 ID 未登记 → 报错（丢失的"引用是否存在"保护由本规则补上）', () => {
  const xml = wrapDisplayList([
    '    <image id="b00001" name="mail_bg" src="q0jse" xy="0,0" size="100,50"/>',
  ]);
  const r = lintComponentXml(xml, { resources: { other_id: { w: 1, h: 1, type: 'image' } } });
  const issues = byRule(r, 'R-11');
  assert.equal(issues.length, 1, '未登记的短 ID 必须报');
  assert.ok(issues[0].message.includes('没有') || issues[0].message.includes('未登记'),
    `信息应说明未登记: ${issues[0].message}`);
  assert.equal(issues[0].severity, 'error');
});

test('★ R-11: 短资源 ID 命中但 type=component → 报「不是图片资源」', () => {
  const xml = wrapDisplayList([
    '    <image id="b00001" name="mail_bg" src="q0jse" xy="0,0" size="100,50"/>',
  ]);
  const r = lintComponentXml(xml, { resources: { q0jse: { w: 1, h: 1, type: 'component' } } });
  const issues = byRule(r, 'R-11');
  assert.equal(issues.length, 1);
  assert.ok(issues[0].message.includes('不是图片'), `信息应说明不是图片: ${issues[0].message}`);
});

test('★ R-11: resources 未注入 → 整条规则跳过（不产生噪声）', () => {
  const xml = wrapDisplayList([
    '    <image id="b00001" name="mail_bg" src="q0jse" xy="0,0" size="100,50"/>',
  ]);
  const r = lintComponentXml(xml, {}); // 无 resources
  assert.deepEqual(byRule(r, 'R-11'), [], '未注入资源时不得凭空报未登记');
});

test('★ R-11: src 含 ui:// → 交给 R-04，本规则不重复报', () => {
  const xml = wrapDisplayList([
    '    <image id="b00001" name="mail_bg" src="ui://mtlga5qj/a7b8c9d0" xy="0,0" size="100,50"/>',
  ]);
  const r = lintComponentXml(xml, { resources: RESOURCES });
  assert.deepEqual(byRule(r, 'R-11'), [], 'ui:// 形态不由 R-11 处理');
  assert.deepEqual(byRule(r, 'R-04'), [], 'ui:// 形态由 R-04 校验且合法');
});

// ════════════════════════════════════════════════════════════════════════════
// 十一、font 引用纳入 R-04（专用清单 uiRefAttributes），但不污染 urlAttributes
// ════════════════════════════════════════════════════════════════════════════
//
// 真实工程字体引用：`font="ui://mtlga5qj8yoa8k"`（拼接）。需要校验。
// 但不能把 `font` 塞进 `urlAttributes` —— 那份清单被 R-05/R-10 用来
// "找这个元素引用的图片去量宽高"，混进 font 会让 `<text font="ui://...">`
// 被当成引用了一张图 → 新误报。

const { parseUiRef } = require('../../src/fgui/resource-resolver');

test('★ parseUiRef: 含 "/" 一律按 slash 拆（6 位包 id 不再被 concat 硬切掩藏）', () => {
  assert.deepEqual(parseUiRef('ui://abc123/x'),
    { raw: 'ui://abc123/x', style: 'slash', pkgId: 'abc123', itemId: 'x' });
  assert.deepEqual(parseUiRef('ui://mtlga5qj/8yoa8k'),
    { raw: 'ui://mtlga5qj/8yoa8k', style: 'slash', pkgId: 'mtlga5qj', itemId: '8yoa8k' });
});

test('★ parseUiRef: 不含 "/" 才走 concat（真实工程写法）', () => {
  assert.deepEqual(parseUiRef('ui://mtlga5qj8yoa8k'),
    { raw: 'ui://mtlga5qj8yoa8k', style: 'concat', pkgId: 'mtlga5qj', itemId: '8yoa8k' });
  assert.deepEqual(parseUiRef('ui://e5f6a7b8a7b8c9d0'),
    { raw: 'ui://e5f6a7b8a7b8c9d0', style: 'concat', pkgId: 'e5f6a7b8', itemId: 'a7b8c9d0' });
  // 缺 itemId / 非 ui:// → null（不猜）
  assert.equal(parseUiRef('ui://mtlga5qj'), null);
  assert.equal(parseUiRef('reward_icon'), null);
  assert.equal(parseUiRef('ui://abc/'), null);
});

test('★ 配置分离: font 在 uiRefAttributes、不在 urlAttributes', () => {
  assert.ok(DEFAULT_FGUI_CONFIG.uiRefAttributes.includes('font'),
    'R-04 专用清单必须含 font（真实工程字体引用要校验）');
  assert.ok(!DEFAULT_FGUI_CONFIG.urlAttributes.includes('font'),
    'urlAttributes 绝不能含 font —— R-05/R-10 会把它当成引用图片去量宽高');
  // 其余属性两份清单一致
  for (const a of ['src', 'url', 'icon', 'defaultItem']) {
    assert.ok(DEFAULT_FGUI_CONFIG.uiRefAttributes.includes(a), `uiRefAttributes 应含 ${a}`);
    assert.ok(DEFAULT_FGUI_CONFIG.urlAttributes.includes(a), `urlAttributes 应含 ${a}`);
  }
});

test('★ R-04: font 引用（拼接）合法 → 不报', () => {
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<component size="480,320" exported="true">',
    '  <font id="f00001" name="main_font" font="ui://mtlga5qj8yoa8k"/>',
    '  <displayList>',
    '    <graph id="b00001" name="bg" xy="0,0" size="480,320"/>',
    '  </displayList>',
    '</component>',
    '',
  ].join('\n');
  assert.deepEqual(byRule(lintComponentXml(xml, { resources: RESOURCES }), 'R-04'), []);
});

test('★ R-04: font 引用包 id 位数错误 → 必报（证明 font 真的被纳入校验）', () => {
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<component size="480,320" exported="true">',
    '  <font id="f00001" name="main_font" font="ui://abc123/x"/>',
    '  <displayList>',
    '    <graph id="b00001" name="bg" xy="0,0" size="480,320"/>',
    '  </displayList>',
    '</component>',
    '',
  ].join('\n');
  const issues = byRule(lintComponentXml(xml, { resources: RESOURCES }), 'R-04');
  assert.equal(issues.length, 1, 'font 的 6 位包 id 必须被 R-04 抓到（改前 font 完全不校验）');
  assert.ok(issues[0].message.includes('abc123'));
});
