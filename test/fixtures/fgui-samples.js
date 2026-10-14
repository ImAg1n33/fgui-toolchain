'use strict';
/**
 * test/fixtures/fgui-samples.js —— FGUI 组件 XML 样本（lint 与事务测试共用）
 *
 * ★ 为什么单独一个文件 ★
 *   lint-rules.test.js 与 fgui-transaction.test.js 都需要「已知合法」与
 *   「已知违规」两种样本。放一处的目的是：**合法样本只有一份**——
 *   两处各写一份时，任何一处不小心写错，另一处不会发现（自证循环的老问题）。
 *
 * ★ 样本设计原则（对应 QA「假绿测试」教训）★
 *   1. legalComponentXml() 是一个**完整且保守**的合法组件：所有属性都按
 *      上游已核实规范写（6 位色 + alpha、8 位包 id、b000NN id、语义名、
 *      exported="true"、scale9grid 不越界）。测试断言它 **0 error 0 warning**。
 *   2. 每个 violation 都是在合法样本基础上**只改一处**，确保「违规样本必报错」
 *      断言抓到的是目标规则，不是别的问题顺带。
 *   3. resources 与样本严格对应（popup_frame 的 scale9grid 恰好不越界），
 *      避免「因为没注入尺寸所以没查边界」这种空转。
 */

/** 图片资源注入（R-05 边界对账 / R-10 九宫格特征用）。 */
const RESOURCES = Object.freeze({
  'ui://abcd1234/popup_bg': { w: 480, h: 320 },
  'ui://abcd1234/popup_frame': {
    w: 464,
    h: 304,
    // 常规面板特征 → computeGrid9 应判 CAN_9GRID（R-10 不应告警）
    features: {
      w: 464, h: 304, aspectRatio: 464 / 304, cornerFill: 0.95,
      radialSymmetry: 0.2, midRowVariance: 0.05, midColVariance: 0.05,
    },
  },
  'ui://abcd1234/reward_icon': { w: 48, h: 48 },
});

/** 圆/菱形特征 → computeGrid9 应判 NEVER（R-10 应告警：禁切图却设了 scale9grid）。 */
const NEVER_FEATURES = Object.freeze({
  w: 464, h: 304, aspectRatio: 464 / 304, cornerFill: 0.1,
  radialSymmetry: 0.3, midRowVariance: 0.4, midColVariance: 0.4,
});

/**
 * 已知合法的组件 XML（保守写法：每条规则都不触犯）。
 * @returns {string}
 */
function legalComponentXml() {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<component size="480,320" extention="Button" exported="true">',
    '  <displayList>',
    '    <image id="b00001" name="popup_bg" src="ui://abcd1234/popup_bg" xy="0,0" size="480,320" color="#ffffff" alpha="1"/>',
    '    <image id="b00002" name="popup_frame" src="ui://abcd1234/popup_frame" xy="8,8" size="464,304" scale9grid="10,10,444,284"/>',
    '    <text id="b00003" name="popup_title" xy="24,20" size="200,36" fontSize="26" color="#f5e6c8" text="邮件详情"/>',
    '    <graph id="b00004" name="deco_line" xy="24,64" size="120,2"/>',
    '    <loader id="b00005" name="reward_icon" url="ui://abcd1234/reward_icon" xy="24,80" size="48,48"/>',
    '  </displayList>',
    '</component>',
    '',
  ].join('\n');
}

/**
 * 各规则的「已知违规」样本（每份只违反对应规则）。
 *
 * key = 规则 id；value = { xml, why, expect: 'error'|'warning', needle }
 *   needle = 错误信息里必须出现的关键词（可读性断言用）
 * @returns {Object<string, {xml:string, why:string, expect:string, needle:string}>}
 */
