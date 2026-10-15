'use strict';
/**
 * test/unit/project-index.test.js —— M1：FGUI 工程只读索引
 *
 * ★ 测试方法论（延续本项目「自己造数据自己验证」的三重收口）★
 *   本地没有真实 FGUI 工程副本（Q3 未答），fixture 由 make-fgui-project.js
 *   按上游 STANDARDS 构造。因此本文件覆盖：
 *     ① 解析正确性（fixture 的结构断言）+ lint 闭环（fixture XML 必须过我们
 *        自己的 lint —— 第一道独立验证）
 *     ② 交叉验证三：round-trip（索引 -> 渲染 -> 再索引，结构一致）
 *     ③ 交叉验证二：上游 baseline 对账（bridge 的 itemUrl 是**无斜杠拼接**
 *        风格，我们的 resolver 必须解析它；fixture 的 RewardCell 就用这个风格）
 *     ④ 只读性（文件级快照，含 mtime）+ 确定性（两次运行 md5 一致）
 *     ⑤ 宽容解析（畸形组件不打断索引，记 warning）
 *
 * 按审查者纪律：不追求测试数量，只加守住回归的用例。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { makeFguiProject, PKG } = require('../fixtures/make-fgui-project');
const { run } = require('../../src/cli/cmd-project-index');
const { loadConfig } = require('../../src/core/config');
const { createLogger } = require('../../src/core/logger');
const { lintComponentXml } = require('../../src/fgui/lint-rules');
const { indexComponentXml, renderComponentXml } = require('../../src/fgui/component-indexer');
const { parseUiRef } = require('../../src/fgui/resource-resolver');

const ROOT = path.resolve(__dirname, '../..');
const FIXTURE = path.join(ROOT, 'test/fixtures/fgui-project');

/** 保证 fixture 存在（缺就现造；脚本确定性，重复造无害）。 */
function ensureFixture() {
  if (!fs.existsSync(path.join(FIXTURE, 'MailPopup.fairy'))) {
    makeFguiProject({ outDir: FIXTURE });
  }
  return FIXTURE;
}

/**
 * 跑一次 project-index（捕获 stdout，避免污染 node:test 报告）。
 * @param {string} outDir 输出目录
 * @returns {{code:number, stdout:string}}
 */
function runIndex(outDir) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    const code = run({
      flags: { project: FIXTURE, out: outDir },
      config: loadConfig({ rootDir: ROOT }),
      logger: createLogger({ command: 'project-index' }),
      rootDir: ROOT,
    });
    // run 是 async 函数，这里同步等待其 Promise
    return Promise.resolve(code).then((c) => ({ code: c, stdout: chunks.join('') }));
  } finally {
    process.stdout.write = orig;
  }
}

/**
 * 递归快照目录（文件 + 大小 + mtimeMs）—— 只读性证明用。
 * @param {string} dir
 * @returns {Object}
 */
