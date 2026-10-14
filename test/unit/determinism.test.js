'use strict';
/**
 * test/unit/determinism.test.js —— B9 逐字节一致性
 *
 * ★ 这是「红线要有测试证明」的第二条 ★（PRD B9 / ARCHITECTURE §4.4）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stringifyJson, writeJson, readJson } = require('../../src/core/fs-json');
const {
  round6, roundDeep, sortKeysDeep, sortBy, entriesSorted, toPosixRel,
} = require('../../src/core/determinism');
const { atomicWrite, stampOf, rollbackFrom } = require('../../src/core/atomic');

/** 临时目录（测试结束自动清理）。 */
function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fgui-${tag}-`));
}

test('round6: 浮点定点化', () => {
  assert.equal(round6(1 / 3), 0.333333);
  assert.equal(round6(2 / 3), 0.666667);
  assert.equal(round6(1), 1);
  assert.equal(round6(-1 / 7), -0.142857);
  // 非有限值原样返回，不静默变成 0
  assert.ok(Number.isNaN(round6(NaN)));
  assert.equal(round6(Infinity), Infinity);
});

test('roundDeep: 递归定点化', () => {
  const out = roundDeep({ a: 1 / 3, b: [1 / 7, { c: 2 / 3 }] });
  assert.equal(out.a, 0.333333);
  assert.equal(out.b[0], 0.142857);
  assert.equal(out.b[1].c, 0.666667);
});

test('sortKeysDeep: 键序按字母序，不依赖插入序', () => {
  const a = { z: 1, a: 2, m: { q: 1, b: 2 } };
  const b = { m: { b: 2, q: 1 }, a: 2, z: 1 };
  assert.equal(JSON.stringify(sortKeysDeep(a)), JSON.stringify(sortKeysDeep(b)),
    '插入顺序不同的等价对象应序列化出相同结果');
  assert.equal(Object.keys(sortKeysDeep(a))[0], 'a');
});

test('stringifyJson: 末尾恰好一个 \\n、2 空格缩进、无 CRLF', () => {
  const text = stringifyJson({ b: 1, a: 2 });
  assert.ok(text.endsWith('}\n'), '末尾应恰好一个换行');
  assert.ok(!text.endsWith('\n\n'), '不应有多余空行');
  assert.ok(!text.includes('\r'), '不应有 CRLF');
  assert.ok(text.includes('\n  "a": 2'), '应为 2 空格缩进');
  assert.ok(text.indexOf('"a"') < text.indexOf('"b"'), '键应按字母序');
});

test('B9 核心: 同一对象序列化 3 次逐字节一致', () => {
  const obj = {
    version: '1.0',
    nested: { z: 1 / 3, a: [3, 1, 2], m: { k: 'v' } },
    list: [{ id: 'L002', score: 1 / 7 }, { id: 'L001', score: 2 / 3 }],
  };
  const h1 = stringifyJson(obj);
  const h2 = stringifyJson(obj);
  const h3 = stringifyJson(JSON.parse(JSON.stringify(obj)));
  assert.equal(h1, h2);
  assert.equal(h2, h3);
});

test('B9 核心: 不同插入序的等价对象产出相同字节', () => {
  const mk = () => ({
    op: 'REUSE', slot: 'popup_bg', node: 'L012', matchLevel: 'L1',
    confidence: 0.9999999, evidence: 'slice 一致',
  });
  const a = mk();
  const b = { evidence: 'slice 一致', confidence: 0.9999999, matchLevel: 'L1', node: 'L012', slot: 'popup_bg', op: 'REUSE' };
  assert.equal(stringifyJson(a), stringifyJson(b));
});

test('writeJson: 同一内容写两次，文件逐字节一致', () => {
  const dir = tmpDir('det');
  const p1 = path.join(dir, 'a.json');
  const p2 = path.join(dir, 'b.json');
  const obj = { x: 1 / 3, y: [{ b: 1, a: 2 }] };
  writeJson(p1, obj);
  writeJson(p2, obj);
  const b1 = fs.readFileSync(p1);
  const b2 = fs.readFileSync(p2);
  assert.equal(b1.equals(b2), true, '★ 同一输入两次写出必须逐字节一致');
  assert.ok(!b1.includes(0xef), '不应有 BOM');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sortBy: 多级稳定排序', () => {
  const arr = [
    { op: 'REUSE', slot: 'b', node: 'L2' },
    { op: 'ADD', slot: 'a', node: 'L1' },
    { op: 'REUSE', slot: 'a', node: 'L3' },
    { op: 'ADD', slot: 'a', node: 'L2' },
  ];
  const out = sortBy(arr, (x) => x.op, (x) => x.slot, (x) => x.node);
  assert.deepEqual(out.map((x) => `${x.op}/${x.slot}/${x.node}`), [
    'ADD/a/L1', 'ADD/a/L2', 'REUSE/a/L3', 'REUSE/b/L2',
  ]);
});

test('entriesSorted: Map 输出必须先排序', () => {
  const m = new Map([['z', 1], ['a', 2], ['m', 3]]);
  assert.deepEqual(entriesSorted(m).map((e) => e[0]), ['a', 'm', 'z']);
});

test('toPosixRel: Windows 路径转 POSIX 相对路径', () => {
  const rel = toPosixRel('D:\\UItool\\out', 'D:\\UItool\\out\\sub\\x.json');
  assert.equal(rel, 'sub/x.json');
  assert.ok(!rel.includes('\\'), '不应残留反斜杠');
});

// ★ UPSTREAM-FIX-6：toPosixRel 跨平台（Ubuntu CI 曾红：得到 ../D:/UItool/...）
//   旧的 path.relative() 用宿主 OS 规则 —— Linux 上反斜杠不是分隔符，
//   Windows 绝对路径被当成普通目录名，产物里直接泄漏绝对路径。
//   以下断言在任何 OS 上都成立（内部改用 win32/posix 规则集，不依赖宿主）。

test('★ toPosixRel: Windows 输入在 Linux 语义下也正确（用 win32 规则集，不靠宿主 OS）', () => {
  // 即使当前宿主是 Linux，Windows 形态输入也必须走 path.win32 规则
  const rel = toPosixRel('D:\\UItool\\out', 'D:\\UItool\\out\\sub\\x.json');
  assert.equal(rel, 'sub/x.json');
  // 与手动用 path.win32 算出的结果逐字一致（证明不是碰巧）
  assert.equal(rel, path.win32.relative('D:\\UItool\\out', 'D:\\UItool\\out\\sub\\x.json').replace(/\\/g, '/'));
  // ★ 若按 POSIX（Linux）规则算，Windows 绝对路径会被当成普通目录名 → 得到
  //   '../D:/UItool/out/sub/x.json'（这正是 Ubuntu CI 红的那条）。断言「不等于」
  //   即把该回归钉死：实现必须**按输入形态选规则集**，不能一律用宿主/posix 规则。
  const linuxSemantics = path.posix.relative('D:\\UItool\\out', 'D:\\UItool\\out\\sub\\x.json');
  assert.notEqual(rel, linuxSemantics,
    `★ 用 POSIX 规则算会得到 ${linuxSemantics}（绝对路径泄漏）—— 实现必须按形态选规则集`);
  assert.ok(/^\.\.\//.test(linuxSemantics), '本断言本身有效：POSIX 规则下确实会泄漏绝对路径');
  // POSIX 输入走 path.posix 规则（与宿主 OS 无关）
  assert.equal(toPosixRel('/repo/out', '/repo/out/sub/x.json'), 'sub/x.json');
});

test('★ toPosixRel: 路径形态混用 / 跨盘符 → 明确报错（不静默给错）', () => {
  // 混用：一侧 Windows 一侧 POSIX
  assert.throws(() => toPosixRel('/repo/out', 'D:\\UItool\\out\\x.json'),
    (err) => err.code === 'BAD_ARGUMENT' && /形态不一致/.test(err.message));
  // 跨盘符：相对路径在语义上不存在，path.win32 会返回绝对路径 —— 必须拦下
  assert.throws(() => toPosixRel('C:\\work\\out', 'D:\\UItool\\out\\x.json'),
    (err) => err.code === 'BAD_ARGUMENT' && /同一个根/.test(err.message));
});

test('★ writeJson 跨盘符降级: 相对路径不存在时写 outside-root/<文件名>，绝不写绝对路径', () => {
  // 真实场景：PSD 放在另一个盘（C:）而项目根在 D: —— 「相对路径」语义上不存在。
  // 旧实现会把 C:\Users\... 直接写进产物（B9 事故）；现在降级为确定性标记值。
  const dir = tmpDir('det-outside');
  const p = path.join(dir, 'o.json');
  writeJson(p, { source: { psdPath: 'C:\\Users\\someone\\solid.psd' } }, { root: 'D:\\UItool' });
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(text.includes('outside-root/solid.psd'), `应降级为 outside-root/<文件名>：${text}`);
  assert.ok(!/[A-Za-z]:[\\/]/.test(text), `★ 产物内绝不允许出现绝对路径：${text}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('★ toPosixRel: 任何输入组合都不得泄漏绝对路径（机器化守卫）', () => {
  const cases = [
    ['D:\\UItool\\out', 'D:\\UItool\\out\\sub\\x.json'],
    ['D:/UItool/out', 'D:/UItool/out/sub/x.json'],
    ['/repo/out', '/repo/out/sub/x.json'],
    ['out', 'out/sub/x.json'],
    ['\\\\srv\\share\\root', '\\\\srv\\share\\root\\a\\b.json'], // UNC
  ];
  for (const [from, target] of cases) {
    const rel = toPosixRel(from, target);
    assert.ok(!/^[A-Za-z]:/.test(rel),
      `★ 产物内绝不允许出现 Windows 绝对路径：${from} + ${target} -> ${rel}`);
    assert.ok(!rel.includes('\\'), `不应残留反斜杠：${rel}`);
  }
  // UNC 同根可算、跨根报错
  assert.equal(toPosixRel('\\\\srv\\share\\root', '\\\\srv\\share\\root\\a\\b.json'), 'a/b.json');
  assert.throws(() => toPosixRel('\\\\srv\\share\\root', '\\\\other\\share\\root\\a.json'),
    (err) => err.code === 'BAD_ARGUMENT');
});

