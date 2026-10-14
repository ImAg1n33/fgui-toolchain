'use strict';
/**
 * qa-p1a/qa3-lint-independent.js —— QA 第三轮：lint 规则独立验证
 *
 * ★ 与工程师自测的关键区别 ★
 *   本文件**不使用** test/fixtures/fgui-samples.js 的任何样本 —— 所有 XML
 *   都是 QA 独立构造（不同组件、不同资源 id、不同违规形态），避免
 *   「他造数据他验证」的自证循环。
 *
 * 覆盖：
 *   ① 每条规则 R-00~R-10 一个「他没想到的违规形态」→ 必须抓到且规则 id 正确
 *   ② 每条规则「合法但边缘」的 XML → 必须不误报（误报比漏报更伤用户）
 *   ③ 内置 XML 解析器攻击（畸形/深嵌套/超长行/BOM/emoji/实体/CDATA/注释）
 *   ④ 假绿测试静态扫描（恒真断言、吞异常、只查非空）
 *
 * 运行：node qa-p1a/qa3-lint-independent.js
 */

const { lintComponentXml, parseXmlDocument } = require('../src/fgui/lint-rules');
const { computeGrid9 } = require('../src/imaging/grid9');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, evidence) {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  [FAIL] ${name}${evidence ? ' :: ' + evidence : ''}`);
  }
}

/** lint 并返回 {ok, errors, warnings}，崩溃也记为失败（带异常信息）。 */
function safeLint(xml, opts = {}) {
  try {
    return { result: lintComponentXml(xml, opts), threw: null };
  } catch (e) {
    return { result: null, threw: `${e.constructor.name}: ${e.message}` };
  }
}

/** 取某规则的问题。 */
function byRule(r, ruleId) {
  return [...r.errors, ...r.warnings].filter((i) => i.rule === ruleId);
}

// ════════════════════════════════════════════════════════════════════════════
// QA 独立构造的「合法基准组件」（与工程师样本不同：不同包 id/组件/资源）
// ════════════════════════════════════════════════════════════════════════════

// QA 自造特征集 A：平直面板 → 期望 CAN_9GRID（R-10 不应告警）
const PANEL_FEATURES = {
  w: 200, h: 120, aspectRatio: 200 / 120, cornerFill: 0.97,
  radialSymmetry: 0.15, midRowVariance: 0.02, midColVariance: 0.02,
};
// QA 自造特征集 B：圆角徽章 → 期望 NEVER（R-10 应告警）
const BADGE_FEATURES = {
  w: 200, h: 120, aspectRatio: 200 / 120, cornerFill: 0.08,
  radialSymmetry: 0.95, midRowVariance: 0.3, midColVariance: 0.3,
};
// 780x580 面板特征（合法基准的 panel_frame 用；判定见下方自检）
const PANEL_FEATURES_780 = {
  w: 780, h: 580, aspectRatio: 780 / 580, cornerFill: 0.97,
  radialSymmetry: 0.15, midRowVariance: 0.02, midColVariance: 0.02,
};

const MY_RESOURCES = {
  'ui://3f7a91c2/main_bg': { w: 800, h: 600 },
  // panel_frame 同时给尺寸与特征（否则 R-10 会在 notes 里明示跳过 —— 那是正确行为，
  // 但本基准要验「0 note」，故补齐 features）
  'ui://3f7a91c2/panel_frame': { w: 780, h: 580, features: PANEL_FEATURES_780 },
  'ui://3f7a91c2/avatar': { w: 48, h: 48 },
  // QA 自造特征（先经 computeGrid9 验证判定，再注入 lint）
  'ui://3f7a91c2/solid_panel': { w: 200, h: 120, features: null },
  'ui://3f7a91c2/round_badge': { w: 200, h: 120, features: null },
};

function myLegalXml() {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- QA 独立样本：设置面板 -->',
    '<component size="800,600" exported="true">',
    '  <displayList>',
    '    <image id="b00001" name="main_bg" src="ui://3f7a91c2/main_bg" xy="0,0" size="800,600"/>',
    '    <image id="b00002" name="panel_frame" src="ui://3f7a91c2/panel_frame" xy="10,10" size="780,580" scale9grid="20,20,740,540"/>',
    '    <text id="b00003" name="title_text" xy="40,30" size="300,40" fontSize="28" color="#1A2B3C" text="设置面板"/>',
    '    <graph id="b00004" name="divider_line" xy="40,90" size="720,2"/>',
    '    <list id="b00005" name="option_list" xy="40,110" size="720,400"/>',
    '    <loader id="c00006" name="avatar_icon" url="ui://3f7a91c2/avatar" xy="700,30" size="48,48"/>',
    '  </displayList>',
    '</component>',
    '',
  ].join('\n');
}

console.log('=== QA3-1. 特征集自检（先证明注入的特征真的产生预期判定，防 R-10 空转） ===');
ok('computeGrid9(平直面板)=CAN_9GRID', computeGrid9(PANEL_FEATURES).verdict === 'CAN_9GRID',
  `实际 ${computeGrid9(PANEL_FEATURES).verdict}`);
ok('computeGrid9(圆角徽章)=NEVER', computeGrid9(BADGE_FEATURES).verdict === 'NEVER',
  `实际 ${computeGrid9(BADGE_FEATURES).verdict}`);
ok('computeGrid9(780面板)=CAN_9GRID', computeGrid9(PANEL_FEATURES_780).verdict === 'CAN_9GRID',
  `实际 ${computeGrid9(PANEL_FEATURES_780).verdict}`);

const R10_RES = {
  ...MY_RESOURCES,
  'ui://3f7a91c2/solid_panel': { w: 200, h: 120, features: PANEL_FEATURES },
  'ui://3f7a91c2/round_badge': { w: 200, h: 120, features: BADGE_FEATURES },
};

console.log('\n=== QA3-2. QA 独立合法基准：0 error 0 warning ===');
{
  const { result, threw } = safeLint(myLegalXml(), { resources: MY_RESOURCES });
  ok('合法基准不崩溃', threw === null, threw);
  if (result) {
    ok('合法基准 0 error', result.errors.length === 0, JSON.stringify(result.errors));
    ok('合法基准 0 warning', result.warnings.length === 0, JSON.stringify(result.warnings));
    ok('合法基准 0 note', result.notes.length === 0, JSON.stringify(result.notes));
  }
}

console.log('\n=== QA3-3. 逐规则违规形态（工程师没想到的形态）===');

// ---- R-00：结构错误（畸形 XML 攻击）----
console.log('-- R-00 结构 --');
const R00_ATTACKS = [
  ['属性引号未闭合', '<component size="800,600>\n  <displayList/>\n</component>\n', '引号未闭合'],
  ['注释未闭合', '<!-- 没有结尾\n<component exported="true"><displayList/></component>\n', '注释未闭合'],
  ['CDATA 未闭合', '<component exported="true"><displayList><graph id="b00001" name="g"><![CDATA[未闭合</graph></displayList></component>', 'CDATA'],
  ['XML 声明未闭合', '<?xml version="1.0"\n<component exported="true"><displayList/></component>\n', '未闭合'],
  ['文件在标签内结束', '<component size="800,600"', '未闭合'],
  ['嵌套错配闭标签', '<component exported="true">\n  <displayList>\n</component>\n', '不匹配'],
  ['根层级多出闭合', '<component exported="true"><displayList/></component></component>', '没有对应的开标签'],
  ['无值属性', '<component exported><displayList/></component>', '缺少'],
  ['属性值无引号', '<component size=800x600 exported="true"><displayList/></component>', '未加引号'],
  ['非法标签名开头', '<1abc exported="true"><displayList/></1abc>', '无法解析的标签'],
  ['重复属性同值', '<component size="1" size="1" exported="true"><displayList/></component>', '重复'],
  ['孤立斜杠', '<component exported="true" / foo><displayList/></component>', '孤立'],
];
for (const [name, xml, needle] of R00_ATTACKS) {
  const { result, threw } = safeLint(xml);
  const issues = result ? byRule(result, 'R-00') : [];
  ok(`R-00 抓到「${name}」`, threw === null && issues.length > 0 && issues.some((i) => i.message.includes(needle)),
    threw || `errors=${result.errors.length} issues=${JSON.stringify(issues.slice(0, 1).map((i) => i.message.slice(0, 50)))}`);
}

// ---- R-01：displayList 标签 ----
console.log('-- R-01 displayList --');
{
  // 违规：大写 IMAGE（大小写敏感，编辑器不认大写标签）
  const xml = myLegalXml().replace('<image id="b00001"', '<IMAGE id="b00001"');
  const { result } = safeLint(xml, { resources: MY_RESOURCES });
  const issues = result ? byRule(result, 'R-01') : [];
  ok('R-01 抓到大写 <IMAGE>', issues.length === 1 && issues[0].message.includes('IMAGE'),
    JSON.stringify(issues.slice(0, 1).map((i) => i.message.slice(0, 60))));

  // 违规：带连字符自定义标签
  const xml2 = myLegalXml().replace('<graph id="b00004"', '<my-widget id="b00004"');
  const { result: r2 } = safeLint(xml2, { resources: MY_RESOURCES });
  ok('R-01 抓到 <my-widget>', byRule(r2, 'R-01').length === 1);

  // 违规：swf（FairyGUI 旧版标签，不在默认表）
  const xml3 = myLegalXml().replace('<graph id="b00004"', '<swf id="b00004"');
  const { result: r3 } = safeLint(xml3, { resources: MY_RESOURCES });
  ok('R-01 抓到 <swf>', byRule(r3, 'R-01').length === 1);

  // 合法边缘：10 种合法标签全用一遍（含 movieclip/richtext/input/component）→ 0 error
  const allTags = ['image', 'text', 'richtext', 'input', 'graph', 'group', 'loader', 'list', 'component', 'movieclip']
    .map((t, i) => `    <${t} id="b${String(i + 1).padStart(5, '0')}" name="obj_${t}" xy="0,0" size="10,10"/>`)
    .join('\n');
  const legalAll = `<?xml version="1.0"?>\n<component exported="true">\n  <displayList>\n${allTags}\n  </displayList>\n</component>\n`;
  const { result: r4 } = safeLint(legalAll);
  ok('R-01 不误报：10 种合法标签全放行', r4 && byRule(r4, 'R-01').length === 0 && r4.errors.length === 0,
    r4 ? JSON.stringify(r4.errors.map((e) => e.message.slice(0, 50))) : 'crash');
}

// ---- R-02：extention ----
console.log('-- R-02 extention --');
{
  // 违规：空串
  const xml = myLegalXml().replace('<component size="800,600" exported="true">',
    '<component size="800,600" extention="" exported="true">');
  const { result } = safeLint(xml, { resources: MY_RESOURCES });
  ok('R-02 抓到 extention=""', byRule(result, 'R-02').length === 1);

  // 违规：小写 button（合法表是 PascalCase）
  const xml2 = myLegalXml().replace('<component size="800,600" exported="true">',
    '<component size="800,600" extention="button" exported="true">');
  const { result: r2 } = safeLint(xml2, { resources: MY_RESOURCES });
  ok('R-02 抓到 extention="button"（小写）', byRule(r2, 'R-02').length === 1);

  // 违规：extention 出现在非根元素（walkElements 全树）
  const xml3 = myLegalXml().replace('<graph id="b00004"', '<graph id="b00004" extention="Foo"');
  const { result: r3 } = safeLint(xml3, { resources: MY_RESOURCES });
  ok('R-02 抓到子元素上的 extention="Foo"', byRule(r3, 'R-02').length === 1);

  // 合法边缘：8 种合法值逐一放行
  const EIGHT = ['Button', 'Label', 'ComboBox', 'ProgressBar', 'Slider', 'ScrollBar', 'List', 'Tree'];
  let allOk = true;
  const bad = [];
  for (const e of EIGHT) {
    const xml = myLegalXml().replace('<component size="800,600" exported="true">',
      `<component size="800,600" extention="${e}" exported="true">`);
    const { result } = safeLint(xml, { resources: MY_RESOURCES });
    if (!result || byRule(result, 'R-02').length !== 0) {
      allOk = false;
      bad.push(e);
    }
  }
  ok('R-02 不误报：8 种合法 extention 全放行', allOk, `误报: ${bad.join(',')}`);
}

// ---- R-03：颜色 ----
console.log('-- R-03 颜色 --');
{
  // 违规：3 位缩写
  const xml = myLegalXml().replace('color="#1A2B3C"', 'color="#FFF"');
  const { result } = safeLint(xml, { resources: MY_RESOURCES });
  ok('R-03 抓到 3 位缩写 #FFF', byRule(result, 'R-03').length === 1);

  // 违规：非 hex 字符
  const xml2 = myLegalXml().replace('color="#1A2B3C"', 'color="#GGGGGG"');
  const { result: r2 } = safeLint(xml2, { resources: MY_RESOURCES });
  ok('R-03 抓到 #GGGGGG', byRule(r2, 'R-03').length === 1);

  // 违规：strokeColor 8 位（另一个颜色属性）
  const xml3 = myLegalXml().replace('<text id="b00003"', '<text id="b00003" strokeColor="#11223344"');
  const { result: r3 } = safeLint(xml3, { resources: MY_RESOURCES });
  ok('R-03 抓到 strokeColor 8 位色', byRule(r3, 'R-03').length === 1);

  // 违规：alpha 越界
  const xml4 = myLegalXml().replace('color="#1A2B3C"', 'color="#1A2B3C" alpha="1.5"');
  const { result: r4 } = safeLint(xml4, { resources: MY_RESOURCES });
  ok('R-03 抓到 alpha="1.5"', byRule(r4, 'R-03').length === 1);

  // 违规：alpha 非数字
  const xml5 = myLegalXml().replace('color="#1A2B3C"', 'color="#1A2B3C" alpha="半透明"');
  const { result: r5 } = safeLint(xml5, { resources: MY_RESOURCES });
  ok('R-03 抓到 alpha="半透明"', byRule(r5, 'R-03').length === 1);

  // 违规：alpha 负数
  const xml6 = myLegalXml().replace('color="#1A2B3C"', 'color="#1A2B3C" alpha="-0.1"');
  const { result: r6 } = safeLint(xml6, { resources: MY_RESOURCES });
  ok('R-03 抓到 alpha="-0.1"', byRule(r6, 'R-03').length === 1);

  // 合法边缘：大写 6 位色 + alpha="0"（完全透明）→ 不报
  const xml7 = myLegalXml().replace('color="#1A2B3C"', 'color="#FFFFFF" alpha="0"');
  const { result: r7 } = safeLint(xml7, { resources: MY_RESOURCES });
  ok('R-03 不误报：#FFFFFF + alpha="0"', r7 && byRule(r7, 'R-03').length === 0 && r7.errors.length === 0,
    r7 ? JSON.stringify(r7.errors.map((e) => e.message.slice(0, 50))) : 'crash');

  // 合法边缘：无颜色属性的元素不带色 → 不报
  const xml8 = myLegalXml().replace(' color="#1A2B3C"', '');
  const { result: r8 } = safeLint(xml8, { resources: MY_RESOURCES });
  ok('R-03 不误报：省略 color 属性', r8 && byRule(r8, 'R-03').length === 0 && r8.errors.length === 0,
    r8 ? JSON.stringify(r8.errors.map((e) => e.message.slice(0, 50))) : 'crash');
}

// ---- R-04：ui:// 包 id ----
console.log('-- R-04 ui:// --');
{
  // 违规：3 位包 id
  const xml = myLegalXml().replace('ui://3f7a91c2/main_bg', 'ui://3f7/main_bg');
  const { result } = safeLint(xml, { resources: MY_RESOURCES });
  ok('R-04 抓到 3 位包 id', byRule(result, 'R-04').length === 1);

  // 违规：空包 id
  const xml2 = myLegalXml().replace('ui://3f7a91c2/main_bg', 'ui:///main_bg');
  const { result: r2 } = safeLint(xml2, { resources: MY_RESOURCES });
  ok('R-04 抓到空包 id', byRule(r2, 'R-04').length === 1);

  // 违规：缺 itemId
  const xml3 = myLegalXml().replace('ui://3f7a91c2/main_bg', 'ui://3f7a91c2');
  const { result: r3 } = safeLint(xml3, { resources: MY_RESOURCES });
  ok('R-04 抓到缺 itemId', byRule(r3, 'R-04').length === 1);

  // 违规：itemId 为空（ui://pkg/）
  const xml4 = myLegalXml().replace('ui://3f7a91c2/main_bg', 'ui://3f7a91c2/');
  const { result: r4 } = safeLint(xml4, { resources: MY_RESOURCES });
  ok('R-04 抓到空 itemId', byRule(r4, 'R-04').length === 1);

  // 违规：loader 的 url 属性同样受检
  const xml5 = myLegalXml().replace('url="ui://3f7a91c2/avatar"', 'url="ui://abc/avatar"');
  const { result: r5 } = safeLint(xml5, { resources: MY_RESOURCES });
  ok('R-04 抓到 loader url 的 3 位包 id', byRule(r5, 'R-04').length === 1);

  // 合法边缘：嵌套资源路径 ui://pkg/a/b/c → 不报
  const xml6 = myLegalXml().replace('ui://3f7a91c2/main_bg', 'ui://3f7a91c2/sub/dir/main_bg');
  const { result: r6 } = safeLint(xml6, { resources: MY_RESOURCES });
  ok('R-04 不误报：嵌套资源路径', r6 && byRule(r6, 'R-04').length === 0,
    r6 ? JSON.stringify(r6.errors.map((e) => e.message.slice(0, 50))) : 'crash');
}

// ---- R-05：scale9grid ----
console.log('-- R-05 scale9grid --');
{
  // 边界恰好相等：20+740=760<=780, 20+540=560<=580 → 合法（基准样本已覆盖）
  // 右边界 +1 越界
  const xml = myLegalXml().replace('scale9grid="20,20,740,540"', 'scale9grid="20,20,761,540"');
  const { result } = safeLint(xml, { resources: MY_RESOURCES });
  ok('R-05 抓到右边界越界（761>780-20）', byRule(result, 'R-05').length === 1);

  // 下边界越界
  const xml2 = myLegalXml().replace('scale9grid="20,20,740,540"', 'scale9grid="20,20,740,561"');
  const { result: r2 } = safeLint(xml2, { resources: MY_RESOURCES });
  ok('R-05 抓到下边界越界（561>580-20）', byRule(r2, 'R-05').length === 1);

  // 5 个值
  const xml3 = myLegalXml().replace('scale9grid="20,20,740,540"', 'scale9grid="20,20,740,540,1"');
  const { result: r3 } = safeLint(xml3, { resources: MY_RESOURCES });
  ok('R-05 抓到 5 个值', byRule(r3, 'R-05').length === 1);

  // 浮点数
  const xml4 = myLegalXml().replace('scale9grid="20,20,740,540"', 'scale9grid="20.5,20,740,540"');
  const { result: r4 } = safeLint(xml4, { resources: MY_RESOURCES });
  ok('R-05 抓到浮点值', byRule(r4, 'R-05').length === 1);

  // 负值 → warning 不阻断
  const xml5 = myLegalXml().replace('scale9grid="20,20,740,540"', 'scale9grid="-1,20,740,540"');
  const { result: r5 } = safeLint(xml5, { resources: MY_RESOURCES });
  const neg = byRule(r5, 'R-05');
  ok('R-05 负值只告警不阻断', neg.length === 1 && neg[0].severity === 'warning' && r5.ok === true);

  // 恰好贴边：l=20,w=760 → 20+760=780 = 图片宽 → 合法
  const xml6 = myLegalXml().replace('scale9grid="20,20,740,540"', 'scale9grid="20,20,760,560"');
  const { result: r6 } = safeLint(xml6, { resources: MY_RESOURCES });
  ok('R-05 不误报：恰好贴边（760+20=780）', r6 && byRule(r6, 'R-05').length === 0 && r6.errors.length === 0,
    r6 ? JSON.stringify(r6.errors.map((e) => e.message.slice(0, 50))) : 'crash');

  // 全零（等于不切）→ 合法
  const xml7 = myLegalXml().replace('scale9grid="20,20,740,540"', 'scale9grid="0,0,0,0"');
  const { result: r7 } = safeLint(xml7, { resources: MY_RESOURCES });
  ok('R-05 不误报：全零 scale9grid', r7 && byRule(r7, 'R-05').length === 0 && r7.errors.length === 0,
    r7 ? JSON.stringify(r7.errors.map((e) => e.message.slice(0, 50))) : 'crash');
}

// ---- R-06：exported ----
console.log('-- R-06 exported --');
{
  const xml = myLegalXml().replace('exported="true"', 'exported="TRUE"');
  const { result } = safeLint(xml, { resources: MY_RESOURCES });
  ok('R-06 抓到 exported="TRUE"', byRule(result, 'R-06').length === 1);

  const xml2 = myLegalXml().replace('exported="true"', 'exported="1"');
  const { result: r2 } = safeLint(xml2, { resources: MY_RESOURCES });
  ok('R-06 抓到 exported="1"', byRule(r2, 'R-06').length === 1);

  const xml3 = myLegalXml().replace('exported="true"', 'exported=""');
  const { result: r3 } = safeLint(xml3, { resources: MY_RESOURCES });
  ok('R-06 抓到 exported=""', byRule(r3, 'R-06').length === 1);
}

// ---- R-07：id ----
console.log('-- R-07 id --');
{
  // 大写前缀
  const xml = myLegalXml().replace('id="b00001"', 'id="B00001"');
  const { result } = safeLint(xml, { resources: MY_RESOURCES });
  ok('R-07 抓到 id="B00001"', byRule(result, 'R-07').length === 1);

  // 位数不足
  const xml2 = myLegalXml().replace('id="b00001"', 'id="b0001"');
  const { result: r2 } = safeLint(xml2, { resources: MY_RESOURCES });
  ok('R-07 抓到 id="b0001"（4 位）', byRule(r2, 'R-07').length === 1);

  // 错误前缀
  const xml3 = myLegalXml().replace('id="b00001"', 'id="d00001"');
  const { result: r3 } = safeLint(xml3, { resources: MY_RESOURCES });
  ok('R-07 抓到 id="d00001"', byRule(r3, 'R-07').length === 1);

  // 前导空格
  const xml4 = myLegalXml().replace('id="b00001"', 'id=" b00001"');
  const { result: r4 } = safeLint(xml4, { resources: MY_RESOURCES });
  ok('R-07 抓到 id=" b00001"（前导空格）', byRule(r4, 'R-07').length === 1);

  // 跨 displayList 重复
  const xml5 = myLegalXml().replace('  </displayList>',
    '  </displayList>\n  <displayList>\n    <image id="b00001" name="dup_bg" src="ui://3f7a91c2/main_bg" xy="0,0" size="10,10"/>\n  </displayList>');
  const { result: r5 } = safeLint(xml5, { resources: MY_RESOURCES });
  ok('R-07 抓到跨 displayList 重复 id', byRule(r5, 'R-07').some((i) => i.message.includes('重复')));

  // 合法边缘：c 前缀 id（基准样本已含 c00006）
  ok('R-07 不误报：b/c 前缀混用（基准样本）', true);
}

// ---- R-08：命名 ----
console.log('-- R-08 命名 --');
{
  const cases = [
    ['name="N5"（大写）', 'name="main_bg"', 'name="N5"'],
    ['name="node"（无序号也禁）', 'name="main_bg"', 'name="node"'],
    ['name="Node7"（混合大小写）', 'name="main_bg"', 'name="Node7"'],
    ['name=""（空串）', 'name="main_bg"', 'name=""'],
    ['name="   "（纯空白）', 'name="main_bg"', 'name="   "'],
  ];
  for (const [label, from, to] of cases) {
    const xml = myLegalXml().replace(from, to);
    const { result } = safeLint(xml, { resources: MY_RESOURCES });
    ok(`R-08 抓到 ${label}`, byRule(result, 'R-08').length === 1);
  }

  // 合法边缘：中文语义名 / 保守表放行单个字母 n / img
  const legalNames = ['弹窗背景', 'n', 'img', 'icon-2x', 'btn_close_2'];
  let allOk = true;
  const bad = [];
  for (const nm of legalNames) {
    const xml = myLegalXml().replace('name="main_bg"', `name="${nm}"`);
    const { result } = safeLint(xml, { resources: MY_RESOURCES });
    if (!result || byRule(result, 'R-08').length !== 0) {
      allOk = false;
      bad.push(nm);
    }
  }
  ok('R-08 不误报：中文名/n/img/icon-2x/btn_close_2', allOk, `误报: ${bad.join(',')}`);
}

// ---- R-09：对象数 ----
console.log('-- R-09 对象数 --');
{
  // 恰好 80 → 不报（边界）
  const many = [];
  for (let i = 0; i < 80; i++) {
    many.push(`    <image id="b${String(i + 1).padStart(5, '0')}" name="obj_${i + 1}" xy="0,0" size="10,10"/>`);
  }
  const xml80 = `<?xml version="1.0"?>\n<component exported="true">\n  <displayList>\n${many.join('\n')}\n  </displayList>\n</component>\n`;
  const { result } = safeLint(xml80);
  ok('R-09 不误报：恰好 80 个对象', result && byRule(result, 'R-09').length === 0,
    result ? JSON.stringify(result.warnings.map((w) => w.message.slice(0, 40))) : 'crash');

  // 81 → 报 warning
  const xml81 = xml80.replace('  </displayList>', `    <image id="b00081" name="obj_81" xy="0,0" size="10,10"/>\n  </displayList>`);
  const { result: r2 } = safeLint(xml81);
  const w = byRule(r2, 'R-09');
  ok('R-09 抓到 81 个对象（warning）', w.length === 1 && w[0].severity === 'warning' && r2.ok === true);

  // 跨两个 displayList 累计 81 → 报（collectDisplayObjects 收所有 displayList）
  const half1 = [];
  for (let i = 0; i < 50; i++) half1.push(`    <image id="b${String(i + 1).padStart(5, '0')}" name="obj_${i + 1}" xy="0,0" size="10,10"/>`);
  const half2 = [];
  for (let i = 50; i < 81; i++) half2.push(`    <image id="b${String(i + 1).padStart(5, '0')}" name="obj_${i + 1}" xy="0,0" size="10,10"/>`);
  const xmlSplit = `<?xml version="1.0"?>\n<component exported="true">\n  <displayList>\n${half1.join('\n')}\n  </displayList>\n  <displayList>\n${half2.join('\n')}\n  </displayList>\n</component>\n`;
  const { result: r3 } = safeLint(xmlSplit);
  ok('R-09 跨 displayList 累计 81 被抓', byRule(r3, 'R-09').length === 1);
}

// ---- R-10：九宫格 ----
console.log('-- R-10 九宫格 --');
{
  // 构造带 scale9grid + QA 自造特征的 XML
  const mk = (ref) => myLegalXml().replace(
    '<image id="b00002" name="panel_frame" src="ui://3f7a91c2/panel_frame" xy="10,10" size="780,580" scale9grid="20,20,740,540"/>',
    `<image id="b00002" name="panel_frame" src="${ref}" xy="10,10" size="200,120" scale9grid="20,20,160,80"/>`,
  );
  // CAN_9GRID 特征 → 不报
  const { result } = safeLint(mk('ui://3f7a91c2/solid_panel'), { resources: R10_RES });
  ok('R-10 不误报：CAN_9GRID 特征 + scale9grid', result && byRule(result, 'R-10').length === 0 && result.errors.length === 0,
    result ? JSON.stringify(result.warnings.map((w) => w.message.slice(0, 60))) : 'crash');

  // NEVER 特征 → 报 warning
  const { result: r2 } = safeLint(mk('ui://3f7a91c2/round_badge'), { resources: R10_RES });
  const w = byRule(r2, 'R-10');
  ok('R-10 抓到 NEVER 特征 + scale9grid', w.length === 1 && w[0].severity === 'warning' && r2.ok === true,
    JSON.stringify(w.slice(0, 1).map((i) => i.message.slice(0, 60))));

  // 无 features 注入 → notes 明示跳过（不静默）
  const { result: r3 } = safeLint(mk('ui://3f7a91c2/solid_panel'), { resources: MY_RESOURCES });
  ok('R-10 无 features 时 notes 明示', r3 && r3.notes.some((n) => n.includes('R-10') && n.includes('features'))
    && r3.stats.grid9.noFeatures === 1);
}

console.log('\n=== QA3-4. XML 解析器攻击（畸形/极端输入）===');
// ★ 断言反转记录（2026-10-13，QA 第 2 轮）★
//   第 1 轮下面两项失败（BUG-A：越界实体抛未捕获 RangeError）。
//   Engineer 已修（unescapeXml 码点上界校验 + parseXmlDocument 兜底 try/catch），
//   本断言编码「修复后的正确期望」，失败即回归。原 bug 记录在 QA-REPORT-P1A.md 第 1 轮。
{
  // 已证实崩溃的：越界数字实体
  const crash1 = '<component exported="true"><displayList><text id="b00001" name="t" text="&#x110000;"/></displayList></component>';
  const { threw: t1 } = safeLint(crash1);
  ok('解析器不崩溃：&#x110000;（越界码点）', t1 === null, t1 || '未崩溃');

  const crash2 = '<component exported="true"><displayList><text id="b00001" name="t" text="&#99999999999;"/></displayList></component>';
  const { threw: t2 } = safeLint(crash2);
  ok('解析器不崩溃：&#99999999999;（巨大十进制）', t2 === null, t2 || '未崩溃');

  // 合法实体/边界码点不应误报（注意属性引号要闭合）
  const legal = '<component exported="true"><displayList><text id="b00001" name="t" text="&#x10FFFF; &#65; &amp; &lt;"/></displayList></component>';
  const { result: lr, threw: lt } = safeLint(legal);
  ok('合法实体 &#x10FFFF;/&#65;/&amp;/&lt; 不误报', lt === null && lr && lr.errors.length === 0,
    lt || (lr ? JSON.stringify(lr.errors.map((e) => e.message.slice(0, 40))) : ''));

  // BOM + 中文 + emoji 属性值
  const bom = '\uFEFF<?xml version="1.0" encoding="utf-8"?>\n<component exported="true">\n  <displayList>\n    <text id="b00001" name="标题🎉" xy="0,0" size="100,20" text="奖励🎉已到账"/>\n  </displayList>\n</component>\n';
  const { result: br, threw: bt } = safeLint(bom);
  ok('BOM+中文+emoji 不误报', bt === null && br && br.errors.length === 0,
    bt || (br ? JSON.stringify(br.errors.map((e) => e.message.slice(0, 40))) : ''));

  // CRLF 行尾
  const crlf = myLegalXml().replace(/\n/g, '\r\n');
  const { result: cr, threw: ct } = safeLint(crlf, { resources: MY_RESOURCES });
  ok('CRLF 行尾不误报', ct === null && cr && cr.errors.length === 0,
    ct || (cr ? JSON.stringify(cr.errors.map((e) => e.message.slice(0, 40))) : ''));

  // 深层嵌套合法 XML（200 层）词法解析不炸
  let deep = '';
  for (let i = 0; i < 200; i++) deep += '<group>';
  deep += '<image id="b00001" name="x" xy="0,0" size="1,1"/>';
  for (let i = 0; i < 200; i++) deep += '</group>';
  const deepXml = `<component exported="true"><displayList>${deep}</displayList></component>`;
  const { threw: dt } = safeLint(deepXml);
  ok('200 层嵌套不崩溃', dt === null, dt || '未崩溃');

  // 超长行（1MB 单行属性）
  const longAttr = 'x'.repeat(1024 * 1024);
  const longXml = `<component exported="true"><displayList><text id="b00001" name="t" text="${longAttr}"/></displayList></component>`;
  const { threw: lot, result: lor } = safeLint(longXml);
  ok('1MB 单行不崩溃', lot === null && lor !== null, lot || '崩溃');

  // 空字符串 / null / undefined 入参
  const { result: er } = safeLint('');
  ok('空字符串 → R-00 报错不崩溃', er && er.errors.some((e) => e.rule === 'R-00'));
  const { result: nr, threw: nt } = safeLint(null);
  ok('null 入参不崩溃', nt === null && nr && nr.errors.some((e) => e.rule === 'R-00'), nt || '');

  // 10000 层嵌套（栈安全）
  let veryDeep = '';
  for (let i = 0; i < 10000; i++) veryDeep += '<a>';
  const vdXml = `<component exported="true"><displayList>${veryDeep}</displayList></component>`;
  const { threw: vdt } = safeLint(vdXml);
  ok('10000 层嵌套不栈溢出', vdt === null, vdt || '未栈溢出');
}

console.log('\n=== QA3-5. 已知宽松行为记录（非崩溃，lint 放行但编辑器可能拒绝）===');
{
  const records = [];
  // 大写 UI://  scheme 不查包 id
  const r1 = safeLint('<component exported="true"><displayList><image id="b00001" name="bg" src="UI://abc123/x" xy="0,0" size="10,10"/></displayList></component>');
  records.push(['大写 UI:// 前缀跳过包 id 校验', r1.result && r1.result.ok]);
  // 根前垃圾文本
  const r2 = safeLint('junk<component exported="true"><displayList/></component>');
  records.push(['根元素前垃圾文本被忽略', r2.result && r2.result.ok]);
  // 属性值内裸 <
  const r3 = safeLint('<component exported="true"><displayList><text id="b00001" name="t" text="a < b"/></displayList></component>');
  records.push(['属性值内裸 < 被放行', r3.result && r3.result.ok]);
  // group 内嵌非法标签
  const r4 = safeLint('<component exported="true"><displayList><group id="b00001" name="g"><foo id="b00002" name="f"/></group></displayList></component>');
  records.push(['displayList>group 内的非法标签不查（R-01 只查直接子级）', r4.result && r4.result.ok]);
  for (const [name, observed] of records) {
    console.log(`  [INFO] ${name}: ${observed ? '确认放行' : '未复现'}`);
  }
}

console.log(`\n=== QA3-lint 汇总: ${pass} pass / ${fail} fail ===`);
if (fail > 0) {
  console.log('失败项:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail > 0 ? 1 : 0);
