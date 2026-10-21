'use strict';
/**
 * test/unit/exec-plan.test.js —— CREATE Executor 地基：create_plan → 执行清单
 *
 * ★ 方法论（沿用本项目此前踩过的坑）★
 *   1. **层序**：底→顶，且不能依赖对象键序（故意把 nodes 写成乱序）。
 *   2. **词表封闭**：`steps` 里的 op **必须全部**在 `BRIDGE_COMMANDS` 内 ——
 *      这条断言是"绝不编造命令名"的机器化守卫。
 *   3. **缺命令必须可见**：用假词表删掉一条命令 → 该节点进 `unsupported` 且带原因。
 *   4. **确定性**：同输入两次运行 JSON 逐字节一致（md5 相同）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { buildExecPlan, BRIDGE_COMMANDS } = require('../../src/create/exec-plan');

const PKG_ID = 'mailpkg1';

/** 一份贴近真实产物的 create_plan（nodes 故意乱序：N2 在 N1 前面）。 */
function samplePlan() {
  return {
    version: '0.1',
    mode: 'create',
    canvas: { w: 750, h: 1334, source: 'cli' },
    page: { name: 'MailPagePopup', pkg: 'Mail', size: [750, 1334] },
    nodes: [
      {
        tempId: 'N2',
        tag: 'text',
        name: 'txt_title',
        layer: 10,
        attrs: {
          xy: '40,100', size: '300,40', text: '邮件详情', color: '#ffffff', fontSize: 24,
        },
        source: { layerId: 'L2' },
      },
      {
        tempId: 'N1',
        tag: 'image',
        name: 'img_bg',
        layer: 0,
        attrs: { xy: '0,0', size: '750,1334', src: 'q0jse' },
        source: { layerId: 'L1' },
      },
      {
        tempId: 'N3',
        tag: 'group',
        name: 'grp_actions',
        layer: 5,
        attrs: { xy: '20,600' },
        source: { layerId: 'L3' },
      },
    ],
    deferred: {
      controllers: [{ name: 'tab', pages: ['a', 'b'] }],
      relations: [],
      listItems: [],
    },
    summary: { nodes: 3 },
  };
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

test('★ 层序：容器 → 背景(layer 0) → 顶层(layer 10) → save_all', () => {
  const { execPlan } = buildExecPlan(samplePlan(), { pkgId: PKG_ID });
  const ops = execPlan.steps.map((s) => s.op);
  assert.deepEqual(ops, ['create_component', 'insert_object', 'insert_text', 'save_all'],
    `层序错误（nodes 乱序输入也必须按 layer 升序）：${JSON.stringify(ops)}`);
  // 背景（layer 0）必须先于标题（layer 10）
  const bg = execPlan.steps.find((s) => s.source.tempId === 'N1');
  const title = execPlan.steps.find((s) => s.source.tempId === 'N2');
  assert.ok(bg.step < title.step, '背景必须排在标题之前');
  // 容器永远是第 1 步
  assert.equal(execPlan.steps[0].op, 'create_component');
  assert.deepEqual(execPlan.steps[0].args, {
    pkg: 'Mail', name: 'MailPagePopup', width: 750, height: 1334,
  });
});

test('★ 词表封闭：steps 里的 op 全部来自 BRIDGE_COMMANDS（绝不编造命令名）', () => {
  const { execPlan } = buildExecPlan(samplePlan(), { pkgId: PKG_ID });
  const vocab = new Set(Object.keys(BRIDGE_COMMANDS));
  for (const s of execPlan.steps) {
    assert.ok(vocab.has(s.op), `词表外的命令被产出：${s.op}`);
  }
  // unsupported 里不得出现"看起来像命令"的 op 字段（只允许 {source, reason}）
  for (const u of execPlan.unsupported) {
    assert.equal(u.op, undefined, 'unsupported 条目不得带 op（否则等于自造命令）');
    assert.ok(u.reason && u.reason.length > 10, 'unsupported 必须带可读原因');
  }
});

test('★ 词表缺命令 → 进 unsupported 且带原因（不静默、不编造）', () => {
  const vocab = Object.keys(BRIDGE_COMMANDS).filter((k) => k !== 'insert_text');
  const { execPlan } = buildExecPlan(samplePlan(), { pkgId: PKG_ID, vocab });
  const textStep = execPlan.steps.find((s) => s.source.tempId === 'N2');
  assert.equal(textStep, undefined, '词表里没有 insert_text 就不该产出该步骤');
  const u = execPlan.unsupported.find((x) => x.source.tempId === 'N2');
  assert.ok(u, '缺命令的节点必须进 unsupported');
  assert.ok(/insert_text/.test(u.reason), `原因必须点名缺失的命令：${u.reason}`);
  // 其余步骤照常产出
  assert.deepEqual(execPlan.steps.map((s) => s.op), ['create_component', 'insert_object', 'save_all']);
});

test('★ 图片缺 pkgId → unsupported（基线没有"按短 ID 插入"的命令）', () => {
  const { execPlan } = buildExecPlan(samplePlan()); // 不传 pkgId
  const u = execPlan.unsupported.find((x) => x.source.tempId === 'N1');
  assert.ok(u, '短 ID 图片在没有 pkgId 时必须进 unsupported，不能瞎猜 url');
  assert.ok(/pkgId|ui:\/\//.test(u.reason), `原因应说明需要 pkgId/ui://：${u.reason}`);
});

test('★ 词表外的 tag（group）→ unsupported，且不产出任何步骤', () => {
  const { execPlan } = buildExecPlan(samplePlan(), { pkgId: PKG_ID });
  const u = execPlan.unsupported.find((x) => x.source.tempId === 'N3');
  assert.ok(u, 'group 没有对应插入命令，必须进 unsupported');
  assert.ok(/insert_object\/text\/loader\/list|没有可插入/.test(u.reason));
});

test('★ deferred（controllers）不静默：进 deferred 区块并计数，且**不**产步骤', () => {
  const { execPlan } = buildExecPlan(samplePlan(), { pkgId: PKG_ID });
  assert.equal(execPlan.deferred.length, 1);
  assert.equal(execPlan.deferred[0].kind, 'controllers');
  assert.equal(execPlan.deferred[0].count, 1);
  assert.equal(execPlan.summary.deferred, 1);
  assert.ok(!execPlan.steps.some((s) => s.op === 'add_controller'), 'v1 不自动生成控制器');
});

test('★ 确定性：同输入两次运行逐字节一致（无时间戳/随机/绝对路径）', () => {
  const a = buildExecPlan(samplePlan(), { pkgId: PKG_ID }).execPlan;
  const b = buildExecPlan(samplePlan(), { pkgId: PKG_ID }).execPlan;
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  assert.equal(md5(sa), md5(sb), '两次运行必须逐字节一致');
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(sa), '产物内不得出现 ISO 时间戳');
  // 绝对路径守卫：只认"独立出现的盘符"，避免把合法 `ui://` 误判成 `C:/`
  assert.ok(!/(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(sa), '产物内不得出现绝对路径');
});

test('★ args 映射：图片走 ui://<pkgId><itemId>（拼接形态），尺寸走 props', () => {
  const { execPlan } = buildExecPlan(samplePlan(), { pkgId: PKG_ID });
  const img = execPlan.steps.find((s) => s.op === 'insert_object');
  assert.equal(img.args.url, `ui://${PKG_ID}q0jse`, '必须用真实工程的拼接形态 ui://<pkgId><itemId>');
  assert.equal(img.args.x, 0);
  assert.equal(img.args.y, 0);
  assert.deepEqual(img.args.props, { size: '750,1334' }, 'insert_object 没有 width/height 参数 → 尺寸走 props');
  assert.equal(img.args.index, 0, '第一个插入的兄弟 index=0（底）');

  const txt = execPlan.steps.find((s) => s.op === 'insert_text');
  assert.equal(txt.args.child, 'txt_title');
  assert.equal(txt.args.text, '邮件详情');
  assert.equal(txt.args.width, 300);
  assert.equal(txt.args.height, 40);
  assert.equal(txt.args.fontSize, 24);
  assert.equal(txt.args.index, 1, '第二个插入的兄弟 index=1（顶）');
});

test('★ 非法输入：缺 page/缺画布 → 明确抛错（不产出半个清单）', () => {
  assert.throws(() => buildExecPlan({}), (e) => e.code === 'BAD_ARGUMENT');
  assert.throws(
    () => buildExecPlan({ page: { name: 'P', pkg: 'Mail' }, nodes: [] }),
    (e) => e.code === 'BAD_ARGUMENT',
  );
});
