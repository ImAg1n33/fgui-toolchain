'use strict';
/**
 * test/unit/exec-plan.test.js —— CREATE Executor 地基：create_plan → 执行清单
 *
 * ★ 本轮（第七轮审查）新增四道硬性验收的测试 ★
 *   · 参数 Schema：名字对 ≠ 能执行 → 不合规进 `invalidSteps`
 *   · preflight + `executable`：只要有必需操作没落成，**不许**说构建完成
 *   · 禁止假成功：`unsupported.required` 参与 executable 判定
 *   · 结果回读：`verify` 用真实存在的回读命令 + `onMismatch:"fail"`
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  buildExecPlan, BRIDGE_COMMANDS, COMMAND_SCHEMA, validateStepArgs,
} = require('../../src/create/exec-plan');

const PKG_ID = 'mailpkg1';

/** 一份「干净」的 create_plan（readiness=ready、无 toImport、nodes 故意乱序）。 */
function cleanPlan() {
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
    ],
    assets: { reused: [{ resourceId: 'q0jse' }], toImport: [] },
    deferred: { controllers: [], relations: [], listItems: [] },
    readiness: { status: 'ready' },
    summary: { nodes: 2 },
  };
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// ────────────────────────────────────────────────────────────────────────────
// 基础：层序 / 词表封闭
// ────────────────────────────────────────────────────────────────────────────

test('★ 层序：容器 → 背景(layer 0) → 顶层(layer 10) → save_all', () => {
  const { execPlan } = buildExecPlan(cleanPlan(), { pkgId: PKG_ID });
  assert.deepEqual(execPlan.steps.map((s) => s.op),
    ['create_component', 'insert_object', 'insert_text', 'save_all'],
    'nodes 乱序输入也必须按 layer 升序');
  assert.equal(execPlan.steps[0].op, 'create_component');
  assert.deepEqual(execPlan.steps[0].args, {
    pkg: 'Mail', name: 'MailPagePopup', width: 750, height: 1334,
  });
  const bg = execPlan.steps.find((s) => s.source.tempId === 'N1');
  const title = execPlan.steps.find((s) => s.source.tempId === 'N2');
  assert.ok(bg.step < title.step, '背景必须排在标题之前');
});

test('★ 词表封闭：steps 与 invalidSteps 的 op 全部来自 BRIDGE_COMMANDS', () => {
  const { execPlan } = buildExecPlan(cleanPlan(), { pkgId: PKG_ID });
  const vocab = new Set(Object.keys(BRIDGE_COMMANDS));
  for (const s of execPlan.steps) assert.ok(vocab.has(s.op), `词表外的命令被产出：${s.op}`);
  for (const s of execPlan.invalidSteps) assert.ok(vocab.has(s.op), `invalidSteps 里出现词表外命令：${s.op}`);
  for (const u of execPlan.unsupported) {
    assert.equal(u.op, undefined, 'unsupported 条目不得带 op（否则等于自造命令）');
    assert.ok(u.reason && u.reason.length > 10, 'unsupported 必须带可读原因');
    assert.equal(typeof u.required, 'boolean', 'unsupported 必须显式声明 required');
  }
});

// ────────────────────────────────────────────────────────────────────────────
// ① 参数 Schema：名字对 ≠ 能执行
// ────────────────────────────────────────────────────────────────────────────

test('★ ① 缺必填参数 → invalidSteps（不是 unsupported）；类型不符同样拦', () => {
  // schema 层：insert_text 必填 child
  const v = validateStepArgs('insert_text', { pkg: 'Mail', name: 'P' });
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, ['child'], `应点名缺少 child：${JSON.stringify(v.missing)}`);

  // 编排层：把节点名写成数字 → insert_text 的 child 类型不符 → invalidSteps，executable=false
  const plan = cleanPlan();
  plan.nodes = [{
    tempId: 'N1', tag: 'text', name: 123, layer: 1,
    attrs: { xy: '0,0', size: '10,10', text: 'x' }, // name 必须是字符串
  }];
  const { execPlan } = buildExecPlan(plan, { pkgId: PKG_ID });
  assert.equal(execPlan.invalidSteps.length, 1, '类型不符必须进 invalidSteps（改前会被当成合法 step）');
  assert.equal(execPlan.invalidSteps[0].op, 'insert_text');
  assert.ok(execPlan.invalidSteps[0].typeErrors.some((e) => e.param === 'child'),
    `应点名 child 类型错误：${JSON.stringify(execPlan.invalidSteps[0].typeErrors)}`);
  assert.ok(/参数不合规/.test(execPlan.invalidSteps[0].reason));
  assert.equal(execPlan.unsupported.length, 0, 'invalid 与 unsupported 语义不同，不得混用');
  assert.equal(execPlan.executable, false, '有 invalidSteps 绝不能 executable');
  // schema 派生自词表（单一真源）
  assert.deepEqual(COMMAND_SCHEMA.insert_text.required, BRIDGE_COMMANDS.insert_text.params.required);
});

