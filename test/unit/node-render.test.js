'use strict';
/**
 * test/unit/node-render.test.js —— node-render 渲染契约（M2-SPEC §2）
 *
 * 覆盖渲染契约的六个维度：
 *   ① 固定属性序（乱序传入 → 输出按 id→name→src→url→icon→defaultItem→xy→size）
 *   ② 未知属性追加末尾且保持插入序
 *   ③ undefined / null 属性被跳过（绝不渲染 attr="undefined"）
 *   ④ 属性值转义（& / " / < / >）
 *   ⑤ 自闭合与非自闭合两种形态（默认自闭合）
 *   ⑥ 非法 tag 抛 AppError(BAD_ARGUMENT)
 *
 * ★ 本文件刻意不测 IR→attrs 语义映射（text/color/alpha）★
 *   那是 gen-plan 的职责（见 src/fgui/node-render.js 头注释「取舍」），
 *   node-render 是对 IR 一无所知的纯渲染器。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderNode, ATTR_ORDER, TAG_RE } = require('../../src/fgui/node-render');
const { AppError, CODES } = require('../../src/core/errors');

// ════════════════════════════════════════════════════════════════════════════
// ① 固定属性序
// ════════════════════════════════════════════════════════════════════════════

test('★ 属性序: 乱序传入 → 输出严格按固定序', () => {
  // 故意用与固定序完全相反的顺序传入
  const out = renderNode({
    tag: 'image',
    attrs: {
      size: '200,56', xy: '260,380', src: 'ui://3f7a91c2/btn_claim',
      name: 'btn_claim', id: 'b00007',
    },
  });
  assert.equal(out, '<image id="b00007" name="btn_claim" src="ui://3f7a91c2/btn_claim" xy="260,380" size="200,56"/>');
});

test('★ 属性序: 固定序常量即 SPEC 定义的 8 项', () => {
  assert.deepEqual([...ATTR_ORDER],
    ['id', 'name', 'src', 'url', 'icon', 'defaultItem', 'xy', 'size']);
});

test('属性序: 只出现部分固定属性时，仍保持相对固定序', () => {
  const out = renderNode({ tag: 'text', attrs: { size: '10,20', id: 'b00001', xy: '0,0' } });
  assert.equal(out, '<text id="b00001" xy="0,0" size="10,20"/>');
});

test('属性序: url/icon/defaultItem 也走固定序（loader/list 场景）', () => {
  const out = renderNode({
    tag: 'loader',
    attrs: { size: '48,48', url: 'ui://pkg/r', name: 'reward_icon', id: 'b00003', xy: '24,80' },
  });
  assert.equal(out,
    '<loader id="b00003" name="reward_icon" url="ui://pkg/r" xy="24,80" size="48,48"/>');
  const listOut = renderNode({
    tag: 'list',
    attrs: { defaultItem: 'ui://pkg/item', id: 'b00004', name: 'reward_list' },
  });
  assert.equal(listOut, '<list id="b00004" name="reward_list" defaultItem="ui://pkg/item"/>');
});

// ════════════════════════════════════════════════════════════════════════════
// ② 未知属性：追加末尾 + 保持插入序
// ════════════════════════════════════════════════════════════════════════════

test('★ 未知属性: 追加在固定序属性之后，且保持传入插入序', () => {
  const out = renderNode({
    tag: 'image',
    attrs: {
      // 未知属性乱序插入，必须按「传入的插入序」原样追加
      scale9grid: '10,10,180,36', color: '#ffffff', alpha: '0.5',
      // 固定序属性打散混入
      id: 'b00001', xy: '0,0',
    },
  });
  assert.equal(out,
    '<image id="b00001" xy="0,0" scale9grid="10,10,180,36" color="#ffffff" alpha="0.5"/>');
});

test('未知属性: 与固定属性混合时，固定属性全在前、未知全在后', () => {
  const out = renderNode({
    tag: 'graph',
    attrs: {
      custom: 'x', name: 'deco_line', anotherUnknown: 'y', id: 'b00002', size: '120,2',
    },
  });
  assert.equal(out,
    '<graph id="b00002" name="deco_line" size="120,2" custom="x" anotherUnknown="y"/>');
});

test('未知属性: extention 等 M2 常见扩展属性位置稳定（人可编辑 gen_plan 依赖它）', () => {
  const out = renderNode({
    tag: 'component',
    attrs: { extention: 'Button', id: 'c00001', name: 'btn', size: '200,56' },
  });
  assert.equal(out, '<component id="c00001" name="btn" size="200,56" extention="Button"/>');
});

// ════════════════════════════════════════════════════════════════════════════
// ③ undefined / null 跳过
// ════════════════════════════════════════════════════════════════════════════

test('★ undefined/null 属性被跳过（绝不渲染 attr="undefined"）', () => {
  const out = renderNode({
    tag: 'image',
    attrs: {
      id: 'b00001', name: undefined, src: null, xy: '0,0', size: '10,10', color: undefined,
    },
  });
  assert.equal(out, '<image id="b00001" xy="0,0" size="10,10"/>');
  assert.ok(!out.includes('undefined'), '输出中不应出现 undefined 字面量');
  assert.ok(!out.includes('null'), '输出中不应出现 null 字面量');
});

test('attrs 缺省 / 空对象 → 只渲染标签本身', () => {
  assert.equal(renderNode({ tag: 'group' }), '<group/>');
  assert.equal(renderNode({ tag: 'group', attrs: {} }), '<group/>');
  assert.equal(renderNode({ tag: 'group', attrs: { a: undefined, b: null } }), '<group/>');
});

test('数值与布尔属性被转成文本（属性值本质是字符串）', () => {
  const out = renderNode({ tag: 'text', attrs: { id: 'b00001', fontSize: 26, bold: false } });
  assert.equal(out, '<text id="b00001" fontSize="26" bold="false"/>');
});

test('空字符串属性**保留**（与 undefined 不同：空值是画师有意为之）', () => {
  const out = renderNode({ tag: 'text', attrs: { id: 'b00001', text: '' } });
  assert.equal(out, '<text id="b00001" text=""/>');
});

// ════════════════════════════════════════════════════════════════════════════
// ④ 转义
// ════════════════════════════════════════════════════════════════════════════

test('★ 转义: 值含 & " < > 时全部转义（复用 xml-patcher.escapeAttrValue）', () => {
  const out = renderNode({
    tag: 'text',
    attrs: { id: 'b00001', text: 'a & b "quoted" <tag> c' },
  });
  assert.equal(out, '<text id="b00001" text="a &amp; b &quot;quoted&quot; &lt;tag&gt; c"/>');
});

test('转义: & 优先转义，不产生二次转义', () => {
  // 若 & 在 " 之后处理，&quot; 会被二次转成 &amp;quot;
  const out = renderNode({ tag: 'text', attrs: { id: 'b00001', text: '"' } });
  assert.equal(out, '<text id="b00001" text="&quot;"/>');
  assert.ok(!out.includes('&amp;quot;'), '不应出现二次转义');
});

test('转义: 已含实体的字面文本会被再次转义（保持文本语义，不做幂等猜测）', () => {
  const out = renderNode({ tag: 'text', attrs: { id: 'b00001', text: '&amp;' } });
  assert.equal(out, '<text id="b00001" text="&amp;amp;"/>');
});

test('转义: 中文/emoji 不受影响（只转义 XML 特殊字符）', () => {
  const out = renderNode({ tag: 'text', attrs: { id: 'b00001', text: '邮件详情 🎉' } });
  assert.equal(out, '<text id="b00001" text="邮件详情 🎉"/>');
});

test('转义: 单引号不转义（本项目统一双引号，无歧义）', () => {
  const out = renderNode({ tag: 'text', attrs: { id: 'b00001', text: "it's" } });
  assert.equal(out, '<text id="b00001" text="it\'s"/>');
});

// ════════════════════════════════════════════════════════════════════════════
// ⑤ 自闭合 / 非自闭合
// ════════════════════════════════════════════════════════════════════════════

test('★ 形态: 默认自闭合（selfClose 缺省 = true）', () => {
  const out = renderNode({ tag: 'image', attrs: { id: 'b00001' } });
  assert.equal(out, '<image id="b00001"/>');
  assert.ok(out.endsWith('/>'));
});

test('★ 形态: selfClose:true 显式自闭合；selfClose:false → 成对标签', () => {
  assert.equal(renderNode({ tag: 'image', attrs: { id: 'b00001' }, selfClose: true }),
    '<image id="b00001"/>');
  assert.equal(renderNode({ tag: 'group', attrs: { id: 'b00002' }, selfClose: false }),
    '<group id="b00002"></group>');
});

test('形态: 非自闭合且无属性', () => {
  assert.equal(renderNode({ tag: 'group', selfClose: false }), '<group></group>');
});

test('形态: 输出不含缩进/换行（缩进与摆放是 insertChild 的职责）', () => {
  const out = renderNode({ tag: 'image', attrs: { id: 'b00001', name: 'bg' } });
  assert.ok(!out.includes('\n'), '输出不应含换行');
  assert.ok(!/^\s/.test(out), '输出不应以空白开头（无缩进）');
  assert.ok(!/\s$/.test(out), '输出不应以空白结尾');
});

// ════════════════════════════════════════════════════════════════════════════
// ⑥ 非法 tag / 非法入参
// ════════════════════════════════════════════════════════════════════════════

test('★ 非法 tag: 抛 AppError(BAD_ARGUMENT)，信息点名非法值', () => {
  const bads = ['1abc', 'my tag', '<x>', 'a"b', '', '  ', null, undefined, 42];
  for (const bad of bads) {
    assert.throws(() => renderNode({ tag: bad, attrs: {} }), (err) => {
      assert.ok(err instanceof AppError, `${JSON.stringify(bad)} 应抛 AppError`);
      assert.equal(err.code, CODES.BAD_ARGUMENT);
      assert.ok(err.message.includes('非法节点标签') || err.message.includes('renderNode'),
        `信息应可读: ${err.message}`);
      return true;
    });
  }
});

test('非法 tag: 合法形态（含命名空间/连字符/下划线/点）不抛', () => {
  for (const good of ['image', 'text', 'my-widget', 'a_b', 'ns:tag', 'A1']) {
    assert.doesNotThrow(() => renderNode({ tag: good }), `${good} 应被接受`);
    assert.ok(TAG_RE.test(good));
  }
});

test('非法入参: 非对象 / null 抛 AppError(BAD_ARGUMENT)', () => {
  for (const bad of [null, undefined, 'image', 42]) {
    assert.throws(() => renderNode(bad), (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, CODES.BAD_ARGUMENT);
      return true;
    });
  }
});

test('非法入参: attrs 非对象时按空属性处理（不崩）', () => {
  assert.equal(renderNode({ tag: 'group', attrs: 'nope' }), '<group/>');
  assert.equal(renderNode({ tag: 'group', attrs: null }), '<group/>');
});

// ════════════════════════════════════════════════════════════════════════════
// ⑦ 确定性（B9：同一输入两次渲染逐字节一致）
// ════════════════════════════════════════════════════════════════════════════

test('确定性: 同一输入两次渲染结果完全一致', () => {
  const node = {
    tag: 'component',
    attrs: { extention: 'Button', id: 'c00001', name: 'btn', size: '200,56', xy: '0,0' },
    selfClose: false,
  };
  assert.equal(renderNode(node), renderNode(node));
  // 与插入序无关的稳定性：同一组键不同插入序 → 固定序部分输出相同
  const a = renderNode({ tag: 'image', attrs: { id: 'b1', xy: '0,0', name: 'n' } });
  const b = renderNode({ tag: 'image', attrs: { name: 'n', xy: '0,0', id: 'b1' } });
  assert.equal(a, b);
});