function violationSamples() {
  return {
    'R-01': {
      why: 'displayList 内出现不合法标签 <foo>',
      expect: 'error',
      needle: 'displayList',
      xml: legalComponentXml().replace(
        '    <graph id="b00004"',
        '    <foo id="b00004"',
      ),
    },
    'R-02': {
      why: 'extention="Foo" 不是合法扩展类型',
      expect: 'error',
      needle: 'extention',
      xml: legalComponentXml().replace('extention="Button"', 'extention="Foo"'),
    },
    'R-03-8bit': {
      why: '8 位色 #000000c8（运行时只取后 6 位 → 纯蓝）',
      expect: 'error',
      needle: '8 位色',
      xml: legalComponentXml().replace('color="#f5e6c8"', 'color="#000000c8"'),
    },
    'R-03-format': {
      why: '命名色 red 不是 #RRGGBB',
      expect: 'error',
      needle: '颜色格式非法',
      xml: legalComponentXml().replace('color="#f5e6c8"', 'color="red"'),
    },
    'R-04': {
      why: '6 位包 id（上游事故：吃 itemId 首字符）',
      expect: 'error',
      needle: '包 id',
      xml: legalComponentXml().replace('ui://abcd1234/popup_bg', 'ui://abc123/popup_bg'),
    },
    'R-05-bounds': {
      why: 'scale9grid 中心矩形超出图片尺寸',
      expect: 'error',
      needle: '越界',
      xml: legalComponentXml().replace('scale9grid="10,10,444,284"', 'scale9grid="10,10,500,284"'),
    },
    'R-05-format': {
      why: 'scale9grid 不是 4 个整数',
      expect: 'error',
      needle: '格式非法',
      xml: legalComponentXml().replace('scale9grid="10,10,444,284"', 'scale9grid="a,b,c,d"'),
    },
    'R-05-negative': {
      why: 'scale9grid 负值（svg 怪癖 → 告警不拦截）',
      expect: 'warning',
      needle: '负值',
      xml: legalComponentXml().replace('scale9grid="10,10,444,284"', 'scale9grid="-5,10,444,284"'),
    },
    'R-06-missing': {
      why: '组件缺少 exported="true"（发布静默丢包）',
      expect: 'error',
      needle: 'exported',
      xml: legalComponentXml().replace(' exported="true"', ''),
    },
    'R-06-false': {
      why: 'exported="false"',
      expect: 'error',
      needle: 'exported',
      xml: legalComponentXml().replace('exported="true"', 'exported="false"'),
    },
    'R-07-format': {
      why: 'id="n0" 不符合 b000NN 序列',
      expect: 'error',
      needle: 'id',
      xml: legalComponentXml().replace('id="b00004"', 'id="n0"'),
    },
    'R-07-missing': {
      why: '显示对象缺少 id',
      expect: 'error',
      needle: 'id',
      xml: legalComponentXml().replace(' id="b00004"', ''),
    },
    'R-07-dup': {
      why: 'id 重复',
      expect: 'error',
      needle: '重复',
      xml: legalComponentXml().replace('id="b00004"', 'id="b00003"'),
    },
    'R-08-n': {
      why: '无语义名 n5',
      expect: 'error',
      needle: '无语义',
      xml: legalComponentXml().replace('name="deco_line"', 'name="n5"'),
    },
    'R-08-img': {
      why: '无语义名 img3',
      expect: 'error',
      needle: '无语义',
      xml: legalComponentXml().replace('name="deco_line"', 'name="img3"'),
    },
    'R-09': {
      why: '81 个显示对象超过上限 80',
      expect: 'warning',
      needle: '显示对象',
      xml: (() => {
        const many = [];
        for (let i = 0; i < 81; i++) {
          many.push(`    <image id="b${String(i + 1).padStart(5, '0')}" name="icon_${i + 1}" src="ui://abcd1234/reward_icon" xy="0,0" size="48,48"/>`);
        }
        return legalComponentXml().replace(
          /    <image id="b00001"[\s\S]*?\n    <loader[\s\S]*?\/>\n/,
          `${many.join('\n')}\n`,
        );
      })(),
    },
    'R-10': {
      why: '禁切图（NEVER）却设置了 scale9grid',
      expect: 'warning',
      needle: 'NEVER',
      // 注意：本样本需要配合 NEVER 资源注入（见 tests）
      xml: legalComponentXml(),
    },
  };
}

/** R-00 系列：XML 结构错误（不走「只改一处」模式，本身就是畸形文档）。 */
const MALFORMED = Object.freeze({
  unclosed: '<?xml version="1.0" encoding="utf-8"?>\n<component size="480,320" exported="true">\n  <displayList>\n    <image id="b00001" name="bg" src="ui://abcd1234/popup_bg"/>\n',
  dupAttr: '<?xml version="1.0" encoding="utf-8"?>\n<component size="480,320" size="480,320" exported="true">\n  <displayList/>\n</component>\n',
  wrongRoot: '<?xml version="1.0" encoding="utf-8"?>\n<window size="480,320" exported="true">\n  <displayList/>\n</window>\n',
  mismatchClose: '<?xml version="1.0" encoding="utf-8"?>\n<component exported="true">\n  <displayList>\n  </displayList></compnent>\n',
  emptyDoc: '',
});

module.exports = {
  RESOURCES,
  NEVER_FEATURES,
  legalComponentXml,
  violationSamples,
  MALFORMED,
};