test('atomicWrite: 注入固定 now 时 .bak 文件名稳定（B9 可验证）', () => {
  const dir = tmpDir('atomic');
  const target = path.join(dir, 'f.txt');
  fs.writeFileSync(target, 'old');
  const r1 = atomicWrite({ targetPath: target, content: 'new1', now: '2026-05-13T10:20:30.123Z' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'new1');
  assert.ok(r1.backupPath.endsWith('.bak.20260513T102030123Z'), `实际: ${r1.backupPath}`);

  const r2 = atomicWrite({ targetPath: target, content: 'new2', now: '2026-05-13T10:20:30.123Z' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'new2');
  assert.ok(r2.backupPath.endsWith('.bak.20260513T102030123Z'), '固定 now 应产出相同 bak 名');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('atomicWrite: 复检失败时不改动原文件，且退出码为 LINT_BLOCKED', () => {
  const dir = tmpDir('atomic-fail');
  const target = path.join(dir, 'f.txt');
  fs.writeFileSync(target, 'ORIGINAL');
  const before = fs.readFileSync(target);

  assert.throws(() => atomicWrite({
    targetPath: target,
    content: 'NEW',
    now: '2026-05-13T10:20:30.123Z',
    verify: () => '模拟 lint 报错',
  }), (err) => {
    assert.equal(err.code, 'LINT_BLOCKED');
    assert.equal(err.exitCode, 3);
    return true;
  });

  assert.equal(fs.readFileSync(target).equals(before), true, '★ 原文件必须未被改动');
  assert.equal(fs.existsSync(`${target}.tmp`), false, 'tmp 应被清理');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rollbackFrom: 从 .bak 恢复原文件', () => {
  const dir = tmpDir('rollback');
  const target = path.join(dir, 'f.txt');
  fs.writeFileSync(target, 'ORIGINAL');
  const r = atomicWrite({ targetPath: target, content: 'CHANGED', now: '2026-05-13T10:20:30.123Z' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'CHANGED');
  const rb = rollbackFrom(r.backupPath, target);
  assert.equal(rb.restored, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stampOf: 非法 now 抛 USAGE 错误', () => {
  assert.throws(() => stampOf('not-a-date'), (err) => {
    assert.equal(err.code, 'USAGE');
    return true;
  });
});

test('writeJson: 产物内不得出现时间戳（run_meta 除外）', () => {
  const dir = tmpDir('ts');
  const p = path.join(dir, 'ir.json');
  const payload = {
    version: '1.0',
    _comment: 'x',
    layers: [{ id: 'L001', bbox: { x: 1, y: 2, w: 3, h: 4 } }],
  };
  writeJson(p, payload);
  const text = fs.readFileSync(p, 'utf8');
  // 产物里不应有 ISO 时间戳或 .bak 文件名
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), '产物内不应有 ISO 时间戳');
  assert.ok(!text.includes('.bak.'), '产物内不应出现 .bak 文件名');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJson: 文件不存在返回 null，存在则解析', () => {
  const dir = tmpDir('read');
  assert.equal(readJson(path.join(dir, 'nope.json')), null);
  const p = path.join(dir, 'a.json');
  writeJson(p, { a: 1 });
  assert.deepEqual(readJson(p), { a: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// ★ 配置一致性守卫（BUG #4/#5 修复版）
// ---------------------------------------------------------------------
//
// ⚠ 第一版守卫在这里踩了坑，务必引以为戒：
//   它断言 `config.diff.maxShapeRatioFactor === 1.6`，而 config 来自 loadConfig()
//   —— 那是「配置文件 ⊕ 内置默认」的深合并结果。配置文件删掉该键后，
//   内置默认会补回来，断言永远成立。**QA 实测：把该键改名为 maxShapeRatioDelta，
//   守卫仍然绿灯通过。** 这就是一个「看起来很严谨、实际是假绿」的守卫。
//
// ✅ 正确做法：守卫必须读**原始配置文件**（readRawConfig），比「键集合」而非「值」。
//    —— 「配置文件少写一个键」正是最该被抓住的配置腐化。

const { loadConfig, defaultConfig, readRawConfig } = require('../../src/core/config');
const { DEFAULT_THRESHOLDS } = require('../../src/imaging/grid9');

const ROOT = path.resolve(__dirname, '../..');
const CONFIG_PATH = path.join(ROOT, 'fgui.config.json');

/** 递归收集对象里的所有非 _ 前缀键路径。 */
function keyPaths(obj, prefix, out) {
  const acc = out || [];
  const p = prefix || '';
  for (const k of Object.keys(obj || {})) {
    if (k.startsWith('_')) continue; // _comment 等说明键不算
    const key = p ? `${p}.${k}` : k;
    acc.push(key);
    if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
      keyPaths(obj[k], key, acc);
    }
  }
  return acc;
}

test('★ 配置守卫: 原始配置文件读得到，且不等于合并后的对象', () => {
  const raw = readRawConfig(CONFIG_PATH);
  assert.equal(raw.exists, true, 'fgui.config.json 应存在');
  assert.ok(raw.raw, '应能读出原始内容');
  assert.ok(!raw.raw.grid9 || !('radialSymmetryMax' in raw.raw.grid9)
    || typeof raw.raw.grid9.radialSymmetryMax === 'number',
    '原始配置的 grid9 段应含数值');
  // 原始内容不含被 stripComments 剔除的 _comment 之下的运行时污染
  const merged = loadConfig({ rootDir: ROOT }).config;
  assert.ok(merged.grid9, '合并后也应可用');
});

test('★ 配置守卫: 原始配置的键集合 === 内置默认的键集合（少键即红）', () => {
  const raw = readRawConfig(CONFIG_PATH).raw;
  const def = defaultConfig();
  const rawKeys = keyPaths(raw).sort();
  const defKeys = keyPaths(def).sort();

  const missing = defKeys.filter((k) => !rawKeys.includes(k));
  const extra = rawKeys.filter((k) => !defKeys.includes(k));
  assert.equal(missing.length, 0,
    `★ fgui.config.json 缺少这些键（它们只会静默走内置默认，改配置不生效）：\n  ${missing.join('\n  ')}`);
  assert.equal(extra.length, 0,
    `★ fgui.config.json 有代码不认识的键（会被静默忽略，以为改了其实没生效）：\n  ${extra.join('\n  ')}`);
});

test('★ 配置守卫: grid9 段与代码默认表逐键一致（含值）', () => {
  const raw = readRawConfig(CONFIG_PATH).raw;
  const rawKeys = Object.keys(raw.grid9).filter((k) => !k.startsWith('_')).sort();
  const defKeys = Object.keys(DEFAULT_THRESHOLDS).sort();
  assert.deepEqual(rawKeys, defKeys,
    `grid9 键不一致 —— 配置里有代码不认的键会被静默忽略：\n配置=${rawKeys}\n代码=${defKeys}`);
  for (const k of defKeys) {
    assert.equal(raw.grid9[k], DEFAULT_THRESHOLDS[k],
      `grid9.${k} 配置值(${raw.grid9[k]}) 与代码默认值(${DEFAULT_THRESHOLDS[k]}) 不一致`);
  }
});

test('★ 配置守卫: diff 段的键与 matcher 实际读取的键一致', () => {
  const raw = readRawConfig(CONFIG_PATH).raw;
  // 这些是 src/diff/matcher.js 的 l3Cfg 与 classifier 真正读取的键
  const USED = [
    'sizeTolerancePx', 'positionTolerancePx', 'phashMaxDistance',
    'phashWeight', 'sizeWeight', 'positionWeight',
    'maxShapeRatioFactor', 'maxAreaRatio', 'l3MinScore',
    'mergedConfidenceCap', 'l4Confidence', 'restyleOpacityDelta',
    'aspectTolerance', 'minRepeatCount',
  ];
  for (const k of USED) {
    assert.ok(k in raw.diff, `★ fgui.config.json 的 diff 段缺 ${k}（matcher/classifier 依赖它，改配置会不生效）`);
  }
  // 反向：diff 段不应有没人读的键
  const dead = Object.keys(raw.diff).filter((k) => !k.startsWith('_') && !USED.includes(k));
  assert.equal(dead.length, 0,
    `★ diff 段存在无人读取的键（写了等于没写，或是被改名的残留）：${dead.join(', ')}`);
});

test('★ 配置守卫: search / asset / psd / normalize 段同样有键覆盖（非只查 grid9）', () => {
  const raw = readRawConfig(CONFIG_PATH).raw;
  const def = defaultConfig();
  for (const section of ['search', 'asset', 'psd', 'normalize', 'paths']) {
    const rawKeys = Object.keys(raw[section] || {}).filter((k) => !k.startsWith('_')).sort();
    const defKeys = Object.keys(def[section] || {}).filter((k) => !k.startsWith('_')).sort();
    assert.deepEqual(rawKeys, defKeys,
      `★ ${section} 段键不一致\n配置=${rawKeys}\n默认=${defKeys}`);
  }
});

test('★ 配置守卫: 运行时配置里不含 _ 开头的说明键（不污染确定性输出）', () => {
  const { config } = loadConfig({ rootDir: ROOT });
  const walk = (node, p) => {
    if (!node || typeof node !== 'object') return;
    for (const k of Object.keys(node)) {
      assert.ok(!k.startsWith('_'), `${p}${k} 以 _ 开头，不应进运行时配置`);
      walk(node[k], `${p}${k}.`);
    }
  };
  walk(config, '');
});

test('★ 守卫自检: 删掉配置里的键后，守卫必须能抓到（证明它不是恒真）', () => {
  // ★★★ 本测试是「守卫自身有效」的唯一证明 ★★★
  // 若守卫对「删键」场景无反应，下面这条会失败。
  const { deepMerge } = require('../../src/core/config');
  const raw = readRawConfig(CONFIG_PATH).raw;

  // 模拟「配置文件删掉了 grid9.radialSymmetryMax」
  const broken = JSON.parse(JSON.stringify(raw));
  delete broken.grid9.radialSymmetryMax;

  // 深合并后该键会被内置默认补回来 —— 这正是旧守卫失效的原因
  const merged = deepMerge(defaultConfig(), broken);
  assert.equal(merged.grid9.radialSymmetryMax, DEFAULT_THRESHOLDS.radialSymmetryMax,
    '深合并确实会把删掉的键补回来（这就是旧守卫抓不到的原因）');
  assert.ok(!('radialSymmetryMax' in broken.grid9),
    '但原始配置里它确实不见了');

  // ★ 而「键集合比对」能抓到：broken 的键集合少于默认
  const brokenKeys = keyPaths(broken).sort();
  const defKeys = keyPaths(defaultConfig()).sort();
  const missing = defKeys.filter((k) => !brokenKeys.includes(k));
  assert.ok(missing.includes('grid9.radialSymmetryMax'),
    `键集合比对必须发现缺失的 grid9.radialSymmetryMax，实际 missing=${missing.join(',')}`);
});

test('配置: loadConfig 支持命令行覆盖', () => {
  const { config } = loadConfig({ rootDir: ROOT, overrides: { search: { topK: 3 } } });
  assert.equal(config.search.topK, 3, '覆盖应生效');
  assert.ok(config.search.weights, '未覆盖的键应保留');
});

test('配置: 缺失配置文件时使用内置默认且不崩', () => {
  const { config, existed } = loadConfig({ rootDir: ROOT, configPath: path.join(ROOT, '不存在.json') });
  assert.equal(existed, false);
  assert.equal(config.grid9.radialSymmetryMax, DEFAULT_THRESHOLDS.radialSymmetryMax);
});

test('配置: 非法 JSON 抛 CONFIG_INVALID（不静默吞）', () => {
  const fsx = require('fs');
  const osx = require('os');
  const dir = fsx.mkdtempSync(path.join(osx.tmpdir(), 'fgui-cfg-'));
  const bad = path.join(dir, 'bad.json');
  fsx.writeFileSync(bad, '{ this is not json ', 'utf8');
  assert.throws(() => loadConfig({ rootDir: ROOT, configPath: bad }), (err) => {
    assert.equal(err.code, 'CONFIG_INVALID');
    return true;
  });
  fsx.rmSync(dir, { recursive: true, force: true });
});