// ────────────────────────────────────────────────────────────────────────────
// ② preflight
// ────────────────────────────────────────────────────────────────────────────

test('★ ② preflight：readiness 非 ready / 缺 readiness → 失败（fail-closed）', () => {
  const notReady = cleanPlan();
  notReady.readiness = { status: 'needs-human' };
  const a = buildExecPlan(notReady, { pkgId: PKG_ID }).execPlan;
  assert.equal(a.preflight.ok, false);
  assert.ok(a.preflight.failures.some((f) => f.code === 'READINESS_NOT_READY'));
  assert.equal(a.executable, false);

  const missing = cleanPlan();
  delete missing.readiness;
  const b = buildExecPlan(missing, { pkgId: PKG_ID }).execPlan;
  assert.equal(b.preflight.ok, false, '没有 readiness 不能当成 ready');
  assert.ok(b.preflight.failures.some((f) => f.code === 'READINESS_NOT_READY'));
});

test('★ ③ 素材未导入（toImport 非空）→ RESOURCE_MISSING + executable=false', () => {
  const plan = cleanPlan();
  plan.assets.toImport = [{ suggestedName: 'popup_bg.png', w: 750, h: 1334 }];
  const { execPlan } = buildExecPlan(plan, { pkgId: PKG_ID });
  const f = execPlan.preflight.failures.find((x) => x.code === 'RESOURCE_MISSING');
  assert.ok(f, '素材未导入必须让 preflight 失败');
  assert.ok(/popup_bg\.png/.test(f.detail), '失败详情要点名缺的素材');
  assert.equal(execPlan.executable, false);
});

// ────────────────────────────────────────────────────────────────────────────
// ④ 禁止假成功
// ────────────────────────────────────────────────────────────────────────────