function snapshotDir(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else {
        const st = fs.statSync(abs);
        out[path.relative(dir, abs)] = { size: st.size, mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(dir);
  return out;
}

test('M1: 合成 fixture 能被完整索引（结构断言）', async () => {
  ensureFixture();
  const out = fs.mkdtempSync(path.join(ROOT, 'out', 'pi-struct-'));
  try {
    const { code } = await runIndex(out);
    assert.equal(code, 0);
    const idx = JSON.parse(fs.readFileSync(path.join(out, 'project_index.json'), 'utf8'));

    // 工程层：两个包 + 包 id（8 位）
    assert.equal(idx.project.packages.length, 2);
    assert.deepEqual(idx.project.packages.map((p) => p.name), ['Common', 'MailDetail']);
    for (const p of idx.project.packages) {
      assert.ok(p.id && p.id.length === 8, `包 ${p.name} 应有 8 位 id`);
      assert.ok(!/[A-Za-z]:/.test(p.relPath), `产物不得含绝对路径: ${p.relPath}`);
    }
    // 资源层：4 图 + 3 组件登记
    assert.equal(idx.resources.length, 7);
    assert.equal(idx.resources.filter((r) => r.type === 'image').length, 4);
    // 九宫格与 exported 如实提取
    const popup = idx.resources.find((r) => r.name === 'popup_bg.png');
    assert.equal(popup.scale, '9grid');
    assert.equal(popup.scale9grid, '24,24,432,272');
    assert.equal(popup.exported, 'true');
    // 图片特征（与 assets.db 关联的数据结构）
    assert.equal(popup.image.width, 480);
    assert.equal(popup.image.height, 320);
    assert.equal(typeof popup.image.phash, 'string');
    // 组件层：3 个组件 + 尺寸/extention
    assert.equal(idx.components.length, 3);
    const mail = idx.components.find((c) => c.name === 'MailDetail');
    assert.deepEqual(mail.size, [560, 360]);
    assert.equal(mail.extention, 'Button');
    // 引用图：7 条引用全部解析，0 未解析
    assert.equal(idx.referenceGraph.edgeCount, 7);
    assert.equal(idx.referenceGraph.unresolvedCount, 0, JSON.stringify(idx.referenceGraph.unresolved));
    // 可复用查询：被引用次数（RewardCell 被 MailDetail 的 list defaultItem 之外……
    // 本 fixture 中 PopupFrame 被 MailDetail 引用 1 次，reward_icon 被 2 个组件用）
    assert.equal(idx.reuse.componentRefCounts['Common/PopupFrame'], 1);
    assert.equal(idx.reuse.imageRefCounts['MailDetail/a7b8c9d0'], 2);
    assert.equal(idx.warnings.length, 0, `合成工程应零 warning：${JSON.stringify(idx.warnings)}`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('M1 交叉验证一（lint 闭环）: fixture 的规范组件必须过我们自己的 lint', () => {
  ensureFixture();
  // 两个按「斜杠风格」构造的组件必须 0 error —— 我们自己的规范检查器就是
  // 第一道独立验证（fixture 若构造得不对，这里先红）。
  for (const rel of ['assets/Common/PopupFrame.xml', 'assets/MailDetail/MailDetail.xml']) {
    const r = lintComponentXml(fs.readFileSync(path.join(FIXTURE, rel), 'utf8'), {});
    assert.equal(r.ok, true, `${rel} 应 0 error（fixture 按 STANDARDS 构造）：${JSON.stringify(r.errors)}`);
    assert.equal(r.errors.length, 0);
  }
  // ★ 已知差异（写进报告，不静默）★：RewardCell 故意用上游 bridge 的**无斜杠
  //   拼接风格**（plugin_main.js.baseline 的 itemUrl），我们的 lint R-04 按
  //   STANDARDS 要求斜杠风格，因此会报 R-04 —— 这正是「真实工程可能含遗留
  //   风格」的形态。indexer 两种都解析（见交叉验证二），lint 是否放宽属
  //   Q18 系列未决问题，本轮不动 lint 契约。
  const cell = lintComponentXml(fs.readFileSync(path.join(FIXTURE, 'assets/MailDetail/RewardCell.xml'), 'utf8'), {});
  assert.equal(cell.ok, false, '拼接风格按现行 lint 契约应报错（已知差异，勿静默改绿）');
  assert.ok(cell.errors.some((e) => e.rule === 'R-04' && e.message.includes('ui://e5f6a7b8a7b8c9d0')),
    '★ 该 R-04 报错应如实存在 —— 它是「上游风格 vs 我们 lint 契约」差异的探针');
});

test('M1 交叉验证三（round-trip）: 索引 -> 渲染 -> 再索引结构一致', () => {
  ensureFixture();
  for (const rel of ['assets/Common/PopupFrame.xml', 'assets/MailDetail/MailDetail.xml', 'assets/MailDetail/RewardCell.xml']) {
    const xml = fs.readFileSync(path.join(FIXTURE, rel), 'utf8');
    const first = indexComponentXml(xml);
    assert.equal(first.ok, true, `${rel} 应可解析`);
    const rendered = renderComponentXml(first);
    const second = indexComponentXml(rendered);
    assert.equal(second.ok, true, `${rel} 渲染产物应可再解析`);
    assert.deepEqual(second.root, first.root,
      `★ ${rel} round-trip 后节点树必须一致（丢字段 = 索引不可信）`);
    assert.deepEqual(second.size, first.size);
    assert.equal(second.uiRefs.length, first.uiRefs.length, `${rel} 引用数不得丢`);
  }
});

test('M1 交叉验证二（上游 baseline 对账）: bridge 的无斜杠拼接风格必须可解析', () => {
  // 事实来源：docs/plugin_main.js.baseline 的 itemUrl() = 'ui://' + pkg.id + item.id
  //   （无分隔符），mcp_server.mjs.baseline 的工具描述同样写明该风格。
  // 我们的 lint/生成侧用斜杠风格 —— 两种都必须解析，否则真实工程索引会漏。
  const baseline = fs.readFileSync(path.join(ROOT, 'docs/plugin_main.js.baseline'), 'utf8');
  assert.ok(baseline.includes('return "ui://" + pkg.id + item.id;'),
    '上游 baseline 的 itemUrl 形态应保持可对账（若上游变更，本断言提醒复查）');

  const concat = parseUiRef('ui://a1b2c3d4b1c2d3e4');
  assert.deepEqual(concat, {
    raw: 'ui://a1b2c3d4b1c2d3e4', style: 'concat', pkgId: 'a1b2c3d4', itemId: 'b1c2d3e4',
  });
  const slash = parseUiRef('ui://a1b2c3d4/b1c2d3e4');
  assert.deepEqual(slash, {
    raw: 'ui://a1b2c3d4/b1c2c3e4'.replace('b1c2c3e4', 'b1c2d3e4'), style: 'slash', pkgId: 'a1b2c3d4', itemId: 'b1c2d3e4',
  });
  assert.equal(parseUiRef('not-a-ref'), null);
  assert.equal(parseUiRef(undefined), null);

  // fixture 的 RewardCell 就用拼接风格，索引必须把它解析成边
  const out = fs.mkdtempSync(path.join(ROOT, 'out', 'pi-baseline-'));
  return runIndex(out).then(({ code }) => {
    try {
      assert.equal(code, 0);
      const idx = JSON.parse(fs.readFileSync(path.join(out, 'project_index.json'), 'utf8'));
      const concatEdges = idx.referenceGraph.edges.filter((e) => e.style === 'concat');
      assert.equal(concatEdges.length, 1, 'fixture 的 RewardCell 引用应为拼接风格边');
      assert.equal(concatEdges[0].to.pkg, 'MailDetail');
      assert.equal(concatEdges[0].to.id, 'a7b8c9d0');
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});

test('M1 只读性: 索引前后工程目录文件级快照（含 mtime）零变化', async () => {
  ensureFixture();
  const before = snapshotDir(FIXTURE);
  const out = fs.mkdtempSync(path.join(ROOT, 'out', 'pi-readonly-'));
  try {
    const { code } = await runIndex(out);
    assert.equal(code, 0);
    const after = snapshotDir(FIXTURE);
    assert.deepEqual(after, before,
      '★ project-index 必须严格只读：目标工程目录任何文件（含 mtime）都不得变化');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('M1 确定性: 同输入两次运行 project_index.json md5 一致', async () => {
  ensureFixture();
  const out1 = fs.mkdtempSync(path.join(ROOT, 'out', 'pi-det1-'));
  const out2 = fs.mkdtempSync(path.join(ROOT, 'out', 'pi-det2-'));
  try {
    await runIndex(out1);
    await runIndex(out2);
    const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
    assert.equal(md5(path.join(out1, 'project_index.json')), md5(path.join(out2, 'project_index.json')),
      '★ B9：同输入两次索引必须逐字节一致');
    // 绝对路径机器化守卫（前两轮 Ubuntu CI 的教训）
    const text = fs.readFileSync(path.join(out1, 'project_index.json'), 'utf8');
    // ★ 注意正则：必须锚定 JSON 字符串开头，否则会误匹配 ui:// 里的 'i:/'
    assert.ok(!/"\s*[A-Za-z]:[\\/]/.test(text), `产物内不得出现本机绝对路径`);
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text), '产物内不得有时间戳');
  } finally {
    fs.rmSync(out1, { recursive: true, force: true });
    fs.rmSync(out2, { recursive: true, force: true });
  }
});

test('M1 宽容解析: 畸形组件不打断索引，记 warning 而不静默', () => {
  // 真实工程可能有编辑器容忍、我们 lint 会拦的形态：缺 size、未知标签、
  // 残缺 ui://、displayList 缺失 —— indexer 的职责是提取信息，不是判死刑。
  const weird = '<?xml version="1.0"?>\n<component exported="true">\n'
    + '  <displayList>\n'
    + '    <image id="b00001" name="x" src="ui://a1b2c3d4/" xy="0,0"/>\n'
    + '    <unknown-tag id="b00002" name="y"/>\n'
    + '    <image id="b00003" name="z"/>\n'
    + '  </displayList>\n</component>\n';
  const r = indexComponentXml(weird);
  assert.equal(r.ok, true, '★ 畸形形态也必须产出索引（不整个文件失败）');
  assert.equal(r.size, null, '缺 size 记 null');
  assert.ok(r.warnings.some((w) => w.includes('size')), '缺 size 要有 warning');
  assert.equal(r.root.children[0].children.length, 3, '三个子对象都要被提取（含未知标签）');
  assert.equal(r.root.children[0].children[0].src, 'ui://a1b2c3d4/');
  assert.equal(r.root.children[0].children[1].tag, 'unknown-tag');
  // 残缺 itemId 的引用：如实记 warning，不当法官
  assert.ok(r.warnings.some((w) => w.includes('解析不出')), JSON.stringify(r.warnings));
});