test('★ ④ 图片缺 pkgId → unsupported(required:true) + executable=false', () => {
  const { execPlan } = buildExecPlan(cleanPlan()); // 不传 pkgId
  const u = execPlan.unsupported.find((x) => x.source.tempId === 'N1');
  assert.ok(u, '短 ID 图片在没有 pkgId 时必须进 unsupported');
  assert.equal(u.required, true, '计划里必须落位的节点 → required:true');
  assert.ok(/pkgId|ui:\/\//.test(u.reason));
  assert.equal(execPlan.executable, false, '有必需操作没落成 → 绝不许说构建完成');
  assert.ok(execPlan.preflight.failures.some((f) => f.code === 'UNSUPPORTED_REQUIRED'));
});

test('★ 词表外 tag（group）→ unsupported(required:true)', () => {
  const plan = cleanPlan();
  plan.nodes.push({
    tempId: 'N3', tag: 'group', name: 'grp', layer: 5, attrs: { xy: '0,0' },
  });
  const { execPlan } = buildExecPlan(plan, { pkgId: PKG_ID });
  const u = execPlan.unsupported.find((x) => x.source.tempId === 'N3');
  assert.ok(u);
  assert.equal(u.required, true);
  assert.equal(execPlan.executable, false);
});

test('★ 词表缺命令（删掉 insert_text）→ unsupported(required:true)，其余步骤照常', () => {
  const vocab = Object.keys(BRIDGE_COMMANDS).filter((k) => k !== 'insert_text');
  const { execPlan } = buildExecPlan(cleanPlan(), { pkgId: PKG_ID, vocab });
  assert.deepEqual(execPlan.steps.map((s) => s.op), ['create_component', 'insert_object', 'save_all']);
  const u = execPlan.unsupported.find((x) => x.source.tempId === 'N2');
  assert.ok(u && /insert_text/.test(u.reason));
  assert.equal(u.required, true);
  assert.equal(execPlan.executable, false);
});

test('★ deferred（controllers）不静默：进 deferred 区块，**不**算 unsupported、不产步骤', () => {
  const plan = cleanPlan();
  plan.deferred = { controllers: [{ name: 'tab', pages: ['a', 'b'] }], relations: [], listItems: [] };
  const { execPlan } = buildExecPlan(plan, { pkgId: PKG_ID });
  assert.equal(execPlan.deferred.length, 1);
  assert.equal(execPlan.deferred[0].kind, 'controllers');
  assert.equal(execPlan.deferred[0].count, 1);
  assert.equal(execPlan.summary.deferred, 1);
  assert.ok(!execPlan.steps.some((s) => s.op === 'add_controller'));
  assert.equal(execPlan.unsupported.length, 0, 'deferred 不得混进 unsupported');
  assert.equal(execPlan.executable, true, 'deferred 是"有意不生成"，不该阻断执行');
});

// ────────────────────────────────────────────────────────────────────────────
// ⑤ 结果回读 verify
// ────────────────────────────────────────────────────────────────────────────

test('★ ⑤ 干净 plan → executable=true，verify.childCount=节点数、顺序与 layer 一致', () => {
  const { execPlan } = buildExecPlan(cleanPlan(), { pkgId: PKG_ID });
  assert.equal(execPlan.preflight.ok, true, `preflight 失败：${JSON.stringify(execPlan.preflight.failures)}`);
  assert.equal(execPlan.executable, true);
  assert.equal(execPlan.verify.length, 1);
  const v = execPlan.verify[0];
  assert.equal(v.op, 'read_component', '回读必须用词表里真实存在的命令');
  assert.deepEqual(v.args, { pkg: 'Mail', name: 'MailPagePopup' });
  assert.equal(v.onMismatch, 'fail', '回读不一致必须报失败，不许"命令 ok 就算成功"');
  assert.equal(v.expect.childCount, 2, 'childCount 应等于计划中的节点数');
  assert.deepEqual(v.expect.children.map((c) => c.name), ['img_bg', 'txt_title'],
    '回读顺序必须与 layer 升序一致（底→顶）');
  assert.deepEqual(v.expect.children[0], { name: 'img_bg', xy: '0,0', size: '750,1334' });
});

test('★ ⑤ 词表删掉 read_component → 回读降级为 list_children(required:false)，**不**改变 executable', () => {
  const vocab = Object.keys(BRIDGE_COMMANDS).filter((k) => k !== 'read_component');
  const { execPlan } = buildExecPlan(cleanPlan(), { pkgId: PKG_ID, vocab });
  assert.equal(execPlan.verify.length, 1);
  assert.equal(execPlan.verify[0].op, 'list_children', '降级到词表里另一条真实回读命令');
  assert.deepEqual(execPlan.verify[0].expect.names, ['img_bg', 'txt_title']);
  const u = execPlan.unsupported.find((x) => /read_component/.test(x.reason));
  assert.ok(u, '降级必须显式记录，不静默');
  assert.equal(u.required, false, '回读能力缺失不是构建失败');
  assert.equal(execPlan.executable, true, '回读不可用不得把 executable 拉成 false');
});

test('★ ⑤ 词表没有任何回读命令 → unsupported(required:false) + 说明"无法回读验证"', () => {
  const vocab = Object.keys(BRIDGE_COMMANDS).filter((k) => k !== 'read_component' && k !== 'list_children');
  const { execPlan } = buildExecPlan(cleanPlan(), { pkgId: PKG_ID, vocab });
  assert.equal(execPlan.verify.length, 0);
  const u = execPlan.unsupported.find((x) => /无法回读验证/.test(x.reason));
  assert.ok(u, '没有回读命令必须显式说明');
  assert.equal(u.required, false);
  assert.equal(execPlan.executable, true);
});

// ────────────────────────────────────────────────────────────────────────────
// ⑥ 确定性与其它守卫
// ────────────────────────────────────────────────────────────────────────────

test('★ ⑥ 确定性：两次运行逐字节一致（无时间戳/随机/绝对路径）', () => {
  const a = JSON.stringify(buildExecPlan(cleanPlan(), { pkgId: PKG_ID }).execPlan);
  const b = JSON.stringify(buildExecPlan(cleanPlan(), { pkgId: PKG_ID }).execPlan);
  assert.equal(md5(a), md5(b), '两次运行必须逐字节一致');
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(a), '产物内不得出现 ISO 时间戳');
  assert.ok(!/(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(a), '产物内不得出现绝对路径');
});

test('★ args 映射：图片走 ui://<pkgId><itemId>（拼接），size 走 props，index 递增', () => {
  const { execPlan } = buildExecPlan(cleanPlan(), { pkgId: PKG_ID });
  const img = execPlan.steps.find((s) => s.op === 'insert_object');
  assert.equal(img.args.url, `ui://${PKG_ID}q0jse`);
  assert.equal(img.args.x, 0);
  assert.equal(img.args.y, 0);
  assert.deepEqual(img.args.props, { size: '750,1334' }, 'insert_object 无 width/height → 尺寸走 props');
  assert.equal(img.args.index, 0);

  const txt = execPlan.steps.find((s) => s.op === 'insert_text');
  assert.equal(txt.args.child, 'txt_title');
  assert.equal(txt.args.width, 300, 'insert_text 有 width/height → 直接映射');
  assert.equal(txt.args.fontSize, 24);
  assert.equal(txt.args.index, 1);
});

test('★ 不做"Bridge 在线"这类假检查：只列 runtimeChecks 供执行方自查', () => {
  const { execPlan } = buildExecPlan(cleanPlan(), { pkgId: PKG_ID });
  assert.ok(Array.isArray(execPlan.runtimeChecks) && execPlan.runtimeChecks.length >= 3);
  const text = JSON.stringify(execPlan);
  assert.ok(!/"bridgeOnline"/.test(text), '不得假装验证了 Bridge 在线状态');
});

test('★ 非法输入：缺 page / 缺画布 → 明确抛 BAD_ARGUMENT', () => {
  assert.throws(() => buildExecPlan({}), (e) => e.code === 'BAD_ARGUMENT');
  assert.throws(
    () => buildExecPlan({ page: { name: 'P', pkg: 'Mail' }, nodes: [] }),
    (e) => e.code === 'BAD_ARGUMENT',
  );
});
